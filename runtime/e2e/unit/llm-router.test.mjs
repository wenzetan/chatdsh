// 模型路由器的验收测试：转发与控制平面的模型入口、额度拒绝。
//
// 起一个真实的 HTTP 网关替身作为控制平面模型入口，断言适配器把请求原样转发过去
// 并把流式分块交回调用方；额度拒绝必须在发出任何上游请求之前就地抛出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { ChatdshLlmRouterService, GatewayLlmAdapter, createQuotaGuard, LlmQuotaError } = await import('../../packages/host/llm-router/lib/index.js');

/** 起一个 HTTP 服务并返回它的地址与收到的请求。 */
async function serve(handler) {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: request.method, url: request.url, headers: request.headers, body });
    await handler(request, response, body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** 一条最小请求。 */
function options() {
  return {
    provider: 'gateway',
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  };
}

/** 收集流式分块。 */
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test('stream() 把请求转发到控制平面的模型入口并交回流式分块', async () => {
  const { server, seen, baseUrl } = await serve((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-chatdsh-request-id': 'req-1',
    });
    response.write('data: {"type":"text-delta","index":0,"text":"你好"}\n\n');
    response.write('data: {"type":"usage","usage":{"inputTokens":3,"outputTokens":2,"totalTokens":5}}\n\n');
    response.write('data: {"type":"finish","reason":{"kind":"stop"}}\n\n');
    response.end();
  });

  const adapter = new GatewayLlmAdapter({
    baseUrl: `${baseUrl}/chatdsh/gateway/llm`,
    quota: { limit: 1000, used: 10 },
    apiKeyEnv: 'CHATDSH_LLM_ROUTER_TEST_KEY',
  });

  try {
    const chunks = await collect(adapter.stream(options()));
    assert.deepEqual(chunks[0], { type: 'text-delta', index: 0, text: '你好' });
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/chatdsh/gateway/llm');
    assert.equal(seen[0].method, 'POST');
    const body = JSON.parse(seen[0].body);
    assert.equal(body.provider, 'gateway');
    assert.equal(body.model, 'test-model');
    assert.equal(body.messages[0].content[0].text, '你好');
  } finally {
    server.close();
  }
});

test('额度不足时在发出请求之前抛出 QUOTA，且区分 ChatDSH 错误码', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((_request, response) => {
    requests += 1;
    response.end();
  });
  const adapter = new GatewayLlmAdapter({
    baseUrl: `${baseUrl}/chatdsh/gateway/llm`,
    quota: { limit: 100, used: 100 },
  });

  try {
    await assert.rejects(
      collect(adapter.stream(options())),
      (error) => error.name === 'LlmQuotaError'
        && error.code === 'QUOTA'
        && error.chatdshCode === 'quota-exceeded',
    );
    assert.equal(requests, 0);
    assert.ok(new LlmQuotaError({ limit: 100, used: 100 }) instanceof Error);
  } finally {
    server.close();
  }
});

test('额度守卫只有一份读数，拒绝把已用额度算成可用', () => {
  const guard = createQuotaGuard({ limit: 10 });
  assert.deepEqual(guard.check(), { allowed: true, limit: 10, used: 0, remaining: 10 });
  guard.record(10);
  assert.throws(
    () => guard.check(),
    (error) => error instanceof LlmQuotaError && error.code === 'QUOTA' && error.reading.used === 10,
  );
  assert.throws(() => guard.record(-1), /额度/);
});

test('上游 429 与 402 映射为可区分的错误码', async () => {
  const { server, baseUrl } = await serve((_request, response) => {
    response.writeHead(402, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'insufficient balance', code: 'insufficient_balance' } }));
  });
  const adapter = new GatewayLlmAdapter({
    baseUrl: `${baseUrl}/chatdsh/gateway/llm`,
    quota: { limit: 100, used: 0 },
  });
  try {
    await assert.rejects(
      collect(adapter.stream(options())),
      (error) => error.name === 'LlmUpstreamError'
        && error.status === 402
        && error.code === 'QUOTA',
    );
  } finally {
    server.close();
  }
});

test('路由器服务把依赖声明在静态字段上', () => {
  assert.deepEqual(ChatdshLlmRouterService.inject, ['llm']);
});

test('配置不合法时在装配阶段就地抛出', () => {
  const base = { baseUrl: 'http://127.0.0.1:3170/chatdsh/gateway/llm' };
  for (const config of [
    { ...base, routes: [{ provider: 'Gateway_1' }] },
    { baseUrl: 'ftp://127.0.0.1/llm', routes: [{ provider: 'gateway' }] },
  ]) {
    assert.throws(
      () => new ChatdshLlmRouterService(new Context(), config),
      (error) => error.code === 'llm-router/invalid',
    );
  }
});

test('上游拒绝时错误对象保留响应原文与上游错误码', async () => {
  const upstreamText = '{"error":{"code":"insufficient_balance","message":"账户余额不足，请充值"}}';
  const { server, baseUrl } = await serve((_request, response) => {
    response.writeHead(402, { 'content-type': 'application/json; charset=utf-8' });
    response.end(upstreamText);
  });
  const adapter = new GatewayLlmAdapter({
    baseUrl: `${baseUrl}/chatdsh/gateway/llm`,
    quota: { limit: 100, used: 0 },
  });
  try {
    await assert.rejects(
      collect(adapter.stream(options())),
      (error) => error.name === 'LlmUpstreamError'
        && error.code === 'QUOTA'
        && error.status === 402
        && error.body === upstreamText
        && error.contentType === 'application/json; charset=utf-8'
        && error.upstreamCode === 'insufficient_balance'
        && error.message.includes('账户余额不足'),
    );
  } finally {
    server.close();
  }
});
