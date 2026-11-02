// WP28 数据管理界面的形状、导出与数据入口验收：真实 HTTP 端点、真实 schema 校验。
//
// 界面消费的对外形状逐项校验：分类字节之和、附件完整性与缺失附件、不重放计数、内部游标字段。
// 导出文件按字段清单构造，额外字段不会顺带写出。数据入口用真实 HTTP 服务端核对请求路径、同源
// 标识、`traceparent` 传播与错误码映射；界面遥测走真实同源中继端点。
//
// 运行：node --test e2e/unit/client-complete-wp28-unit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const PACKAGE = join(RUNTIME, 'packages/client/data-management');
ensureDeps(RUNTIME);

/**
 * 编译新包，多个测试文件同时运行时用目录锁串行。
 * @param {string} projectDir - 工程目录。
 * @param {string} artifact - 就绪判定用的产物路径。
 * @param {string} lockName - 锁目录名。
 */
function ensureBuild(projectDir, artifact, lockName) {
  if (existsSync(artifact)) return;
  const lock = join(RUNTIME, '.verify', `${lockName}.lock`);
  mkdirSync(join(RUNTIME, '.verify'), { recursive: true });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (existsSync(artifact)) return;
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 300_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('等待构建锁超时');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  try {
    execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', projectDir], { cwd: RUNTIME, stdio: 'inherit' });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

ensureBuild(PACKAGE, join(PACKAGE, 'lib/client/index.js'), 'wp28-data-management-build');

const {
  parseCleanupEstimate,
  parseCleanupOutcome,
  parseDeletionInbox,
  parseForkEstimate,
  parseForkOutcome,
  parseLineageChain,
  parsePermanentOutcome,
  parsePermanentScope,
  parseReplicaState,
  parseRestoreResult,
  parseRetentionPolicy,
  parseUsageReport,
} = await import('../../packages/client/data-management/lib/client/schemas.js');
const { buildExportDocument, exportText } = await import('../../packages/client/data-management/lib/client/export.js');
const { formatBytes, formatShare, formatTimestamp, scopeText, turnsOf } = await import(
  '../../packages/client/data-management/lib/client/format.js'
);
const { callFace, createHttpDataManagementFace, USAGE_PATH } = await import(
  '../../packages/client/data-management/lib/client/face.js'
);
const { createDataManagementTelemetry } = await import('../../packages/client/data-management/lib/client/telemetry.js');

/** 递归收集一个形状里的键。 */
function keysOf(value, into = []) {
  if (value === null || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
    return into;
  }
  for (const [key, child] of Object.entries(value)) {
    into.push(key);
    keysOf(child, into);
  }
  return into;
}

const SCOPE = {
  turnFrom: 1,
  turnTo: 2,
  eventCount: 8,
  charCount: 640,
  compressed: false,
  attachmentsComplete: true,
};

const USAGE = {
  measuredAt: 1_700_000_000_000,
  root: '/srv/chatdsh-home',
  deviceId: 'device-1',
  retentionDays: 90,
  totalBytes: 4096,
  fileCount: 12,
  buckets: {
    session: { bytes: 1024, files: 3 },
    replica: { bytes: 2048, files: 2 },
    attachment: { bytes: 512, files: 1 },
    memory: { bytes: 256, files: 1 },
    other: { bytes: 256, files: 5 },
  },
  rows: [
    {
      dimension: 'device',
      key: 'device-1',
      sessionCount: 2,
      textReplicaBytes: 2048,
      attachmentBytes: 512,
      lastActiveAt: 1_700_000_000_000,
      retentionDays: 90,
    },
    {
      dimension: 'workspace',
      key: 'ws-w1',
      sessionCount: 2,
      textReplicaBytes: 2048,
      attachmentBytes: 512,
      lastActiveAt: 1_700_000_000_000,
      retentionDays: 90,
    },
    {
      dimension: 'session',
      key: 'session-alpha',
      sessionCount: 1,
      textReplicaBytes: 1024,
      attachmentBytes: 512,
      lastActiveAt: 1_700_000_000_000,
      retentionDays: 90,
    },
  ],
  replicaSource: 'measured',
  replica: { sessions: 2, payloadBytes: 2048, tableBytes: 1024, databaseBytes: 8192 },
};

const CANDIDATE = {
  sessionId: 'session-alpha',
  deviceId: 'device-1',
  workspaceId: 'ws-w1',
  replicaBytes: 2048,
  eventCount: 8,
  lastEventAt: 1_600_000_000_000,
  expiresAt: 1_607_776_000_000,
  dependentShares: 1,
  activeImports: 1,
};

const ESTIMATE = {
  estimateId: 'estimate-wp28',
  objectCount: 1,
  reclaimableBytes: 2048,
  retentionDays: 30,
  estimatedAt: 1_700_000_000_000,
  dependentShares: 1,
  activeImports: 1,
  candidates: [CANDIDATE],
};

const LINEAGE_NODE = {
  sessionId: 'session-fork',
  deviceId: 'device-2',
  cwd: '/work/beta',
  kind: 'work',
  createdAt: 1_700_000_100_000,
  parentSession: 'session-root',
  inheritedScope: SCOPE,
};

const CHAIN = {
  sessionId: 'session-fork-child',
  rootSessionId: 'session-root',
  depth: 2,
  ancestors: [
    { sessionId: 'session-root', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: 1_700_000_000_000 },
    LINEAGE_NODE,
  ],
  self: {
    sessionId: 'session-fork-child',
    deviceId: 'device-2',
    cwd: '/work/beta',
    kind: 'work',
    createdAt: 1_700_000_200_000,
    parentSession: 'session-fork',
    inheritedScope: { ...SCOPE, eventCount: 8, charCount: 700 },
  },
  children: [],
  descendants: [],
};

const FORK_ESTIMATE = {
  importMode: 'full-prefix',
  scope: SCOPE,
  eventCount: 8,
  charCount: 640,
  missingAttachmentIds: [],
  compressionLoss: false,
};

const REPLAY = {
  replayedToolCalls: 0,
  replayedScheduledTasks: 0,
  retainedScheduledTasks: 2,
  droppedToolCalls: 0,
  droppedToolResults: 0,
  unresolvedToolCalls: 0,
};

const FORK_OUTCOME = {
  sessionId: 'session-forked',
  parentSession: 'session-root',
  cwd: '/work/alpha',
  createdAt: 1_700_000_300_000,
  estimate: FORK_ESTIMATE,
  replay: REPLAY,
};

const INBOX_ITEM = {
  sessionId: 'session-inbox',
  title: '已删除的排障记录',
  originDeviceId: 'device-1',
  deletedAt: 1_700_000_000_000,
  retentionExpiresAt: 1_707_776_000_000,
  remainingDays: 90,
  bytes: 2048,
  restorable: true,
  hasShareDependency: true,
};

const PERMANENT_SCOPE = {
  sessionId: 'session-inbox',
  objects: ['replica', 'share'],
  dependentShares: 1,
  bytes: 2048,
  requiresConfirm: true,
  dependencies: [
    { kind: 'share', label: '分享链接', createdAt: 1_700_000_000_000, expiresAt: 1_707_776_000_000, visits: 3 },
    { kind: 'memory-group', label: '记忆项目' },
  ],
};

/** 取一次的拒绝码。 */
function rejectionCode(run) {
  try {
    run();
  } catch (error) {
    return error.code;
  }
  return undefined;
}

test('用量读数拒绝内部游标与不一致的分类之和', () => {
  const usage = parseUsageReport(USAGE);
  assert.equal(usage.totalBytes, 4096);
  assert.equal(usage.buckets.attachment.bytes, 512);

  const withCursor = {
    ...USAGE,
    rows: [{ ...USAGE.rows[0], seq: 4 }],
  };
  assert.equal(rejectionCode(() => parseUsageReport(withCursor)), 'dto/internal-cursor', '带副本序号的应答必须拒绝');

  const sumMismatch = { ...USAGE, totalBytes: 9999 };
  assert.equal(rejectionCode(() => parseUsageReport(sumMismatch)), 'gateway/invalid-response', '分类之和与总量不一致时拒绝');

  const negative = { ...USAGE, buckets: { ...USAGE.buckets, memory: { bytes: -1, files: 1 } } };
  assert.equal(rejectionCode(() => parseUsageReport(negative)), 'gateway/invalid-response');

  const watermark = { ...USAGE, replica: { ...USAGE.replica, watermark: 12 } };
  assert.equal(rejectionCode(() => parseUsageReport(watermark)), 'dto/internal-cursor');
});

test('保留策略与清理视图按契约校验', () => {
  assert.equal(parseRetentionPolicy({ days: 90, defaulted: true }).days, 90);
  assert.equal(rejectionCode(() => parseRetentionPolicy({ days: 0, defaulted: false })), 'gateway/invalid-response');
  assert.equal(rejectionCode(() => parseRetentionPolicy({ days: 3651, defaulted: false })), 'gateway/invalid-response');

  const estimate = parseCleanupEstimate(ESTIMATE);
  assert.equal(estimate.retentionDays, 30);
  assert.equal(estimate.candidates[0].dependentShares, 1);
  assert.equal(rejectionCode(() => parseCleanupEstimate({
    ...ESTIMATE,
    candidates: [{ ...CANDIDATE, replicaBytes: -5 }],
  })), 'gateway/invalid-response');

  const outcome = parseCleanupOutcome({
    cleanupId: 'cleanup-1',
    estimatedBytes: 2048,
    reclaimedBytes: 1900,
    finishedAt: 1_700_000_400_000,
    authoritativeLogsPreserved: true,
    removedSessions: 1,
    removedEvents: 8,
    dependencies: { shares: 1, imports: 1 },
  });
  assert.equal(outcome.reclaimedBytes, 1900);
  assert.equal(rejectionCode(() => parseCleanupOutcome({
    cleanupId: 'cleanup-1',
    estimatedBytes: 2048,
    reclaimedBytes: 1900,
    finishedAt: 1_700_000_400_000,
    authoritativeLogsPreserved: false,
    removedSessions: 1,
    removedEvents: 8,
    dependencies: { shares: 1, imports: 1 },
  })), 'gateway/invalid-response', '权威日志未保留时必须拒绝');
});

test('血缘链与只读副本带真实范围且不含内部游标', () => {
  const chain = parseLineageChain(CHAIN);
  assert.equal(chain.depth, 2);
  assert.equal(chain.ancestors.length, 2);
  assert.equal(chain.self.inheritedScope.eventCount, 8);

  const withCursor = { ...CHAIN, self: { ...CHAIN.self, lastSeq: 9 } };
  assert.equal(rejectionCode(() => parseLineageChain(withCursor)), 'dto/internal-cursor');

  const replica = parseReplicaState({
    sessionId: 'session-alpha',
    replica: { state: 'partial', scope: { ...SCOPE, attachmentsComplete: false }, readAt: 1_700_000_000_000 },
    source: 'replica',
    readOnlyReason: 'replica-only',
    retentionDays: 90,
    missingAttachments: 1,
  });
  assert.equal(replica.replica.state, 'partial');
  assert.equal(rejectionCode(() => parseReplicaState({
    sessionId: 'session-alpha',
    replica: { state: 'missing', scope: SCOPE, readAt: 1_700_000_000_000 },
    source: 'replica',
    retentionDays: 90,
    missingAttachments: 0,
  })), 'gateway/invalid-response', '副本缺失时不得携带内容范围');
});

test('分叉预估交叉核对附件与不重放计数', () => {
  const estimate = parseForkEstimate(FORK_ESTIMATE);
  assert.equal(estimate.eventCount, 8);
  assert.equal(rejectionCode(() => parseForkEstimate({
    ...FORK_ESTIMATE,
    missingAttachmentIds: ['att-missing'],
  })), 'gateway/invalid-response', '附件完整标记与缺失附件不一致时拒绝');

  const outcome = parseForkOutcome(FORK_OUTCOME);
  assert.equal(outcome.replay.replayedToolCalls, 0);
  assert.equal(outcome.replay.retainedScheduledTasks, 2);
  assert.equal(rejectionCode(() => parseForkOutcome({
    ...FORK_OUTCOME,
    replay: { ...REPLAY, replayedToolCalls: 1 },
  })), 'gateway/invalid-response', '重放工具调用不为零时拒绝');
});

test('删除收件箱、恢复结果与永久删除视图', () => {
  const items = parseDeletionInbox([INBOX_ITEM]);
  assert.equal(items[0].remainingDays, 90);
  const rejected = parseRestoreResult({ outcome: 'rejected', code: 'restore-expired' });
  assert.equal(rejected.code, 'restore-expired');
  const restored = parseRestoreResult({
    outcome: 'restored',
    sessionId: 'session-inbox',
    restoredAt: 1_700_000_500_000,
    scope: SCOPE,
  });
  assert.equal(restored.outcome, 'restored');

  const scope = parsePermanentScope(PERMANENT_SCOPE);
  assert.equal(scope.dependencies.length, 2);
  assert.equal(scope.dependencies[0].kind, 'share');

  const outcome = parsePermanentOutcome({
    sessionId: 'session-inbox',
    deletedAt: 1_700_000_600_000,
    removedEvents: 8,
    removedShares: 1,
    removedReceipts: 2,
    releasedBytes: 1900,
    dependencies: { shares: 1, memoryGroups: 1 },
    authoritativeLogsPreserved: true,
  });
  assert.equal(outcome.releasedBytes, 1900);
  assert.equal(rejectionCode(() => parsePermanentScope({
    ...PERMANENT_SCOPE,
    sessionId: 'session-inbox',
    objects: [],
  })), 'gateway/invalid-response');
});

test('导出文件只含字段清单，没有内部游标', () => {
  const input = {
    exportedAt: 1_700_000_700_000,
    retention: { days: 30, updatedAt: 1_700_000_000_000, defaulted: false },
    usage: { ...parseUsageReport(USAGE), internalLocation: 7 },
    cleanupEstimate: parseCleanupEstimate(ESTIMATE),
    cleanupOutcome: parseCleanupOutcome({
      cleanupId: 'cleanup-1',
      estimatedBytes: 2048,
      reclaimedBytes: 1900,
      finishedAt: 1_700_000_400_000,
      authoritativeLogsPreserved: true,
      removedSessions: 1,
      removedEvents: 8,
      dependencies: { shares: 1, imports: 1 },
    }),
    replica: parseReplicaState({
      sessionId: 'session-alpha',
      replica: { state: 'complete', scope: SCOPE, readAt: 1_700_000_000_000 },
      source: 'replica',
      readOnlyReason: 'replica-only',
      retentionDays: 90,
      missingAttachments: 0,
    }),
    lineage: parseLineageChain(CHAIN),
    forkEstimate: parseForkEstimate(FORK_ESTIMATE),
    forkOutcome: parseForkOutcome(FORK_OUTCOME),
    inbox: parseDeletionInbox([INBOX_ITEM]),
    permanentScope: parsePermanentScope(PERMANENT_SCOPE),
  };
  const document = buildExportDocument(input);
  const keys = new Set(keysOf(document));
  for (const blocked of ['seq', 'watermark', 'upToSeq', 'readUpToSeq', 'sourceWatermark', 'replicaSeq', 'cursor']) {
    assert.equal(keys.has(blocked), false, `导出文件不得包含 ${blocked}`);
  }
  assert.equal(keys.has('internalLocation'), false, '导出只复制字段清单里的字段');
  assert.equal(document.usage.totalBytes, 4096);
  assert.equal(document.usage.categories.length, 5);
  assert.equal(document.usage.categories[0].category, 'session');
  assert.equal(document.cleanup.estimate.objects[0].sessionId, 'session-alpha');
  assert.equal(document.lineage.self.sessionId, 'session-fork-child');
  assert.equal(document.fork.outcome.replayedToolCalls, 0);
  assert.equal(document.inbox.permanentScope.dependencies.length, 2);

  const text = exportText(document);
  for (const blocked of ['watermark', 'up_to_seq', 'read_up_to_seq', 'sourceWatermark', 'replicaSeq', '"seq"']) {
    assert.equal(text.includes(blocked), false, `导出文本不得包含 ${blocked}`);
  }
});

test('字节、占比与内容范围换算', () => {
  assert.equal(formatBytes(0), '0 字节');
  assert.equal(formatBytes(1023), '1023 字节');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MiB');
  assert.throws(() => formatBytes(-1), /非负整数/u);
  assert.equal(formatShare(512, 4096), '12.5%');
  assert.equal(formatShare(0, 0), '没有可比较的总量');
  assert.equal(turnsOf(SCOPE), 2);
  assert.match(scopeText(SCOPE), /第 1 到 2 回合/u);
  assert.match(formatTimestamp(1_700_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
});

test('数据入口按同源路径发请求并映射错误码', { timeout: 60_000 }, async () => {
  const received = [];
  const relayed = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.url === '/chatdsh/telemetry/browser') {
        relayed.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(body) });
        response.writeHead(204).end();
        return;
      }
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url === USAGE_PATH) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(USAGE));
        return;
      }
      if (request.url === '/chatdsh/client/data/retention') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ days: JSON.parse(body).days, defaulted: false, updatedAt: 1_700_000_000_000 }));
        return;
      }
      if (request.url === '/chatdsh/client/data/lineage/session-missing') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'session-not-found' }));
        return;
      }
      if (request.url === '/chatdsh/client/data/cleanup/execute') {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'object-in-use', message: '范围内有 1 个有效分享，需要逐项确认影响' }));
        return;
      }
      if (request.url === '/chatdsh/client/data/replica/session-broken') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html>不是 JSON</html>');
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'internal-error' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const telemetry = createDataManagementTelemetry({
      fetchImpl: (path, init) => fetch(new URL(path, origin), init),
    });
    const face = createHttpDataManagementFace({
      fetchImpl: (path, init) => fetch(new URL(path, origin), init),
      telemetry,
    });

    const usage = await callFace('读取用量', () => face.usage(), parseUsageReport);
    assert.equal(usage.totalBytes, 4096);
    assert.equal(received[0].method, 'GET');
    assert.equal(received[0].url, USAGE_PATH);
    assert.match(received[0].headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u, '跨组件边界传播 traceparent');

    const policy = await callFace('保存保留策略', () => face.saveRetention(30), parseRetentionPolicy);
    assert.equal(policy.days, 30);
    const saved = received.find((item) => item.url === '/chatdsh/client/data/retention');
    assert.equal(saved.method, 'POST');
    assert.equal(saved.headers['x-chatdsh-csrf'], '1', '写操作带同源标识请求头');
    assert.equal(saved.headers['content-type'], 'application/json');

    const notFound = await callFace('读取血缘', () => face.lineage('session-missing'), parseLineageChain)
      .then(() => undefined, (error) => error);
    assert.equal(notFound.code, 'gateway/unavailable');
    assert.equal(notFound.status, 404);

    const inUse = await callFace(
      '执行副本清理',
      () => face.cleanupExecute({ estimateId: 'estimate-wp28', confirmDependencies: false }),
      parseCleanupOutcome,
    ).then(() => undefined, (error) => error);
    assert.equal(inUse.code, 'object-in-use');
    assert.match(inUse.message, /逐项确认/u, '控制平面给出的说明进入界面');

    const broken = await callFace('读取只读副本', () => face.replica('session-broken'), parseReplicaState)
      .then(() => undefined, (error) => error);
    assert.equal(broken.code, 'gateway/invalid-response');

    const missingInterface = await callFace('读取用量', undefined, parseUsageReport)
      .then(() => undefined, (error) => error);
    assert.equal(missingInterface.code, 'gateway/unavailable');
    assert.match(missingInterface.message, /没有提供读取用量接口/u);

    const deadline = Date.now() + 5_000;
    while (relayed.length < 3 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    const traces = relayed.filter((item) => item.signal === 'traces').map((item) => JSON.stringify(item.body)).join('\n');
    assert.ok(traces.includes('chatdsh.client.remote.call'), '调用写了 span');
    assert.ok(traces.includes('data/usage'), 'span 带调用名');
    const logs = relayed.filter((item) => item.signal === 'logs').map((item) => JSON.stringify(item.body)).join('\n');
    assert.ok(logs.includes('chatdsh.client.error'), '失败写了事件');
    assert.ok(logs.includes('object-in-use'), '失败事件带错误码');
    const metrics = relayed.filter((item) => item.signal === 'metrics').map((item) => JSON.stringify(item.body)).join('\n');
    assert.ok(metrics.includes('chatdsh_client_errors_total'), '失败计数已上报');
    assert.equal(logs.includes('/srv/chatdsh-home'), false, '遥测里没有数据根路径');
    assert.equal(logs.includes('session-alpha'), false, '遥测里没有会话标识');
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
