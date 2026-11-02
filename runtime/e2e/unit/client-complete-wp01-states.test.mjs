// 客户端共同状态与写操作状态契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-states.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_VIEW_STATES,
  EMPTY_REASONS,
  WRITE_ACTION_STATES,
  canTransitionWriteAction,
  clientViewStateSchema,
} from '../../packages/core/contracts/lib/index.js';
import { expectReject, roundtrip } from './client-complete-wp01-support.mjs';

test('状态矩阵登记全部读取与呈现状态', () => {
  assert.deepEqual([...CLIENT_VIEW_STATES], [
    'loading',
    'empty',
    'error',
    'readonly',
    'offline',
    'pending',
    'forbidden',
    'disabled',
    'danger',
    'degraded',
    'long',
  ]);
  for (const state of CLIENT_VIEW_STATES) {
    roundtrip(clientViewStateSchema, { state }, `状态 ${state}`);
  }
});

test('空状态区分没有记录、没有搜索结果与过滤后为空', () => {
  assert.deepEqual([...EMPTY_REASONS], ['no-records', 'no-results', 'filtered-out']);
  for (const emptyReason of EMPTY_REASONS) {
    const parsed = roundtrip(clientViewStateSchema, { state: 'empty', emptyReason }, `空状态 ${emptyReason}`);
    assert.equal(parsed.emptyReason, emptyReason);
  }
});

test('只读状态携带读取时间与只读原因', () => {
  const readonly = roundtrip(
    clientViewStateSchema,
    { state: 'readonly', readOnlyReason: 'replica-only', readAt: 1_700_000_000_000 },
    '只读状态',
  );
  assert.equal(readonly.readAt, 1_700_000_000_000);
  expectReject(clientViewStateSchema, { state: 'readonly', readOnlyReason: 'sleeping' }, '未知的只读原因');
});

test('失败状态携带错误码与对象标识', () => {
  const failed = roundtrip(
    clientViewStateSchema,
    { state: 'error', code: 'device-offline', objectRef: 'session-1', retryable: true },
    '失败状态',
  );
  assert.equal(failed.retryable, true);
  expectReject(clientViewStateSchema, { state: 'error', code: 'unknown-code' }, '未登记的错误码');
  expectReject(clientViewStateSchema, { state: 'unknown' }, '未知的状态');
});

test('长任务显示阶段、进度与已运行时长', () => {
  const running = roundtrip(
    clientViewStateSchema,
    { state: 'long', since: 1_700_000_000_000, stage: '正在生成导出', progress: 0.4 },
    '长任务状态',
  );
  assert.equal(running.progress, 0.4);
  const unknown = roundtrip(clientViewStateSchema, { state: 'long', since: 1_700_000_000_000, stage: '正在等待宿主' }, '未知进度的长任务');
  assert.equal(unknown.progress, undefined);
  expectReject(clientViewStateSchema, { state: 'long', progress: 1.5 }, '进度超出范围');
});

test('降级状态说明不可用的依赖', () => {
  const degraded = roundtrip(
    clientViewStateSchema,
    { state: 'degraded', degradedDependency: '记忆后端', code: 'memory-backend-unreachable', readAt: 1_700_000_000_000 },
    '降级状态',
  );
  assert.equal(degraded.degradedDependency, '记忆后端');
  const pendingView = roundtrip(clientViewStateSchema, { state: 'pending', pendingCount: 3, since: 1_700_000_000_000 }, '待处理状态');
  assert.equal(pendingView.pendingCount, 3);
});

test('写操作状态按迁移表推进', () => {
  assert.deepEqual([...WRITE_ACTION_STATES], [
    'validating',
    'submitting',
    'succeeded',
    'failed',
    'conflict',
    'unconfirmed',
  ]);
  assert.equal(canTransitionWriteAction('validating', 'submitting'), true);
  assert.equal(canTransitionWriteAction('submitting', 'succeeded'), true);
  assert.equal(canTransitionWriteAction('submitting', 'conflict'), true);
  assert.equal(canTransitionWriteAction('submitting', 'unconfirmed'), true);
  assert.equal(canTransitionWriteAction('unconfirmed', 'succeeded'), true);
  assert.equal(canTransitionWriteAction('succeeded', 'submitting'), false);
  assert.equal(canTransitionWriteAction('failed', 'submitting'), true);
  assert.equal(canTransitionWriteAction('conflict', 'succeeded'), false);
});
