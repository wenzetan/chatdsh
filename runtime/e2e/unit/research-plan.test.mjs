// 检索编排的单元测试。
//
// 直接调用编译后的真实实现，覆盖默认角度、自定义角度、空问题、角度上限与合并格式。
//
// 运行：node --test e2e/unit/research-plan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ANGLES, mergeFindings, planResearch } from '../../packages/tool/research/lib/plan.js';

test('不给角度时按事实、对比、风险三个角度展开', () => {
  const plan = planResearch('  某个问题  ');
  assert.deepEqual(plan.map((item) => item.angle), ['事实', '对比', '风险']);
  assert.match(plan[0].prompt, /围绕「事实」这个角度/);
  assert.match(plan[0].prompt, /问题：某个问题/);
});

test('给出角度时按给定顺序展开', () => {
  const plan = planResearch('问题', ['成本', '维护']);
  assert.deepEqual(plan.map((item) => item.angle), ['成本', '维护']);
});

test('空问题报错', () => {
  assert.throws(() => planResearch('   '), /不能为空/);
});

test('角度超过上限时报错并说明数量', () => {
  const tooMany = Array.from({ length: MAX_ANGLES + 1 }, (_, index) => `角度${index}`);
  assert.throws(() => planResearch('问题', tooMany), new RegExp(`最多 ${MAX_ANGLES} 个`));
});

test('合并结果按角度分节', () => {
  const text = mergeFindings([
    { angle: '事实', text: '第一段' },
    { angle: '风险', text: '  第二段  ' },
  ]);
  assert.equal(text, '## 事实\n第一段\n\n## 风险\n第二段');
});

test('某个角度没有内容时明确标注', () => {
  const text = mergeFindings([{ angle: '对比', text: '   ' }]);
  assert.match(text, /## 对比\n（这个角度没有返回内容）/);
});

test('没有任何结论时给出一句说明', () => {
  assert.equal(mergeFindings([]), '没有取得任何角度的结论。');
});
