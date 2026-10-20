// 审批应答的关联键与待处理列表读取的单元测试。
//
// 上游的 `approval/request` 水位事件带 `agent`、`toolName`、`callId`、`reason`，
// 没有 `id`——`id` 只存在于会话日志的 `approval/asked` 与 `approval/decided`
// 两条审计事件里，由审批服务生成，请求方看不到。因此等待表与审计事件之间
// 唯一可用的关联点是工具调用标识。
//
// 运行：node --test e2e/unit/approval-answer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlationKeyOf } from '../../packages/plugins/approval/lib/types.js';

test('关联键取工具调用标识', () => {
  assert.equal(correlationKeyOf({ callId: 'call-1' }), 'call-1');
});

test('没有工具调用标识时没有关联键', () => {
  assert.equal(correlationKeyOf({}), undefined);
  assert.equal(correlationKeyOf({ callId: undefined }), undefined);
  assert.equal(correlationKeyOf({ callId: '' }), undefined);
});

test('非字符串的工具调用标识没有关联键', () => {
  assert.equal(correlationKeyOf({ callId: 42 }), undefined);
  assert.equal(correlationKeyOf({ callId: {} }), undefined);
});

test('不同请求得到不同关联键，不会互相覆盖', () => {
  const first = correlationKeyOf({ callId: 'call-1' });
  const second = correlationKeyOf({ callId: 'call-2' });
  assert.notEqual(first, second);
  assert.equal(first, 'call-1');
  assert.equal(second, 'call-2');
});
