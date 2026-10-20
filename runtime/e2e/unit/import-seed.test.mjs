// 种子构造的单元测试。
//
// 副本记录里既有排序用的标量，也有被上报的完整事件。恢复时取完整事件，并核对内外序号
// 一致；不一致说明副本被写坏，就地抛出。
//
// 运行：node --test e2e/unit/import-seed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../../packages/plugins/import/lib/seed.js';

const record = (seq, payload) => ({ seq, kind: payload?.type ?? 'unknown', time: payload?.time ?? seq, payload });

test('完整信封被还原成种子', () => {
  const seed = buildSeed([
    record(0, { type: 'session/start', seq: 0, time: 100, data: { cwd: '/work' } }),
    record(1, { type: 'user/message', seq: 1, time: 200, data: { text: '你好' } }),
  ]);
  assert.deepEqual(seed.map((event) => event.type), ['session/start', 'user/message']);
  assert.deepEqual(seed[0].data, { cwd: '/work' });
  assert.equal(seed[1].seq, 1);
});

test('空副本直接抛出', () => {
  assert.throws(() => buildSeed([]), /副本为空/);
});

test('缺少完整事件时抛出', () => {
  assert.throws(() => buildSeed([record(0, null)]), /缺少完整事件/);
});

test('信封字段不全时抛出', () => {
  assert.throws(() => buildSeed([record(0, { seq: 0, time: 1 })]), /信封不完整/);
});

test('内外序号不一致时抛出', () => {
  assert.throws(
    () => buildSeed([record(3, { type: 'session/start', seq: 2, time: 1 })]),
    /序号不一致/,
  );
});

test('只保留用到的字段', () => {
  const seed = buildSeed([record(0, { type: 'session/start', seq: 0, time: 1, data: {}, extra: '丢弃' })]);
  assert.deepEqual(Object.keys(seed[0]).sort(), ['data', 'seq', 'time', 'type']);
});
