// WP32 电源、开机启动、通知与启动恢复。
//
// 覆盖电源阻止的动作计算与失败说明、开机启动的平台支持与设置对象、通知能力如实报告与
// 跳转路径校验，以及启动失败记录的脱敏、有界保存、崩溃证据、安全模式状态与诊断文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { describePowerState, powerFailureHint, powerPlan } from '../../desktop/electron/power.mjs';
import { LoginRejection, describeLoginFailure, loginItemSettings, loginSupport } from '../../desktop/electron/login-item.mjs';
import {
  NotificationRejection, assertNotificationRequest, assertRoute, describeNotificationFailure,
  notificationCapability, routeToUrl,
} from '../../desktop/electron/notifications.mjs';
import {
  MAX_CRASH_RECORDS, MAX_LOG_LINES, buildFailureRecord, clearCrashes, clearFailureRecord, enterSafeMode,
  exitSafeMode, readCrashes, readFailureRecord, readSafeMode, recordCrash, recoveryChoices, redactLine,
  redactLines, safeModeEnv, safeModeNotice, writeDiagnostics, writeFailureRecord,
} from '../../desktop/electron/startup-recovery.mjs';

test('电源阻止按开关与当前持有状态计算动作', () => {
  assert.deepEqual(powerPlan({ enabled: true, active: false, mode: 'prevent-display-sleep' }), {
    action: 'start', type: 'prevent-display-sleep', reason: 'requested',
  });
  assert.equal(powerPlan({ enabled: false, active: true }).action, 'stop');
  assert.equal(powerPlan({ enabled: true, active: true }).action, 'none');
  assert.equal(powerPlan({ enabled: false, active: false }).action, 'none');
  assert.throws(() => powerPlan({ enabled: true, active: false, mode: 'keep-awake' }), /未知电源阻止模式/u);
});

test('电源状态如实区分已生效、未生效与未启用', () => {
  assert.equal(describePowerState({ enabled: true, active: true, mode: 'prevent-display-sleep' }).tone, 'ok');
  const failed = describePowerState({ enabled: true, active: false, failureCode: 'blocker-refused' });
  assert.equal(failed.tone, 'danger');
  assert.match(failed.detail, /系统拒绝/u);
  assert.equal(describePowerState({ enabled: false, active: false }).tone, 'muted');
  assert.match(powerFailureHint('unsupported-platform'), /不支持/u);
  assert.equal(powerFailureHint('other'), '电源阻止未能生效');
});

test('开机启动只在小 Windows 与 macOS 上登记', () => {
  assert.equal(loginSupport('win32').supported, true);
  assert.equal(loginSupport('darwin').supported, true);
  const linux = loginSupport('linux');
  assert.equal(linux.supported, false);
  assert.match(linux.hint, /手动添加/u);
  assert.deepEqual(loginItemSettings({ enabled: true, platform: 'win32', executablePath: 'C:\\ChatDSH\\ChatDSH.exe' }), {
    openAtLogin: true,
    path: 'C:\\ChatDSH\\ChatDSH.exe',
    args: ['--launch-at-login'],
  });
  assert.deepEqual(loginItemSettings({ enabled: false, platform: 'win32', executablePath: 'C:\\ChatDSH\\ChatDSH.exe' }), { openAtLogin: false });
  assert.deepEqual(loginItemSettings({ enabled: true, platform: 'darwin' }), { openAtLogin: true, openAsHidden: true });
  assert.throws(
    () => loginItemSettings({ enabled: true, platform: 'linux', executablePath: '/usr/bin/chatdsh' }),
    (error) => error instanceof LoginRejection && error.code === 'platform-unsupported',
  );
  assert.throws(() => loginItemSettings({ enabled: true, platform: 'win32' }), (error) => error.code === 'path-missing');
  assert.match(describeLoginFailure('settings-write-failed'), /策略/u);
});

test('通知能力按系统结果报告，不伪造授权', () => {
  assert.deepEqual(notificationCapability({ platform: 'win32', isSupported: true }), {
    status: 'granted', reason: 'system-default', detail: '',
  });
  assert.equal(notificationCapability({ platform: 'win32', isSupported: false }).status, 'unsupported');
  const macPending = notificationCapability({ platform: 'darwin', isSupported: true, permission: 'not-determined' });
  assert.equal(macPending.status, 'denied');
  assert.equal(macPending.reason, 'not-requested');
  const macDenied = notificationCapability({ platform: 'darwin', isSupported: true, permission: 'denied' });
  assert.equal(macDenied.reason, 'system-denied');
  assert.equal(notificationCapability({ platform: 'darwin', isSupported: true, permission: 'granted' }).status, 'granted');
  assert.match(describeNotificationFailure('system-denied'), /系统设置/u);
});

test('通知请求校验字段与业务页面路径', () => {
  const request = assertNotificationRequest({ kind: 'approval', title: '有审批', body: '等待处理', route: '/approvals' });
  assert.deepEqual(request, { kind: 'approval', title: '有审批', body: '等待处理', route: '/approvals' });
  assert.throws(() => assertNotificationRequest({ kind: 'unknown', title: 't', body: 'b', route: '/approvals' }), (error) => error instanceof NotificationRejection && error.code === 'kind-unknown');
  assert.throws(() => assertNotificationRequest({ kind: 'failure', title: '', body: 'b', route: '/approvals' }), (error) => error.code === 'title-invalid');
  assert.throws(() => assertNotificationRequest({ kind: 'failure', title: 't', body: 'x'.repeat(400), route: '/approvals' }), (error) => error.code === 'body-invalid');
  assert.throws(() => assertRoute('https://evil.example/'), (error) => error.code === 'route-invalid');
  assert.throws(() => assertRoute('/sessions/../../etc'), (error) => error.code === 'route-invalid');
  assert.throws(() => assertRoute('//evil.example'), (error) => error.code === 'route-invalid');
  assert.throws(() => assertRoute('/unknown/page'), (error) => error.code === 'route-not-allowed');
  assert.equal(assertRoute('/sessions/abc'), '/sessions/abc');
});

test('通知跳转拼在当前运行时地址后面', () => {
  assert.equal(
    routeToUrl('/sessions/abc', 'http://127.0.0.1:3170/chatdsh/boot/token'),
    'http://127.0.0.1:3170/chatdsh/boot/token#/sessions/abc',
  );
  assert.throws(() => routeToUrl('/sessions/abc', ''), (error) => error.code === 'boot-url-missing');
});

test('日志脱敏覆盖凭据、令牌、邮箱、地址与用户目录', () => {
  const redacted = redactLine('GET /chatdsh/gateway/bootstrap?token=abc123 200 Authorization: Bearer [REDACTED:auth_header] me@example.com 127.0.0.1 /home/alice/chatdsh/runtime');
  assert.equal(redacted.includes('abc123'), false);
  assert.equal(redacted.includes('secret-value'), false);
  assert.equal(redacted.includes('me@example.com'), false);
  assert.equal(redacted.includes('127.0.0.1'), false);
  assert.equal(redacted.includes('/home/alice'), false);
  assert.match(redacted, /<已隐藏>/u);
  assert.match(redacted, /<邮箱已隐藏>/u);
  assert.match(redacted, /<地址已隐藏>/u);
  assert.equal(redactLine('x'.repeat(900)).length, 501);
  const many = Array.from({ length: 200 }, (_unused, index) => `line ${index}`);
  const tail = redactLines(many);
  assert.equal(tail.length, MAX_LOG_LINES);
  assert.equal(tail[0], 'line 120');
});

test('启动失败记录有界保存并可以清除', () => {
  const dir = tempHome('wp32-startup-failure');
  const record = buildFailureRecord({
    stage: 'runtime',
    code: 'startup-failed',
    exitCode: 1,
    uptimeSeconds: 12.4,
    lines: ['阶段 runtime 失败 token=hidden'],
  });
  const file = writeFailureRecord(dir, record);
  assert.equal(existsSync(file), true);
  const loaded = readFailureRecord(dir);
  assert.equal(loaded.stage, 'runtime');
  assert.equal(loaded.exitCode, 1);
  assert.equal(loaded.uptimeSeconds, 12);
  assert.deepEqual(loaded.logTail, ['阶段 runtime 失败 token=<已隐藏>']);
  clearFailureRecord(dir);
  assert.equal(readFailureRecord(dir), undefined);
  assert.throws(() => buildFailureRecord({}), /失败记录缺少阶段/u);
});

test('崩溃证据按上限保留并可清除', () => {
  const dir = tempHome('wp32-startup-crashes');
  for (let index = 0; index < MAX_CRASH_RECORDS + 5; index += 1) {
    recordCrash(dir, { code: 'ERR_RENDER_GONE', reason: '渲染进程退出', uptimeSeconds: index });
  }
  const crashes = readCrashes(dir);
  assert.equal(crashes.length, MAX_CRASH_RECORDS);
  assert.equal(crashes.at(-1).uptimeSeconds, MAX_CRASH_RECORDS + 4);
  clearCrashes(dir);
  assert.deepEqual(readCrashes(dir), []);
});

test('安全模式记录原因与停用扩展，并给出环境变量', () => {
  const dir = tempHome('wp32-startup-safe-mode');
  assert.equal(readSafeMode(dir), undefined);
  const record = enterSafeMode(dir, { reason: 'startup-recovery', disabledExtensions: ['@chatdsh/client-kanban'] });
  assert.deepEqual(readSafeMode(dir), record);
  assert.deepEqual(safeModeEnv(record), {
    CHATDSH_SAFE_MODE: '1',
    CHATDSH_SAFE_MODE_REASON: 'startup-recovery',
    CHATDSH_DISABLED_EXTENSIONS: '@chatdsh/client-kanban',
  });
  assert.match(safeModeNotice(record), /已停用 1 个扩展/u);
  assert.match(safeModeNotice(enterSafeMode(dir, { reason: 'manual' })), /没有登记的扩展/u);
  exitSafeMode(dir);
  assert.equal(readSafeMode(dir), undefined);
});

test('恢复入口给出重试、安全模式与重置三条路径', () => {
  const choices = recoveryChoices({ stage: 'runtime', code: 'startup-failed' });
  assert.deepEqual(choices.map((item) => item.id), ['retry', 'safe-mode', 'reset-config']);
  assert.match(choices[0].detail, /runtime/u);
  assert.equal(choices[2].danger, true);
  assert.match(recoveryChoices(undefined)[0].detail, /重新拉起/u);
});

test('诊断文件写出脱敏后的失败记录与版本信息', () => {
  const dir = tempHome('wp32-startup-diagnostics');
  const file = writeDiagnostics(dir, {
    versions: { app: '0.1.0', electron: '44.0.0' },
    failure: { stage: 'runtime', code: 'startup-failed', logTail: [] },
    crashes: [{ code: 'ERR_RENDER_GONE' }],
    lines: ['bootstrap?token=leaked 401'],
  });
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(payload.versions.app, '0.1.0');
  assert.equal(payload.failure.stage, 'runtime');
  assert.equal(payload.crashes.length, 1);
  assert.equal(JSON.stringify(payload).includes('leaked'), false);
  assert.equal(join(dir, 'diagnostics.json'), file);
});
