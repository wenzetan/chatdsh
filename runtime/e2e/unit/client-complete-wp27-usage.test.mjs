// WP27 用量统计的验收：真实 SQLite 副本读数、真实文件系统字节与 du 实际占用比对。
//
// 数据根在 runtime/.run 下独立分配，会话日志、附件、记忆组、产物与设置都是真实文件，控制平面
// 用真实 GatewayStore 建库并写入真实副本行。清点结果按来源分类与三个维度给出，逐项与磁盘核对；
// 读取失败走错误分支并带失败路径，遥测用真实客户端接本地 OTLP 接收端断言 span、事件与指标。
//
// 运行：node --test e2e/unit/client-complete-wp27-usage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { GatewayStore, ReplicaStore } = await import('../../gateway/lib/store.js');
const { DataMaintenance } = await import('../../gateway/lib/maintenance/index.js');
const { measureStorageUsage, STORAGE_BUCKETS } = await import('../../packages/host/usage/lib/index.js');
const { MemoryStore } = await import('../../packages/host/memory/lib/store.js');
const { MemoryGroupRegistry } = await import('../../packages/host/memory/lib/groups.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

/** 等待遥测批次到达接收端。 */
function settle(ms = 150) {
  return new Promise((done) => setTimeout(done, ms));
}

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

/** 写一个真实文件并返回字节数。 */
function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return Buffer.byteLength(content);
}

/** 一条副本事件。 */
function event(seq, kind, data, time) {
  return { seq, kind, time, bytes: Buffer.byteLength(JSON.stringify(data)), payload: { type: kind, seq, time, data } };
}

test('用量统计按真实字节给出分类与三个维度，总量与 du 一致', { timeout: 120_000 }, async () => {
  const home = allocateIndependentHome('wp27-usage');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'root');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  const receiver = await startOtlpReceiver();
  let telemetry;
  let store;
  try {
    const sessionA = writeFile(join(root, 'sessions', 'session-a', 'events.jsonl'), '{"a":1}\n'.repeat(12));
    const sessionB = writeFile(join(root, 'sessions', 'session-b', 'events.jsonl'), '{"b":2}\n'.repeat(8));
    const attachmentA = writeFile(join(root, 'attachments', 'att-alpha', '需求.md'), '# 需求\n附件正文\n');
    const attachmentB = writeFile(join(root, 'attachments', 'att-beta', '数据.csv'), 'a,b\n1,2\n');
    const attachmentOrphan = writeFile(join(root, 'attachments', 'att-gamma', '随手记.txt'), '未登记归属的附件\n');
    writeFile(join(root, 'artifacts', 'art-1', 'v1'), '制品内容\n');
    writeFile(join(root, 'storages', 'attachments.json'), '{"unit":"attachments"}\n');
    writeFile(join(root, 'settings.yaml'), 'telemetry:\n  enabled: true\n');

    const memoryStore = new MemoryStore();
    const groups = new MemoryGroupRegistry(memoryStore);
    const group = await groups.save({
      displayName: '甲项目',
      workspaces: [{ deviceId: 'device-1', path: '/work/alpha' }],
    });
    assert.match(group.memoryGroupId, /^mg_/u);

    const databasePath = join(root, 'gateway', 'gateway.sqlite');
    store = new GatewayStore(databasePath);
    store.upsertSession({ sessionId: 'session-a', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: 1_700_000_000_000 });
    store.upsertSession({ sessionId: 'session-b', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: 1_700_000_100_000 });
    store.upsertSession({ sessionId: 'session-c', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: 1_700_000_200_000 });
    const replicas = new ReplicaStore(store.handle());
    replicas.append('session-a', [
      event(0, 'turn/start', { turn: 1 }, 1_700_000_000_000),
      event(1, 'user/message', { text: '第一回合的问题', attachments: ['att-alpha'] }, 1_700_000_000_100),
      event(2, 'turn/end', { turn: 1 }, 1_700_000_000_200),
    ]);
    replicas.append('session-b', [event(0, 'turn/start', { turn: 1 }, 1_700_000_100_000)]);
    replicas.append('session-c', [
      event(0, 'turn/start', { turn: 1 }, 1_700_000_200_000),
      event(1, 'user/message', { text: '另一台设备的问题' }, 1_700_000_200_100),
      event(2, 'turn/end', { turn: 1 }, 1_700_000_200_200),
    ]);
    const replicaRows = store.handle().prepare('select session_id, length(cast(payload as blob)) as bytes from replica_events').all();
    const replicaPayload = replicaRows.reduce((sum, row) => sum + row.bytes, 0);

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
    const report = await maintenance.usage.report({
      root,
      deviceId: 'device-1',
      attachments: [
        { attachmentId: 'att-alpha', sessionId: 'session-a' },
        { attachmentId: 'att-beta', sessionId: 'session-b' },
      ],
    });

    const du = Number(execFileSync('du', ['-sb', root], { encoding: 'utf8' }).split('\t')[0]);
    assert.equal(report.totalBytes, du, `清点总量与 du 一致：${String(report.totalBytes)} / ${String(du)}`);
    const bucketSum = STORAGE_BUCKETS.reduce((sum, bucket) => sum + report.buckets[bucket].bytes, 0);
    assert.equal(bucketSum, report.totalBytes, '五个分类之和等于总量');
    assert.equal(report.buckets.session.bytes, sessionA + sessionB, '会话日志按真实文件字节计');
    assert.equal(report.buckets.attachment.bytes, attachmentA + attachmentB + attachmentOrphan, '附件按真实文件字节计');
    assert.ok(report.buckets.memory.bytes > 0, '记忆组文件计入记忆分类');
    assert.ok(report.buckets.other.bytes > 0, '产物、元数据与设置计入其他分类');
    assert.ok(report.buckets.replica.bytes > 0, '控制平面数据库计入副本分类');
    assert.equal(report.replicaSource, 'measured');
    assert.equal(report.replica.sessions, 3);
    assert.equal(report.replica.payloadBytes, replicaPayload, '副本载荷字节按真实存储长度统计');
    assert.ok(report.replica.tableBytes > 0, '副本表页占用是真实读数');
    assert.ok(report.replica.databaseBytes >= report.buckets.replica.bytes, '数据库文件字节覆盖副本分类');

    const sessionRow = report.rows.find((row) => row.dimension === 'session' && row.key === 'session-a');
    assert.ok(sessionRow !== undefined, '有 session-a 的会话行');
    assert.equal(sessionRow.attachmentBytes, attachmentA, '会话行带上归属到它的附件字节');
    assert.ok(sessionRow.textReplicaBytes > 0);
    assert.equal(sessionRow.retentionDays, 90);
    const sessionBRow = report.rows.find((row) => row.dimension === 'session' && row.key === 'session-b');
    assert.equal(sessionBRow.attachmentBytes, attachmentB);
    const sessionCRow = report.rows.find((row) => row.dimension === 'session' && row.key === 'session-c');
    assert.equal(sessionCRow.attachmentBytes, 0);
    const workspaceRow = report.rows.find((row) => row.dimension === 'workspace' && row.key === 'ws-w1');
    assert.equal(workspaceRow.sessionCount, 2);
    assert.equal(workspaceRow.attachmentBytes, attachmentA + attachmentB);
    assert.equal(workspaceRow.textReplicaBytes, sessionRow.textReplicaBytes + sessionBRow.textReplicaBytes);
    const deviceRow = report.rows.find((row) => row.dimension === 'device' && row.key === 'device-1');
    assert.equal(deviceRow.sessionCount, 2);
    assert.equal(deviceRow.attachmentBytes, attachmentA + attachmentB + attachmentOrphan, '设备行包含未登记归属的附件字节');
    const otherDeviceRow = report.rows.find((row) => row.dimension === 'device' && row.key === 'device-2');
    assert.equal(otherDeviceRow.sessionCount, 1);
    assertNoCursor(report, '用量读数');

    await telemetry.flush(5000);
    const traceBodies = receiver.records.filter((item) => item.path.includes('/v1/traces')).map((item) => item.body).join('\n');
    assert.ok(traceBodies.includes('chatdsh.gateway.data.usage'), '用量统计写了动作 span');
    assert.ok(traceBodies.includes('"outcome"') && traceBodies.includes('ok'), 'span 带结果属性');
    const metricBodies = receiver.records.filter((item) => item.path.includes('/v1/metrics')).map((item) => item.body).join('\n');
    assert.ok(metricBodies.includes('chatdsh_gateway_data_operations_total'), '计数指标已导出');
    const allPayloads = receiver.records.map((item) => item.body).join('\n');
    assert.equal(allPayloads.includes('附件正文'), false, '遥测里没有文件内容');
    assert.equal(allPayloads.includes('第一回合的问题'), false, '遥测里没有问题原文');

    await settle();
    const missing = await maintenance.usage.report({
      root,
      deviceId: 'device-1',
      attachments: [{ attachmentId: 'att-missing', sessionId: 'session-a' }],
    }).then(() => undefined, (error) => error);
    assert.ok(missing !== undefined, '索引里的附件缺失时必须失败');
    assert.equal(missing.code, 'internal-error');
    assert.match(missing.message, /attachments\/att-missing/u);
    await telemetry.flush(5000);
    const rejectBodies = receiver.records.filter((item) => item.path.includes('/v1/logs')).map((item) => item.body).join('\n');
    assert.ok(rejectBodies.includes('chatdsh.gateway.data.rejected'), '失败分支写了拒绝事件');
    assert.ok(rejectBodies.includes('"error.code"') || rejectBodies.includes('error_code'), '拒绝事件带错误码');

    const direct = await measureStorageUsage({
      root,
      deviceId: 'device-1',
      retentionDays: 90,
      sessions: [],
      attachments: [{ attachmentId: 'att-alpha', sessionId: 'session-a' }],
      replicas: [],
    });
    assert.equal(direct.replicaSource, 'absent');
    assert.equal(direct.rows.some((row) => row.dimension === 'device'), true, '没有副本索引也给出设备行');
    await assert.rejects(
      () => measureStorageUsage({
        root,
        deviceId: 'device-1',
        retentionDays: 0,
        sessions: [],
        attachments: [],
        replicas: [],
      }),
      (error) => error.code === 'request-invalid',
      '保留周期越界就地拒绝',
    );

    const notADirectory = writeFile(join(root, 'attachments', 'att-flat'), '这是一个普通文件，占住了应有的目录位置\n');
    assert.ok(notADirectory > 0);
    const wrongType = await measureStorageUsage({
      root,
      deviceId: 'device-1',
      retentionDays: 90,
      sessions: [],
      attachments: [{ attachmentId: 'att-flat', sessionId: 'session-a' }],
      replicas: [],
    }).then(() => undefined, (error) => error);
    assert.equal(wrongType.code, 'internal-error', '附件路径不是目录时按读取失败报告');
    assert.match(wrongType.message, /不是目录/u);
    assert.match(wrongType.path, /attachments\/att-flat$/u, '失败带上具体路径');
    const fileAsRoot = await measureStorageUsage({
      root: join(root, 'settings.yaml'),
      deviceId: 'device-1',
      retentionDays: 90,
      sessions: [],
      attachments: [],
      replicas: [],
    }).then(() => undefined, (error) => error);
    assert.equal(fileAsRoot.code, 'request-invalid', '数据根不是目录时就地拒绝');
  } finally {
    if (telemetry !== undefined) await telemetry.shutdown();
    await receiver.close();
    if (store !== undefined) store.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});
