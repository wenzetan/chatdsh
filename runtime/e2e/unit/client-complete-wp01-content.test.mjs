// 内容范围、副本读取、继续会话与草稿契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-content.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_READ_SOURCES,
  CONTINUE_MODES,
  DRAFT_EXCLUDED_CONTENT,
  OFFLINE_SEND_RESULT,
  READ_ONLY_REASONS,
  REFERENCE_KINDS,
  REPLICA_AVAILABILITY,
  WRITE_LEASE_STATES,
  contentReadStateSchema,
  contentScopeSchema,
  continueRequestSchema,
  draftKeySchema,
  draftRecordSchema,
  draftReferenceSchema,
  draftWriteResultSchema,
  forkEstimateSchema,
  forkResultSchema,
  replicaAvailabilitySchema,
  writeLeaseSchema,
} from '../../packages/core/contracts/lib/index.js';
import {
  CONTENT_SCOPE,
  OPERATION_ID,
  REQUEST_DIGEST,
  assertNoWatermark,
  expectReject,
  roundtrip,
} from './client-complete-wp01-support.mjs';

test('内容范围按回合编号表达且不得倒置', () => {
  const scope = roundtrip(contentScopeSchema, CONTENT_SCOPE, '内容范围');
  assert.equal(scope.turnTo, 4);
  assertNoWatermark(scope, '内容范围');
  expectReject(contentScopeSchema, { ...CONTENT_SCOPE, turnFrom: 5, turnTo: 4 }, '结束回合小于起始回合');
  expectReject(contentScopeSchema, { ...CONTENT_SCOPE, turnFrom: 0 }, '起始回合为零');
  expectReject(contentScopeSchema, { ...CONTENT_SCOPE, eventCount: -1 }, '负的事件条数');
});

test('内容读取状态区分来源与只读原因', () => {
  const state = roundtrip(
    contentReadStateSchema,
    { source: 'replica', readAt: 1_700_000_000_000, scope: CONTENT_SCOPE, readOnlyReason: 'device-offline' },
    '内容读取状态',
  );
  assert.equal(state.source, 'replica');
  assertNoWatermark(state, '内容读取状态');
  assert.deepEqual([...CONTENT_READ_SOURCES], ['authoritative', 'replica', 'snapshot']);
  assert.deepEqual([...READ_ONLY_REASONS], ['device-offline', 'replica-only', 'public-snapshot', 'permission']);
  expectReject(contentReadStateSchema, { ...state, source: 'cache' }, '未知的读取来源');
  expectReject(contentReadStateSchema, { ...state, readOnlyReason: 'sleeping' }, '未知的只读原因');
  expectReject(contentReadStateSchema, { source: 'replica', readAt: 1 }, '缺少内容范围');
});

test('副本可用状态与内容范围、读取时间成对出现', () => {
  assert.deepEqual([...REPLICA_AVAILABILITY], ['complete', 'partial', 'missing']);
  const complete = roundtrip(
    replicaAvailabilitySchema,
    { state: 'complete', scope: CONTENT_SCOPE, readAt: 1_700_000_000_000 },
    '副本完整',
  );
  assert.equal(complete.state, 'complete');
  const partial = roundtrip(
    replicaAvailabilitySchema,
    { state: 'partial', scope: { ...CONTENT_SCOPE, turnTo: 2 }, readAt: 1_700_000_000_000 },
    '副本部分可用',
  );
  assert.equal(partial.scope.turnTo, 2);
  const missing = roundtrip(replicaAvailabilitySchema, { state: 'missing' }, '副本缺失');
  assert.equal(missing.scope, undefined);
  expectReject(replicaAvailabilitySchema, { state: 'missing', scope: CONTENT_SCOPE }, '缺失却带内容范围');
  expectReject(replicaAvailabilitySchema, { state: 'complete', readAt: 1 }, '可用却缺内容范围');
  expectReject(replicaAvailabilitySchema, { state: 'complete', scope: CONTENT_SCOPE }, '可用却缺读取时间');
  expectReject(replicaAvailabilitySchema, { state: 'unknown' }, '未知的副本状态');
});

test('继续会话的两种方式各自校验', () => {
  assert.deepEqual([...CONTINUE_MODES], ['remote', 'local']);
  roundtrip(
    continueRequestSchema,
    { mode: 'remote', sessionId: 'session-1', deviceId: 'device-1' },
    '在远程继续',
  );
  const local = roundtrip(
    continueRequestSchema,
    {
      mode: 'local',
      importMode: 'full-prefix',
      sourceSessionId: 'session-1',
      sourceDeviceId: 'device-1',
      targetDeviceId: 'device-2',
      targetCwd: '/srv/work',
      scope: CONTENT_SCOPE,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
    },
    '在本机继续',
  );
  assert.equal(local.importMode, 'full-prefix');
  expectReject(
    continueRequestSchema,
    { mode: 'remote', sessionId: 'session-1' },
    '远程继续缺少设备',
  );
  expectReject(
    continueRequestSchema,
    { mode: 'local', importMode: 'full-prefix', sourceSessionId: 'session-1', sourceDeviceId: 'device-1', targetDeviceId: 'device-2', scope: CONTENT_SCOPE, operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '本机继续缺少目标目录',
  );
  expectReject(
    continueRequestSchema,
    { mode: 'local', importMode: 'compressed', sourceSessionId: 'session-1', sourceDeviceId: 'device-1', targetDeviceId: 'device-2', targetCwd: '/srv/work', scope: CONTENT_SCOPE, operationId: OPERATION_ID },
    '本机继续缺少请求摘要',
  );
  expectReject(
    continueRequestSchema,
    { mode: 'local', importMode: 'compact', sourceSessionId: 'session-1', sourceDeviceId: 'device-1', targetDeviceId: 'device-2', targetCwd: '/srv/work', scope: CONTENT_SCOPE, operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '未知的复制方式',
  );
});

test('fork 预估不含内部序号并列出附件缺失', () => {
  const estimate = roundtrip(
    forkEstimateSchema,
    {
      importMode: 'compressed',
      scope: CONTENT_SCOPE,
      eventCount: 21,
      charCount: 4096,
      source: { state: 'partial', scope: CONTENT_SCOPE, readAt: 1_700_000_000_000 },
      missingAttachmentIds: ['attachment-1'],
      compressionLoss: true,
    },
    'fork 预估',
  );
  assert.equal(estimate.compressionLoss, true);
  assertNoWatermark(estimate, 'fork 预估');
  const result = roundtrip(
    forkResultSchema,
    { sessionId: 'session-2', deviceId: 'device-2', cwd: '/srv/work', parentSession: 'session-1', createdAt: 1_700_000_000_000 },
    'fork 结果',
  );
  assert.equal(result.parentSession, 'session-1');
  expectReject(forkResultSchema, { sessionId: 'session-2', deviceId: 'device-2', cwd: '/srv/work', createdAt: 1 }, '缺少父会话');
});

test('写租约只显示占用方与期限', () => {
  assert.deepEqual([...WRITE_LEASE_STATES], ['free', 'held', 'expired']);
  const held = roundtrip(
    writeLeaseSchema,
    {
      sessionId: 'session-1',
      state: 'held',
      holderDeviceId: 'device-1',
      holderProcess: 'dsh-runtime',
      acquiredAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    },
    '占用中的写租约',
  );
  assert.equal(held.state, 'held');
  assertNoWatermark(held, '写租约');
  roundtrip(writeLeaseSchema, { sessionId: 'session-1', state: 'free' }, '空闲的写租约');
  expectReject(writeLeaseSchema, { sessionId: 'session-1', state: 'locked' }, '未知的租约状态');
});

test('草稿键按客户端、窗口、设备与会话保存', () => {
  const key = roundtrip(
    draftKeySchema,
    { clientId: 'client-1', windowId: 'window-1', deviceId: 'device-1', sessionId: 'session-1' },
    '草稿键',
  );
  assert.equal(key.windowId, 'window-1');
  roundtrip(draftKeySchema, { clientId: 'client-1', windowId: 'window-1', deviceId: 'device-1' }, '未指定会话的草稿键');
  expectReject(draftKeySchema, { clientId: 'client-1', windowId: 'window-1' }, '缺少设备标识');
  expectReject(draftKeySchema, { clientId: 'client-1', deviceId: 'device-1' }, '缺少窗口标识');
});

test('草稿记录排除凭据、记忆查询与工具原文', () => {
  const draft = roundtrip(
    draftRecordSchema,
    {
      key: { clientId: 'client-1', windowId: 'window-1', deviceId: 'device-1' },
      text: '继续排查',
      references: [{ kind: 'file', id: 'file-1', label: 'main.ts', available: false }],
      attachments: [{ id: 'attachment-1', filename: 'log.txt', mimeType: 'text/plain', size: 1024, confirmed: true, needsReselect: true }],
      revision: 2,
      updatedAt: 1_700_000_000_000,
    },
    '草稿记录',
  );
  assert.equal(draft.attachments[0].needsReselect, true);
  assert.deepEqual([...DRAFT_EXCLUDED_CONTENT], ['credentials', 'memory-query', 'tool-body', 'unconfirmed-attachment-bytes']);
  assert.ok(REFERENCE_KINDS.includes('skill'));
  expectReject(
    draftRecordSchema,
    { ...draft, attachments: [{ ...draft.attachments[0], confirmed: false }] },
    '未确认的附件进入草稿',
  );
  expectReject(
    draftReferenceSchema,
    { kind: 'bookmark', id: 'x', label: 'x', available: true },
    '未知的引用种类',
  );
  expectReject(draftRecordSchema, { ...draft, text: 'x'.repeat(262145) }, '草稿文本超过上限');
});

test('草稿写入结果与离线发送结果固定', () => {
  const saved = roundtrip(draftWriteResultSchema, { outcome: 'saved', revision: 3 }, '草稿保存');
  assert.equal(saved.revision, 3);
  const failed = roundtrip(
    draftWriteResultSchema,
    { outcome: 'rejected', reason: 'storage-full' },
    '草稿写入失败',
  );
  assert.equal(failed.reason, 'storage-full');
  expectReject(draftWriteResultSchema, { outcome: 'rejected', reason: 'disk-full' }, '未知的失败原因');
  assert.equal(OFFLINE_SEND_RESULT.code, 'device-offline');
  assert.equal(OFFLINE_SEND_RESULT.draftKept, true);
  assert.equal(OFFLINE_SEND_RESULT.queued, false);
});
