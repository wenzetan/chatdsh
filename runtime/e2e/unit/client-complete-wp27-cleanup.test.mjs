// WP27 副本清理、保留周期与删除收件箱的验收：真实 SQLite、真实磁盘字节与真实依赖数据。
//
// 控制平面用真实 GatewayStore 建库，副本行、分享记录与会话归属都真实写入；设备权威日志与工作区
// 文件是数据根外的真实文件，清理与永久删除之后必须原样存在。清理的实际释放量取数据库文件在
// 清理前后的真实字节差，并与磁盘核对。失败分支走真实错误（写只读库、依赖未确认、预估已消费），
// 遥测用真实客户端接本地 OTLP 接收端断言 span、拒绝事件与计数、释放字节分布。
//
// 运行：node --test e2e/unit/client-complete-wp27-cleanup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { GatewayStore, ReplicaStore, ShareStore } = await import('../../gateway/lib/store.js');
const { DataMaintenance, ActiveRunRegistry, memoryGroupReferencesOf } = await import('../../gateway/lib/maintenance/index.js');
const { measureStorageUsage } = await import('../../packages/host/usage/lib/index.js');
const { MemoryStore } = await import('../../packages/host/memory/lib/store.js');
const { MemoryGroupRegistry } = await import('../../packages/host/memory/lib/groups.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

const DAY = 86_400_000;

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

/** 造一批副本事件。 */
function eventsOf(count, time, text) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const data = { text: `${text}-${String(index)}` };
    out.push({
      seq: index,
      kind: index % 2 === 0 ? 'user/message' : 'assistant/message',
      time: time + index,
      bytes: Buffer.byteLength(JSON.stringify(data)),
      payload: { type: index % 2 === 0 ? 'user/message' : 'assistant/message', seq: index, time: time + index, data },
    });
  }
  return out;
}

test('保留周期、副本清理与删除收件箱都按真实状态工作', { timeout: 180_000 }, async () => {
  const home = allocateIndependentHome('wp27-cleanup');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'root');
  const workspace = join(home, 'workspace', 'alpha');
  mkdirSync(root, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.DSH_HOME = root;
  const workspaceFile = join(workspace, 'notes.md');
  writeFileSync(workspaceFile, '# 工作区笔记\n这些文件不属于副本。\n');
  const oldLog = writeFile(join(root, 'sessions', 'session-old', 'events.jsonl'), '{"old":true}\n'.repeat(20));
  writeFile(join(root, 'sessions', 'session-shared', 'events.jsonl'), '{"shared":true}\n'.repeat(10));
  writeFile(join(root, 'sessions', 'session-share2', 'events.jsonl'), '{"share2":true}\n'.repeat(8));
  writeFile(join(root, 'sessions', 'session-restore', 'events.jsonl'), '{"restore":true}\n'.repeat(6));
  writeFile(join(root, 'sessions', 'session-mem', 'events.jsonl'), '{"mem":true}\n'.repeat(6));
  writeFile(join(root, 'sessions', 'session-running', 'events.jsonl'), '{"running":true}\n'.repeat(6));

  const receiver = await startOtlpReceiver();
  let telemetry;
  let store;
  let readOnly;
  try {
    const now = Date.now();
    const databasePath = join(root, 'gateway', 'gateway.sqlite');
    store = new GatewayStore(databasePath);
    const sessions = [
      { sessionId: 'session-old', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 400 * DAY },
      { sessionId: 'session-shared', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 400 * DAY },
      { sessionId: 'session-new', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 2 * DAY },
      { sessionId: 'session-restore', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 60 * DAY },
      { sessionId: 'session-mem', workspaceId: 'ws-w2', deviceId: 'device-1', cwd: '/work/memory', kind: 'work', createdAt: now - 60 * DAY },
      { sessionId: 'session-running', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 60 * DAY },
      { sessionId: 'session-inbox', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 300 * DAY },
      { sessionId: 'session-share2', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 60 * DAY },
      { sessionId: 'session-child', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: workspace, kind: 'work', createdAt: now - 1 * DAY, parentSession: 'session-old' },
    ];
    for (const session of sessions) store.upsertSession(session);
    store.handle().prepare('update sessions set deleted_at = ? where session_id = ?').run(now - 5 * DAY, 'session-inbox');

    const replicas = new ReplicaStore(store.handle());
    replicas.append('session-old', eventsOf(600, now - 200 * DAY, 'old-event'));
    replicas.append('session-shared', eventsOf(20, now - 200 * DAY, 'shared-event'));
    replicas.append('session-new', eventsOf(5, now - 2 * DAY, 'new-event'));
    replicas.append('session-restore', eventsOf(6, now - 60 * DAY, 'restore-event'));
    replicas.append('session-mem', eventsOf(6, now - 60 * DAY, 'mem-event'));
    replicas.append('session-running', eventsOf(6, now - 60 * DAY, 'running-event'));
    replicas.append('session-inbox', eventsOf(4, now - 300 * DAY, 'inbox--event'));
    replicas.append('session-share2', eventsOf(10, now - 2 * DAY, 'share2-event'));
    const shares = new ShareStore(store.handle());
    const share = shares.create({ sessionId: 'session-shared' }, 20);
    const share2 = shares.create({ sessionId: 'session-share2' }, 10);

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
    const activeRuns = new ActiveRunRegistry();
    const maintenance = new DataMaintenance({ database: store.handle(), measure: measureStorageUsage, telemetry, dataRoot: root, activeRuns });

    const defaultPolicy = await maintenance.retention.read();
    assert.deepEqual(defaultPolicy, { days: 90, defaulted: true });
    await assert.rejects(() => maintenance.retention.write(0), (error) => error.code === 'replica-retention-invalid');
    await assert.rejects(() => maintenance.retention.write(3651), (error) => error.code === 'replica-retention-invalid');

    const candidates = await maintenance.retention.candidates({ now });
    assert.deepEqual(candidates.map((item) => item.sessionId).sort(), ['session-old', 'session-shared'], '只把到期且未软删除的会话列为候选');
    const oldCandidate = candidates.find((item) => item.sessionId === 'session-old');
    const sharedCandidate = candidates.find((item) => item.sessionId === 'session-shared');
    assert.equal(oldCandidate.dependentShares, 0);
    assert.equal(oldCandidate.activeImports, 1, '从 session-old 导入的子会话计入活动导入');
    assert.equal(sharedCandidate.dependentShares, 1, 'session-shared 的有效分享计入依赖');
    assert.ok(oldCandidate.expiresAt < now);

    const written = await maintenance.retention.write(30);
    assert.equal(written.days, 30);
    assert.equal(written.defaulted, false);
    assert.equal((await maintenance.retention.read()).days, 30);
    const narrow = await maintenance.retention.candidates({ now });
    assert.equal(narrow.length, 5, '30 天保留期把 60 天前的会话也列为到期对象');
    await maintenance.retention.write(90);
    assert.equal((await maintenance.retention.read()).days, 90);

    const estimate = await maintenance.cleanup.estimate({ now });
    assert.equal(estimate.objectCount, 2);
    assert.equal(estimate.reclaimableBytes, candidates.reduce((sum, item) => sum + item.replicaBytes, 0));
    assert.equal(estimate.dependentShares, 1);
    assert.equal(estimate.activeImports, 1);
    assert.equal(estimate.retentionDays, 90);
    assert.equal(estimate.candidates.length, 2);
    assertNoCursor(estimate, '清理预估');

    const byWorkspace = await maintenance.cleanup.estimate({ workspaceId: 'ws-w1', now });
    assert.deepEqual(byWorkspace.candidates.map((item) => item.sessionId).sort(), ['session-old', 'session-shared'], '按工作区过滤到期对象');
    const otherDevice = await maintenance.cleanup.estimate({ deviceId: 'device-2', now });
    assert.equal(otherDevice.objectCount, 0, '按设备过滤没有到期对象');
    const onlyOne = await maintenance.cleanup.estimate({ sessionIds: ['session-old'], now });
    assert.deepEqual(onlyOne.candidates.map((item) => item.sessionId), ['session-old']);
    assert.equal(onlyOne.activeImports, 1);

    const blocked = await maintenance.cleanup.execute({ estimateId: estimate.estimateId }).then(() => undefined, (error) => error);
    assert.equal(blocked.code, 'object-in-use', '依赖未确认时拒绝执行');
    const stillThere = store.handle().prepare("select count(*) as total from replica_events where session_id = 'session-old'").get();
    assert.ok(stillThere.total > 0, '拒绝执行时副本没有被删');

    const fileBefore = statSync(databasePath).size;
    const result = await maintenance.cleanup.execute({ estimateId: estimate.estimateId, confirmDependencies: true });
    const fileAfter = statSync(databasePath).size;
    assert.equal(result.authoritativeLogsPreserved, true);
    assert.equal(result.estimatedBytes, estimate.reclaimableBytes);
    assert.ok(result.reclaimedBytes > 0, '实际释放量是真实磁盘减少量');
    assert.equal(result.reclaimedBytes, fileBefore - fileAfter, '释放量与数据库文件真实减少一致');
    assert.equal(result.removedSessions, 2);
    assert.ok(result.removedEvents > 0);
    assert.equal(result.dependencies.shares, 1);
    assert.equal(result.dependencies.imports, 1);
    assertNoCursor(result, '清理结果');
    assert.equal(store.handle().prepare("select count(*) as total from replica_events where session_id in ('session-old','session-shared')").get().total, 0);
    assert.equal(store.handle().prepare("select count(*) as total from replica_events where session_id = 'session-new'").get().total, 5, '未到期的副本保留');
    assert.ok(shares.get(share.token) !== undefined, '清理保留分享记录');
    assert.equal(existsSync(join(root, 'sessions', 'session-old', 'events.jsonl')), true, '设备权威日志保留');
    assert.equal(existsSync(workspaceFile), true, '工作区文件保留');
    assert.equal(statSync(join(root, 'sessions', 'session-old', 'events.jsonl')).size, oldLog);

    await assert.rejects(
      () => maintenance.cleanup.execute({ estimateId: estimate.estimateId, confirmDependencies: true }),
      (error) => error.code === 'object-not-found',
      '同一个预估不能执行两次',
    );

    const softDeleted = await maintenance.deletion.softDelete('session-restore', now);
    assert.equal(softDeleted.sessionId, 'session-restore');
    assert.equal(softDeleted.restorable, true);
    assert.equal(softDeleted.remainingDays, 90);
    assert.ok(softDeleted.bytes > 0);
    assertNoCursor(softDeleted, '删除收件箱条目');
    const inbox = await maintenance.deletion.inbox(now);
    assert.deepEqual(inbox.map((item) => item.sessionId).sort(), ['session-inbox', 'session-restore']);
    assertNoCursor(inbox, '删除收件箱');

    const operationId = 'wp27-operation-restore-0001';
    const digest = 'a'.repeat(64);
    const restored = await maintenance.deletion.restore({ sessionId: 'session-restore', operationId, requestDigest: digest });
    assert.equal(restored.outcome, 'restored');
    assert.equal(restored.scope.eventCount, 6);
    assert.equal(restored.scope.compressed, false);
    assertNoCursor(restored, '恢复结果');
    const again = await maintenance.deletion.restore({ sessionId: 'session-restore', operationId, requestDigest: digest });
    assert.deepEqual(again, { outcome: 'rejected', code: 'already-handled' });

    await maintenance.retention.write(30);
    await maintenance.deletion.softDelete('session-restore', now - 31 * DAY);
    const expired = await maintenance.deletion.restore({ sessionId: 'session-restore', operationId, requestDigest: digest });
    assert.deepEqual(expired, { outcome: 'rejected', code: 'restore-expired' });
    const expiredItem = (await maintenance.deletion.inbox(now)).find((item) => item.sessionId === 'session-restore');
    assert.equal(expiredItem.restorable, false);
    assert.equal(expiredItem.remainingDays, 0);

    const scope = await maintenance.deletion.permanentScope('session-share2');
    assert.deepEqual(scope.objects, ['replica', 'share']);
    assert.equal(scope.dependentShares, 1);
    assert.ok(scope.bytes > 0);
    assert.equal(scope.requiresConfirm, true);
    assertNoCursor(scope, '永久删除范围');
    const needsDependencyConfirm = await maintenance.deletion.permanentDelete({ sessionId: 'session-share2', confirm: true }).then(() => undefined, (error) => error);
    assert.equal(needsDependencyConfirm.code, 'object-in-use');
    const needsConfirm = await maintenance.deletion.permanentDelete({ sessionId: 'session-share2', confirm: false }).then(() => undefined, (error) => error);
    assert.equal(needsConfirm.code, 'request-invalid');
    const permanent = await maintenance.deletion.permanentDelete({ sessionId: 'session-share2', confirm: true, confirmDependencies: true });
    assert.equal(permanent.authoritativeLogsPreserved, true);
    assert.equal(permanent.dependencies.shares, 1);
    assert.ok(permanent.removedEvents > 0);
    assert.ok(permanent.removedShares >= 1);
    assert.ok(permanent.releasedBytes > 0);
    assertNoCursor(permanent, '永久删除结果');
    assert.equal(store.getSession('session-share2'), undefined, '永久删除移除归属记录');
    assert.equal(shares.get(share2.token), undefined, '永久删除移除分享记录');
    assert.equal(existsSync(join(root, 'sessions', 'session-share2', 'events.jsonl')), true, '设备权威日志保留');
    assert.equal(existsSync(workspaceFile), true, '工作区文件保留');

    const groups = new MemoryGroupRegistry(new MemoryStore());
    await groups.save({ displayName: '记忆项目', workspaces: [{ deviceId: 'device-1', path: '/work/memory' }] });
    assert.equal(memoryGroupReferencesOf(root, 'device-1', '/work/memory').length, 1);
    const memBlocked = await maintenance.deletion.permanentDelete({ sessionId: 'session-mem', confirm: true }).then(() => undefined, (error) => error);
    assert.equal(memBlocked.code, 'object-in-use', '记忆组引用需要逐项确认');
    const memDeleted = await maintenance.deletion.permanentDelete({ sessionId: 'session-mem', confirm: true, confirmDependencies: true });
    assert.equal(memDeleted.dependencies.memoryGroups, 1);

    activeRuns.begin('session-running');
    const runningBlocked = await maintenance.deletion.permanentDelete({ sessionId: 'session-running', confirm: true, confirmDependencies: true }).then(() => undefined, (error) => error);
    assert.equal(runningBlocked.code, 'object-in-use', '进行中的运行直接拒绝');
    activeRuns.end('session-running');

    readOnly = new DatabaseSync(databasePath, { readOnly: true });
    const readOnlyMaintenance = new DataMaintenance({ database: readOnly, measure: measureStorageUsage, telemetry, dataRoot: root, activeRuns });
    const readOnlyEstimate = await readOnlyMaintenance.cleanup.estimate({ retentionDays: 1, now: now + 400 * DAY, sessionIds: ['session-new'] });
    const failed = await readOnlyMaintenance.cleanup.execute({ estimateId: readOnlyEstimate.estimateId }).then(() => undefined, (error) => error);
    assert.equal(failed.code, 'internal-error', '写库失败按内部错误报告');
    assert.match(failed.message, /readonly|read-only/u);
    const afterFailure = store.handle().prepare("select count(*) as total from replica_events where session_id = 'session-new'").get();
    assert.equal(afterFailure.total, 5, '执行失败时没有假装成功');

    await telemetry.flush(5000);
    const all = receiver.records.map((item) => item.body).join('\n');
    assert.ok(all.includes('chatdsh.gateway.data.retention'), '保留策略写了 span');
    assert.ok(all.includes('chatdsh.gateway.data.cleanup'), '清理写了 span');
    assert.ok(all.includes('chatdsh.gateway.data.deletion'), '删除写了 span');
    assert.ok(all.includes('chatdsh.gateway.data.rejected'), '失败分支写了拒绝事件');
    assert.ok(all.includes('object-in-use'), '拒绝事件带依赖错误码');
    assert.ok(all.includes('chatdsh_gateway_data_operations_total'), '动作计数指标已导出');
    assert.ok(all.includes('chatdsh_gateway_data_reclaimed_bytes'), '实际释放字节分布已导出');
    assert.equal(all.includes('工作区笔记'), false, '遥测里没有工作区文件内容');
    assert.equal(all.includes('old-event-0'), false, '遥测里没有副本正文');
  } finally {
    if (readOnly !== undefined) readOnly.close();
    if (telemetry !== undefined) await telemetry.shutdown();
    await receiver.close();
    if (store !== undefined) store.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});
