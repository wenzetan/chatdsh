/**
 * 本地草稿契约。
 *
 * 草稿按客户端、窗口、设备与会话四元组保存在浏览器侧存储里；窗口标识在该窗口刷新时保持
 * 稳定，第二个窗口使用独立标识。录音与未上传文件的字节不持久化，需要重新选择的附件显式
 * 标注。凭据、记忆查询内容与工具原文不进入草稿。
 * @module @chatdsh/core-contracts/drafts
 */

import { z } from 'zod';
import { countSchema, epochMillisSchema, identifierSchema, revisionSchema } from './primitives.ts';

/** 草稿键：客户端、窗口、设备与会话。 */
export const draftKeySchema = z.object({
  /** 浏览器侧客户端标识，同一浏览器内稳定。 */
  clientId: identifierSchema,
  /** 窗口标识；同一窗口刷新后保持稳定，第二个窗口不同。 */
  windowId: identifierSchema,
  /** 目标执行设备。 */
  deviceId: identifierSchema,
  /** 目标会话；新建会话的草稿缺省。 */
  sessionId: identifierSchema.optional(),
});

/** 草稿键。 */
export type DraftKey = z.infer<typeof draftKeySchema>;

/** 引用对象的种类。 */
export const REFERENCE_KINDS = ['file', 'skill', 'subagent', 'session', 'command'] as const;

/** 引用对象种类取值。 */
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** 草稿里的一段引用。 */
export const draftReferenceSchema = z.object({
  kind: z.enum(REFERENCE_KINDS),
  /** 引用对象的稳定标识。 */
  id: identifierSchema,
  /** 插入时展示的名称；对象失效后仍然保留。 */
  label: z.string().min(1).max(200),
  /** 对象当前是否仍然可用；不可用时要求用户重新选择或移除。 */
  available: z.boolean(),
});

/** 草稿里的一段引用。 */
export type DraftReference = z.infer<typeof draftReferenceSchema>;

/** 草稿附件：只保存已确认的元数据。 */
export const draftAttachmentSchema = z.object({
  /** 附件标识。 */
  id: identifierSchema,
  /** 原始文件名。 */
  filename: z.string().min(1).max(255),
  /** 媒体类型。 */
  mimeType: z.string().min(1).max(200),
  /** 字节数。 */
  size: countSchema,
  /** 上传完成并确认后才记入草稿。 */
  confirmed: z.literal(true),
  /** 内容未持久化，需要重新选择时为真。 */
  needsReselect: z.boolean(),
});

/** 草稿附件。 */
export type DraftAttachment = z.infer<typeof draftAttachmentSchema>;

/** 一条草稿。 */
export const draftRecordSchema = z.object({
  key: draftKeySchema,
  /** 输入区文本。 */
  text: z.string().max(262144),
  /** 插入的引用对象。 */
  references: z.array(draftReferenceSchema),
  /** 已确认的附件元数据。 */
  attachments: z.array(draftAttachmentSchema),
  /** 本地版本，用于同键的并发写入判定。 */
  revision: revisionSchema,
  /** 最后修改时刻的毫秒时间戳。 */
  updatedAt: epochMillisSchema,
});

/** 一条草稿。 */
export type DraftRecord = z.infer<typeof draftRecordSchema>;

/** 草稿不持久化的内容种类。 */
export const DRAFT_EXCLUDED_CONTENT = ['credentials', 'memory-query', 'tool-body', 'unconfirmed-attachment-bytes'] as const;

/** 草稿写入失败的原因。 */
export const DRAFT_FAILURE_REASONS = ['storage-full', 'storage-unavailable', 'privacy-mode', 'cleared-by-browser'] as const;

/** 草稿写入失败的原因取值。 */
export type DraftFailureReason = (typeof DRAFT_FAILURE_REASONS)[number];

/** 草稿写入结果。 */
export const draftWriteResultSchema = z.object({
  outcome: z.enum(['saved', 'rejected']),
  /** 失败原因；成功时缺省。 */
  reason: z.enum(DRAFT_FAILURE_REASONS).optional(),
  /** 保存后的本地版本；成功时携带。 */
  revision: revisionSchema.optional(),
});

/** 草稿写入结果。 */
export type DraftWriteResult = z.infer<typeof draftWriteResultSchema>;

/** 离线发送的固定结果：草稿保留，不进入待发队列。 */
export const OFFLINE_SEND_RESULT = {
  outcome: 'rejected',
  code: 'device-offline',
  draftKept: true,
  queued: false,
} as const;
