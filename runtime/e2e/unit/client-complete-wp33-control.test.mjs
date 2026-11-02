// WP33 权限与租约模块：能力声明、授权流程、作用范围、租约失效、中断、审计与遥测。
//
// 全部对象来自 `desktop/control/` 的真实实现。到期与中断用真实计时器验证；审计写到真实文件
// 并按行读回；遥测走桌面壳既有的中继管道，本测试起一个真实的 HTTP 中继端点收集 OTLP 载荷；
// 界面契约用真实的 HTTP 服务器与真实请求验证。控制提供方按 `provider.mjs` 的接口约定实现，
// 真机上的提供方与支持的桌面平台属于未满足条件。
//
// 运行：node --test e2e/unit/client-complete-wp33-control.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { AuditLog } from '../../desktop/control/audit.mjs';
import { declareCapabilities, describeCapabilities, isSupportedPlatform } from '../../desktop/control/capability.mjs';
import { createControlHttpHandler, CONTROL_PREFIX } from '../../desktop/control/http.mjs';
import { createDesktopControl, ControlRejection } from '../../desktop/control/index.mjs';
import { LeaseAuthority, LeaseInterruption, LeaseRejection, MAX_DURATION_MS } from '../../desktop/control/lease.mjs';
import {
  missingPermissions,
  permissionItems,
  permissionStateFrom,
  settingsEntries,
  settingsEntryFor,
} from '../../desktop/control/permissions.mjs';
import { ProviderRejection, assertProvider } from '../../desktop/control/provider.mjs';
import { describeScope, normalizeScope, scopeAllowsPoint, ScopeRejection } from '../../desktop/control/scope.mjs';
import { setTelemetryOrigin } from '../../desktop/electron/telemetry.mjs';

/** 收集遥测载荷的真实中继端点。 */
const relayed = [];

/** 运行时根目录与新客户端包目录。 */
const RUNTIME = resolve(import.meta.dirname, '../..');
const CLIENT_PACKAGE = join(RUNTIME, 'packages/client/desktop-control');

/**
 * 按接口约定实现的控制提供方。真机提供方是 `@deepseek-ai/dsh-computer-use`，本机没有安装，
 * 这里实现同一份约定以驱动授权流程。
 * @param options.granted - 系统授权是否通过。
 */
function controlProvider({ granted = true } = {}) {
  const state = {
    accessibility: granted,
    'screen-recording': granted,
    'screen-capture': granted,
    'input-injection': granted,
  };
  return {
    name: '@deepseek-ai/dsh-computer-use',
    version: '0.1.6-alpha.1',
    capabilities() {
      return ['screen-capture', 'input-injection', 'window-enumeration'];
    },
    async checkPermissions() {
      return { ...state };
    },
    async requestPermissions() {
      return { ...state };
    },
  };
}

const home = allocateIndependentHome('wp33-control');
const relay = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  relayed.push({ signal: request.headers['x-chatdsh-signal'], body: Buffer.concat(chunks).toString('utf8') });
  response.writeHead(204);
  response.end();
});
relay.listen(0, '127.0.0.1');
await once(relay, 'listening');
setTelemetryOrigin(`http://127.0.0.1:${relay.address().port}`);

test.after(async () => {
  relay.closeAllConnections();
  await new Promise((done) => relay.close(done));
  releaseIndependentHome(home);
});

/** 等待中继收到包含指定文本的载荷。 */
async function waitRelayed(text) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (relayed.some((item) => item.body.includes(text))) return true;
    await delay(30);
  }
  return false;
}

/** 等待一个条件成立。 */
async function waitUntil(message, predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await delay(30);
  }
  assert.fail(`等待超时：${message}`);
}

/** 收集到的租约 span。 */
function collectedLeaseSpans() {
  return relayed
    .filter((item) => item.signal === 'traces')
    .flatMap((item) => JSON.parse(item.body).resourceSpans[0].scopeSpans[0].spans)
    .filter((span) => span.name === 'chatdsh.desktop.computeruse.lease');
}

/** 一个 span 上某个属性的取值。 */
function attributeOf(span, key) {
  return span.attributes.find((attribute) => attribute.key === key)?.value.stringValue;
}

test('平台能力按平台声明，不支持的平台不给能力', () => {
  const linux = declareCapabilities({ platform: 'linux', provider: controlProvider() });
  assert.equal(linux.supported, false);
  assert.equal(linux.available, false);
  assert.deepEqual(linux.capabilities, []);
  assert.deepEqual(linux.requirements, []);
  assert.equal(linux.gaps[0].code, 'platform-unsupported');
  assert.ok(describeCapabilities(linux).includes('不提供桌面控制'));

  const windows = declareCapabilities({ platform: 'win32', osVersion: '10.0.22631', provider: controlProvider() });
  assert.equal(windows.supported, true);
  assert.equal(windows.available, true);
  assert.deepEqual([...windows.capabilities], ['screen-capture', 'input-injection', 'window-enumeration']);
  assert.deepEqual([...windows.requirements], ['screen-capture', 'input-injection']);
  assert.equal(windows.provider.name, '@deepseek-ai/dsh-computer-use');
  assert.deepEqual(windows.gaps, []);

  const oldMac = declareCapabilities({ platform: 'darwin', osVersion: '13.6.1', provider: controlProvider() });
  assert.equal(oldMac.supported, false);
  assert.equal(oldMac.gaps[0].code, 'version-unsupported');
  assert.ok(oldMac.gaps[0].detail.includes('14'));

  const mac = declareCapabilities({ platform: 'darwin', osVersion: '14.5.0', provider: controlProvider() });
  assert.equal(mac.supported, true);
  assert.deepEqual([...mac.requirements], ['accessibility', 'screen-recording']);

  const noProvider = declareCapabilities({ platform: 'win32', provider: undefined });
  assert.equal(noProvider.supported, true);
  assert.equal(noProvider.available, false);
  assert.equal(noProvider.gaps[0].code, 'provider-missing');
  assert.ok(describeCapabilities(noProvider).includes('没有加载控制提供方'));

  assert.equal(isSupportedPlatform('win32'), true);
  assert.equal(isSupportedPlatform('darwin'), true);
  assert.equal(isSupportedPlatform('linux'), false);
  assert.equal(isSupportedPlatform('freebsd'), false);
});

test('授权项逐项列出用途与系统设置入口', () => {
  assert.equal(settingsEntryFor('accessibility', 'darwin'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  assert.equal(settingsEntryFor('screen-recording', 'darwin'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  assert.equal(settingsEntryFor('screen-capture', 'win32'), 'ms-settings:privacy-screenshots');
  assert.equal(settingsEntryFor('input-injection', 'win32'), undefined);

  const macItems = permissionItems('darwin', ['accessibility', 'screen-recording']);
  assert.deepEqual(macItems.map((item) => item.label), ['辅助功能', '屏幕录制']);
  assert.ok(macItems[0].purpose.includes('窗口'));
  assert.equal(macItems[0].settingsPath.includes('Privacy_Accessibility'), true);

  const winItems = permissionItems('win32', ['screen-capture', 'input-injection']);
  const entries = settingsEntries(winItems);
  assert.equal(entries[0].path, 'ms-settings:privacy-screenshots');
  assert.equal(entries[1].path, undefined);
  assert.ok(entries[1].note.includes('管理员身份'));

  const state = permissionStateFrom({ 'screen-capture': true }, winItems);
  assert.deepEqual(state, { 'screen-capture': true, 'input-injection': false });
  assert.deepEqual(missingPermissions(state), ['input-injection']);
});

test('提供方实现按接口约定核对', () => {
  assert.throws(() => assertProvider(undefined), (error) => error instanceof ProviderRejection && error.code === 'provider-missing');
  assert.throws(() => assertProvider({ name: '' }), (error) => error.code === 'provider-name');
  assert.throws(() => assertProvider({ name: 'x', capabilities() {} }), (error) => error.code === 'provider-method');
  assert.equal(assertProvider(controlProvider()).name, '@deepseek-ai/dsh-computer-use');
});

test('作用范围只接受屏幕区域与目标窗口', () => {
  const region = normalizeScope({ kind: 'region', displayId: '1', x: 0, y: 0, width: 1280, height: 720 });
  assert.ok(Object.isFrozen(region));
  assert.ok(describeScope(region).includes('1280×720'));
  assert.equal(scopeAllowsPoint(region, { x: 1279, y: 719 }), true);
  assert.equal(scopeAllowsPoint(region, { x: 1280, y: 719 }), false);
  assert.equal(scopeAllowsPoint(region, { x: 0, y: -1 }), false);

  const windowScope = normalizeScope({ kind: 'window', applicationId: 'com.apple.Safari', windowId: 'w-7' });
  assert.ok(describeScope(windowScope).includes('com.apple.Safari'));
  assert.equal(scopeAllowsPoint(windowScope, { x: 999_999, y: 0 }), true);

  const cases = [
    [null, 'scope-missing'],
    [{ kind: 'desktop' }, 'scope-kind'],
    [{ kind: 'region', displayId: '', x: 0, y: 0, width: 10, height: 10 }, 'display-id'],
    [{ kind: 'region', displayId: '1', x: 0.5, y: 0, width: 10, height: 10 }, 'region-x'],
    [{ kind: 'region', displayId: '1', x: 0, y: 0, width: 0, height: 10 }, 'region-width'],
    [{ kind: 'window', applicationId: 'x', windowId: '' }, 'window-id'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => normalizeScope(input), (error) => error instanceof ScopeRejection && error.code === code, code);
  }
});

test('租约到期由真实计时器触发，失效后不能发起动作', async () => {
  const authority = new LeaseAuthority();
  const changes = [];
  authority.subscribe((snapshot, change) => changes.push({ status: snapshot.lease?.status, change }));
  const granted = authority.grant({
    scope: normalizeScope({ kind: 'window', applicationId: 'com.apple.Safari', windowId: 'w-1' }),
    durationMs: 1_200,
    requestId: 'req-expire',
  });
  assert.equal(granted.lease.status, 'active');
  assert.equal(granted.lease.expiresAt - granted.lease.grantedAt, 1_200);
  const permit = authority.begin(granted.lease.leaseId, 'click');
  assert.equal(permit.expiresAt, granted.lease.expiresAt);

  await delay(1_400);
  const after = authority.snapshot();
  assert.equal(after.lease.status, 'expired');
  assert.equal(after.remainingMs, 0);
  assert.ok(changes.some((item) => item.change === 'expired' && item.status === 'expired'));
  assert.equal(permit.signal.aborted, true, '到期时正在执行的动作收到停止信号');
  assert.throws(() => authority.begin(granted.lease.leaseId, 'click'), (error) => error instanceof LeaseRejection && error.code === 'lease-expired');
  authority.dispose();
});

test('中断立即生效，正在执行的动作收到停止信号且不再接受新动作', () => {
  const authority = new LeaseAuthority();
  const granted = authority.grant({
    scope: normalizeScope({ kind: 'region', displayId: '1', x: 0, y: 0, width: 800, height: 600 }),
    durationMs: 60_000,
    requestId: 'req-interrupt',
  });
  const first = authority.begin(granted.lease.leaseId, 'click');
  const second = authority.begin(granted.lease.leaseId, 'type');
  assert.equal(authority.snapshot().activeActions, 2);
  const interrupted = authority.interrupt('用户按下中断');
  assert.equal(interrupted.lease.status, 'interrupted');
  assert.equal(interrupted.lease.reason, '用户按下中断');
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.ok(first.signal.reason instanceof LeaseInterruption);
  assert.equal(first.signal.reason.code, 'lease-interrupted');
  assert.equal(interrupted.activeActions, 0);
  assert.throws(() => authority.begin(granted.lease.leaseId, 'click'), (error) => error.code === 'lease-interrupted');
  assert.throws(() => authority.interrupt('再次中断'), (error) => error.code === 'lease-interrupted');
  authority.dispose();
});

test('暂停期间拒绝新动作，恢复之后按原期限继续', () => {
  const authority = new LeaseAuthority();
  const granted = authority.grant({
    scope: normalizeScope({ kind: 'window', applicationId: 'com.apple.Safari', windowId: 'w-2' }),
    durationMs: 60_000,
    requestId: 'req-pause',
  });
  const paused = authority.setPaused(true);
  assert.equal(paused.lease.status, 'paused');
  assert.equal(paused.lease.paused, true);
  assert.throws(() => authority.begin(granted.lease.leaseId, 'click'), (error) => error.code === 'lease-paused');
  const resumed = authority.setPaused(false);
  assert.equal(resumed.lease.status, 'active');
  assert.equal(resumed.lease.expiresAt, granted.lease.expiresAt);
  const permit = authority.begin(granted.lease.leaseId, 'click');
  assert.equal(permit.signal.aborted, false);
  authority.dispose();
});

test('新的授权替换旧租约，旧标识不能再发起动作', () => {
  const authority = new LeaseAuthority();
  const first = authority.grant({
    scope: normalizeScope({ kind: 'region', displayId: '1', x: 0, y: 0, width: 100, height: 100 }),
    durationMs: 60_000,
    requestId: 'req-1',
  });
  const second = authority.grant({
    scope: normalizeScope({ kind: 'region', displayId: '1', x: 0, y: 0, width: 200, height: 200 }),
    durationMs: 60_000,
    requestId: 'req-2',
  });
  assert.notEqual(first.lease.leaseId, second.lease.leaseId);
  assert.throws(() => authority.begin(first.lease.leaseId, 'click'), (error) => error.code === 'lease-stale');
  assert.equal(authority.begin(second.lease.leaseId, 'click').leaseId, second.lease.leaseId);
  assert.throws(
    () => authority.grant({ scope: normalizeScope({ kind: 'window', applicationId: 'a', windowId: 'w' }), durationMs: MAX_DURATION_MS + 1, requestId: 'x' }),
    (error) => error.code === 'duration-range',
  );
  authority.dispose();
});

test('多个窗口订阅到同一份状态', () => {
  const authority = new LeaseAuthority();
  const left = [];
  const right = [];
  authority.subscribe((snapshot) => left.push(snapshot));
  authority.subscribe((snapshot) => right.push(snapshot));
  const granted = authority.grant({
    scope: normalizeScope({ kind: 'window', applicationId: 'com.apple.Safari', windowId: 'w-3' }),
    durationMs: 60_000,
    requestId: 'req-windows',
  });
  authority.begin(granted.lease.leaseId, 'click');
  authority.setPaused(true);
  authority.interrupt('用户中断');
  assert.equal(left.length, right.length);
  assert.deepEqual(left.at(-1), right.at(-1));
  assert.equal(left.at(-1).lease.status, 'interrupted');
  assert.equal(left.at(-1).lease.leaseId, granted.lease.leaseId);
  authority.dispose();
});

test('审计写到真实文件，按种类与条数查询', () => {
  const file = join(home, 'audit', 'control.jsonl');
  const log = new AuditLog({ file, now: () => 1_700_000_000_000 });
  log.record({ kind: 'grant', outcome: 'granted', leaseId: 'l-1', scope: { kind: 'window' }, expiresAt: 1_700_000_060_000, detail: '授权期限 1 分钟' });
  log.record({ kind: 'use', outcome: 'permitted', leaseId: 'l-1', action: 'click' });
  log.record({ kind: 'interrupt', outcome: 'interrupted', leaseId: 'l-1' });
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const grant = JSON.parse(lines[0]);
  assert.equal(grant.kind, 'grant');
  assert.equal(grant.time, new Date(1_700_000_000_000).toISOString());
  assert.equal(grant.expiresAtTime, new Date(1_700_000_060_000).toISOString());
  assert.equal(grant.outcome, 'granted');
  assert.equal(log.query({ kind: 'use' }).length, 1);
  assert.equal(log.query({ limit: 2 }).length, 2);
  assert.equal(log.query()[0].kind, 'interrupt', '最新的记录在前');
  assert.throws(() => log.record({ kind: 'unknown', outcome: 'ok' }), /未登记的审计种类/);
});

test('授权申请逐项确认，拒绝时给出系统设置入口', async () => {
  const auditFile = join(home, 'flow', 'audit.jsonl');
  const control = createDesktopControl({ platform: 'win32', osVersion: '10.0.22631', provider: controlProvider(), auditFile });
  assert.equal(control.capabilities.supported, true);
  const pending = control.beginRequest({
    scope: { kind: 'region', displayId: '1', x: 0, y: 0, width: 1280, height: 720 },
    durationMs: 5 * 60_000,
    purpose: '整理表格里的数据。',
  });
  assert.deepEqual(pending.items.map((item) => item.id), ['purpose', 'scope', 'duration', 'permission-screen-capture', 'permission-input-injection']);
  assert.equal(pending.items.every((item) => item.confirmed === false), true);
  assert.ok(pending.items[1].detail.includes('1280×720'));
  assert.ok(pending.items[2].detail.includes('5 分钟'));

  const partial = await control.confirm({ requestId: pending.requestId, itemId: 'purpose', confirmed: true });
  assert.equal(partial.remaining, 4);
  const denied = await control.confirm({ requestId: pending.requestId, itemId: 'scope', confirmed: false });
  assert.equal(denied.denied, true);
  assert.equal(denied.settings.length, 2);
  assert.equal(denied.settings[0].path, 'ms-settings:privacy-screenshots');
  assert.equal(control.state().lease, undefined, '拒绝之后没有租约');
  await waitUntil('拒绝产生失败的授权 span', () => collectedLeaseSpans()
    .some((span) => attributeOf(span, 'action') === 'authorize' && span.status.code === 2));

  const again = control.beginRequest({
    scope: { kind: 'window', applicationId: 'notepad.exe', windowId: 'w-9' },
    durationMs: 60_000,
    purpose: '核对窗口内容。',
  });
  let result;
  for (const item of again.items) {
    result = await control.confirm({ requestId: again.requestId, itemId: item.id, confirmed: true });
  }
  assert.equal(result.granted, true);
  assert.equal(result.lease.status, 'active');
  assert.equal(control.state().permissions['screen-capture'], true);
  assert.equal(control.state().lease.leaseId, result.lease.leaseId);

  const permit = control.use({ action: 'click', point: { x: 10, y: 10 } });
  assert.equal(control.state().activeActions, 1);
  const farPermit = control.use({ action: 'click', point: { x: 9_999, y: 10 } });
  assert.equal(farPermit.expiresAt, permit.expiresAt, '窗口范围不限制坐标');
  control.end({ permitId: farPermit.permitId, outcome: 'ok' });
  control.end({ permitId: permit.permitId, outcome: 'ok' });
  assert.throws(() => control.end({ permitId: permit.permitId, outcome: 'ok' }), (error) => error.code === 'permit-missing');

  const interrupted = control.interrupt('用户按下中断');
  assert.equal(interrupted.lease.status, 'interrupted');
  assert.throws(() => control.use({ action: 'click' }), (error) => error.code === 'lease-interrupted');

  const kinds = control.auditEntries().map((entry) => entry.kind);
  for (const kind of ['request', 'deny', 'grant', 'use', 'end', 'interrupt']) {
    assert.ok(kinds.includes(kind), `审计缺少 ${kind}`);
  }
  const grantEntry = control.auditEntries({ kind: 'grant' })[0];
  assert.equal(typeof grantEntry.time, 'string');
  assert.equal(typeof grantEntry.expiresAtTime, 'string');
  assert.equal(grantEntry.scope.kind, 'window');
  control.dispose();
});

test('不支持的平台与缺少提供方都拒绝发起授权', async () => {
  const linux = createDesktopControl({ platform: 'linux', provider: controlProvider(), auditFile: join(home, 'linux', 'audit.jsonl') });
  assert.throws(
    () => linux.beginRequest({ scope: { kind: 'window', applicationId: 'x', windowId: 'w' }, durationMs: 60_000, purpose: '验证' }),
    (error) => error instanceof ControlRejection && error.code === 'platform-unsupported',
  );
  assert.throws(() => linux.use({ action: 'click' }), (error) => error.code === 'lease-missing');
  linux.dispose();

  const noProvider = createDesktopControl({ platform: 'win32', auditFile: join(home, 'no-provider', 'audit.jsonl') });
  assert.throws(
    () => noProvider.beginRequest({ scope: { kind: 'window', applicationId: 'x', windowId: 'w' }, durationMs: 60_000, purpose: '验证' }),
    (error) => error.code === 'provider-missing',
  );
  await assert.rejects(() => noProvider.checkPermissions(), (error) => error.code === 'provider-missing');
  noProvider.dispose();
});

test('授权与使用与中断都写进遥测', async () => {
  const control = createDesktopControl({ platform: 'darwin', osVersion: '14.5.0', provider: controlProvider(), auditFile: join(home, 'telemetry', 'audit.jsonl') });
  const pending = control.beginRequest({
    scope: { kind: 'region', displayId: '2', x: 100, y: 100, width: 400, height: 300 },
    durationMs: 60_000,
    purpose: '核对遥测。',
  });
  let result;
  for (const item of pending.items) {
    result = await control.confirm({ requestId: pending.requestId, itemId: item.id, confirmed: true });
  }
  assert.equal(result.granted, true);
  const permit = control.use({ action: 'click', point: { x: 120, y: 120 } });
  control.end({ permitId: permit.permitId, outcome: 'ok' });
  control.interrupt('遥测验证');
  await control.checkPermissions();
  await assert.rejects(
    () => control.confirm({ requestId: 'grant-missing', itemId: 'purpose', confirmed: true }),
    (error) => error.code === 'request-missing',
  );

  assert.equal(await waitRelayed('chatdsh.desktop.computeruse.lease'), true, '没有收到租约 span');
  assert.equal(await waitRelayed('chatdsh.desktop.native.rejected'), true, '没有收到拒绝事件');
  assert.equal(await waitRelayed('chatdsh_desktop_actions_total'), true, '没有收到动作计数');

  await waitUntil('租约 span 覆盖申请、授权、使用与中断', () => {
    const covered = new Set(collectedLeaseSpans().map((span) => attributeOf(span, 'action')));
    return ['request', 'authorize', 'use', 'interrupt'].every((action) => covered.has(action));
  });

  const leaseSpans = collectedLeaseSpans();
  const actions = new Set(leaseSpans.map((span) => attributeOf(span, 'action')));
  for (const action of ['request', 'authorize', 'use', 'interrupt']) {
    assert.equal(actions.has(action), true, `span 里缺少动作 ${action}`);
  }
  for (const span of leaseSpans) {
    assert.equal(attributeOf(span, 'outcome') !== undefined, true, 'span 需要带结果');
    assert.equal(typeof span.startTimeUnixNano, 'string');
  }

  const collectedRejections = () => relayed
    .filter((item) => item.signal === 'logs')
    .flatMap((item) => JSON.parse(item.body).resourceLogs[0].scopeLogs[0].logRecords)
    .filter((event) => event.body.stringValue === 'chatdsh.desktop.native.rejected');

  await waitUntil('缺少申请时写出的拒绝事件到达', () => collectedRejections()
    .some((event) => event.attributes.some((attribute) => attribute.key === 'error.code' && attribute.value.stringValue === 'request-missing')));

  const rejections = collectedRejections();
  assert.ok(rejections.length > 0, '没有拒绝事件');
  const keys = rejections[0].attributes.map((attribute) => attribute.key);
  assert.ok(keys.includes('error.type'));
  assert.ok(keys.includes('error.code'));
  assert.equal(
    rejections.some((event) => event.attributes.some((attribute) => attribute.key === 'error.code' && attribute.value.stringValue === 'request-missing')),
    true,
    '缺少申请时写出的拒绝事件里没有 error.code',
  );

  const metrics = relayed
    .filter((item) => item.signal === 'metrics')
    .flatMap((item) => JSON.parse(item.body).resourceMetrics[0].scopeMetrics[0].metrics);
  const counter = metrics.find((metric) => metric.name === 'chatdsh_desktop_actions_total');
  assert.ok(counter !== undefined);
  assert.equal(counter.sum.isMonotonic, true);
  const body = relayed.map((item) => item.body).join('\n');
  assert.equal(body.includes('核对遥测。'), false, '遥测里没有用途原文');
  assert.equal(body.includes('com.apple.Safari'), false, '遥测里没有应用标识');
  control.dispose();
});

test('同源 HTTP 入口完成申请、授权、动作与中断', async () => {
  const control = createDesktopControl({
    platform: 'win32',
    osVersion: '10.0.22631',
    provider: controlProvider(),
    auditFile: join(home, 'http', 'audit.jsonl'),
  });
  const handle = createControlHttpHandler({ control });
  const server = createServer(async (request, response) => {
    if (await handle(request, response)) return;
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const write = (path, body) => fetch(`${origin}${CONTROL_PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chatdsh-csrf': '1' },
    body: JSON.stringify(body),
  });
  try {
    const stateResponse = await fetch(`${origin}${CONTROL_PREFIX}/state`);
    assert.equal(stateResponse.status, 200);
    const initial = await stateResponse.json();
    assert.equal(initial.state.capability.supported, true);
    assert.equal(initial.state.lease, undefined);

    const csrfMissing = await fetch(`${origin}${CONTROL_PREFIX}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'window', applicationId: 'a', windowId: 'w' }, durationMs: 60_000, purpose: 'x' }),
    });
    assert.equal(csrfMissing.status, 403);
    assert.equal((await csrfMissing.json()).error, 'csrf-missing');

    const requested = await write('/request', {
      scope: { kind: 'region', displayId: '1', x: 0, y: 0, width: 800, height: 600 },
      durationMs: 60_000,
      purpose: '核对界面契约。',
    });
    assert.equal(requested.status, 200);
    const { pending } = await requested.json();
    for (const item of pending.items) {
      const confirmed = await write('/confirm', { requestId: pending.requestId, itemId: item.id, confirmed: true });
      assert.equal(confirmed.status, 200);
    }
    const afterGrant = await (await fetch(`${origin}${CONTROL_PREFIX}/state`)).json();
    assert.equal(afterGrant.state.lease.status, 'active');

    const action = await write('/action', { action: 'click', point: { x: 10, y: 10 } });
    assert.equal(action.status, 200);
    const { permit } = await action.json();
    const outside = await write('/action', { action: 'click', point: { x: 5000, y: 10 } });
    assert.equal(outside.status, 409);
    assert.equal((await outside.json()).error, 'point-outside-scope');
    const ended = await write('/action/end', { permitId: permit.permitId, outcome: 'ok' });
    assert.equal(ended.status, 200);

    const paused = await write('/pause', { paused: true });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).state.lease.status, 'paused');
    const rejected = await write('/action', { action: 'click' });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, 'lease-paused');
    await write('/pause', { paused: false });

    const interrupted = await write('/interrupt', { reason: '界面中断' });
    assert.equal(interrupted.status, 200);
    assert.equal((await interrupted.json()).state.lease.status, 'interrupted');
    const afterInterrupt = await write('/action', { action: 'click' });
    assert.equal(afterInterrupt.status, 409);
    assert.equal((await afterInterrupt.json()).error, 'lease-interrupted');

    const audit = await (await fetch(`${origin}${CONTROL_PREFIX}/audit?limit=5`)).json();
    assert.equal(audit.entries.length, 5);
    assert.equal(audit.entries[0].kind, 'interrupt');
    assert.equal(typeof audit.entries[0].time, 'string');

    const missing = await (await fetch(`${origin}${CONTROL_PREFIX}/nothing`)).json();
    assert.equal(missing.error, 'route-not-found');
  } finally {
    control.dispose();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('遥测信号与清单、文档三处一致', () => {
  const doc = readFileSync(join(RUNTIME, 'docs/telemetry.md'), 'utf8');
  const attributeKeys = new Set(['chatdsh.surface', 'chatdsh.component', 'chatdsh.instance.id', 'chatdsh.version']);
  const manifests = [
    { manifest: join(RUNTIME, 'desktop/control/package.json'), source: join(RUNTIME, 'desktop/control') },
    { manifest: join(CLIENT_PACKAGE, 'package.json'), source: join(CLIENT_PACKAGE, 'src') },
  ];
  for (const { manifest: manifestPath, source } of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const telemetry = manifest.chatdsh?.telemetry ?? {};
    const declared = new Set([...(telemetry.spans ?? []), ...(telemetry.events ?? []), ...(telemetry.metrics ?? [])]);
    assert.ok(declared.size > 0, `${manifest.name} 没有声明遥测面`);
    const used = new Set();
    for (const file of readdirSync(source, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.(?:ts|tsx|mjs)$/.test(file.name)) continue;
      const text = readFileSync(join(file.parentPath, file.name), 'utf8');
      for (const match of text.matchAll(/\bchatdsh\.[a-z0-9_]+(?:\.[a-z0-9_]+)+\b/g)) used.add(match[0]);
      for (const match of text.matchAll(/\bchatdsh_[a-z0-9_]+\b/g)) used.add(match[0]);
    }
    for (const name of used) {
      if (attributeKeys.has(name)) continue;
      assert.equal(declared.has(name), true, `${manifest.name} 的源码出现 ${name}，清单没有声明`);
      assert.equal(doc.includes(`\`${name}\``), true, `${name} 没有登记在 docs/telemetry.md`);
    }
    for (const name of declared) {
      assert.equal(doc.includes(`\`${name}\``), true, `${manifest.name} 声明了 ${name}，文档里没有登记`);
    }
  }
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(CLIENT_PACKAGE, 'package.json'), 'utf8')).chatdsh.telemetry),
    ['events', 'spans', 'metrics'],
    '客户端包的遥测声明字段',
  );
});
