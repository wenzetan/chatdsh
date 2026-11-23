// 保留包的契约回归测试。
//
// 断言插件依赖声明、核心 schema、诊断配置与脱敏、导入种子与分叉计划，以及中继存储的
// 真实 SQLite 行为。所有被测模块都取构建产物，存储使用真实数据库文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = new URL('../..', import.meta.url).pathname;
const REPO = new URL('../../..', import.meta.url).pathname;
ensureDeps(RUNTIME);
ensureDeps(join(REPO, 'dsh-adapter'));

const contracts = await import('../../packages/core/contracts/lib/index.js');
const diagnostics = await import('../../packages/core/diagnostics/lib/index.js');
const config = await import('../../packages/core/diagnostics/lib/config.js');
const traceContext = await import('../../packages/core/diagnostics/lib/trace-context.js');
const { ChatdshTelemetryService } = await import('../../packages/host/telemetry/lib/index.js');
const { ChatdshDeviceLinkService, credentialFor, hasLocalCredential, nodeTokenFrom } = await import('../../packages/host/device-link/lib/index.js');
const { ChatdshPushService, defaultIntentPath } = await import('../../packages/host/push/lib/index.js');
const { ImportService, buildSeed, inject: importInject, planFork } = await import('../../packages/host/import/lib/index.js');
const { ChatdshSettingsSyncService, WHITELIST } = await import('../../packages/host/settings-sync/lib/index.js');
const { GatewayStore, ReplicaStore, SettingsStore, aggregateSessions, readConfig } = await import('../../gateway/lib/index.js');

test('保留的服务把依赖声明在静态字段或插件清单上', () => {
  assert.deepEqual(ChatdshTelemetryService.inject, ['otel', 'webServer', 'settings']);
  assert.ok(ChatdshDeviceLinkService.inject.includes('webServer'));
  assert.ok(ChatdshPushService.inject.includes('sessionPersistence'));
  assert.ok(ChatdshSettingsSyncService.inject.includes('webServer'));
  assert.ok(importInject.includes('sessions'));
  assert.equal(typeof ImportService.Config, 'function');
});

test('核心契约的 schema 接受合法值并拒绝非法值', () => {
  assert.equal(contracts.identifierSchema.parse('session-1'), 'session-1');
  assert.equal(contracts.identifierSchema.safeParse('').success, false);
  assert.equal(contracts.NODE_HEADERS.id, 'x-chatdsh-node-id');
  assert.equal(contracts.CHATDSH_ERROR_CODES.deviceOffline, 'device-offline');

  const applied = contracts.settingsWriteResultSchema.parse({ outcome: 'applied', revision: 2, fields: ['model'] });
  assert.equal(applied.revision, 2);
  assert.equal(contracts.settingsWriteResultSchema.safeParse({ outcome: 'applied', revision: -1, fields: [] }).success, false);
  assert.equal(contracts.settingsWriteResultSchema.safeParse({ outcome: 'conflict' }).success, false);

  const device = {
    id: 'device-a',
    name: '设备甲',
    platform: 'linux',
    role: 'both',
    capabilities: ['shell'],
    createdAt: 1,
    lastSeenAt: 2,
    online: true,
    currentExecutor: false,
  };
  assert.equal(contracts.deviceSchema.parse(device).role, 'both');
  assert.equal(contracts.deviceSchema.safeParse({ ...device, role: 'server' }).success, false);
  assert.equal(contracts.deviceSchema.safeParse({ ...device, capabilities: [''] }).success, false);
});

test('诊断配置按任一来源关闭并保留原因', () => {
  const base = config.defaultTelemetryConfig();
  assert.deepEqual(config.resolveSwitch(base, {}), {
    enabled: true,
    reason: undefined,
    sources: { env: false, upstream: false, settings: false, flag: false, platform: false },
  });
  assert.equal(config.resolveSwitch(base, { CHATDSH_TELEMETRY: 'off' }).reason, 'env');
  assert.equal(config.resolveSwitch(base, { DSH_TELEMETRY_DISABLED: '1' }).reason, 'env');
  assert.equal(config.resolveSwitch({ ...base, enabled: false }, {}).reason, 'settings');
  assert.equal(config.resolveSwitch({ ...base, noTelemetry: true }, {}).reason, 'flag');
  assert.equal(config.resolveSwitch(base, {}, false).reason, 'platform');
});

test('脱敏与链路上下文保持真实格式', () => {
  const redactor = diagnostics.createRedactor();
  const result = redactor.attributes({
    outcome: 'ok',
    'error.code': 'device-offline',
    'message.body': '不应保留',
    'custom.key': 'alice@example.com',
  });
  assert.equal(result.kept.outcome, 'ok');
  assert.equal(result.kept['error.code'], 'device-offline');
  assert.equal(result.kept['message.body'], undefined);
  assert.equal(result.kept['custom.key'], undefined);
  assert.equal(result.dropped, 2);
  assert.match(redactor.message('Bearer abcdefghijklmnop'), /\[redacted-credential\]/);

  const traceId = traceContext.generateTraceId();
  const spanId = traceContext.generateSpanId();
  const header = traceContext.formatTraceparent({ traceId, spanId, traceFlags: '01' });
  assert.deepEqual(traceContext.parseTraceparent(header), { traceId, spanId, traceFlags: '01' });
  assert.equal(traceContext.parseTraceparent('00-00000000000000000000000000000000-0000000000000000-01'), undefined);
});

test('设备链路的令牌与凭据选择按路径生效', () => {
  assert.equal(nodeTokenFrom({ CHATDSH_NODE_TOKEN: '  token-value  ' }), 'token-value');
  assert.equal(nodeTokenFrom({}), '');
  const credential = { origin: 'http://127.0.0.1:3000', page: 'page-cookie', api: 'api-cookie' };
  assert.equal(credentialFor(credential, '/'), 'page-cookie');
  assert.equal(credentialFor(credential, '/index.html?x=1'), 'page-cookie');
  assert.equal(credentialFor(credential, '/api/remote.mux?session=1'), 'api-cookie');
  assert.equal(credentialFor(credential, '/assets/app.js'), undefined);
  assert.equal(hasLocalCredential('dsh-auth-page=page-cookie'), true);
  assert.equal(hasLocalCredential('other=value'), false);
});

test('导入种子与分叉计划拒绝坏形状并保留完整前缀', () => {
  const records = [
    { seq: 0, kind: 'turn/start', time: 10, payload: { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } } },
    { seq: 1, kind: 'turn/end', time: 11, payload: { type: 'turn/end', seq: 1, time: 11, data: { turn: 1, reason: { kind: 'completed' } } } },
  ];
  const seed = buildSeed(records);
  assert.deepEqual(seed.map((event) => event.type), ['turn/start', 'turn/end']);
  assert.throws(() => buildSeed([{ seq: 0, kind: 'turn/start', time: 10, payload: { type: 'turn/start', seq: 1, time: 10 } }]), /序号不一致/);
  assert.throws(() => buildSeed([]), /副本为空/);

  const plan = planFork({
    records,
    sourceSessionId: 'session-source',
    sourceDeviceId: 'device-source',
    turnTo: 1,
    importMode: 'full-prefix',
    availableAttachmentIds: [],
    scheduledTasks: 2,
    now: 100,
  });
  assert.equal(plan.seed.length, 2);
  assert.equal(plan.estimate.eventCount, 2);
  assert.equal(plan.replay.toolCalls, 0);
  assert.equal(plan.replay.retainedScheduledTasks, 2);
  assert.throws(() => planFork({
    records,
    sourceSessionId: 'session-source',
    sourceDeviceId: 'device-source',
    turnTo: 2,
    importMode: 'full-prefix',
    availableAttachmentIds: [],
    scheduledTasks: 0,
  }), /没有第 2 回合/);
});

test('中继存储读写真实 SQLite 并聚合会话列表', () => {
  const home = tempHome('service-contracts');
  const databasePath = join(home, 'gateway.sqlite');
  const store = new GatewayStore(databasePath);
  try {
    const replica = new ReplicaStore(store.handle());
    const settings = new SettingsStore(store.handle());
    store.registerNode({ id: 'node-a', name: '节点甲', platform: 'linux', role: 'host', capabilities: ['shell'], tokenHash: 'hash-a' });
    store.upsertSession({ sessionId: 'session-a', deviceId: 'node-a', cwd: '/workspace/project', kind: 'work', createdAt: 100 });
    store.upsertSession({ sessionId: 'session-b', deviceId: 'node-a', cwd: '/workspace/bare', kind: 'work', createdAt: 101 });
    replica.append('session-a', [
      { seq: 0, kind: 'session/title', time: 200, bytes: 20, payload: { data: { title: '真实标题' } } },
      { seq: 1, kind: 'turn/start', time: 300, bytes: 10, payload: { data: { turn: 1 } } },
    ]);
    replica.append('session-b', [
      { seq: 0, kind: 'session/title', time: 201, bytes: 20, payload: { title: '裸数据标题' } },
    ]);
    assert.equal(replica.watermarkOf('session-a'), 1);
    assert.equal(replica.read('session-a').length, 2);
    assert.equal(replica.append('session-a', [{ seq: 0, kind: 'session/title', time: 200, bytes: 20, payload: { data: { title: '重复' } } }]).written, 0);

    settings.put({ namespace: 'agent-default-model', key: 'model', value: 'model-a' });
    assert.equal(settings.list('agent-default-model')[0].value, 'model-a');
    assert.equal(settings.snapshot()['agent-default-model'].length, 1);

    const snapshot = aggregateSessions({ store, replica, online: (deviceId) => deviceId === 'node-a' });
    assert.equal(snapshot.devices.length, 1);
    assert.equal(snapshot.devices[0].deviceId, 'node-a');
    assert.equal(snapshot.devices[0].online, true);
    assert.equal(snapshot.devices[0].sessions[0].title, '真实标题');
    assert.equal(snapshot.devices[0].sessions[0].workspaceName, 'project');
    assert.equal(snapshot.devices[0].sessions[1].title, '裸数据标题');

    const parsed = readConfig({
      CHATDSH_GATEWAY_PORT: '4567',
      CHATDSH_GATEWAY_DB: databasePath,
      CHATDSH_PUSH_MODE: 'all-at-once',
      CHATDSH_PUSH_ESCALATION_MS: '500',
    });
    assert.equal(parsed.port, 4567);
    assert.equal(parsed.databasePath, databasePath);
    assert.equal(parsed.pushMode, 'all-at-once');
    assert.equal(parsed.pushEscalationMs, 500);
  } finally {
    store.close();
  }
});

test('设置同步白名单与意图库路径跟随数据根', () => {
  assert.deepEqual(WHITELIST, ['agent-default-model', 'client-locale', 'client-ui-chat', 'client-product-analytics', 'agent-preset-registry']);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(RUNTIME, '.run', 'service-contracts-home');
  try {
    assert.equal(defaultIntentPath(), join(RUNTIME, '.run', 'service-contracts-home', 'push', 'replica-intents.sqlite'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
