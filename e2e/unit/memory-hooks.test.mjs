// 记忆挂钩的纯逻辑测试。
//
// 覆盖两件与提示注入直接相关的规则：从本步消息里取问题、把召回结果渲染成提示里的一段。
// 会话生命周期本身（席位注册与每步召回）依赖运行时，不在这里覆盖。
//
// 运行：node --test e2e/unit/memory-hooks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastUserText, renderRecallSection } from '../../packages/plugins/memory/lib/rules.js';

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
