// MCP 服务端的验收测试。
//
// 用真实的 HTTP 请求走一遍 JSON-RPC：初始化、列出工具、调用工具。服务端按会话归属
// 过滤工具目录，未鉴权的请求在协议层之前就被拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { createMcpServer } = await import('../../packages/host/mcp-server/lib/index.js');

/** 起一个 MCP 服务端，返回地址与关闭函数。 */
async function serve(options) {
  const server = createMcpServer(options);
  const http = createServer((request, response) => server.handle(request, response));
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  return { http, url: `http://127.0.0.1:${http.address().port}/mcp`, server };
}

/** 发一次 JSON-RPC 请求。 */
async function rpc(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

test('initialize 返回协议版本与工具能力', async () => {
  const { http, url } = await serve({
    tools: [{ name: 'echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
  try {
    const result = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.protocolVersion, '2025-11-25');
    assert.equal(result.body.result.capabilities.tools.listChanged, false);
    assert.equal(result.body.result.serverInfo.name, 'chatdsh');
  } finally {
    http.close();
  }
});

test('tools/list 返回注册的工具', async () => {
  const { http, url } = await serve({
    tools: [{ name: 'echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
  try {
    const result = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepEqual(result.body.result.tools.map((tool) => tool.name), ['echo']);
    assert.equal(result.body.result.tools[0].inputSchema.type, 'object');
  } finally {
    http.close();
  }
});

test('tools/call 交给回调并回传结果', async () => {
  let seen;
  const { http, url } = await serve({
    tools: [{ name: 'echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    callTool: async (name, args) => {
      seen = { name, args };
      return { content: [{ type: 'text', text: `回显：${args.text}` }] };
    },
  });
  try {
    const result = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: '你好' } } });
    assert.deepEqual(seen, { name: 'echo', args: { text: '你好' } });
    assert.equal(result.body.result.content[0].text, '回显：你好');
    assert.equal(result.body.result.isError, false);
  } finally {
    http.close();
  }
});

test('未鉴权的请求返回 401 且不进入协议层', async () => {
  const { http, url } = await serve({
    tools: [],
    callTool: async () => ({ content: [] }),
    authorize: () => false,
  });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    assert.equal(response.status, 401);
  } finally {
    http.close();
  }
});

test('未知方法与未知工具返回 JSON-RPC 错误码', async () => {
  const { http, url } = await serve({
    tools: [{ name: 'echo', description: '回显', parameters: { type: 'object', properties: {} } }],
    callTool: async () => ({ content: [] }),
  });
  try {
    const method = await rpc(url, { jsonrpc: '2.0', id: 5, method: 'tools/nope', params: {} });
    assert.equal(method.body.error.code, -32601);
    const tool = await rpc(url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing', arguments: {} } });
    assert.equal(tool.body.error.code, -32602);
  } finally {
    http.close();
  }
});

test('工具目录按调用方可见范围过滤', async () => {
  const { http, url } = await serve({
    tools: [
      { name: 'echo', description: '回显', parameters: { type: 'object', properties: {} }, scope: 'a' },
      { name: 'secret', description: '私有', parameters: { type: 'object', properties: {} }, scope: 'b' },
    ],
    callTool: async () => ({ content: [] }),
    scopeOf: () => 'a',
  });
  try {
    const result = await rpc(url, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    assert.deepEqual(result.body.result.tools.map((tool) => tool.name), ['echo']);
    const denied = await rpc(url, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'secret', arguments: {} } });
    assert.equal(denied.body.error.code, -32602);
  } finally {
    http.close();
  }
});

test('标准 MCP 客户端可以完成握手、列举与调用', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { http, url } = await serve({
    tools: [{ name: 'echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    callTool: async (_name, args) => ({ content: [{ type: 'text', text: `回显：${args.text}` }] }),
  });
  const client = new Client({ name: 'chatdsh-e2e', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['echo']);
    const result = await client.callTool({ name: 'echo', arguments: { text: '你好' } });
    assert.equal(result.content[0].text, '回显：你好');
  } finally {
    await client.close();
    http.close();
  }
});

test('带会话标识时按该会话解析工具目录', async () => {
  const { http, url } = await serve({
    tools: [{ name: 'global', description: '全局', parameters: { type: 'object', properties: {} } }],
    toolsFor: (caller) => (caller.sessionId === 'session-1'
      ? [
          { name: 'global', description: '全局', parameters: { type: 'object', properties: {} } },
          { name: 'session-only', description: '会话内', parameters: { type: 'object', properties: {} } },
        ]
      : [{ name: 'global', description: '全局', parameters: { type: 'object', properties: {} } }]),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    sessionOf: (request) => request.headers['x-chatdsh-session-id'],
  });
  try {
    const withoutSession = await rpc(url, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
    assert.deepEqual(withoutSession.body.result.tools.map((tool) => tool.name), ['global']);
    const withSession = await rpc(
      url,
      { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} },
      { 'x-chatdsh-session-id': 'session-1' },
    );
    assert.deepEqual(withSession.body.result.tools.map((tool) => tool.name), ['global', 'session-only']);
  } finally {
    http.close();
  }
});
