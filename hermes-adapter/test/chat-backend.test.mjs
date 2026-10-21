// Hermes 适配器的契约测试。
//
// 用真的 HTTP 服务端代替 Hermes，只验证请求形状与错误映射：适配器把契约调用翻译成
// Hermes 的接口，再把非 2xx 的结果翻译成带状态码与错误码的异常。测试不依赖 Hermes 进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHermesChatBackend, HermesError } from '../lib/index.js';

/** 起一个只处理一次请求的服务端，返回地址与收到的请求。 */
async function fakeHermes(handler) {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ method: request.method, url: request.url, headers: request.headers, body });
    await handler(request, response, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, received, baseUrl: `http://127.0.0.1:${port}` };
}

test('createRun 返回 run_id 并携带会话标识', async () => {
  const fake = await fakeHermes((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ run_id: 'run-1' }));
  });
  const backend = createHermesChatBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, approvalTimeoutMs: 2000 });
  try {
    const handle = await backend.createRun({ sessionId: 'chat-1', text: '你好' }, {});
    assert.equal(handle.runId, 'run-1');
    assert.equal(fake.received[0].method, 'POST');
    assert.equal(fake.received[0].url, '/v1/runs');
    assert.deepEqual(JSON.parse(fake.received[0].body), { session_id: 'chat-1', message: '你好' });
    assert.match(fake.received[0].headers['x-hermes-session-id'], /^chat-1$/);
  } finally {
    fake.server.close();
  }
});

test('streamEvents 把 SSE 行翻译成契约事件', async () => {
  const fake = await fakeHermes((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"text","text":"第一段"}\n\n');
    response.write('data: {"type":"approval.request","request_id":"r1","title":"执行命令","choices":["once","deny"]}\n\n');
    response.write('data: {"type":"finish","reason":"stop"}\n\n');
    response.end();
  });
  const backend = createHermesChatBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, approvalTimeoutMs: 2000 });
  try {
    const events = [];
    for await (const event of backend.streamEvents('run-1', {})) events.push(event);
    assert.deepEqual(events, [
      { type: 'text', text: '第一段' },
      { type: 'approval-request', runId: 'run-1', requestId: 'r1', title: '执行命令', choices: ['once', 'deny'] },
      { type: 'finish', reason: 'stop' },
    ]);
  } finally {
    fake.server.close();
  }
});

test('审批应答 409 映射为 approval-not-pending 并带上 request_id', async () => {
  const fake = await fakeHermes((_request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'approval_not_pending' }));
  });
  const backend = createHermesChatBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, approvalTimeoutMs: 2000 });
  try {
    await assert.rejects(
      backend.respondApproval('run-1', 'req-1', 'allowed-once', {}),
      (error) => error instanceof HermesError && error.status === 409 && error.code === 'approval_not_pending',
    );
    assert.equal(fake.received[0].url, '/v1/runs/run-1/approval');
    assert.deepEqual(JSON.parse(fake.received[0].body), { request_id: 'req-1', choice: 'once' });
  } finally {
    fake.server.close();
  }
});

test('429 保留状态码供上层区分限流', async () => {
  const fake = await fakeHermes((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'rate_limited' }));
  });
  const backend = createHermesChatBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, approvalTimeoutMs: 2000 });
  try {
    await assert.rejects(
      backend.steer('run-1', '继续', {}),
      (error) => error instanceof HermesError && error.status === 429 && error.operation === 'steer',
    );
  } finally {
    fake.server.close();
  }
});

test('health 在服务可达时为 ok，不可达时为 not-ok', async () => {
  const fake = await fakeHermes((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
  });
  const backend = createHermesChatBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, approvalTimeoutMs: 2000 });
  try {
    assert.deepEqual(await backend.health({}), { ok: true });
  } finally {
    fake.server.close();
  }
  const down = createHermesChatBackend({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 300, approvalTimeoutMs: 300 });
  assert.deepEqual(await down.health({}), { ok: false, detail: 'unreachable' });
});

test('能力清单固定包含审批、干预与事件流', () => {
  const backend = createHermesChatBackend({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 300, approvalTimeoutMs: 300 });
  assert.deepEqual(backend.capabilities(), ['approval', 'steer', 'events']);
});
