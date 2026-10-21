// Hindsight 适配器的契约测试。
//
// 用真的 HTTP 服务端代替 Hindsight：验证 bank 顺序、按文本去重、写入形状与不可用时的
// 错误类型。测试不依赖 Hindsight 进程，也不写任何数据到真实服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHindsightMemoryBackend, HindsightUnavailableError } from '../lib/index.js';

/** 起一个记录请求的服务端。 */
async function fakeHindsight(handler) {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    handler(request, response, received.at(-1).body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, received, baseUrl: `http://127.0.0.1:${port}` };
}

test('recall 按 bank 顺序请求并按文本去重', async () => {
  const fake = await fakeHindsight((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: [{ id: 'hit', text: '同一段记忆', type: 'world' }] }));
  });
  const backend = createHindsightMemoryBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, maxTokens: 512 });
  try {
    const hits = await backend.recall({ banks: ['t:1:ws:2', 'acct:3'], text: '蓝鲸' }, {});
    assert.deepEqual(fake.received.map((item) => item.url), [
      '/v1/default/banks/t%3A1%3Aws%3A2/memories/recall',
      '/v1/default/banks/acct%3A3/memories/recall',
    ]);
    assert.deepEqual(hits, [{ bank: 't:1:ws:2', text: '同一段记忆', source: 'hit' }]);
  } finally {
    fake.server.close();
  }
});

test('write 把契约字段映射成 Hindsight 的请求体', async () => {
  const fake = await fakeHindsight((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items_count: 1, operation_id: 'op-1' }));
  });
  const backend = createHindsightMemoryBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, maxTokens: 512 });
  try {
    await backend.write({ bank: 'acct:3', text: '一段记忆', metadata: { kind: 'summary' } }, {});
    assert.equal(fake.received[0].url, '/v1/default/banks/acct%3A3/memories');
    assert.deepEqual(JSON.parse(fake.received[0].body), {
      items: [{ content: '一段记忆', context: 'summary' }],
      async: true,
    });
  } finally {
    fake.server.close();
  }
});

test('服务返回 503 时写入抛 HindsightUnavailableError', async () => {
  const fake = await fakeHindsight((_request, response) => {
    response.writeHead(503);
    response.end('{}');
  });
  const backend = createHindsightMemoryBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, maxTokens: 512 });
  try {
    await assert.rejects(
      backend.write({ bank: 'acct:3', text: '一段记忆' }, {}),
      (error) => error instanceof HindsightUnavailableError && error.status === 503,
    );
  } finally {
    fake.server.close();
  }
});

test('health 区分可达与不可达', async () => {
  const fake = await fakeHindsight((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: '1.1.1' }));
  });
  const backend = createHindsightMemoryBackend({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000, maxTokens: 512 });
  try {
    assert.deepEqual(await backend.health({}), { ok: true });
  } finally {
    fake.server.close();
  }
  const down = createHindsightMemoryBackend({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 200, maxTokens: 512 });
  assert.deepEqual(await down.health({}), { ok: false, detail: 'unreachable' });
});

test('能力清单固定', () => {
  const backend = createHindsightMemoryBackend({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 200, maxTokens: 512 });
  assert.deepEqual(backend.capabilities(), ['recall', 'write', 'operation-id']);
});
