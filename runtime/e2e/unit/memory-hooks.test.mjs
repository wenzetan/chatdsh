// 记忆挂钩的纯逻辑测试。
//
// 覆盖与注入直接相关的三项规则：从本步消息里取问题、判断这一步该不该召回、同一批召回
// 不重复追加；召回内容如何渲染成一条消息的内容也在这一层。消息本身的构造与会话生命周期
// 依赖运行时，由真实会话验收覆盖。
//
// 运行：node --test e2e/unit/memory-hooks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastUserText, RecallSequenceDeduper, renderRecallSection, shouldRecall } from '../../packages/host/memory/lib/rules.js';

test('取最后一条带文本的用户消息', () => {
  const messages = [
    { content: [{ type: 'text', text: '第一句' }] },
    { content: [{ type: 'text', text: '  第二句  ' }] },
  ];
  assert.equal(lastUserText(messages), '第二句');
});

test('最后一条没有文本时继续往前找', () => {
  const messages = [
    { content: [{ type: 'text', text: '有内容' }] },
    { content: [{ type: 'image', text: undefined }] },
  ];
  assert.equal(lastUserText(messages), '有内容');
});

test('没有任何文本时返回空串', () => {
  assert.equal(lastUserText([]), '');
  assert.equal(lastUserText([{ content: [] }]), '');
});

test('多条文本块按顺序拼接', () => {
  const messages = [{ content: [{ type: 'text', text: '前半' }, { type: 'text', text: '后半' }] }];
  assert.equal(lastUserText(messages), '前半 后半');
});

test('没有召回结果时提示里不出现空段', () => {
  assert.equal(renderRecallSection([]), '');
});

test('召回结果按条目渲染', () => {
  const text = renderRecallSection([{ text: '第一条记忆' }, { text: '第二条记忆' }]);
  assert.equal(text, '# 相关记忆\n- 第一条记忆\n- 第二条记忆');
});

test('回合开始的那一步召回', () => {
  assert.equal(shouldRecall({ step: 1, messages: [] }), true);
});

test('工具调用之后的步骤不召回', () => {
  assert.equal(shouldRecall({ step: 2, messages: [] }), false);
  assert.equal(shouldRecall({ step: 3, messages: [{ source: { kind: 'tool' } }] }), false);
});

test('用户中途插话的步骤召回', () => {
  assert.equal(shouldRecall({ step: 2, messages: [{ source: { kind: 'user' } }] }), true);
  assert.equal(shouldRecall({
    step: 4,
    messages: [{ source: { kind: 'tool' } }, { source: { kind: 'user' } }],
  }), true);
});

test('没有来源字段的消息不构成召回判据', () => {
  assert.equal(shouldRecall({ step: 2, messages: [{ content: [] }] }), false);
});

test('同一批召回编号不重复追加', () => {
  const deduper = new RecallSequenceDeduper();
  assert.equal(deduper.accept('s1', ['a', 'b']), true);
  assert.equal(deduper.accept('s1', ['a', 'b']), false);
  assert.equal(deduper.accept('s1', ['b', 'a']), true);
  assert.equal(deduper.accept('s1', ['a']), true);
});

test('不同会话各自记自己的召回编号', () => {
  const deduper = new RecallSequenceDeduper();
  assert.equal(deduper.accept('s1', ['a']), true);
  assert.equal(deduper.accept('s2', ['a']), true);
  assert.equal(deduper.size, 2);
});

test('去重记录有上限并按最早一条淘汰', () => {
  const deduper = new RecallSequenceDeduper(2);
  deduper.accept('s1', ['a']);
  deduper.accept('s2', ['b']);
  deduper.accept('s3', ['c']);
  assert.equal(deduper.size, 2);
  assert.equal(deduper.accept('s1', ['a']), true);
});
