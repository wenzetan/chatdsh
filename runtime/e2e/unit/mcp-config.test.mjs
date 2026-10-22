// MCP 接入配置的单元测试。
//
// 配置采用 VSCode 的 mcp.json 形状：`servers` 字典，键是服务器名，值给出 `type`、
// `command`/`args`/`env` 或 `url`/`headers`。解析后转成 MCP 客户端的加载器行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const {
  parseMcpConfig,
  resolveEnvReference,
  rowsOf,
  toLoaderConfig,
  McpConfigError,
  toServerName,
} = await import('../../packages/host/connectors/lib/config.js');

test('解析 stdio 服务器并生成行', () => {
  const parsed = parseMcpConfig({
    servers: {
      context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_API_KEY: '${env:CONTEXT7_API_KEY}' } },
    },
  });
  assert.deepEqual(parsed.map((entry) => entry.serverName), ['context7']);
  assert.deepEqual(parsed[0].row, {
    transport: 'stdio',
    serverName: 'context7',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: { CONTEXT7_API_KEY: '${env:CONTEXT7_API_KEY}' },
  });
});

test('解析 http 服务器并生成行', () => {
  const parsed = parseMcpConfig({
    servers: {
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { 'CONTEXT7_API_KEY': '${env:CONTEXT7_API_KEY}' } },
    },
  });
  assert.deepEqual(parsed[0].row, {
    transport: 'streamable-http',
    serverName: 'context7',
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: '${env:CONTEXT7_API_KEY}' },
  });
});

test('缺 type 时按字段推断传输方式', () => {
  const parsed = parseMcpConfig({
    servers: {
      local: { command: 'notes-mcp' },
      remote: { url: 'https://example.test/mcp' },
    },
  });
  assert.deepEqual(parsed.map((entry) => entry.row.transport), ['stdio', 'streamable-http']);
});

test('服务器名规范化并保留原始名字用于展示', () => {
  const parsed = parseMcpConfig({ servers: { 'my notes': { command: 'notes-mcp' } } });
  assert.equal(parsed[0].serverName, 'my-notes');
  assert.equal(parsed[0].displayName, 'my notes');
  // 非 ASCII 字符逐字替换成连字符，保留原有的位置。
  assert.equal(toServerName('上下文 7'), '----7');
  assert.throws(() => toServerName('上下文'), /规范化后为空/);
});

test('非法配置就地抛出并指出哪一项', () => {
  assert.throws(() => parseMcpConfig({}), (error) => error instanceof McpConfigError && /servers/.test(error.message));
  assert.throws(
    () => parseMcpConfig({ servers: { broken: { type: 'stdio' } } }),
    (error) => error instanceof McpConfigError && /command/.test(error.message),
  );
  assert.throws(
    () => parseMcpConfig({ servers: { broken: { type: 'http' } } }),
    (error) => error instanceof McpConfigError && /url/.test(error.message),
  );
  assert.throws(
    () => parseMcpConfig({ servers: { broken: { type: 'websocket', url: 'x' } } }),
    (error) => error instanceof McpConfigError && /type/.test(error.message),
  );
});

test('rowsOf 把解析结果转成带条目 id 的加载器行', () => {
  const parsed = parseMcpConfig({ servers: { context7: { url: 'https://mcp.context7.com/mcp' } } });
  const rows = rowsOf(parsed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowId, 'chatdsh-mcp-context7');
  assert.equal(rows[0].name, '@deepseek-ai/dsh-mcp-client');
});

test('凭据引用在写入加载器行之前解析成实际值', () => {
  process.env.CHATDSH_MCP_TEST_KEY = 'secret-value';
  assert.equal(resolveEnvReference('${env:CHATDSH_MCP_TEST_KEY}', process.env), 'secret-value');
  assert.equal(resolveEnvReference('plain', process.env), 'plain');
  assert.throws(
    () => resolveEnvReference('${env:CHATDSH_MCP_MISSING_KEY}', process.env),
    (error) => error instanceof McpConfigError && /CHATDSH_MCP_MISSING_KEY/.test(error.message),
  );
  delete process.env.CHATDSH_MCP_TEST_KEY;
});

test('端点记录转成 DSH 原生 MCP 客户端的加载器配置', () => {
  process.env.CHATDSH_MCP_TEST_TOKEN = 'token-value';
  const http = toLoaderConfig({
    server: 'context7',
    deviceId: 'device-a',
    transport: 'http',
    row: { url: 'https://mcp.context7.com/mcp', headers: { 'X-Tenant': 'demo' } },
    credentialEnv: 'CHATDSH_MCP_TEST_TOKEN',
    updatedAt: 1,
  });
  assert.equal(http.transport, 'streamable-http');
  assert.equal(http.serverName, 'context7');
  assert.deepEqual(http.headers, { 'X-Tenant': 'demo', Authorization: 'Bearer token-value' });

  const stdio = toLoaderConfig({
    server: 'notes',
    deviceId: 'device-a',
    transport: 'stdio',
    row: { command: 'npx', args: ['-y', 'notes-mcp'] },
    updatedAt: 1,
  });
  assert.equal(stdio.transport, 'stdio');
  assert.equal(stdio.command, 'npx');
  assert.deepEqual(stdio.args, ['-y', 'notes-mcp']);
  assert.deepEqual(stdio.env, {});
  delete process.env.CHATDSH_MCP_TEST_TOKEN;
});

test('凭据环境变量缺失时不填值，让原生客户端报告不可达', () => {
  const row = toLoaderConfig({
    server: 'context7',
    deviceId: 'device-a',
    transport: 'http',
    row: { url: 'https://mcp.context7.com/mcp' },
    credentialEnv: 'CHATDSH_MCP_MISSING_TOKEN',
    updatedAt: 1,
  });
  assert.equal(row.headers.Authorization, undefined);
});
