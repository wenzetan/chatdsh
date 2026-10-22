// 控制平面模型入口的 HTTP 验收测试。
//
// 真实起一个模型网关替身，网关的模型入口只做鉴权、额度前置检查与流式转发。
// 两项断言：一次通过的请求把 SSE 分块带回，一次额度耗尽的请求在到达上游之前被拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { createGatewayServer } = await import('../../gateway/lib/server.js');
const { GatewayStore, ReplicaStore, ShareStore, ScheduleStore, ReceiptStore, PushQueue, readConfig } = await import('../../gateway/lib/store.js');
const { createPushHub } = await import('../../gateway/lib/push.js');

/** 起一个有界流式响应的上游模型网关。 */
async function serveUpstream() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n');
    response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** 起控制平面，只装配模型入口需要的部分。 */
async function startGateway(upstreamUrl, quota) {
  const config = {
    ...readConfig(),
    accessProvider: 'manual',
    llmGateway: { upstreamUrl, quota, apiKeyEnv: undefined },
  };
  const store = new GatewayStore(':memory:');
  const server = createGatewayServer({
    config,
    store,
    replica: new ReplicaStore(store.handle()),
    share: new ShareStore(store.handle()),
    schedule: new ScheduleStore(store.handle()),
    receipts: new ReceiptStore(store.handle()),
    push: createPushHub({
      queue: new PushQueue(store.handle()),
      devices: store,
      mode: 'all-online',
      escalationMs: 1000,
      telemetry: { counter: () => ({ add() {} }) },
    }),
    telemetry: {
      event() {},
      runSpan(_name, _attributes, fn) { return fn({ setAttribute() {}, setAttributes() {}, recordException() {}, end() {} }); },
      runSpanSync(_name, _attributes, fn) { return fn({ setAttribute() {}, setAttributes() {}, recordException() {}, end() {} }); },
      currentTraceId() { return undefined; },
      log() {},
      counter: () => ({ add() {} }),
      histogram: () => ({ record() {} }),
      gauge: () => ({ record() {} }),
      startSpan: () => ({ setAttribute() {}, setAttributes() {}, recordException() {}, end() {} }),
    },
  });
  await server.start();
  return { server, store };
}

test('模型入口转发 SSE 分块并带上控制平面身份头', async () => {
  const upstream = await serveUpstream();
  const { server, store } = await startGateway(upstream.baseUrl, { limit: 1000, used: 0 });
  try {
    const response = await fetch(`${server.url()}/chatdsh/gateway/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tailscale-user-login': 'alice' },
      body: JSON.stringify({ provider: 'gateway', model: 'test-model', messages: [] }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"type":"text-delta"/);
    assert.match(text, /"type":"usage"/);
    assert.match(text, /"type":"finish"/);
    assert.match(text, /"kind":"stop"/);
    assert.equal(upstream.requests.length, 1);
    assert.equal(typeof upstream.requests[0].headers['x-chatdsh-account-id'], 'string');
    assert.deepEqual(JSON.parse(upstream.requests[0].body), {
      model: 'test-model',
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    });
  } finally {
    await server.stop();
    upstream.server.close();
    store.close();
  }
});

test('额度耗尽时模型入口返回 402 且不转发到上游', async () => {
  const upstream = await serveUpstream();
  const { server, store } = await startGateway(upstream.baseUrl, { limit: 100, used: 100 });
  try {
    const response = await fetch(`${server.url()}/chatdsh/gateway/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tailscale-user-login': 'bob' },
      body: JSON.stringify({ provider: 'gateway', model: 'test-model', messages: [] }),
    });
    assert.equal(response.status, 402);
    const payload = await response.json();
    assert.equal(payload.error.code, 'quota-exceeded');
    assert.equal(upstream.requests.length, 0);
  } finally {
    await server.stop();
    upstream.server.close();
    store.close();
  }
});

test('翻译器把上游增量翻译成分块，并在结束时补齐用量与结束原因', async () => {
  const { createStreamTranslator } = await import('../../gateway/lib/stream.js');
  const translator = createStreamTranslator();
  const first = translator.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n');
  const rest = translator.flush();
  assert.deepEqual(first, [
    { type: 'text-delta', index: 0, text: 'a' },
    { type: 'text-delta', index: 0, text: 'b' },
  ]);
  assert.deepEqual(rest, []);

  const finished = translator.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
  assert.deepEqual(finished, []);
  assert.deepEqual(translator.flush(), [
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('请求翻译把内容块拼成 OpenAI 消息并打开流式', async () => {
  const { toOpenAiRequest } = await import('../../gateway/lib/openai.js');
  const request = toOpenAiRequest({
    provider: 'gateway',
    model: 'test-model',
    system: '系统提示',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '在' }, { type: 'tool-call', id: 'c1', name: 'fs', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '结果' }] },
    ],
    maxTokens: 64,
  });
  assert.equal(request.model, 'test-model');
  assert.equal(request.stream, true);
  assert.deepEqual(request.messages, [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs', arguments: '{}' } }] },
    { role: 'tool', content: '结果', tool_call_id: 'c1' },
  ]);
  assert.equal(request.max_tokens, 64);
});
