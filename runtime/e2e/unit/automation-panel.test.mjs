// 自动化面板的纯函数测试。
//
// 只验证统计文案；面板的 Remote 交互由浏览器侧构建产物检查覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAutomationSummary } from '../../packages/client/automation/lib/index.js';

test('空列表给出一句话', () => {
  assert.equal(formatAutomationSummary([]), '还没有自动化');
});

test('按启用数统计', () => {
  assert.equal(formatAutomationSummary([
    { id: 'a1', enabled: true },
    { id: 'a2', enabled: false },
  ]), '1/2 个自动化已启用');
});

test('全部启用与全部停用', () => {
  assert.equal(formatAutomationSummary([{ id: 'a1', enabled: true }]), '1/1 个自动化已启用');
  assert.equal(formatAutomationSummary([{ id: 'a1', enabled: false }]), '0/1 个自动化已启用');
});
