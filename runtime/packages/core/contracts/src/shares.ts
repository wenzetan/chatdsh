/**
 * 分享范围、过滤与公开快照契约。
 *
 * 建立分享时选择完整回合范围与逐项附件；默认只含用户与助手可见文本，相关记忆、工具参数、
 * 内部路径与敏感元数据不进入默认分享，服务端执行相同过滤。公开页只读，无输入、审批、
 * 继续与编辑动作。分享列表不显示内部序号与副本水位。
 * @module @chatdsh/core-contracts/shares
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { contentScopeSchema } from './content-scope.ts';
import {
  countSchema,
  displayNameSchema,
  epochMillisSchema,
  identifierSchema,
  operationIdSchema,
  requestDigestSchema,
} from './primitives.ts';

/** 分享状态。 */
export const SHARE_STATUSES = ['active', 'revoked', 'expired'] as const;

/** 分享状态取值。 */
export type ShareStatus = (typeof SHARE_STATUSES)[number];

/** 默认分享排除的内容。 */
export const SHARE_DEFAULT_EXCLUSIONS = [
  'memory-recall',
  'tool-arguments',
  'internal-paths',
  'sensitive-metadata',
  'replica-watermark',
] as const;

/** 分享范围：公开哪些消息与附件。 */
export const shareScopeSchema = z
  .object({
    /** 内容范围。 */
    scope: contentScopeSchema,
    /** 公开用户消息。 */
    includeUserText: z.boolean(),
    /** 公开助手消息。 */
    includeAssistantText: z.boolean(),
    /** 逐项公开的附件标识。 */
    attachmentIds: z.array(identifierSchema),
  })
  .refine((value) => value.includeUserText || value.includeAssistantText, {
    message: '分享范围至少包含用户消息或助手消息',
    path: ['includeUserText'],
  });

/** 分享范围。 */
export type ShareScope = z.infer<typeof shareScopeSchema>;

/** 建立分享的请求。 */
export const shareCreateRequestSchema = z.object({
  /** 操作标识。 */
  operationId: operationIdSchema,
  /** 请求摘要。 */
  requestDigest: requestDigestSchema,
  /** 源会话。 */
  sessionId: identifierSchema,
  /** 分享范围。 */
  scope: shareScopeSchema,
  /** 有效期，单位毫秒；缺省表示不设期限。 */
  ttlMs: countSchema.optional(),
});

/** 建立分享的请求。 */
export type ShareCreateRequest = z.infer<typeof shareCreateRequestSchema>;

/** 分享列表里的一条记录。 */
export const shareRecordViewSchema = z.object({
  /** 分享标识。 */
  shareId: identifierSchema,
  /** 源会话。 */
  sourceSessionId: identifierSchema,
  /** 展示名称。 */
  title: displayNameSchema,
  /** 内容范围。 */
  scope: contentScopeSchema,
  /** 当前状态。 */
  status: z.enum(SHARE_STATUSES),
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 过期时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema.optional(),
  /** 撤销时刻的毫秒时间戳。 */
  revokedAt: epochMillisSchema.optional(),
  /** 访问次数。 */
  visits: countSchema,
  /** 占用空间字节数。 */
  bytes: countSchema,
});

/** 分享列表里的一条记录。 */
export type ShareRecordView = z.infer<typeof shareRecordViewSchema>;

/** 分享预览。 */
export const sharePreviewSchema = z.object({
  /** 内容范围。 */
  scope: contentScopeSchema,
  /** 将要公开的消息条数。 */
  messageCount: countSchema,
  /** 将要公开的附件。 */
  attachments: z.array(
    z.object({
      id: identifierSchema,
      filename: z.string().min(1).max(255),
      /** 可下载则为真。 */
      downloadable: z.boolean(),
    }),
  ),
  /** 被过滤掉的内容种类。 */
  excluded: z.array(z.enum(SHARE_DEFAULT_EXCLUSIONS)),
});

/** 分享预览。 */
export type SharePreview = z.infer<typeof sharePreviewSchema>;

/** 撤销分享的结果。 */
export const shareRevokeResultSchema = z.object({
  /** 分享标识。 */
  shareId: identifierSchema,
  /** 撤销时刻的毫秒时间戳。 */
  revokedAt: epochMillisSchema,
  /** 当前状态。 */
  status: z.enum(SHARE_STATUSES),
});

/** 撤销分享的结果。 */
export type ShareRevokeResult = z.infer<typeof shareRevokeResultSchema>;

/** 公开快照。 */
export const publicSnapshotSchema = z.object({
  /** 快照标题。 */
  title: displayNameSchema,
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 只读声明。 */
  readOnly: z.literal(true),
  /** 固定内容范围。 */
  scope: contentScopeSchema,
  /** 可分享附件。 */
  attachments: z.array(
    z.object({
      id: identifierSchema,
      filename: z.string().min(1).max(255),
      size: countSchema,
      downloadable: z.boolean(),
    }),
  ),
  /** 允许打印。 */
  canPrint: z.boolean(),
  /** 无输入与交互动作。 */
  interactive: z.literal(false),
});

/** 公开快照。 */
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>;

/** 公开访问失败的应答。 */
export const shareUnavailableSchema = z.object({
  /** 错误码。 */
  code: chatdshErrorCodeSchema,
  /** 失效原因。 */
  reason: z.enum(['revoked', 'expired', 'unknown']),
});

/** 公开访问失败的应答。 */
export type ShareUnavailable = z.infer<typeof shareUnavailableSchema>;
