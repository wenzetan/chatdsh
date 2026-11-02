// 导出与打印范围契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-exports.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_POLICIES,
  EXPORT_EXCLUDED_CONTENT,
  EXPORT_FORMATS,
  EXPORT_STATES,
  PRINT_EXCLUSIONS,
  exportAttachmentSchema,
  exportCreateRequestSchema,
  exportEstimateSchema,
  exportJobSchema,
  exportScopeSchema,
  exportSourceSchema,
  printScopeSchema,
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
  source: { kind: 'session', sessionId: 'session-1' },
  scope: CONTENT_SCOPE,
  format: 'markdown',
  includeToolReads: false,
  attachmentPolicy: 'include-missing-list',
  timeDisplay: 'local',
  redaction: 'default',
  privateExport: false,
};

test('导出源区分会话与制品版本', () => {
  roundtrip(exportSourceSchema, { kind: 'session', sessionId: 'session-1' }, '会话导出源');
  roundtrip(exportSourceSchema, { kind: 'artifact', artifactId: 'artifact-1', version: 2 }, '制品导出源');
  expectReject(exportSourceSchema, { kind: 'artifact', artifactId: 'artifact-1' }, '制品导出源缺少版本');
  expectReject(exportSourceSchema, { kind: 'workspace', workspaceId: 'w-1' }, '未知的导出源种类');
});

test('原始 JSONL 导出需要私有导出权限', () => {
  const jsonl = roundtrip(exportScopeSchema, { ...SCOPE, format: 'jsonl', privateExport: true }, '原始 JSONL 导出');
  assert.equal(jsonl.format, 'jsonl');
  expectReject(exportScopeSchema, { ...SCOPE, format: 'jsonl' }, '缺少私有导出权限的 JSONL');
  roundtrip(exportScopeSchema, { ...SCOPE, format: 'pdf' }, 'PDF 导出');
  expectReject(exportScopeSchema, { ...SCOPE, format: 'docx' }, '未登记的导出格式');
  assert.ok(EXPORT_FORMATS.includes('html'));
  assert.ok(ATTACHMENT_POLICIES.includes('available-only'));
  assert.ok(EXPORT_EXCLUDED_CONTENT.includes('replica-watermark'));
});

test('导出请求携带操作标识与请求摘要', () => {
  roundtrip(exportCreateRequestSchema, { operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST, scope: SCOPE }, '导出请求');
  expectReject(exportCreateRequestSchema, { operationId: OPERATION_ID, scope: SCOPE }, '缺少请求摘要');
  expectReject(
    exportCreateRequestSchema,
    { operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST, scope: { ...SCOPE, format: 'txt' } },
    '未登记的导出格式',
  );
});

test('附件状态区分可下载、缺失与需要源设备', () => {
  roundtrip(exportAttachmentSchema, { id: 'attachment-1', filename: 'report.pdf', state: 'downloadable', size: 1024 }, '可下载附件');
  roundtrip(exportAttachmentSchema, { id: 'attachment-2', filename: 'lost.png', state: 'missing' }, '缺失附件');
  roundtrip(
    exportAttachmentSchema,
    { id: 'attachment-3', filename: 'remote.zip', state: 'needs-source-device' },
    '需要源设备的附件',
  );
  expectReject(
    exportAttachmentSchema,
    { id: 'attachment-1', filename: 'report.pdf', state: 'pending' },
    '未知的附件状态',
  );
});

test('导出任务可以往返且不含副本水位', () => {
  const job = roundtrip(
    exportJobSchema,
    {
      jobId: 'job-1',
      state: 'generating',
      scope: SCOPE,
      estimate: {
        eventCount: 21,
        charCount: 4096,
        bytes: 8192,
        attachments: [{ id: 'attachment-1', filename: 'report.pdf', state: 'downloadable', size: 1024 }],
      },
      createdAt: 1_700_000_000_000,
    },
    '导出任务',
  );
  assert.equal(job.state, 'generating');
  assertNoWatermark(job, '导出任务');
  assert.deepEqual([...EXPORT_STATES], ['estimated', 'generating', 'cancelling', 'completed', 'failed', 'expired']);
  expectReject(exportJobSchema, { ...job, state: 'exported' }, '未知的导出状态');
  const completed = roundtrip(
    exportJobSchema,
    { ...job, state: 'completed', completedAt: 1_700_000_100_000, expiresAt: 1_700_000_900_000 },
    '完成的导出任务',
  );
  assert.equal(completed.state, 'completed');
  expectReject(
    exportJobSchema,
    { ...job, state: 'failed', code: 'unknown-code' },
    '未登记的错误码',
  );
  roundtrip(exportEstimateSchema, job.estimate, '导出预估');
});

test('打印范围去掉导航与交互部分', () => {
  const printScope = roundtrip(
    printScopeSchema,
    {
      title: '会话导出',
      scope: CONTENT_SCOPE,
      pageNumbers: true,
      codeWrapping: 'wrap',
      repeatTableHeader: true,
      excluded: ['navigation', 'composer', 'interaction-buttons'],
    },
    '打印范围',
  );
  assert.deepEqual([...printScope.excluded], ['navigation', 'composer', 'interaction-buttons']);
  assertNoWatermark(printScope, '打印范围');
  expectReject(
    printScopeSchema,
    { ...printScope, excluded: ['sidebar'] },
    '未知的排除部分',
  );
  expectReject(printScopeSchema, { ...printScope, codeWrapping: 'clip' }, '未知的代码换行方式');
  assert.deepEqual([...PRINT_EXCLUSIONS], ['navigation', 'composer', 'interaction-buttons']);
});
