/**
 * 数据管理界面消费的对外形状。
 *
 * 形状优先取跨组件契约里的 schema（用量行、清理预估与结果、删除收件箱条目、恢复结果、永久删除
 * 范围、血缘节点、副本可用状态）；契约没有覆盖的界面视图在这里补齐并做交叉核对：分类字节之和
 * 必须等于总量，附件完整性必须与缺失附件一致，分叉的不重放计数必须为零。每个解析结果在返回前
 * 统一检查内部游标字段。
 * @module @chatdsh/client-data-management/schemas
 */

import { z } from 'zod';
import {
  CONTENT_READ_SOURCES,
  READ_ONLY_REASONS,
  cleanupEstimateSchema,
  cleanupResultSchema,
  contentScopeSchema,
  countSchema,
  deletionInboxItemSchema,
  displayNameSchema,
  epochMillisSchema,
  identifierSchema,
  lineageNodeSchema,
  permanentDeleteScopeSchema,
  replicaAvailabilitySchema,
  restoreRequestSchema,
  restoreResultSchema,
  retentionDaysSchema,
  usageRowSchema,
} from '@chatdsh/core-contracts';
import { assertNoInternalCursor } from './cursor.ts';
import { DataCallError, LOCAL_ERROR_CODES } from './errors.ts';

/** 一个来源分类的读数。 */
const usageBucketSchema = z.object({
  bytes: countSchema,
  files: countSchema,
});

/** 一次用量统计的对外形状。 */
export const usageReportSchema = z
  .object({
    measuredAt: epochMillisSchema,
    root: z.string().min(1),
    deviceId: identifierSchema,
    retentionDays: retentionDaysSchema,
    totalBytes: countSchema,
    fileCount: countSchema,
    buckets: z.object({
      session: usageBucketSchema,
      replica: usageBucketSchema,
      attachment: usageBucketSchema,
      memory: usageBucketSchema,
      other: usageBucketSchema,
    }),
    rows: z.array(usageRowSchema),
    replicaSource: z.enum(['measured', 'absent']),
    replica: z.object({
      sessions: countSchema,
      payloadBytes: countSchema,
      tableBytes: countSchema,
      databaseBytes: countSchema,
    }),
  })
  .refine(
    (report) => Object.values(report.buckets).reduce((sum, bucket) => sum + bucket.bytes, 0) === report.totalBytes,
    { message: '分类字节之和必须等于总量', path: ['totalBytes'] },
  );

/** 一次用量统计的对外形状。 */
export type UsageReport = z.infer<typeof usageReportSchema>;

/** 副本保留策略的对外形状。 */
export const retentionPolicySchema = z.object({
  days: retentionDaysSchema,
  updatedAt: epochMillisSchema.optional(),
  defaulted: z.boolean(),
});

/** 副本保留策略的对外形状。 */
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

/** 预估里的一个对象。 */
export const cleanupCandidateSchema = z.object({
  sessionId: identifierSchema,
  /** 归属设备；孤儿副本没有归属记录时为空字符串。 */
  deviceId: z.string().max(200),
  workspaceId: identifierSchema.optional(),
  replicaBytes: countSchema,
  eventCount: countSchema,
  lastEventAt: epochMillisSchema,
  expiresAt: epochMillisSchema,
  dependentShares: countSchema,
  activeImports: countSchema,
});

/** 预估里的一个对象。 */
export type CleanupCandidate = z.infer<typeof cleanupCandidateSchema>;

/** 一次清理预估的对外形状。 */
export const cleanupEstimateViewSchema = cleanupEstimateSchema.extend({
  candidates: z.array(cleanupCandidateSchema),
});

/** 一次清理预估的对外形状。 */
export type CleanupEstimateView = z.infer<typeof cleanupEstimateViewSchema>;

/** 一次清理执行的对外形状。 */
export const cleanupOutcomeSchema = cleanupResultSchema.extend({
  removedSessions: countSchema,
  removedEvents: countSchema,
  dependencies: z.object({ shares: countSchema, imports: countSchema }),
});

/** 一次清理执行的对外形状。 */
export type CleanupOutcome = z.infer<typeof cleanupOutcomeSchema>;

/** 一条血缘链的对外形状。 */
export const lineageChainSchema = z.object({
  sessionId: identifierSchema,
  rootSessionId: identifierSchema,
  depth: countSchema,
  ancestors: z.array(lineageNodeSchema),
  self: lineageNodeSchema,
  children: z.array(lineageNodeSchema),
  descendants: z.array(lineageNodeSchema),
});

/** 一条血缘链的对外形状。 */
export type LineageChain = z.infer<typeof lineageChainSchema>;

/** 只读副本的对外形状。 */
export const replicaStateSchema = z.object({
  sessionId: identifierSchema,
  replica: replicaAvailabilitySchema,
  source: z.enum(CONTENT_READ_SOURCES),
  readOnlyReason: z.enum(READ_ONLY_REASONS).optional(),
  retentionDays: retentionDaysSchema,
  missingAttachments: countSchema,
});

/** 只读副本的对外形状。 */
export type ReplicaState = z.infer<typeof replicaStateSchema>;

/** 分叉预估的对外形状。 */
export const forkEstimateViewSchema = z
  .object({
    importMode: z.enum(['full-prefix', 'compressed']),
    scope: contentScopeSchema,
    eventCount: countSchema,
    charCount: countSchema,
    missingAttachmentIds: z.array(identifierSchema),
    compressionLoss: z.boolean(),
  })
  .refine(
    (estimate) => estimate.scope.attachmentsComplete === (estimate.missingAttachmentIds.length === 0),
    { message: '附件完整标记必须与缺失附件一致', path: ['scope', 'attachmentsComplete'] },
  )
  .refine((estimate) => estimate.scope.eventCount === estimate.eventCount, {
    message: '范围内的事件条数必须与预估一致',
    path: ['eventCount'],
  });

/** 分叉预估的对外形状。 */
export type ForkEstimateView = z.infer<typeof forkEstimateViewSchema>;

/** 不重放的校验记录。 */
export const forkReplayViewSchema = z.object({
  /** 重放的工具调用数，恒为零。 */
  replayedToolCalls: z.literal(0),
  /** 重放的定时任务数，恒为零。 */
  replayedScheduledTasks: z.literal(0),
  /** 留在源会话上的定时任务数。 */
  retainedScheduledTasks: countSchema,
  /** 压缩复制移出的工具调用数。 */
  droppedToolCalls: countSchema,
  /** 压缩复制移出的工具结果数。 */
  droppedToolResults: countSchema,
  /** 前缀里没有结果的工具调用数。 */
  unresolvedToolCalls: countSchema,
});

/** 不重放的校验记录。 */
export type ForkReplayView = z.infer<typeof forkReplayViewSchema>;

/** 分叉结果的对外形状。 */
export const forkOutcomeViewSchema = z.object({
  sessionId: identifierSchema,
  parentSession: identifierSchema,
  cwd: z.string().min(1),
  createdAt: epochMillisSchema,
  estimate: forkEstimateViewSchema,
  replay: forkReplayViewSchema,
});

/** 分叉结果的对外形状。 */
export type ForkOutcomeView = z.infer<typeof forkOutcomeViewSchema>;

/** 删除收件箱的对外形状。 */
export const deletionInboxViewSchema = z.array(deletionInboxItemSchema);

/** 删除收件箱条目的对外形状。 */
export type DeletionInboxItem = z.infer<typeof deletionInboxItemSchema>;

/** 永久删除的一项依赖。 */
export const deletionDependencySchema = z.object({
  kind: z.enum(['share', 'memory-group']),
  label: displayNameSchema,
  createdAt: epochMillisSchema.optional(),
  expiresAt: epochMillisSchema.optional(),
  visits: countSchema.optional(),
});

/** 永久删除的一项依赖。 */
export type DeletionDependency = z.infer<typeof deletionDependencySchema>;

/** 永久删除范围的对外形状。 */
export const permanentScopeViewSchema = permanentDeleteScopeSchema.extend({
  dependencies: z.array(deletionDependencySchema),
});

/** 永久删除范围的对外形状。 */
export type PermanentScopeView = z.infer<typeof permanentScopeViewSchema>;

/** 永久删除结果的对外形状。 */
export const permanentOutcomeViewSchema = z.object({
  sessionId: identifierSchema,
  deletedAt: epochMillisSchema,
  removedEvents: countSchema,
  removedShares: countSchema,
  removedReceipts: countSchema,
  releasedBytes: countSchema,
  dependencies: z.object({ shares: countSchema, memoryGroups: countSchema }),
  authoritativeLogsPreserved: z.literal(true),
});

/** 永久删除结果的对外形状。 */
export type PermanentOutcomeView = z.infer<typeof permanentOutcomeViewSchema>;

/** 恢复请求的对外形状。 */
export const restoreRequestViewSchema = restoreRequestSchema;

/** 恢复结果的对外形状。 */
export const restoreResultViewSchema = restoreResultSchema;

/** 恢复结果的对外形状。 */
export type RestoreResultView = z.infer<typeof restoreResultViewSchema>;

/**
 * 按 schema 解析一次应答。
 *
 * 解析前后各做一次内部游标检查：解析前检查原始应答，解析后检查最终形状。schema 会丢掉没有
 * 声明的字段，只在解析后检查就会把带副本序号的应答悄悄放过去。
 * @param schema - 目标形状。
 * @param value - 应答体。
 * @param label - 形状名称，写进失败说明。
 * @returns 解析后的形状。
 * @throws DataCallError - 形状不符或带内部游标字段。
 */
function parseAs<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  assertNoInternalCursor(value, label);
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined ? '' : issue.path.map(String).join('.');
    throw new DataCallError(
      LOCAL_ERROR_CODES.invalidResponse,
      `${label}的形状不符合约定${path === '' ? '' : `：${path}`}`,
    );
  }
  assertNoInternalCursor(result.data, label);
  return result.data;
}

/**
 * 解析用量读数。
 * @param value - 应答体。
 * @returns 用量读数。
 */
export function parseUsageReport(value: unknown): UsageReport {
  return parseAs(usageReportSchema, value, '用量读数');
}

/**
 * 解析保留策略。
 * @param value - 应答体。
 * @returns 保留策略。
 */
export function parseRetentionPolicy(value: unknown): RetentionPolicy {
  return parseAs(retentionPolicySchema, value, '保留策略');
}

/**
 * 解析清理预估。
 * @param value - 应答体。
 * @returns 清理预估。
 */
export function parseCleanupEstimate(value: unknown): CleanupEstimateView {
  return parseAs(cleanupEstimateViewSchema, value, '清理预估');
}

/**
 * 解析清理结果。
 * @param value - 应答体。
 * @returns 清理结果。
 */
export function parseCleanupOutcome(value: unknown): CleanupOutcome {
  return parseAs(cleanupOutcomeSchema, value, '清理结果');
}

/**
 * 解析血缘链。
 * @param value - 应答体。
 * @returns 血缘链。
 */
export function parseLineageChain(value: unknown): LineageChain {
  return parseAs(lineageChainSchema, value, '血缘链');
}

/**
 * 解析只读副本状态。
 * @param value - 应答体。
 * @returns 只读副本状态。
 */
export function parseReplicaState(value: unknown): ReplicaState {
  return parseAs(replicaStateSchema, value, '只读副本状态');
}

/**
 * 解析分叉预估。
 * @param value - 应答体。
 * @returns 分叉预估。
 */
export function parseForkEstimate(value: unknown): ForkEstimateView {
  return parseAs(forkEstimateViewSchema, value, '分叉预估');
}

/**
 * 解析分叉结果。
 * @param value - 应答体。
 * @returns 分叉结果。
 */
export function parseForkOutcome(value: unknown): ForkOutcomeView {
  return parseAs(forkOutcomeViewSchema, value, '分叉结果');
}

/**
 * 解析删除收件箱。
 * @param value - 应答体。
 * @returns 删除收件箱条目。
 */
export function parseDeletionInbox(value: unknown): readonly DeletionInboxItem[] {
  return parseAs(deletionInboxViewSchema, value, '删除收件箱');
}

/**
 * 解析永久删除范围。
 * @param value - 应答体。
 * @returns 永久删除范围。
 */
export function parsePermanentScope(value: unknown): PermanentScopeView {
  return parseAs(permanentScopeViewSchema, value, '永久删除范围');
}

/**
 * 解析永久删除结果。
 * @param value - 应答体。
 * @returns 永久删除结果。
 */
export function parsePermanentOutcome(value: unknown): PermanentOutcomeView {
  return parseAs(permanentOutcomeViewSchema, value, '永久删除结果');
}

/**
 * 解析恢复结果。
 * @param value - 应答体。
 * @returns 恢复结果。
 */
export function parseRestoreResult(value: unknown): RestoreResultView {
  return parseAs(restoreResultViewSchema, value, '恢复结果');
}
