// 上下文占用洞察的测试。
//
// 只验证纯函数的三档判定与边界；宿主服务读取两个投影的行为由组合检查覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeContext } from '../../packages/host/context-insights/lib/summarize.js';

/** 部署配置窗口：没有模型目录披露窗口时的回落来源。 */
const configWindow = (tokens) => ({ tokens, source: 'config', degraded: false });

/** 一次纯函数调用的公共输入。 */
const input = (fields) => ({ events: 10, tokensSource: 'unavailable', ...fields });

test('低于七成视为 ok', () => {
  const insight = summarizeContext(input({ inputTokens: 100, outputTokens: 50, window: configWindow(1000) }));
  assert.equal(insight.usedRatio, 0.15);
  assert.equal(insight.level, 'ok');
  assert.equal(insight.remainingTokens, 850);
  assert.equal(insight.usedTokens, 150);
});

test('七成到九成视为 warn', () => {
  assert.equal(
    summarizeContext(input({ inputTokens: 600, outputTokens: 200, window: configWindow(1000) })).level,
    'warn'
  );
});

test('九成以上视为 critical', () => {
  assert.equal(
    summarizeContext(input({ inputTokens: 900, outputTokens: 50, window: configWindow(1000) })).level,
    'critical'
  );
});

test('边界恰好七成与九成归入较高一档', () => {
  assert.equal(summarizeContext(input({ events: 0, inputTokens: 700, outputTokens: 0, window: configWindow(1000) })).level, 'warn');
  assert.equal(summarizeContext(input({ events: 0, inputTokens: 900, outputTokens: 0, window: configWindow(1000) })).level, 'critical');
});

test('超出窗口时占比按实际用量给出，剩余归零', () => {
  const insight = summarizeContext(input({ events: 3, inputTokens: 900, outputTokens: 300, window: configWindow(1000) }));
  assert.equal(insight.usedRatio, 1.2);
  assert.equal(insight.remainingTokens, 0);
  assert.equal(insight.level, 'critical');
});

test('降级窗口如实报告来源与原因', () => {
  const insight = summarizeContext(input({
    inputTokens: 10,
    outputTokens: 10,
    window: { tokens: 200, source: 'config', degraded: true, reason: 'catalog-unsupported' },
  }));
  assert.equal(insight.window.tokens, 200);
  assert.equal(insight.window.degraded, true);
  assert.equal(insight.window.reason, 'catalog-unsupported');
});

test('窗口为零时就地抛出', () => {
  assert.throws(
    () => summarizeContext(input({ events: 0, inputTokens: 0, outputTokens: 0, window: configWindow(0) })),
    /窗口/
  );
});
