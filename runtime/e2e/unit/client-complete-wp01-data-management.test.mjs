// 数据管理契约的单元测试：用量、副本清理、删除收件箱与血缘。
//
// 运行：node --test e2e/unit/client-complete-wp01-data-management.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETENTION_DAYS_RANGE,
  USAGE_DIMENSIONS,
  cleanupEstimateSchema,
  cleanupResultSchema,
  deletionInboxItemSchema,
  lineageNodeSchema,
  permanentDeleteScopeSchema,
  restoreRequestSchema,
  restoreResultSchema,
  usageRowSchema,
} from '../../packages/core/contracts/lib/index.js';
import {
  CONTENT_SCOPE,
  OPERATION_ID,
  REQUEST_DIGEST,
  assertNoWatermark,
  expectReject,
  roundtrip,
} from './client-complete-wp01-support.mjs';

const USAGE = {
  dimension: 'device',
  key: 'device-1',
  sessionCount: 12,
  textReplicaBytes: 1048576,
  attachmentBytes: 2097152,
  lastActiveAt: 1_700_000_000_000,
  retentionDays: 90,
};

const INBOX_ITEM = {
  sessionId: 'session-1',
  title: '已删除的排障记录',
  originDeviceId: 'device-1',
  deletedAt: 1_700_000_000_000,
  retentionExpiresAt: 1_702_592_000_000,
  remainingDays: 30,
  bytes: 8192,
  restorable: true,
  hasShareDependency: false,
};

test('用量行可以往返且不含副本水位', () => {
  const usage = roundtrip(usageRowSchema, USAGE, '用量行');
  assert.equal(usage.retentionDays, 90);
  assertNoWatermark(usage, '用量行');
  assert.deepEqual([...USAGE_DIMENSIONS], ['device', 'workspace', 'session']);
  expectReject(usageRowSchema, { ...USAGE, dimension: 'account' }, '未知的用量维度');
  expectReject(usageRowSchema, { ...USAGE, textReplicaBytes: -1 }, '负的副本字节数');
});

test('副本保留周期按允许范围校验', () => {
  assert.equal(RETENTION_DAYS_RANGE.default, 90);
  expectReject(usageRowSchema, { ...USAGE, retentionDays: RETENTION_DAYS_RANGE.min - 1 }, '低于保留下限');
  expectReject(usageRowSchema, { ...USAGE, retentionDays: RETENTION_DAYS_RANGE.max + 1 }, '高于保留上限');
});

test('清理预估与实际结果分开表达', () => {
  const estimate = roundtrip(
    cleanupEstimateSchema,
    {
      estimateId: 'estimate-1',
      objectCount: 40,
      reclaimableBytes: 1048576,
      retentionDays: 90,
      estimatedAt: 1_700_000_000_000,
      dependentShares: 1,
      activeImports: 0,
    },
    '清理预估',
  );
  assert.equal(estimate.dependentShares, 1);
  assertNoWatermark(estimate, '清理预估');
  const result = roundtrip(
    cleanupResultSchema,
    {
      cleanupId: 'cleanup-1',
      estimatedBytes: 1048576,
      reclaimedBytes: 1040000,
      finishedAt: 1_700_000_100_000,
      authoritativeLogsPreserved: true,
    },
    '清理结果',
  );
  assert.equal(result.authoritativeLogsPreserved, true);
  expectReject(
    cleanupResultSchema,
    { ...result, authoritativeLogsPreserved: false },
    '权威日志被标记为不保留',
  );
  expectReject(
    cleanupResultSchema,
    { ...result, code: 'unknown-code' },
    '未登记的错误码',
  );
});

test('删除收件箱条目显示剩余保留天数与依赖', () => {
  const item = roundtrip(deletionInboxItemSchema, INBOX_ITEM, '删除收件箱条目');
  assert.equal(item.remainingDays, 30);
  assertNoWatermark(item, '删除收件箱条目');
  const dependent = roundtrip(
    deletionInboxItemSchema,
    { ...INBOX_ITEM, hasShareDependency: true },
    '带分享依赖的条目',
  );
  assert.equal(dependent.hasShareDependency, true);
  expectReject(deletionInboxItemSchema, { ...INBOX_ITEM, remainingDays: -1 }, '负的剩余天数');
});

test('恢复请求与结果区分恢复成功与过期', () => {
  roundtrip(
    restoreRequestSchema,
    { sessionId: 'session-1', operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '恢复请求',
  );
  expectReject(restoreRequestSchema, { sessionId: 'session-1', operationId: OPERATION_ID }, '缺少请求摘要');
  const restored = roundtrip(
    restoreResultSchema,
    { outcome: 'restored', sessionId: 'session-1', restoredAt: 1_700_000_000_000, scope: CONTENT_SCOPE },
    '恢复成功',
  );
  assert.equal(restored.sessionId, 'session-1');
  const expired = roundtrip(restoreResultSchema, { outcome: 'rejected', code: 'restore-expired' }, '恢复过期');
  assert.equal(expired.code, 'restore-expired');
  expectReject(restoreResultSchema, { outcome: 'rejected', code: 'unknown-code' }, '未登记的错误码');
  expectReject(restoreResultSchema, { outcome: 'restored', sessionId: 'session-1' }, '恢复成功缺少内容范围');
});

test('永久删除范围要求确认并列出对象种类', () => {
  const scope = roundtrip(
    permanentDeleteScopeSchema,
    {
      sessionId: 'session-1',
      objects: ['log', 'replica', 'object', 'share', 'attachment'],
      dependentShares: 1,
      bytes: 8192,
      requiresConfirm: true,
    },
    '永久删除范围',
  );
  assert.equal(scope.dependentShares, 1);
  expectReject(permanentDeleteScopeSchema, { ...scope, requiresConfirm: false }, '缺少确认标记');
  expectReject(permanentDeleteScopeSchema, { ...scope, objects: ['cache'] }, '未知的对象种类');
  expectReject(permanentDeleteScopeSchema, { ...scope, objects: [] }, '没有删除对象');
});

test('血缘节点显示继承内容范围', () => {
  const root = roundtrip(
    lineageNodeSchema,
    { sessionId: 'session-1', deviceId: 'device-1', cwd: '/srv/work', kind: 'work', createdAt: 1_700_000_000_000 },
    '根会话血缘',
  );
  assert.equal(root.inheritedScope, undefined);
  const forked = roundtrip(
    lineageNodeSchema,
    {
      sessionId: 'session-2',
      deviceId: 'device-2',
      cwd: '/srv/other',
       kind: 'work',
      createdAt: 1_700_000_100_000,
      parentSession: 'session-1',
      inheritedScope: CONTENT_SCOPE,
    },
    '分叉会话血缘',
  );
  assert.equal(forked.parentSession, 'session-1');
  assertNoWatermark(forked, '分叉会话血缘');
  expectReject(lineageNodeSchema, { ...root, kind: 'meeting' }, '未知的会话类型');
  expectReject(lineageNodeSchema, { ...root, deviceId: undefined }, '缺少归属设备');
});
