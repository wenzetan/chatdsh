// 诊断基础件的单元测试。
//
// 覆盖 W3C traceparent/tracestate 的严格解析、格式化与载体读写，以及有界环形缓冲的
// FIFO、覆盖计数、快照、取出与清理语义。测试直接导入编译后的真实实现。
//
// 运行：node --test e2e/unit/diagnostics-primitives.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTraceContext,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  parseTracestate,
  writeTraceContext,
} from '../../packages/core/diagnostics/lib/trace-context.js';
import { createBoundedRingBuffer } from '../../packages/core/diagnostics/lib/ring-buffer.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

test('traceparent 合法值解析并往返格式化', () => {
  assert.deepEqual(parseTraceparent(TRACEPARENT), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: '01',
  });
  assert.equal(
    formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: '01' }),
    TRACEPARENT,
  );
});

test('formatTraceparent 统一输出小写', () => {
  assert.equal(
    formatTraceparent({
      traceId: TRACE_ID.toUpperCase(),
      spanId: SPAN_ID.toUpperCase(),
      traceFlags: 'AF',
    }),
    `00-${TRACE_ID}-${SPAN_ID}-af`,
  );
});

test('版本 00 严格要求长度 55 且不能有追加字段', () => {
  assert.equal(parseTraceparent(`${TRACEPARENT}-extra`), undefined);
  assert.equal(parseTraceparent(TRACEPARENT.slice(0, -1)), undefined);
  assert.equal(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01'), undefined);
  assert.equal(parseTraceparent('0g-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), undefined);
  assert.equal(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), undefined);
});

test('更高版本接受合法追加字段但拒绝空字段与不完整基础字段', () => {
  assert.deepEqual(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: '01',
  });
  assert.deepEqual(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-future`), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: '01',
  });
  assert.equal(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-`), undefined);
  assert.equal(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-fu ture`), undefined);
});

test('trace-id、span-id 与 flags 拒绝全零、错误长度和非法十六进制', () => {
  assert.equal(
    parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`),
    undefined,
  );
  assert.equal(
    parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`),
    undefined,
  );
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-0`), undefined);
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-0g`), undefined);
  assert.equal(parseTraceparent(`00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`), undefined);
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID.slice(1)}-01`), undefined);
  assert.equal(parseTraceparent('00-ATTENTION-ATTENTION-01'), undefined);
  assert.equal(parseTraceparent(''), undefined);
});

test('随机 trace-id 与 span-id 格式正确且非全零', () => {
  const seenTraceIds = new Set();
  const seenSpanIds = new Set();
  for (let index = 0; index < 32; index += 1) {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    assert.match(traceId, /^[0-9a-f]{32}$/);
    assert.match(spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(traceId, '0'.repeat(32));
    assert.notEqual(spanId, '0'.repeat(16));
    seenTraceIds.add(traceId);
    seenSpanIds.add(spanId);
  }
  // 连续 32 次的碰撞概率可忽略；该断言能发现返回固定常量之类的假实现。
  assert.ok(seenTraceIds.size > 1);
  assert.ok(seenSpanIds.size > 1);
});

test('tracestate 接受合法成员与 OWS', () => {
  assert.equal(parseTracestate(undefined), undefined);
  assert.equal(parseTracestate('vendor=value'), 'vendor=value');
  assert.equal(parseTracestate('vendor=value, other=value2'), 'vendor=value, other=value2');
  assert.equal(parseTracestate('a@b=value'), 'a@b=value');
  assert.equal(parseTracestate('a=b c'), 'a=b c');
});

test('tracestate 512 字符边界与超限拒绝', () => {
  const first = `a=${'x'.repeat(254)}`;
  const second = `b=${'x'.repeat(253)}`;
  const multiMember = `${first},${second}`;
  assert.equal(multiMember.length, 512);
  assert.equal(parseTracestate(multiMember), multiMember);

  const singleMember = `a=${'x'.repeat(510)}`;
  assert.equal(singleMember.length, 512);
  assert.equal(parseTracestate(singleMember), singleMember);
  assert.equal(parseTracestate(`${singleMember}x`), undefined);
});

test('tracestate 拒绝控制字符与非法成员格式', () => {
  assert.equal(parseTracestate(''), undefined);
  assert.equal(parseTracestate('vendor=value\nother=value'), undefined);
  assert.equal(parseTracestate('vendor=va\u0000lue'), undefined);
  assert.equal(parseTracestate('vendor'), undefined);
  assert.equal(parseTracestate('=value'), undefined);
  assert.equal(parseTracestate('vendor='), undefined);
  assert.equal(parseTracestate('Vendor=value'), undefined);
  assert.equal(parseTracestate('vendor=value=other'), undefined);
  assert.equal(parseTracestate('vendor=value,,other=value'), undefined);
  assert.equal(parseTracestate('vendor=value,'), undefined);
  assert.equal(parseTracestate('vendor=value\tother=value'), undefined);
});

test('extractTraceContext 提取 traceparent 并保留合法 tracestate', () => {
  assert.deepEqual(
    extractTraceContext({ traceparent: TRACEPARENT, tracestate: 'vendor=value' }),
    { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: '01', traceState: 'vendor=value' },
  );
});

test('extractTraceContext 在 traceparent 非法时返回 undefined，并忽略非法 tracestate', () => {
  assert.equal(extractTraceContext({ traceparent: 'invalid', tracestate: 'vendor=value' }), undefined);
  assert.deepEqual(extractTraceContext({ traceparent: TRACEPARENT, tracestate: 'invalid member' }), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: '01',
  });
});

test('writeTraceContext 返回新载体且不修改入参', () => {
  const carrier = Object.freeze({ traceparent: 'old', tracestate: 'old=value', custom: 'kept' });
  const next = writeTraceContext(carrier, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: '01',
    traceState: 'vendor=value',
  });
  assert.deepEqual(carrier, { traceparent: 'old', tracestate: 'old=value', custom: 'kept' });
  assert.deepEqual(next, {
    traceparent: TRACEPARENT,
    tracestate: 'vendor=value',
    custom: 'kept',
  });
  assert.notEqual(next, carrier);

  const withoutState = writeTraceContext(carrier, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: '01',
  });
  assert.equal(withoutState.traceparent, TRACEPARENT);
  assert.equal('tracestate' in withoutState, false);
  assert.equal(withoutState.custom, 'kept');
});

test('环形缓冲拒绝非法容量', () => {
  for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createBoundedRingBuffer(capacity), RangeError);
  }
});

test('环形缓冲接受超大正安全整数容量且不预分配整块内存', () => {
  const buffer = createBoundedRingBuffer(Number.MAX_SAFE_INTEGER);
  assert.equal(buffer.capacity, Number.MAX_SAFE_INTEGER);
  assert.equal(buffer.push('a'), false);
  assert.deepEqual(buffer.snapshot(), ['a']);
});

test('环形缓冲未满时按 FIFO 增长且不增加 dropped', () => {
  const buffer = createBoundedRingBuffer(3);
  assert.equal(buffer.capacity, 3);
  assert.equal(buffer.size, 0);
  assert.equal(buffer.dropped, 0);
  assert.equal(buffer.push('a'), false);
  assert.equal(buffer.push('b'), false);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.dropped, 0);
  assert.deepEqual(buffer.snapshot(), ['a', 'b']);
});

test('环形缓冲写满后覆盖最旧元素并累计 dropped', () => {
  const buffer = createBoundedRingBuffer(3);
  assert.equal(buffer.push('a'), false);
  assert.equal(buffer.push('b'), false);
  assert.equal(buffer.push('c'), false);
  assert.equal(buffer.push('d'), true);
  assert.equal(buffer.push('e'), true);
  assert.equal(buffer.size, 3);
  assert.equal(buffer.dropped, 2);
  assert.deepEqual(buffer.snapshot(), ['c', 'd', 'e']);
});

test('snapshot 不移除元素，drain 从旧到新取出并移除', () => {
  const buffer = createBoundedRingBuffer(3);
  buffer.push('a');
  buffer.push('b');
  buffer.push('c');
  buffer.push('d');

  assert.deepEqual(buffer.snapshot(), ['b', 'c', 'd']);
  assert.equal(buffer.size, 3);
  assert.deepEqual(buffer.drain(2), ['b', 'c']);
  assert.equal(buffer.size, 1);
  assert.equal(buffer.dropped, 1);
  assert.deepEqual(buffer.snapshot(), ['d']);

  buffer.push('e');
  buffer.push('f');
  assert.deepEqual(buffer.drain(), ['d', 'e', 'f']);
  assert.equal(buffer.size, 0);
  assert.deepEqual(buffer.snapshot(), []);
});

test('drain 支持 0 与超过当前数量的上限', () => {
  const buffer = createBoundedRingBuffer(2);
  buffer.push(1);
  buffer.push(2);
  assert.deepEqual(buffer.drain(0), []);
  assert.deepEqual(buffer.drain(10), [1, 2]);
  assert.deepEqual(buffer.drain(), []);
});

test('drain 拒绝非法数量', () => {
  const buffer = createBoundedRingBuffer(2);
  for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buffer.drain(limit), RangeError);
  }
});

test('clear 清空元素并重置 dropped', () => {
  const buffer = createBoundedRingBuffer(2);
  buffer.push('a');
  buffer.push('b');
  buffer.push('c');
  assert.equal(buffer.dropped, 1);
  buffer.clear();
  assert.equal(buffer.size, 0);
  assert.equal(buffer.dropped, 0);
  assert.deepEqual(buffer.snapshot(), []);
  assert.equal(buffer.push('d'), false);
  assert.deepEqual(buffer.snapshot(), ['d']);
});
