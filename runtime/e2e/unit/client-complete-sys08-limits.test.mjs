// SYS08 资源额度的验收测试。
//
// 真实 SQLite、真实 HTTP 监听与独立数据根。额度表逐项核对上限与单位；守卫在分配之前判定；
// 请求体、单次消息、单条事件、附件、录音与预览在边界处通过、在边界加一处被明确拒绝，响应体
// 带错误码、单位、上限、实测值与允许的处理入口；声明长度超限时在读取之前拒绝；读取期限到期
// 返回期限拒绝；超限上传不产生与请求体等量的内存分配。
//
// 运行：node --test e2e/unit/client-complete-sys08-limits.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { startResourceLimitServer } from '../../gateway/lib/resource-limits/server.js';
import {
  CountedBytes,
  RESOURCE_LIMITS,
  RESOURCE_SCOPES,
  createDeadline,
  guardBytes,
  guardCount,
  guardMilliseconds,
  limitOf,
  rejectionOf,
  sampleProcess,
} from '../../packages/core/limits/lib/index.js';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');
const MiB = 1024 * 1024;
const KiB = 1024;

/** 关闭遥测导出的真实遥测客户端。 */
function createTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 在独立数据根里运行一个测试。 */
async function withHome(prefix, run) {
  const home = allocateIndependentHome(prefix);
  const telemetry = createTelemetry();
  try {
    return await run(home, telemetry);
  } finally {
    await telemetry.shutdown();
    releaseIndependentHome(home);
  }
}

/** 建立真实存储与服务。 */
async function startServer(home, telemetry) {
  const store = new GatewayStore(join(home, 'gateway', 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const now = Date.now();
  store.registerNode({ id: 'device-a', name: 'A 工作站', platform: 'linux', role: 'host', capabilities: ['shell'], tokenHash: 'a'.repeat(64) });
  store.touchDevice({ id: 'device-a', origin: 'cli', platform: 'linux', lastSeenAt: now });
  store.upsertSession({ sessionId: 'sess-alpha', deviceId: 'device-a', cwd: '/work/alpha', kind: 'work', createdAt: now });
  replica.append('sess-alpha', Array.from({ length: 20 }, (_unused, seq) => ({
    seq,
    kind: 'turn/start',
    time: now + seq,
    bytes: 64,
    payload: { turn: seq + 1, text: 'a'.repeat(40) },
  })));
  const server = await startResourceLimitServer({
    store,
    replica,
    telemetry,
    jobs: {
      export: async () => ({ jobId: 'export-probe', bytes: 1 }),
      backup: async () => ({ objects: 1, bytes: 1 }),
    },
  });
  return { store, replica, server };
}

/** 发一个原生 HTTP 请求。 */
function rawRequest(options, payload) {
  return new Promise((settle, fail) => {
    const request = httpRequest(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        settle({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', fail);
    if (payload !== undefined) request.write(payload);
    if (options.end !== false) request.end();
  });
}

test('额度表逐项带单位与拒绝语义', () => {
  const expected = {
    'request-body': [1 * MiB, 'bytes'],
    message: [256 * KiB, 'bytes'],
    event: [1 * MiB, 'bytes'],
    'replica-batch-bytes': [1 * MiB, 'bytes'],
    'replica-batch-items': [256, 'items'],
    'webhook-body': [1 * MiB, 'bytes'],
    'device-frame': [64 * KiB, 'bytes'],
    'device-frame-payload': [32 * KiB, 'bytes'],
    'channel-count': [128, 'items'],
    'channel-credit': [256 * KiB, 'bytes'],
    'link-buffer': [8 * MiB, 'bytes'],
    attachment: [25 * MiB, 'bytes'],
    'turn-attachments': [100 * MiB, 'bytes'],
    'attachment-count': [10, 'items'],
    'recording-bytes': [25 * MiB, 'bytes'],
    'recording-duration': [600 * 1000, 'milliseconds'],
    preview: [1 * MiB, 'bytes'],
    'tool-display': [256 * KiB, 'bytes'],
    'list-page': [200, 'items'],
    'list-page-default': [50, 'items'],
    'pending-messages': [20, 'items'],
    'sse-connection': [4, 'items'],
    'sse-buffer': [1 * MiB, 'bytes'],
    'export-concurrency': [1, 'items'],
    'export-queue': [4, 'items'],
    'backup-concurrency': [1, 'items'],
    'backup-queue': [4, 'items'],
    'read-timeout': [15 * 1000, 'milliseconds'],
    'write-accept-timeout': [30 * 1000, 'milliseconds'],
    'stream-idle-timeout': [75 * 1000, 'milliseconds'],
    'cancel-timeout': [2 * 1000, 'milliseconds'],
    'control-plane-memory': [512 * MiB, 'bytes'],
    'client-memory': [768 * MiB, 'bytes'],
  };
  assert.deepEqual([...RESOURCE_SCOPES].sort(), Object.keys(expected).sort(), '额度表的种类必须与设计第九节一致');
  for (const [scope, [value, unit]] of Object.entries(expected)) {
    const limit = limitOf(scope);
    assert.equal(limit.value, value, `${scope} 的上限`);
    assert.equal(limit.unit, unit, `${scope} 的单位`);
    assert.equal(typeof limit.description, 'string');
    assert.ok(limit.description.length > 0, `${scope} 缺少说明`);
    assert.ok(['payload-too-large', 'page-limit-exceeded', 'subscription-limit', 'queue-full', 'backpressure-exceeded', 'deadline-exceeded', 'resource-budget-exceeded'].includes(limit.rejection.code), `${scope} 的拒绝码`);
    assert.ok(limit.rejection.status >= 400 && limit.rejection.status < 600, `${scope} 的拒绝状态`);
    assert.equal(typeof limit.rejection.entry, 'string');
    assert.ok(limit.rejection.guidance.length > 0, `${scope} 缺少处理说明`);
  }
  assert.equal(Object.isFrozen(RESOURCE_LIMITS), true, '额度表必须冻结');
});

test('守卫在分配之前判定并给出单位与入口', () => {
  assert.equal(guardBytes('request-body', 1 * MiB).ok, true);
  const over = guardBytes('request-body', 1 * MiB + 1);
  assert.equal(over.ok, false);
  assert.equal(over.rejection.code, 'payload-too-large');
  assert.equal(over.rejection.scope, 'request-body');
  assert.equal(over.rejection.unit, 'bytes');
  assert.equal(over.rejection.limit, 1 * MiB);
  assert.equal(over.rejection.observed, 1 * MiB + 1);
  assert.equal(over.rejection.entry, 'narrower-request');
  assert.equal(guardCount('list-page', 200).ok, true);
  assert.equal(guardCount('list-page', 201).ok, false);
  assert.equal(guardCount('sse-connection', 5).rejection.code, 'subscription-limit');
  assert.equal(guardMilliseconds('recording-duration', 600 * 1000).ok, true);
  assert.equal(guardMilliseconds('recording-duration', 600 * 1000 + 1).rejection.unit, 'milliseconds');
  assert.throws(() => guardBytes('recording-duration', 1), /单位/);
  assert.throws(() => guardCount('request-body', 1), /单位/);
  assert.throws(() => guardBytes('request-body', -1), /非负/);

  const counter = new CountedBytes('preview');
  assert.equal(counter.accept(512 * 1024), true);
  assert.equal(counter.accept(512 * 1024), true);
  assert.equal(counter.accept(1), false, '越界的那一块必须被拒绝');
  assert.equal(counter.bytes, 1 * MiB + 1);
  assert.equal(counter.overLimit, true);
  assert.equal(counter.accept(4 * MiB), false, '越界之后不再累计');
  assert.equal(counter.bytes, 1 * MiB + 1);
  const verdict = counter.verdict();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rejection.observed, 1 * MiB + 1);

  const deadline = createDeadline('read-timeout', 1000);
  assert.equal(deadline.expiresAt, 16_000);
  assert.equal(deadline.expired(15_999), false);
  assert.equal(deadline.expired(16_000), true);
  assert.equal(deadline.remaining(1000), 15_000);
  assert.equal(deadline.rejection().code, 'deadline-exceeded');

  const rejection = rejectionOf('attachment', 26 * MiB);
  assert.equal(rejection.status, 413);
  assert.equal(rejection.entry, 'chunked-upload');
  assert.equal(rejection.limit, 25 * MiB);
});

test('真实 HTTP 上传在每类额度边界通过、超限被拒绝', async () => {
  await withHome('sys08-limits-upload', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const cases = [
        ['request-body', RESOURCE_LIMITS['request-body'].value],
        ['message', RESOURCE_LIMITS.message.value],
        ['event', RESOURCE_LIMITS.event.value],
        ['preview', RESOURCE_LIMITS.preview.value],
        ['tool-display', RESOURCE_LIMITS['tool-display'].value],
        ['attachment', RESOURCE_LIMITS.attachment.value],
        ['webhook-body', RESOURCE_LIMITS['webhook-body'].value],
        ['replica-batch-bytes', RESOURCE_LIMITS['replica-batch-bytes'].value],
      ];
      for (const [scope, limit] of cases) {
        const exact = Buffer.alloc(limit, 0x41);
        const accepted = await fetch(`${server.url}/chatdsh/gateway/resource/upload?scope=${scope}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: exact,
        });
        assert.equal(accepted.status, 200, `${scope} 边界内必须通过`);
        const acceptedBody = await accepted.json();
        assert.equal(acceptedBody.bytes, limit, `${scope} 必须报告真实字节数`);
        assert.equal(typeof acceptedBody.digest, 'string');

        const over = Buffer.alloc(limit + 1, 0x42);
        const rejected = await fetch(`${server.url}/chatdsh/gateway/resource/upload?scope=${scope}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: over,
        });
        assert.equal(rejected.status, 413, `${scope} 超限必须返回 413`);
        const body = await rejected.json();
        assert.equal(body.error, 'payload-too-large', `${scope} 的错误码`);
        assert.equal(body.kind, scope);
        assert.equal(body.unit, 'bytes');
        assert.equal(body.limit, limit);
        assert.equal(body.observed, limit + 1);
        assert.equal(typeof body.entry, 'string');
        assert.ok(body.guidance.length > 0);
      }
    } finally {
      await server.close();
    }
  });
});

test('录音按字节与时长分别判定', async () => {
  await withHome('sys08-limits-recording', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const exactBytes = Buffer.alloc(RESOURCE_LIMITS['recording-bytes'].value, 0x31);
      const accepted = await fetch(`${server.url}/chatdsh/gateway/resource/recording?durationMs=600000`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: exactBytes,
      });
      assert.equal(accepted.status, 200);

      const tooLong = await fetch(`${server.url}/chatdsh/gateway/resource/recording?durationMs=600001`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(1024, 0x32),
      });
      assert.equal(tooLong.status, 413);
      const longBody = await tooLong.json();
      assert.equal(longBody.kind, 'recording-duration');
      assert.equal(longBody.unit, 'milliseconds');
      assert.equal(longBody.limit, 600_000);
      assert.equal(longBody.observed, 600_001);
      assert.equal(longBody.entry, 'split-recording');

      const tooBig = await fetch(`${server.url}/chatdsh/gateway/resource/recording?durationMs=1000`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(RESOURCE_LIMITS['recording-bytes'].value + 1, 0x33),
      });
      assert.equal(tooBig.status, 413);
      const bigBody = await tooBig.json();
      assert.equal(bigBody.kind, 'recording-bytes');
      assert.equal(bigBody.unit, 'bytes');
    } finally {
      await server.close();
    }
  });
});

test('分页条数超限返回 400 与分页入口', async () => {
  await withHome('sys08-limits-page', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const defaultPage = await fetch(`${server.url}/chatdsh/gateway/sessions`);
      assert.equal(defaultPage.status, 200);
      const defaultBody = await defaultPage.json();
      assert.equal(defaultBody.limit, 50);
      assert.ok(Array.isArray(defaultBody.items));

      const maxPage = await fetch(`${server.url}/chatdsh/gateway/sessions?limit=200`);
      assert.equal(maxPage.status, 200);

      const overPage = await fetch(`${server.url}/chatdsh/gateway/sessions?limit=201`);
      assert.equal(overPage.status, 400);
      const body = await overPage.json();
      assert.equal(body.error, 'page-limit-exceeded');
      assert.equal(body.kind, 'list-page');
      assert.equal(body.unit, 'items');
      assert.equal(body.limit, 200);
      assert.equal(body.observed, 201);
      assert.equal(body.entry, 'pagination');

      const history = await fetch(`${server.url}/chatdsh/gateway/sessions/sess-alpha/events?limit=5`);
      assert.equal(history.status, 200);
      const historyBody = await history.json();
      assert.equal(historyBody.count, 5);
      assert.equal(historyBody.nextAfter, 4);
      assert.equal(historyBody.truncated, true);
      const next = await fetch(`${server.url}/chatdsh/gateway/sessions/sess-alpha/events?after=${String(historyBody.nextAfter)}&limit=200`);
      assert.equal(next.status, 200);
      const nextBody = await next.json();
      assert.equal(nextBody.count, 15);
      assert.equal(nextBody.nextAfter, 19);
      assert.equal(nextBody.truncated, false);
      assert.ok(nextBody.bytes <= RESOURCE_LIMITS['replica-batch-bytes'].value);
    } finally {
      await server.close();
    }
  });
});

test('事件批次按条数与字节双重判定', async () => {
  await withHome('sys08-limits-events', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const events = (count, size) => Array.from({ length: count }, (_unused, index) => ({
        seq: 100 + index,
        kind: 'turn/start',
        time: Date.now(),
        payload: { text: 'e'.repeat(Math.max(1, size - 40)) },
      }));
      const exact = await fetch(`${server.url}/chatdsh/gateway/resource/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-alpha', events: events(256, 64) }),
      });
      assert.equal(exact.status, 200);
      const exactBody = await exact.json();
      assert.equal(exactBody.written, 256);

      const tooMany = await fetch(`${server.url}/chatdsh/gateway/resource/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-alpha', events: events(257, 64) }),
      });
      assert.equal(tooMany.status, 413);
      const manyBody = await tooMany.json();
      assert.equal(manyBody.kind, 'replica-batch-items');
      assert.equal(manyBody.unit, 'items');
      assert.equal(manyBody.limit, 256);
      assert.equal(manyBody.observed, 257);

      const bigEvent = await fetch(`${server.url}/chatdsh/gateway/resource/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-alpha', events: events(1, RESOURCE_LIMITS.event.value + 64) }),
      });
      assert.equal(bigEvent.status, 413);
      const bigBody = await bigEvent.json();
      assert.ok(['event', 'replica-batch-bytes'].includes(bigBody.kind), `超大单条事件的种类：${bigBody.kind}`);
      assert.equal(bigBody.unit, 'bytes');
      assert.ok(bigBody.limit <= RESOURCE_LIMITS.event.value);
      assert.equal(bigBody.entry, 'pagination');
      const single = guardBytes('event', RESOURCE_LIMITS.event.value + 1);
      assert.equal(single.ok, false, '单条事件额度本身必须拒绝超限内容');
      assert.equal(single.rejection.scope, 'event');
    } finally {
      await server.close();
    }
  });
});

test('声明长度超限在读取之前拒绝', async () => {
  await withHome('sys08-limits-declared', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const url = new URL(`${server.url}/chatdsh/gateway/resource/upload?scope=request-body`);
      const started = Date.now();
      const response = await rawRequest({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(8 * MiB) },
        end: false,
      }, Buffer.alloc(16, 0x44));
      const elapsed = Date.now() - started;
      assert.equal(response.status, 413);
      const body = JSON.parse(response.body);
      assert.equal(body.error, 'payload-too-large');
      assert.equal(body.limit, 1 * MiB);
      assert.equal(body.observed, 8 * MiB);
      assert.ok(elapsed < 3000, `声明长度必须立即拒绝，实际 ${String(elapsed)} 毫秒`);
    } finally {
      await server.close();
    }
  });
});

test('读取期限到期返回期限拒绝', async () => {
  await withHome('sys08-limits-deadline', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      const url = new URL(`${server.url}/chatdsh/gateway/resource/upload?scope=request-body`);
      const started = Date.now();
      const response = await rawRequest({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(64 * 1024) },
        end: false,
      }, Buffer.alloc(16, 0x45));
      const elapsed = Date.now() - started;
      assert.equal(response.status, 408);
      const body = JSON.parse(response.body);
      assert.equal(body.error, 'deadline-exceeded');
      assert.equal(body.kind, 'read-timeout');
      assert.equal(body.unit, 'milliseconds');
      assert.equal(body.limit, 15_000);
      assert.ok(elapsed >= 14_000, `期限必须真实等待到 15 秒，实际 ${String(elapsed)} 毫秒`);
      assert.ok(elapsed < 20_000, `期限不应超出登记值太多，实际 ${String(elapsed)} 毫秒`);
    } finally {
      await server.close();
    }
  });
});

test('超限上传不产生与请求体等量的内存分配', async () => {
  await withHome('sys08-limits-memory', async (home, telemetry) => {
    const { server } = await startServer(home, telemetry);
    try {
      // 同一块载荷重复使用：客户端侧的内存是一次性常量，增长只可能来自服务端的读取路径。
      const payload = Buffer.alloc(16 * MiB, 0x46);
      const baseline = sampleProcess();
      let peak = baseline.rssBytes;
      for (let index = 0; index < 4; index += 1) {
        const response = await fetch(`${server.url}/chatdsh/gateway/resource/upload?scope=request-body`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload,
        });
        assert.equal(response.status, 413);
        await response.text();
        peak = Math.max(peak, sampleProcess().rssBytes);
      }
      const growth = peak - baseline.rssBytes;
      assert.ok(growth < 64 * MiB, `超限上传的常驻内存增长必须远小于请求体，实际 ${String(Math.round(growth / MiB))} MiB`);
      const stats = server.snapshot();
      assert.ok((stats.rejections['request-body'] ?? 0) >= 4, '每次超限都要计入拒绝');
    } finally {
      await server.close();
    }
  });
});
