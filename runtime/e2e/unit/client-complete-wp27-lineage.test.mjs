// WP27 分叉与血缘的验收：完整回合前缀、不重放工具与定时任务的校验记录、完整血缘链。
//
// 分叉走真实副本记录，前缀只到用户选择的完整回合，尾部未结束的回合与活动工具不进种子；压缩
// 复制把工具调用与结果移出种子并重新编号。血缘用真实控制平面数据库：父子关系来自会话归属与
// 副本里的导入声明，继承内容范围按实测的相同前缀算出。导入服务的远程方法用真实遥测客户端接
// 本地 OTLP 接收端断言 span、失败事件与计数。
//
// 运行：node --test e2e/unit/client-complete-wp27-lineage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { GatewayStore, ReplicaStore } = await import('../../gateway/lib/store.js');
const { DataMaintenance } = await import('../../gateway/lib/maintenance/index.js');
const { ImportService, planFork } = await import('../../packages/host/import/lib/index.js');
const { measureStorageUsage } = await import('../../packages/host/usage/lib/index.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

/** 起一个接收 OTLP/HTTP JSON 的本地端点。 */
async function startOtlpReceiver() {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({ path: request.url, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 递归检查一个形状里没有任何内部游标字段。 */
function assertNoCursor(value, where) {
  const blocked = new Set(['seq', 'watermark', 'upToSeq', 'up_to_seq', 'readUpToSeq', 'read_up_to_seq', 'sourceWatermark', 'cursor']);
  const visit = (current, path) => {
    if (current === null || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      assert.equal(blocked.has(key), false, `${where} 暴露了内部字段 ${path}${key}`);
      visit(child, `${path}${key}.`);
    }
  };
  visit(value, '');
}

/** 一条副本记录。 */
function record(seq, kind, data, time) {
  return { seq, kind, time, bytes: Buffer.byteLength(JSON.stringify(data)), payload: { type: kind, seq, time, data } };
}

/** 一段完整回合，从给定序号起连续编号。 */
function turn(base, text, withTool) {
  const out = [];
  const push = (kind, data) => {
    const seq = base + out.length;
    out.push(record(seq, kind, data, 1_700_000_000_000 + seq * 100));
  };
  push('turn/start', { turn: 1 });
  push('user/message', { text });
  if (withTool) {
    push('tool/call', { callId: `call-${String(base)}`, tool: 'shell' });
    push('tool/result', { callId: `call-${String(base)}`, content: '命令输出' });
  } else {
    push('assistant/message', { text: `${text} 的回答` });
  }
  push('turn/end', { turn: 1 });
  return out;
}

/** 源副本：第 1 回合完整且带工具，第 2 回合没有结束。 */
function sourceRecords() {
  const first = turn(0, '第一回合的问题 [附件 att-1 需求.md text/markdown 10 字节]', true);
  const secondStart = first.length;
  return [
    ...first,
    record(secondStart, 'turn/start', { turn: 2 }, 1_700_000_001_000),
    record(secondStart + 1, 'user/message', { text: '第二回合的问题' }, 1_700_000_001_100),
    record(secondStart + 2, 'tool/call', { callId: 'call-active', tool: 'shell' }, 1_700_000_001_150),
  ];
}

test('分叉计划只复制完整回合前缀，并给出不重放的校验记录', () => {
  const records = sourceRecords();
  const plan = planFork({
    records,
    sourceSessionId: 'session-src',
    sourceDeviceId: 'device-1',
    turnTo: 1,
    importMode: 'full-prefix',
    availableAttachmentIds: ['att-1'],
    scheduledTasks: 2,
    now: 1_700_000_500_000,
  });
  assert.equal(plan.seed.length, 5, '只复制第 1 回合的 5 条事件');
  assert.deepEqual(plan.seed.map((event) => event.seq), [0, 1, 2, 3, 4]);
  assert.equal(plan.replay.toolCalls, 0, '不重放工具调用');
  assert.equal(plan.replay.scheduledTasks, 0, '不重放定时任务');
  assert.equal(plan.replay.retainedScheduledTasks, 2, '定时任务留在源会话上');
  assert.equal(plan.replay.unresolvedToolCalls, 0);
  assert.equal(plan.replay.droppedToolCalls, 0);
  assert.equal(plan.estimate.importMode, 'full-prefix');
  assert.equal(plan.estimate.scope.turnFrom, 1);
  assert.equal(plan.estimate.scope.turnTo, 1);
  assert.equal(plan.estimate.scope.eventCount, 5);
  assert.equal(plan.estimate.scope.compressed, false);
  assert.equal(plan.estimate.scope.attachmentsComplete, true);
  assert.ok(plan.estimate.charCount > 0);
  assert.deepEqual(plan.estimate.missingAttachmentIds, []);
  assert.equal(plan.estimate.compressionLoss, false);
  assert.equal(plan.importRecord.kind, 'import');
  assert.equal(plan.importRecord.sourceSessionId, 'session-src');
  assert.equal(plan.importRecord.sourceDeviceId, 'device-1');
  assert.equal(plan.importRecord.mode, 'full-prefix');
  assert.equal(plan.importRecord.lossy, false);
  assert.equal(plan.importRecord.eventCount, 5);
  assert.equal(plan.importRecord.sourceWatermark, 4);
  assert.equal(plan.importRecord.importedAt, 1_700_000_500_000);
  assertNoCursor(plan.estimate, '分叉预估');
  assertNoCursor(plan.replay, '分叉校验记录');

  const missingAttachments = planFork({
    records,
    sourceSessionId: 'session-src',
    sourceDeviceId: 'device-1',
    turnTo: 1,
    importMode: 'full-prefix',
    availableAttachmentIds: [],
    scheduledTasks: 0,
    now: 1_700_000_500_000,
  });
  assert.deepEqual(missingAttachments.estimate.missingAttachmentIds, ['att-1']);
  assert.equal(missingAttachments.estimate.scope.attachmentsComplete, false);

  assert.throws(
    () => planFork({
      records,
      sourceSessionId: 'session-src',
      sourceDeviceId: 'device-1',
      turnTo: 2,
      importMode: 'full-prefix',
      availableAttachmentIds: [],
      scheduledTasks: 0,
    }),
    /没有第 2 回合的结束事件/u,
    '没有结束的回合不能作为分叉边界',
  );

  const compressed = planFork({
    records,
    sourceSessionId: 'session-src',
    sourceDeviceId: 'device-1',
    turnTo: 1,
    importMode: 'compressed',
    availableAttachmentIds: ['att-1'],
    scheduledTasks: 0,
    now: 1_700_000_500_000,
  });
  assert.equal(compressed.seed.length, 3, '压缩复制移出工具调用与结果');
  assert.deepEqual(compressed.seed.map((event) => event.seq), [0, 1, 2], '剩余事件重新编号');
  assert.equal(compressed.seed[2].type, 'turn/end');
  assert.equal(compressed.replay.droppedToolCalls, 1);
  assert.equal(compressed.replay.droppedToolResults, 1);
  assert.equal(compressed.replay.toolCalls, 0);
  assert.equal(compressed.replay.scheduledTasks, 0);
  assert.equal(compressed.importRecord.lossy, true);
  assert.equal(compressed.estimate.scope.compressed, true);
  assert.equal(compressed.estimate.compressionLoss, true);

  const brokenFirstTurn = [
    record(0, 'turn/start', { turn: 1 }, 1_700_000_000_000),
    record(1, 'tool/call', { callId: 'call-open' }, 1_700_000_000_100),
    record(2, 'turn/end', { turn: 1 }, 1_700_000_000_200),
  ];
  assert.throws(
    () => planFork({
      records: brokenFirstTurn,
      sourceSessionId: 'session-broken',
      sourceDeviceId: 'device-1',
      turnTo: 1,
      importMode: 'full-prefix',
      availableAttachmentIds: [],
      scheduledTasks: 0,
    }),
    /没有结果的工具调用/u,
    '完整前缀里仍有活动工具时就地拒绝',
  );

  const discontinuous = [
    record(0, 'turn/start', { turn: 1 }, 1_700_000_000_000),
    record(2, 'turn/end', { turn: 1 }, 1_700_000_000_200),
  ];
  assert.throws(
    () => planFork({
      records: discontinuous,
      sourceSessionId: 'session-gap',
      sourceDeviceId: 'device-1',
      turnTo: 1,
      importMode: 'full-prefix',
      availableAttachmentIds: [],
      scheduledTasks: 0,
    }),
    /不连续/u,
  );
});

test('血缘链按真实父子关系与导入声明给出继承范围', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp27-lineage');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'root');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  const receiver = await startOtlpReceiver();
  let telemetry;
  let store;
  try {
    store = new GatewayStore(join(root, 'gateway', 'gateway.sqlite'));
    const now = Date.now();
    const sessions = [
      { sessionId: 'session-root', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 50 * 86_400_000 },
      { sessionId: 'session-fork', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: now - 40 * 86_400_000, parentSession: 'session-root' },
      { sessionId: 'session-fork-child', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: now - 30 * 86_400_000, parentSession: 'session-fork' },
      { sessionId: 'session-import', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 20 * 86_400_000 },
      { sessionId: 'session-compressed', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: now - 10 * 86_400_000, parentSession: 'session-root' },
      { sessionId: 'cycle-a', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 5 * 86_400_000, parentSession: 'cycle-b' },
      { sessionId: 'cycle-b', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 4 * 86_400_000, parentSession: 'cycle-a' },
    ];
    for (const session of sessions) store.upsertSession(session);
    const replicas = new ReplicaStore(store.handle());
    const rootEvents = turn(0, '根会话的问题', true);
    replicas.append('session-root', rootEvents);
    const forkedEvents = [...rootEvents];
    for (const entry of turn(forkedEvents.length, '分叉后的问题', false)) {
      const seq = forkedEvents.length;
      forkedEvents.push({ seq, kind: entry.kind, time: entry.time, bytes: entry.bytes, payload: { ...entry.payload, seq } });
    }
    replicas.append('session-fork', forkedEvents);
    replicas.append('session-fork-child', forkedEvents.slice(0, 7));
    replicas.append('session-import', [
      ...rootEvents.slice(0, 4),
      {
        seq: 4,
        kind: 'plugin:import',
        time: now - 20 * 86_400_000,
        bytes: 200,
        payload: {
          type: 'plugin:import',
          seq: 4,
          time: now - 20 * 86_400_000,
          data: {
            kind: 'import',
            sourceSessionId: 'session-root',
            sourceDeviceId: 'device-1',
            sourceWatermark: 4,
            mode: 'full-prefix',
            eventCount: 4,
            charCount: 200,
            lossy: false,
            importedAt: now - 20 * 86_400_000,
          },
        },
      },
    ]);
    replicas.append('session-compressed', [
      ...rootEvents.slice(0, 3),
      {
        seq: 3,
        kind: 'plugin:import',
        time: now - 10 * 86_400_000,
        bytes: 200,
        payload: {
          type: 'plugin:import',
          seq: 3,
          time: now - 10 * 86_400_000,
          data: {
            kind: 'import',
            sourceSessionId: 'session-root',
            sourceDeviceId: 'device-1',
            sourceWatermark: 3,
            mode: 'compressed',
            eventCount: 3,
            charCount: 90,
            lossy: true,
            importedAt: now - 10 * 86_400_000,
          },
        },
      },
    ]);

    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: receiver.endpoint,
        surface: 'gateway',
        exportIntervalMs: 2000,
        exportIntervalMsMetrics: 3000,
        exportTimeoutMs: 500,
      }),
      component: '@chatdsh/gateway',
      env: { CHATDSH_TELEMETRY: 'on' },
    });
    const maintenance = new DataMaintenance({ database: store.handle(), measure: measureStorageUsage, telemetry, dataRoot: root });

    const forkNode = await maintenance.lineage.node('session-fork');
    assert.equal(forkNode.parentSession, 'session-root');
    assert.equal(forkNode.deviceId, 'device-2');
    assert.equal(forkNode.cwd, '/work/beta');
    assert.equal(forkNode.inheritedScope.turnFrom, 1);
    assert.equal(forkNode.inheritedScope.eventCount, 5);
    assert.equal(forkNode.inheritedScope.compressed, false);
    assert.ok(forkNode.inheritedScope.charCount > 0);
    assertNoCursor(forkNode, '归属详情');

    const childNode = await maintenance.lineage.node('session-fork-child');
    assert.equal(childNode.parentSession, 'session-fork');
    assert.equal(childNode.inheritedScope.eventCount, 7);
    assertNoCursor(childNode, '归属详情');

    const imported = await maintenance.lineage.node('session-import');
    assert.equal(imported.parentSession, 'session-root', '导入声明补充父会话');
    assert.equal(imported.inheritedScope.eventCount, 4, '继承条数按实测的相同前缀');
    assertNoCursor(imported, '归属详情');

    const compressed = await maintenance.lineage.node('session-compressed');
    assert.equal(compressed.inheritedScope.compressed, true, '压缩导入标记进入继承范围');

    const chain = await maintenance.lineage.chain('session-fork-child');
    assert.equal(chain.rootSessionId, 'session-root');
    assert.equal(chain.depth, 2);
    assert.deepEqual(chain.ancestors.map((node) => node.sessionId), ['session-root', 'session-fork']);
    assert.equal(chain.self.sessionId, 'session-fork-child');
    assert.deepEqual(chain.children, []);
    assertNoCursor(chain, '血缘链');

    const rootChain = await maintenance.lineage.chain('session-root');
    assert.equal(rootChain.depth, 0);
    assert.deepEqual(rootChain.ancestors, []);
    assert.deepEqual(rootChain.children.map((node) => node.sessionId).sort(), ['session-compressed', 'session-fork']);
    assert.deepEqual(
      rootChain.descendants.map((node) => node.sessionId).sort(),
      ['session-compressed', 'session-fork', 'session-fork-child'],
      '后代覆盖整棵子树',
    );
    assertNoCursor(rootChain, '血缘链');

    const missing = await maintenance.lineage.node('session-missing').then(() => undefined, (error) => error);
    assert.equal(missing.code, 'session-not-found');

    const cycle = await maintenance.lineage.chain('cycle-a').then(() => undefined, (error) => error);
    assert.equal(cycle.code, 'internal-error', '血缘链出现环时就地拒绝');

    const context = new Context();
    context.provide('chatdshTelemetry');
    context.set('chatdshTelemetry', telemetry);
    const importer = new ImportService(context, { gatewayUrl: 'http://127.0.0.1:1' });
    assert.equal(typeof importer.fork, 'function');
    assert.equal(typeof importer.forkEstimate, 'function');
    const estimate = await importer.forkEstimate({
      records: sourceRecords(),
      sourceSessionId: 'session-src',
      sourceDeviceId: 'device-1',
      turnTo: 1,
      importMode: 'full-prefix',
      availableAttachmentIds: ['att-1'],
      scheduledTasks: 1,
    });
    assert.equal(estimate.eventCount, 5);
    assertNoCursor(estimate, '分叉预估');
    const failed = await importer.forkEstimate({
      records: sourceRecords(),
      sourceSessionId: 'session-src',
      sourceDeviceId: 'device-1',
      turnTo: 3,
      importMode: 'full-prefix',
      availableAttachmentIds: [],
      scheduledTasks: 0,
    }).then(() => undefined, (error) => error);
    assert.ok(failed instanceof Error);

    await telemetry.flush(5000);
    const all = receiver.records.map((item) => item.body).join('\n');
    assert.ok(all.includes('chatdsh.gateway.data.lineage'), '血缘查询写了 span');
    assert.ok(all.includes('chatdsh.sync.import'), '分叉预估写了导入 span');
    assert.ok(all.includes('chatdsh.import.seed.failed'), '分叉失败写了事件');
    assert.ok(all.includes('chatdsh_import_seed_total'), '分叉计数指标已导出');
    assert.equal(all.includes('根会话的问题'), false, '遥测里没有问题原文');
  } finally {
    if (telemetry !== undefined) await telemetry.shutdown();
    await receiver.close();
    if (store !== undefined) store.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});
