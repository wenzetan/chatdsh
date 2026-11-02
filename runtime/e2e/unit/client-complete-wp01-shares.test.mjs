// 分享范围、过滤与公开快照契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-shares.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARE_DEFAULT_EXCLUSIONS,
  SHARE_STATUSES,
  publicSnapshotSchema,
  shareCreateRequestSchema,
  sharePreviewSchema,
  shareRecordViewSchema,
  shareRevokeResultSchema,
  shareScopeSchema,
  shareUnavailableSchema,
} from '../../packages/core/contracts/lib/index.js';
import {
  CONTENT_SCOPE,
  OPERATION_ID,
  REQUEST_DIGEST,
  assertNoWatermark,
  expectReject,
  roundtrip,
} from './client-complete-wp01-support.mjs';

const SCOPE = {
  scope: CONTENT_SCOPE,
  includeUserText: true,
  includeAssistantText: true,
  attachmentIds: ['attachment-1'],
};

const RECORD = {
  shareId: 'share-1',
  sourceSessionId: 'session-1',
  title: '排障记录',
  scope: CONTENT_SCOPE,
  status: 'active',
  createdAt: 1_700_000_000_000,
  visits: 3,
  bytes: 8192,
};

test('分享范围至少公开一种文本', () => {
  const scope = roundtrip(shareScopeSchema, SCOPE, '分享范围');
  assert.deepEqual([...scope.attachmentIds], ['attachment-1']);
  expectReject(
    shareScopeSchema,
    { ...SCOPE, includeUserText: false, includeAssistantText: false },
    '两种文本都不公开',
  );
  roundtrip(
    shareScopeSchema,
    { ...SCOPE, includeUserText: false, includeAssistantText: true, attachmentIds: [] },
    '仅公开助手消息',
  );
});

test('建立分享请求携带操作标识与源会话', () => {
  roundtrip(
    shareCreateRequestSchema,
    { operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST, sessionId: 'session-1', scope: SCOPE, ttlMs: 86_400_000 },
    '建立分享请求',
  );
  expectReject(
    shareCreateRequestSchema,
    { operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST, scope: SCOPE },
    '缺少源会话',
  );
  expectReject(
    shareCreateRequestSchema,
    { operationId: OPERATION_ID, sessionId: 'session-1', scope: SCOPE },
    '缺少请求摘要',
  );
});

test('分享列表条目不显示内部序号与副本水位', () => {
  const record = roundtrip(shareRecordViewSchema, RECORD, '分享列表条目');
  assert.equal(record.status, 'active');
  assertNoWatermark(record, '分享列表条目');
  assert.ok(!JSON.stringify(record).includes('upToSeq'));
  assert.deepEqual([...SHARE_STATUSES], ['active', 'revoked', 'expired']);
  expectReject(shareRecordViewSchema, { ...RECORD, status: 'paused' }, '未知的分享状态');
  for (const status of SHARE_STATUSES) {
    roundtrip(shareRecordViewSchema, { ...RECORD, status }, `分享状态 ${status}`);
  }
});

test('分享预览列出公开内容与过滤项', () => {
  const preview = roundtrip(
    sharePreviewSchema,
    {
      scope: CONTENT_SCOPE,
      messageCount: 12,
      attachments: [{ id: 'attachment-1', filename: 'log.txt', downloadable: true }],
      excluded: ['memory-recall', 'tool-arguments', 'internal-paths', 'sensitive-metadata', 'replica-watermark'],
    },
    '分享预览',
  );
  assert.equal(preview.messageCount, 12);
  assert.deepEqual([...SHARE_DEFAULT_EXCLUSIONS], [
    'memory-recall',
    'tool-arguments',
    'internal-paths',
    'sensitive-metadata',
    'replica-watermark',
  ]);
  expectReject(sharePreviewSchema, { ...preview, excluded: ['secrets'] }, '未登记的过滤项');
  assertNoWatermark(preview, '分享预览');
});

test('公开快照只读且没有交互动作', () => {
  const snapshot = roundtrip(
    publicSnapshotSchema,
    {
      title: '排障记录',
      createdAt: 1_700_000_000_000,
      readOnly: true,
      scope: CONTENT_SCOPE,
      attachments: [{ id: 'attachment-1', filename: 'log.txt', size: 1024, downloadable: true }],
      canPrint: true,
      interactive: false,
    },
    '公开快照',
  );
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.interactive, false);
  assertNoWatermark(snapshot, '公开快照');
  expectReject(
    publicSnapshotSchema,
    { ...snapshot, interactive: true },
    '公开快照启用了交互',
  );
  expectReject(publicSnapshotSchema, { ...snapshot, readOnly: false }, '公开快照不是只读');
  expectReject(publicSnapshotSchema, { ...snapshot, canPrint: 'yes' }, '打印标记类型不符');
});

test('撤销结果与失效原因分开表达', () => {
  const revoked = roundtrip(shareRevokeResultSchema, { shareId: 'share-1', revokedAt: 1_700_000_100_000, status: 'revoked' }, '撤销分享');
  assert.equal(revoked.status, 'revoked');
  const unavailable = roundtrip(shareUnavailableSchema, { code: 'share-unavailable', reason: 'expired' }, '分享失效');
  assert.equal(unavailable.reason, 'expired');
  expectReject(shareUnavailableSchema, { code: 'share-unavailable', reason: 'deleted' }, '未知的失效原因');
  expectReject(shareUnavailableSchema, { code: 'unknown-code', reason: 'expired' }, '未登记的错误码');
});
