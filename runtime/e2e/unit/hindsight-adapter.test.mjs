// 记忆存储层门面的测试。
//
// 适配器本身由 `hindsight-adapter` 的测试覆盖；这里验证接入层用到的门面仍保留旧形状：
// 逐 bank 召回、按一条内容写入、写入返回整合任务标识、失败时回调降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMemoryClient, MemoryUnavailableError } from '../../packages/host/memory/lib/client.js';

async function fakeHindsight(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    handler(request, response, Buffer.concat(chunks).toString('utf8'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('写入返回整合任务标识，召回逐 bank 合并去重', async () => {
  const fake = await fakeHindsight((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url.endsWith('/memories')) {
      response.end(JSON.stringify({ items_count: 1, operation_id: 'op-9' }));
      return;
    }
    response.end(JSON.stringify({ results: [{ id: 'x', text: '同一段记忆' }] }));
  });
  const client = createMemoryClient({ hindsightUrl: fake.baseUrl, maxTokens: 256, requestTimeoutMs: 2000 });
  try {
    const written = await client.write('acct:1', { content: '一段记忆', context: '测试' });
    assert.deepEqual(written, { items: 1, operationId: 'op-9' });
    const hits = await client.recall(['t:1:ws:2', 'acct:1'], { query: '记忆' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].text, '同一段记忆');
  } finally {
    fake.server.close();
  }
});

test('失败时先回调降级再抛出可识别的错误', async () => {
  const fake = await fakeHindsight((_request, response) => {
    response.writeHead(503);
    response.end('{}');
  });
  const failures = [];
  const client = createMemoryClient(
    { hindsightUrl: fake.baseUrl, maxTokens: 256, requestTimeoutMs: 2000 },
    (operation, error) => failures.push({ operation, name: error.name }),
  );
  try {
    await assert.rejects(client.recall(['acct:1'], { query: '记忆' }), (error) => error instanceof MemoryUnavailableError);
    assert.deepEqual(failures, [{ operation: '召回', name: 'HindsightUnavailableError' }]);
  } finally {
    fake.server.close();
  }
});
