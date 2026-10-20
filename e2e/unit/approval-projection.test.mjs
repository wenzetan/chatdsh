// 审批投影折叠的单元测试。
//
// 跨端收敛的数据层就是这份折叠：一端作答后写下的 approval/decided 会让待处理列表里对应
// 的条目消失，另一端读投影时自然看不到它。这里覆盖折叠规则本身。
//
// 运行：node --test e2e/unit/approval-projection.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyApprovalEvent } from '../../packages/plugins/approval/lib/types.js';

const initial = { pending: [], askedCount: 0 };

test('asked 进入待处理列表并计数', () => {
  const next = applyApprovalEvent(initial, {
    type: 'approval/asked',
    time: 100,
    data: { id: 'a1', callId: 'c1', toolName: 'bash', reason: '写入工作区外' },
  });
  assert.equal(next.pending.length, 1);
  assert.deepEqual(next.pending[0], { id: 'a1', callId: 'c1', toolName: 'bash', reason: '写入工作区外', askedAt: 100 });
  assert.equal(next.askedCount, 1);
});

test('没有工具调用标识时待处理条目不带该字段', () => {
  const next = applyApprovalEvent(initial, {
    type: 'approval/asked',
    time: 100,
    data: { id: 'a1', toolName: 'bash' },
  });
  assert.equal(next.pending[0].callId, undefined);
});

test('decided 移除对应条目并记录结果', () => {
  const asked = applyApprovalEvent(initial, { type: 'approval/asked', time: 100, data: { id: 'a1', toolName: 'bash' } });
  const decided = applyApprovalEvent(asked, { type: 'approval/decided', time: 200, data: { id: 'a1', outcome: 'allowed-once' } });
  assert.equal(decided.pending.length, 0);
  assert.equal(decided.askedCount, 1);
  assert.equal(decided.lastOutcome, 'allowed-once');
  assert.equal(decided.lastAt, 200);
});

test('多条审批各自独立进出', () => {
  let state = initial;
  state = applyApprovalEvent(state, { type: 'approval/asked', time: 1, data: { id: 'a1', toolName: 'bash' } });
  state = applyApprovalEvent(state, { type: 'approval/asked', time: 2, data: { id: 'a2', toolName: 'write' } });
  state = applyApprovalEvent(state, { type: 'approval/decided', time: 3, data: { id: 'a1', outcome: 'rejected' } });
  assert.deepEqual(state.pending.map((item) => item.id), ['a2']);
  assert.equal(state.askedCount, 2);
});

test('无关事件返回同一个对象', () => {
  const state = { pending: [{ id: 'a1', toolName: 'bash', askedAt: 1 }], askedCount: 1 };
  assert.equal(applyApprovalEvent(state, { type: 'user/message', time: 5 }), state);
  assert.equal(applyApprovalEvent(state, { type: 'approval/asked', time: 6, data: {} }), state);
});

test('重复的 decided 不改变状态形状', () => {
  const state = { pending: [], askedCount: 1, lastOutcome: 'rejected', lastAt: 10 };
  const again = applyApprovalEvent(state, { type: 'approval/decided', time: 20, data: { id: 'a1', outcome: 'rejected' } });
  assert.equal(again.pending.length, 0);
  assert.equal(again.lastAt, 20);
});
