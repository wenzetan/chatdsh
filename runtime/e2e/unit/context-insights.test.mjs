// 上下文占用洞察的测试。
//
// 只验证纯函数的三档判定与边界；宿主服务读取两个投影的行为由组合检查覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeContext } from '../../packages/host/context-insights/lib/summarize.js';

test('低于七成视为 ok', () => {
  assert.deepEqual(summarizeContext({ events: 10, inputTokens: 100, outputTokens: 50, windowTokens: 1000 }), {
    usedRatio: 0.15,
    level: 'ok',
    remainingTokens: 850,
  });
});

test('七成到九成视为 warn', () => {
  assert.equal(summarizeContext({ events: 10, inputTokens: 600, outputTokens: 200, windowTokens: 1000 }).level, 'warn');
});

test('九成以上视为 critical', () => {
  assert.equal(summarizeContext({ events: 10, inputTokens: 900, outputTokens: 50, windowTokens: 1000 }).level, 'critical');
});

test('边界恰好七成与九成归入较高一档', () => {
  assert.equal(summarizeContext({ events: 0, inputTokens: 700, outputTokens: 0, windowTokens: 1000 }).level, 'warn');
  assert.equal(summarizeContext({ events: 0, inputTokens: 900, outputTokens: 0, windowTokens: 1000 }).level, 'critical');
});

test('超出窗口时占比按实际用量给出，剩余归零', () => {
  const insight = summarizeContext({ events: 3, inputTokens: 900, outputTokens: 300, windowTokens: 1000 });
  assert.equal(insight.usedRatio, 1.2);
  assert.equal(insight.remainingTokens, 0);
  assert.equal(insight.level, 'critical');
});

test('窗口为零时就地抛出', () => {
  assert.throws(() => summarizeContext({ events: 0, inputTokens: 0, outputTokens: 0, windowTokens: 0 }), /窗口/);
});
