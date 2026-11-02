/**
 * 数据管理契约：用量、副本清理、血缘与删除收件箱。
 *
 * 界面只显示会话数量、副本字节、附件空间、最近活动与保留策略；内部游标不进入任何对外
 * 形状。清理预估与实际释放分别返回，权威日志与工作区文件不受副本清理影响。删除收件箱
 * 保留标题、原设备、删除时间、剩余保留天数与空间，恢复前重新校验目标存在性与是否过期。
 * @module @chatdsh/core-contracts/data-management
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { contentScopeSchema, retentionDaysSchema } from './content-scope.ts';
import { countSchema, epochMillisSchema, identifierSchema, operationIdSchema, requestDigestSchema } from './primitives.ts';

/** 用量查询的维度。 */
export const USAGE_DIMENSIONS = ['device', 'workspace', 'session'] as const;

/** 用量查询的维度取值。 */
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

/** 一行用量。 */
export const usageRowSchema = z.object({
  /** 维度。 */
  dimension: z.enum(USAGE_DIMENSIONS),
  /** 维度取值：设备、工作区或会话标识。 */
  key: identifierSchema,
  /** 会话数量。 */
  sessionCount: countSchema,
  /** 文本副本字节数。 */
  textReplicaBytes: countSchema,
  /** 附件空间字节数。 */
  attachmentBytes: countSchema,
  /** 最近活动时刻的毫秒时间戳。 */
  lastActiveAt: epochMillisSchema,
  /** 副本保留周期，单位天。 */
  retentionDays: retentionDaysSchema,
});

/** 一行用量。 */
export type UsageRow = z.infer<typeof usageRowSchema>;

/** 清理预估。 */
export const cleanupEstimateSchema = z.object({
  /** 预估标识。 */
  estimateId: identifierSchema,
  /** 涉及对象数。 */
  objectCount: countSchema,
  /** 预计可释放字节数。 */
  reclaimableBytes: countSchema,
  /** 保留周期，单位天。 */
  retentionDays: retentionDaysSchema,
  /** 预估时刻的毫秒时间戳。 */
  estimatedAt: epochMillisSchema,
  /** 依赖该范围的有效分享数。 */
  dependentShares: countSchema,
  /** 依赖该范围的活动导入数。 */
  activeImports: countSchema,
});

/** 清理预估。 */
export type CleanupEstimate = z.infer<typeof cleanupEstimateSchema>;

/** 清理结果。 */
export const cleanupResultSchema = z.object({
  /** 清理标识。 */
  cleanupId: identifierSchema,
  /** 预计释放字节数。 */
  estimatedBytes: countSchema,
  /** 实际释放字节数。 */
  reclaimedBytes: countSchema,
  /** 完成时刻的毫秒时间戳。 */
  finishedAt: epochMillisSchema,
  /** 设备权威日志与工作区文件保留。 */
  authoritativeLogsPreserved: z.literal(true),
  /** 失败原因码。 */
  code: chatdshErrorCodeSchema.optional(),
});

/** 清理结果。 */
export type CleanupResult = z.infer<typeof cleanupResultSchema>;

/** 删除收件箱条目。 */
export const deletionInboxItemSchema = z.object({
  /** 会话标识。 */
  sessionId: identifierSchema,
  /** 标题。 */
  title: z.string().min(1).max(300),
  /** 原设备。 */
  originDeviceId: identifierSchema,
  /** 删除时刻的毫秒时间戳。 */
  deletedAt: epochMillisSchema,
  /** 保留期结束时刻的毫秒时间戳。 */
  retentionExpiresAt: epochMillisSchema,
  /** 剩余保留天数。 */
  remainingDays: countSchema,
  /** 占用空间字节数。 */
  bytes: countSchema,
  /** 是否可以恢复。 */
  restorable: z.boolean(),
  /** 是否有有效分享依赖；永久删除需要逐项确认。 */
  hasShareDependency: z.boolean(),
});

/** 删除收件箱条目。 */
export type DeletionInboxItem = z.infer<typeof deletionInboxItemSchema>;

/** 恢复请求。 */
export const restoreRequestSchema = z.object({
  /** 会话标识。 */
  sessionId: identifierSchema,
  /** 操作标识。 */
  operationId: operationIdSchema,
  /** 请求摘要。 */
  requestDigest: requestDigestSchema,
});

/** 恢复请求。 */
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

/** 恢复结果。 */
export const restoreResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('restored'),
    /** 会话标识。 */
    sessionId: identifierSchema,
    /** 恢复时刻的毫秒时间戳。 */
    restoredAt: epochMillisSchema,
    /** 恢复内容范围。 */
    scope: contentScopeSchema,
  }),
  z.object({
    outcome: z.literal('rejected'),
    /** 错误码。 */
    code: chatdshErrorCodeSchema,
  }),
]);

/** 恢复结果。 */
export type RestoreResult = z.infer<typeof restoreResultSchema>;

/** 永久删除范围。 */
export const permanentDeleteScopeSchema = z.object({
  /** 会话标识。 */
  sessionId: identifierSchema,
  /** 删除的对象种类。 */
  objects: z.array(z.enum(['log', 'replica', 'object', 'share', 'attachment'])).min(1),
  /** 涉及的有效分享数。 */
  dependentShares: countSchema,
  /** 释放字节数。 */
  bytes: countSchema,
  /** 需要显式确认。 */
  requiresConfirm: z.literal(true),
});

/** 永久删除范围。 */
export type PermanentDeleteScope = z.infer<typeof permanentDeleteScopeSchema>;

/** 会话归属详情与血缘。 */
export const lineageNodeSchema = z.object({
  /** 会话标识。 */
  sessionId: identifierSchema,
  /** 归属设备。 */
  deviceId: identifierSchema,
  /** 工作目录。 */
  cwd: z.string().min(1),
  /** 会话类型。 */
  kind: z.enum(['work', 'chat']),
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 分叉来源会话。 */
  parentSession: identifierSchema.optional(),
  /** 继承的内容范围；根会话缺省。 */
  inheritedScope: contentScopeSchema.optional(),
});

/** 会话归属详情与血缘。 */
export type LineageNode = z.infer<typeof lineageNodeSchema>;
