// 写操作信封、幂等与分页契约的单元测试。
//
// 覆盖成功、失败、冲突、未确认四种结果，重放判定，revision 冲突，以及分页游标与上限。
// 运行：node --test e2e/unit/client-complete-wp01-operations.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  OPERATION_STATES,
  OPERATION_ID_PATTERN,
  REQUEST_DIGEST_PATTERN,
  chatdshErrorCodeSchema,
  decideReplay,
  isSettledOutcome,
  listQuerySchema,
  operationRecordSchema,
  pageInfoSchema,
  pageSchemaOf,
  identifierSchema,
  stopAckSchema,
  writeOutcomeSchema,
} from '../../packages/core/contracts/lib/index.js';
import { OPERATION_ID, REQUEST_DIGEST, expectReject, roundtrip } from './client-complete-wp01-support.mjs';

test('成功的写操作结果可以往返', () => {
  const applied = roundtrip(
    writeOutcomeSchema,
    { outcome: 'applied', operationId: OPERATION_ID, revision: 7, replayed: false, result: { sessionId: 's-1' } },
    'applied',
  );
  assert.equal(applied.outcome, 'applied');
  assert.equal(isSettledOutcome(applied), true);
});

test('幂等重放的结果标记 replayed', () => {
  const applied = writeOutcomeSchema.parse({
    outcome: 'applied',
    operationId: OPERATION_ID,
    replayed: true,
    result: { sessionId: 's-1' },
  });
  assert.equal(applied.replayed, true);
});

test('revision 冲突的结果携带服务端版本', () => {
  const conflict = roundtrip(
    writeOutcomeSchema,
    {
      outcome: 'conflict',
      operationId: OPERATION_ID,
      code: 'revision-conflict',
      currentRevision: 9,
      fields: ['maxTokens'],
    },
    'conflict',
  );
  assert.equal(conflict.code, 'revision-conflict');
  assert.equal(conflict.currentRevision, 9);
});

test('未确认的结果必须携带查询间隔', () => {
  roundtrip(
    writeOutcomeSchema,
    { outcome: 'unconfirmed', operationId: OPERATION_ID, retryAfterMs: 500 },
    'unconfirmed',
  );
  expectReject(
    writeOutcomeSchema,
    { outcome: 'unconfirmed', operationId: OPERATION_ID },
    '未确认结果缺少查询间隔',
  );
});

test('未知的结果种类被拒绝', () => {
  expectReject(
    writeOutcomeSchema,
    { outcome: 'done', operationId: OPERATION_ID, replayed: false },
    '未知的结果种类',
  );
});

test('未登记的错误码被拒绝', () => {
  expectReject(chatdshErrorCodeSchema, 'not-a-registered-code', '未登记的错误码');
  expectReject(
    writeOutcomeSchema,
    { outcome: 'rejected', operationId: OPERATION_ID, code: 'not-a-registered-code' },
    '失败结果里的未登记错误码',
  );
});

test('操作标识与请求摘要按固定写法校验', () => {
  assert.equal(OPERATION_ID_PATTERN.test(OPERATION_ID), true);
  assert.equal(REQUEST_DIGEST_PATTERN.test(REQUEST_DIGEST), true);
  expectReject(operationRecordSchema, {
    operationId: 'short',
    requestDigest: REQUEST_DIGEST,
    state: 'applied',
    createdAt: 1,
    expiresAt: 2,
  }, '过短的操作标识');
  expectReject(operationRecordSchema, {
    operationId: OPERATION_ID,
    requestDigest: 'XYZ',
    state: 'applied',
    createdAt: 1,
    expiresAt: 2,
  }, '非法请求摘要');
});

test('操作记录的状态取值有界', () => {
  assert.deepEqual([...OPERATION_STATES], ['pending', 'applied', 'conflict', 'unconfirmed']);
  roundtrip(
    operationRecordSchema,
    { operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST, state: 'unconfirmed', createdAt: 1, expiresAt: 2 },
    '操作记录',
  );
  expectReject(operationRecordSchema, {
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    state: 'unknown-state',
    createdAt: 1,
    expiresAt: 2,
  }, '未知的操作状态');
});

test('重放判定按标识与摘要配对', () => {
  const record = operationRecordSchema.parse({
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    state: 'applied',
    createdAt: 1,
    expiresAt: 2,
  });
  assert.equal(decideReplay(undefined, { operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST }), 'execute');
  assert.equal(decideReplay(record, { operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST }), 'replayed');
  assert.equal(decideReplay(record, { operationId: OPERATION_ID, requestDigest: 'b'.repeat(64) }), 'digest-conflict');
});

test('分页参数有默认值与上限', () => {
  const defaults = listQuerySchema.parse({});
  assert.equal(defaults.limit, DEFAULT_PAGE_SIZE);
  assert.equal(MAX_PAGE_SIZE, 200);
  expectReject(listQuerySchema, { limit: MAX_PAGE_SIZE + 1 }, '超过每页上限');
  expectReject(listQuerySchema, { limit: 0 }, '每页为零');
  expectReject(listQuerySchema, { cursor: '不合法 游标' }, '含空格的游标');
  roundtrip(listQuerySchema, { cursor: 'eyJhIjoxfQ', limit: 100, order: 'title-asc' }, '列表查询');
  expectReject(listQuerySchema, { order: 'random' }, '未知排序方式');
});

test('分页信息与列表形状可以往返', () => {
  roundtrip(pageInfoSchema, { hasMore: true, nextCursor: 'abc' }, '分页信息');
  expectReject(pageInfoSchema, { nextCursor: 'abc' }, '缺少是否还有更多数据的标记');
  const page = pageSchemaOf(identifierSchema);
  const parsed = roundtrip(page, { items: ['a', 'b'], page: { hasMore: false } }, '一页列表');
  assert.deepEqual(parsed.items, ['a', 'b']);
  expectReject(page, { items: [1, 2], page: { hasMore: false } }, '条目类型不符');
});

test('停止请求的应答区分已停止与未确认', () => {
  roundtrip(stopAckSchema, { outcome: 'stopped', runId: 'run-1' }, '已停止');
  roundtrip(stopAckSchema, { outcome: 'unconfirmed', runId: 'run-1', code: 'stop-unconfirmed' }, '停止未确认');
  expectReject(stopAckSchema, { outcome: 'stopped-maybe' }, '未知的停止应答');
});
