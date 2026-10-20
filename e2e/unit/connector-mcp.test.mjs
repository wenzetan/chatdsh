// MCP 行配置生成的单元测试。
//
// 直接调用编译后的真实实现。覆盖服务器名规范化、两种传输的字段、停用跳过与信息不完整时的报错。
//
// 运行：node --test e2e/unit/connector-mcp.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpRow, buildMcpRows, loaderEntryOf, planMcpSync, rowIdOf, toServerName } from '../../packages/plugins/connectors/lib/mcp.js';

test('服务器名满足约束：替换非法字符并截断', () => {
  assert.equal(toServerName('notes'), 'notes');
  assert.equal(toServerName('my notes.svc'), 'my-notes-svc');
  const long = toServerName('a'.repeat(40));
  assert.equal(long.length, 32);
  assert.equal(toServerName('中文名字'), '----');
  assert.equal(toServerName(''), 'connector');
});

test('stdio 连接器生成 stdio 行并回传凭据来源', () => {
  const result = buildMcpRow({
    name: 'notes',
    transport: 'stdio',
    command: 'notes-mcp',
    args: ['--dir', '/srv/notes'],
    credentialEnv: 'NOTES_TOKEN',
    enabled: true,
  });
  assert.deepEqual(result.row, {
    transport: 'stdio',
    serverName: 'notes',
    command: 'notes-mcp',
    args: ['--dir', '/srv/notes'],
  });
  assert.equal(result.credentialEnv, 'NOTES_TOKEN');
});

test('http 连接器生成 streamable-http 行', () => {
  const result = buildMcpRow({
    name: 'search',
    transport: 'http',
    url: 'https://example.test/mcp',
    enabled: true,
  });
  assert.deepEqual(result.row, {
    transport: 'streamable-http',
    serverName: 'search',
    url: 'https://example.test/mcp',
  });
  assert.equal(result.credentialEnv, undefined);
});

test('停用的连接器被跳过', () => {
  const rows = buildMcpRows([
    { name: 'on', transport: 'stdio', command: 'a', enabled: true },
    { name: 'off', transport: 'stdio', command: 'b', enabled: false },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row.serverName, 'on');
});

test('信息不完整时抛出并说明缺哪一项', () => {
  assert.throws(
    () => buildMcpRow({ name: 'broken', transport: 'stdio', enabled: true }),
    /缺少命令/,
  );
  assert.throws(
    () => buildMcpRow({ name: 'broken', transport: 'http', enabled: true }),
    /缺少地址/,
  );
});

test('条目 id 带固定前缀', () => {
  assert.equal(rowIdOf('notes'), 'chatdsh-connector-notes');
});

test('同步计划区分新建、覆盖与移除', () => {
  const plan = planMcpSync(
    [
      { name: 'kept', transport: 'stdio', command: 'a', enabled: true },
      { name: 'fresh', transport: 'stdio', command: 'b', enabled: true },
    ],
    ['chatdsh-connector-kept', 'chatdsh-connector-stale', 'ui-chat'],
  );
  assert.deepEqual(plan.create.map((item) => item.rowId), ['chatdsh-connector-fresh']);
  assert.deepEqual(plan.update.map((item) => item.rowId), ['chatdsh-connector-kept']);
  assert.deepEqual(plan.remove, ['chatdsh-connector-stale']);
});

test('前缀之外的条目不会被移除', () => {
  const plan = planMcpSync([], ['ui-chat', 'tool-bash', 'chatdsh-connector-a']);
  assert.deepEqual(plan.remove, ['chatdsh-connector-a']);
});

test('停用的连接器连同它的行一起被移除', () => {
  const plan = planMcpSync(
    [{ name: 'off', transport: 'stdio', command: 'a', enabled: false }],
    ['chatdsh-connector-off'],
  );
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.remove, ['chatdsh-connector-off']);
});

test('加载器条目显式带标识，与同步计划里的标识一致', () => {
  const plan = planMcpSync(
    [{ name: 'notes', transport: 'stdio', command: 'a', enabled: true }],
    [],
  );
  const entry = loaderEntryOf(plan.create[0].rowId, '@deepseek-ai/dsh-mcp-client', plan.create[0].row);
  assert.equal(entry.id, 'chatdsh-connector-notes');
  assert.equal(entry.id, plan.create[0].rowId);
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
});

test('条目标识回读后仍能对上，第二轮同步不会重复新建', () => {
  const specs = [{ name: 'notes', transport: 'stdio', command: 'a', enabled: true }];
  const first = planMcpSync(specs, []);
  const entry = loaderEntryOf(first.create[0].rowId, '@deepseek-ai/dsh-mcp-client', first.create[0].row);
  // 加载器把条目标识原样保留下来，下一轮同步读到的就是它。
  const second = planMcpSync(specs, [entry.id]);
  assert.deepEqual(second.create, []);
  assert.deepEqual(second.update.map((item) => item.rowId), ['chatdsh-connector-notes']);
  assert.deepEqual(second.remove, []);
});

test('停用后旧行能被移除，因为标识对得上', () => {
  const specs = [{ name: 'notes', transport: 'stdio', command: 'a', enabled: true }];
  const first = planMcpSync(specs, []);
  const entry = loaderEntryOf(first.create[0].rowId, '@deepseek-ai/dsh-mcp-client', first.create[0].row);
  const afterDisable = planMcpSync(
    [{ name: 'notes', transport: 'stdio', command: 'a', enabled: false }],
    [entry.id],
  );
  assert.deepEqual(afterDisable.remove, ['chatdsh-connector-notes']);
});
