// 连接器呈现的单元测试。
//
// 直接调用编译后的真实实现，覆盖四种形态：空列表、stdio 带参数、http 带凭据来源、停用条目。
//
// 运行：node --test e2e/unit/connector-format.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeConnectors } from '../../packages/presets/tool-connector/lib/format.js';

test('没有连接器时给出一句说明', () => {
  assert.equal(describeConnectors([]), '还没有登记外部连接器。');
});

test('stdio 连接器显示命令与参数', () => {
  const text = describeConnectors([
    { name: 'notes', transport: 'stdio', command: 'notes-mcp', args: ['--dir', '/srv/notes'], enabled: true },
  ]);
  assert.match(text, /已登记 1 个外部连接器/);
  assert.match(text, /notes：stdio · notes-mcp --dir \/srv\/notes/);
});

test('http 连接器显示地址与凭据来源', () => {
  const text = describeConnectors([
    { name: 'search', transport: 'http', url: 'https://example.test/mcp', credentialEnv: 'SEARCH_TOKEN', enabled: true },
  ]);
  assert.match(text, /search：http · https:\/\/example\.test\/mcp，凭据来自环境变量 SEARCH_TOKEN/);
});

test('停用的连接器标注状态但仍然列出', () => {
  const text = describeConnectors([
    { name: 'legacy', transport: 'stdio', command: 'legacy', enabled: false },
  ]);
  assert.match(text, /legacy（已停用）：stdio · legacy/);
});

test('缺少目标字段时明确说明缺什么', () => {
  const http = describeConnectors([{ name: 'broken', transport: 'http', enabled: true }]);
  assert.match(http, /地址未填写/);
  const stdio = describeConnectors([{ name: 'broken', transport: 'stdio', enabled: true }]);
  assert.match(stdio, /命令未填写/);
});
