// WP18 自动化的数据层验收：条件表单逻辑、真实控制平面、真实 SQLite 与真实 HTTP。
//
// 页面之外的部分先在这里验证：时间方式的互斥与校验、夏令时边界、下次发生时间、webhook 投递
// 与去重、启停后的数据库状态，以及建立、删除与投递记录分页的真实读写。控制平面是真实的
// `createGatewayServer`，存储是真实 `GatewayStore`（SQLite），请求全部走真实 HTTP。
//
// 运行：node --test e2e/unit/client-complete-wp18-automation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer } from '../../gateway/lib/server.js';
import { AutomationStore } from '../../gateway/lib/automation.js';
import { createAutomationGateway } from '../../packages/client/automation/lib/client/gateway.js';
import {
  cronShapeError,
  createDefaultDraft,
  daylightNotice,
  describeSpec,
  draftErrors,
  draftToSpec,
  formatInZone,
  nextOccurrence,
  resolveLocalDateTime,
} from '../../packages/client/automation/lib/client/schedule.js';

/** 秒到毫秒。 */
const SECOND = 1000;

/** 构造一份表单取值。 */
function draftOf(patch) {
  return { ...createDefaultDraft('Asia/Shanghai', Date.UTC(2026, 10, 1, 12, 0, 0)), ...patch };
}

/** 取某个字段的错误说明。 */
function errorAt(errors, fieldId) {
  return errors.find((error) => error.fieldId === fieldId)?.message;
}

test('条件表单：四种时间方式互斥，只校验选中的一种', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);

  const immediate = draftOf({ mode: 'immediate' });
  assert.deepEqual(draftErrors(immediate, now), []);
  const immediateSpec = draftToSpec(immediate, now);
  assert.equal(immediateSpec.kind, 'once');
  assert.equal(immediateSpec.at, now, '立即方式在保存时刻发生');
  assert.equal(immediateSpec.timeZone, 'Asia/Shanghai');

  const badDelay = draftOf({ mode: 'delay', delayMinutes: '0' });
  assert.match(errorAt(draftErrors(badDelay, now), 'chdsh-automation-delay-minutes'), /不少于 1/);
  const goodDelay = draftOf({ mode: 'delay', delayMinutes: '15' });
  assert.deepEqual(draftErrors(goodDelay, now), []);
  assert.equal(draftToSpec(goodDelay, now).at, now + 15 * 60 * SECOND);

  const pastOnce = draftOf({ mode: 'once', localDateTime: '2026-10-01T09:00' });
  assert.match(errorAt(draftErrors(pastOnce, now), 'chdsh-automation-once-at'), /晚于当前时刻/);

  const shortInterval = draftOf({ mode: 'repeat', repeat: 'interval', intervalSeconds: '30' });
  assert.match(errorAt(draftErrors(shortInterval, now), 'chdsh-automation-interval-seconds'), /不少于 60 秒/);
  const interval = draftOf({ mode: 'repeat', repeat: 'interval', intervalSeconds: '90' });
  assert.deepEqual(draftErrors(interval, now), []);
  assert.deepEqual(draftToSpec(interval, now), { kind: 'interval', everySeconds: 90, timeZone: 'Asia/Shanghai' });

  const emptyWeek = draftOf({ mode: 'repeat', repeat: 'weekly', weekdays: [], clock: '09:30' });
  assert.match(errorAt(draftErrors(emptyWeek, now), 'chdsh-automation-weekday-1'), /至少选择一天/);
  const weekly = draftOf({ mode: 'repeat', repeat: 'weekly', weekdays: [5, 1], clock: '09:30' });
  assert.deepEqual(draftErrors(weekly, now), []);
  assert.deepEqual(draftToSpec(weekly, now).weekdays, [1, 5], '星期按编号排序之后提交');

  // 互斥：固定间隔方式不校验每日与每周的时刻字段。
  const unrelatedClock = draftOf({ mode: 'repeat', repeat: 'interval', intervalSeconds: '60', clock: '99:99' });
  assert.equal(errorAt(draftErrors(unrelatedClock, now), 'chdsh-automation-clock'), undefined);

  // 互斥：选了 cron 时不校验每日时刻，选了每日时不校验 cron 表达式。
  const cronWithBadClock = draftOf({ mode: 'repeat', repeat: 'cron', expression: '0 9 * * *', clock: '99:99' });
  assert.deepEqual(draftErrors(cronWithBadClock, now), []);
  const dailyWithBadCron = draftOf({ mode: 'repeat', repeat: 'daily', clock: '07:05', expression: 'x' });
  assert.deepEqual(draftErrors(dailyWithBadCron, now), []);
  assert.deepEqual(draftToSpec(dailyWithBadCron, now), { kind: 'daily', time: '07:05', timeZone: 'Asia/Shanghai' });

  // cron 只做形状检查，语义由原会话运行时判定。
  assert.match(cronShapeError('0 9 * *'), /需要 5 段/);
  assert.equal(cronShapeError('0 9 * * *'), undefined);
  assert.match(cronShapeError('a b c d e'), /不支持的字符/);
  assert.match(cronShapeError('   '), /请填写 cron 表达式/);

  // 不认识的时区按字段错误处理。
  const badZone = draftOf({ mode: 'immediate', timeZone: 'Mars/Olympus' });
  assert.match(errorAt(draftErrors(badZone, now), 'chdsh-automation-timezone'), /IANA 时区/);
});

test('夏令时：跳过的本地时刻与重复的本地时刻各有结论', () => {
  const zone = 'America/New_York';
  const gap = resolveLocalDateTime(zone, '2026-03-08T02:30');
  assert.equal(gap.kind, 'gap', '2026 年 3 月 8 日 02:30 在纽约不存在');
  const overlap = resolveLocalDateTime(zone, '2026-11-01T01:30');
  assert.equal(overlap.kind, 'overlap', '2026 年 11 月 1 日 01:30 在纽约出现两次');
  assert.equal(formatInZone(zone, overlap.epochMs), '2026年11月1日 01:30');
  assert.equal(overlap.epochMs, Date.UTC(2026, 10, 1, 5, 30, 0), '重复时刻取较早的一次，对应夏令时偏移');

  const now = Date.UTC(2026, 2, 7, 12, 0, 0);
  const gapDraft = draftOf({ mode: 'once', localDateTime: '2026-03-08T02:30', timeZone: zone });
  assert.match(errorAt(draftErrors(gapDraft, now), 'chdsh-automation-once-at'), /夏令时跳过的时段/);
  assert.match(daylightNotice(gapDraft, now), /不存在/);

  const overlapDraft = draftOf({ mode: 'once', localDateTime: '2026-11-01T01:30', timeZone: zone });
  assert.deepEqual(draftErrors(overlapDraft, now), []);
  assert.match(daylightNotice(overlapDraft, now), /只在较早的一次发生/);

  const dailyDraft = draftOf({ mode: 'repeat', repeat: 'daily', clock: '02:30', timeZone: zone });
  assert.match(daylightNotice(dailyDraft, now), /当天的任务会被跳过/);

  // 每日 02:30 在 3 月 8 日被跳过，下一次发生在 3 月 9 日。
  const daily = draftToSpec(dailyDraft, now);
  const next = nextOccurrence(daily, now);
  assert.equal(formatInZone(zone, next), '2026年3月9日 02:30');

  // 每周一 09:00：3 月 7 日是周六，下一次是 3 月 9 日周一，此时已经进入夏令时。
  const weekly = draftToSpec(draftOf({ mode: 'repeat', repeat: 'weekly', weekdays: [1], clock: '09:00', timeZone: zone }), now);
  assert.equal(formatInZone(zone, nextOccurrence(weekly, now)), '2026年3月9日 09:00');

  // cron 的下次发生时间由运行时计算，界面返回空值。
  assert.equal(nextOccurrence(draftToSpec(draftOf({ mode: 'repeat', repeat: 'cron', expression: '0 9 * * *' }), now), now), undefined);
});

test('触发方式的摘要写清时间方式与时区', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  assert.match(describeSpec(draftToSpec(draftOf({ mode: 'repeat', repeat: 'interval', intervalSeconds: '3600' }), now), now), /每 1 小时一次/);
  assert.match(describeSpec(draftToSpec(draftOf({ mode: 'repeat', repeat: 'daily', clock: '08:15' }), now), now), /每日：08:15/);
  assert.match(describeSpec(draftToSpec(draftOf({ mode: 'repeat', repeat: 'weekly', weekdays: [1, 7], clock: '21:00' }), now), now), /每周：周一、周日 21:00/);
  assert.match(describeSpec(draftToSpec(draftOf({ mode: 'repeat', repeat: 'cron', expression: '*/15 * * * *' }), now), now), /cron：\*\/15/);
  assert.match(describeSpec(draftToSpec(draftOf({ mode: 'immediate' }), now), now), /单次（立即）/);
});

test('真实控制平面：列表、启停、webhook 投递与去重、投递记录分页与建立删除', async () => {
  const home = allocateIndependentHome('wp18-automation');
  const secretEnv = 'CHATDSH_WP18_HOOK_SECRET';
  const secret = `wp18-${randomUUID().slice(0, 8)}`;
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const share = new ShareStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const settings = new SettingsStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'all-at-once',
    escalationMs: 1000,
    telemetry: { counter: (name, config) => telemetry.counter(name, config) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const server = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: 'http://127.0.0.1:1',
      databasePath: join(home, 'gateway.sqlite'),
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-wp18',
    },
    store,
    replica,
    share,
    receipts,
    settings,
    push,
    telemetry,
    deviceLink,
  });

  const actions = [];

  try {
    await server.start();
    const origin = server.url();
    const client = createAutomationGateway({
      origin,
      telemetry: { action: (action, outcome) => actions.push({ action, outcome }) },
    });

    // 记录经真实 AutomationStore 写入控制平面的 SQLite。
    const automations = new AutomationStore(store.handle());
    const base = Date.UTC(2026, 10, 1, 12, 0, 0);
    automations.create({
      id: 'auto-github',
      name: 'GitHub 推送',
      trigger: { kind: 'webhook', secretEnv },
      action: { kind: 'start-session', prompt: '处理这次推送' },
      enabled: true,
      createdAt: base,
    });
    automations.create({
      id: 'auto-off',
      name: '已停用的投递',
      trigger: { kind: 'webhook', secretEnv },
      action: { kind: 'start-session', prompt: '不会发生' },
      enabled: false,
      createdAt: base + 1,
    });

    const listed = await client.automations();
    assert.equal(listed.length, 2);
    const github = listed.find((record) => record.id === 'auto-github');
    assert.equal(github.name, 'GitHub 推送');
    assert.deepEqual(github.trigger, { kind: 'webhook', secretEnv });
    assert.equal(github.action.prompt, '处理这次推送');
    assert.equal(github.enabled, true);
    assert.equal(listed.find((record) => record.id === 'auto-off').enabled, false);

    // 启停走真实的 PATCH，数据库随之变化。
    const enabled = await client.setEnabled('auto-off', true);
    assert.equal(enabled.enabled, true);
    assert.equal(automations.get('auto-off').enabled, true);
    const disabled = await client.setEnabled('auto-off', false);
    assert.equal(disabled.enabled, false);
    assert.equal(automations.get('auto-off').enabled, false);

    // 已停用与不存在的记录在启停时明确失败。
    await assert.rejects(client.setEnabled('auto-missing', true), (error) => {
      assert.equal(error.code, 'automation-not-found');
      assert.equal(error.status, 404);
      return true;
    });

    // webhook 投递：真实签名、真实去重、真实拒绝。
    process.env[secretEnv] = secret;
    const body = JSON.stringify({ action: 'opened', issue: 18 });
    const accepted = await fetch(`${origin}/chatdsh/gateway/webhook/auto-github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-webhook-secret': secret },
      body,
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true });
    const duplicate = await fetch(`${origin}/chatdsh/gateway/webhook/auto-github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-webhook-secret': secret },
      body,
    });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), { duplicate: true }, '同一事件重复投递不重复建立会话');
    const events = automations.eventsOf('auto-github');
    assert.equal(events.length, 1, '去重之后数据库里只有一行');
    assert.equal(events[0].source, 'generic');

    const unauthorized = await fetch(`${origin}/chatdsh/gateway/webhook/auto-github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-webhook-secret': 'wrong' },
      body,
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'webhook-unauthorized' });

    const disabledTarget = await fetch(`${origin}/chatdsh/gateway/webhook/auto-off`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-webhook-secret': secret },
      body,
    });
    assert.equal(disabledTarget.status, 404);
    assert.deepEqual(await disabledTarget.json(), { error: 'automation-disabled' });

    delete process.env[secretEnv];
    const missingSecret = await fetch(`${origin}/chatdsh/gateway/webhook/auto-github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-webhook-secret': secret },
      body,
    });
    assert.equal(missingSecret.status, 503);
    assert.deepEqual(await missingSecret.json(), { error: 'webhook-secret-unconfigured' });
    process.env[secretEnv] = secret;

    // 投递记录分页、建立与删除都由控制平面提供：投递可读，执行目标没有登记时建立被明确
    // 拒绝，删除对已有记录立即生效。
    const deliveries = await client.deliveries({ limit: 20 });
    assert.ok(deliveries.deliveries.length >= 1, 'webhook 投递留下可读的投递记录');
    assert.ok(deliveries.deliveries.some((row) => row.automationId === 'auto-github'), '投递记录带自动化标识');
    assert.ok(deliveries.deliveries.every((row) => row.source === 'generic'), '投递来源按请求头判定');
    await assert.rejects(client.create({
      name: '界面新建',
      trigger: { kind: 'webhook', secretEnv },
      prompt: '从界面建立',
      enabled: true,
      target: { deviceId: 'device-unknown' },
    }), (error) => {
      assert.equal(error.code, 'device-unknown');
      return true;
    });
    assert.equal(automations.list().length, 2, '建立失败没有写入记录');
    automations.create({
      id: 'auto-extra',
      name: '待删除的自动化',
      trigger: { kind: 'webhook', secretEnv },
      action: { kind: 'start-session', prompt: '不会发生' },
      enabled: true,
      createdAt: base + 2,
    });
    await client.remove('auto-extra');
    assert.equal(automations.get('auto-extra'), undefined, '删除之后记录立即消失');
    assert.equal(automations.get('auto-github').enabled, true, '删除只影响指定记录');
    assert.equal(automations.list().length, 2);

    // 执行节点与会话都来自真实接口。
    store.registerNode({
      id: 'device-alpha',
      name: '工作站 alpha',
      platform: 'linux',
      role: 'executor',
      capabilities: ['bash'],
      tokenHash: `hash-${randomUUID()}`,
    });
    store.upsertSession({ sessionId: 'session-alpha', deviceId: 'device-alpha', cwd: '/work/alpha', kind: 'work', createdAt: base });
    const devices = await client.devices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, 'device-alpha');
    assert.equal(devices[0].name, '工作站 alpha');
    assert.equal(devices[0].online, false, '没有长连接的设备按离线返回');
    const sessions = await client.sessions();
    const group = sessions.devices.find((device) => device.deviceId === 'device-alpha');
    assert.equal(group.online, false);
    assert.equal(group.sessions.length, 1);
    assert.equal(group.sessions[0].sessionId, 'session-alpha');

    // 原会话定时任务走设备前缀：设备不在线时明确失败，不落到控制平面宿主执行。
    await assert.rejects(client.schedules('device-alpha', 'session-alpha'), (error) => {
      assert.equal(error.code, 'device-offline');
      assert.match(error.message, /目标设备离线/);
      return true;
    });
    await assert.rejects(client.createSchedule({
      deviceId: 'device-alpha',
      sessionId: 'session-alpha',
      name: '每天提醒',
      prompt: '看一次构建结果',
      spec: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
      enabled: true,
    }), (error) => {
      assert.equal(error.code, 'device-offline');
      return true;
    });
    await assert.rejects(client.schedules('device-missing', 'session-alpha'), (error) => {
      assert.equal(error.code, 'device-not-found');
      return true;
    });

    // 控制平面没有第二个定时调度器：创建失败的调度任务不会出现在任何控制平面记录里。
    assert.equal(automations.list().length, 2);
    client.noteAction('automation-reload', 'ok');
    assert.deepEqual(actions.at(-1), { action: 'automation-reload', outcome: 'ok' });
  } finally {
    delete process.env[secretEnv];
    await server.stop();
    store.close();
    releaseIndependentHome(home);
  }
});
