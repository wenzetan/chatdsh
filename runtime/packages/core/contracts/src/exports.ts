/**
 * 导出与打印范围契约。
 *
 * 导出内容范围与权威日志一致；默认阅读导出只含选定用户与助手内容，排除凭据、相关记忆、
 * 内部路径与副本水位。原始 JSONL 只在具备私有导出权限时提供。附件逐项显示可下载、缺失、
 * 需要源设备三种状态，丢失附件不能静默跳过。
 * @module @chatdsh/core-contracts/exports
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { contentScopeSchema } from './content-scope.ts';
import {
  countSchema,
  epochMillisSchema,
  identifierSchema,
  operationIdSchema,
  requestDigestSchema,
} from './primitives.ts';

/** 导出格式。 */
export const EXPORT_FORMATS = ['markdown', 'jsonl', 'html', 'pdf'] as const;

/** 导出格式取值。 */
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 附件处理方式。 */
export const ATTACHMENT_POLICIES = ['available-only', 'include-missing-list', 'exclude'] as const;

/** 附件处理方式取值。 */
export type AttachmentPolicy = (typeof ATTACHMENT_POLICIES)[number];

/** 导出状态。 */
export const EXPORT_STATES = ['estimated', 'generating', 'cancelling', 'completed', 'failed', 'expired'] as const;

/** 导出状态取值。 */
export type ExportState = (typeof EXPORT_STATES)[number];

/** 打印时去掉的界面部分。 */
export const PRINT_EXCLUSIONS = ['navigation', 'composer', 'interaction-buttons'] as const;

/** 导出默认排除的内容。 */
export const EXPORT_EXCLUDED_CONTENT = ['credentials', 'memory-recall', 'internal-paths', 'replica-watermark'] as const;

/** 导出源。 */
export const exportSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    /** 源会话标识。 */
    sessionId: identifierSchema,
  }),
  z.object({
    kind: z.literal('artifact'),
    /** 源制品标识。 */
    artifactId: identifierSchema,
    /** 制品版本。 */
    version: z.number().int().positive(),
  }),
]);

/** 导出源。 */
export type ExportSource = z.infer<typeof exportSourceSchema>;

/** 导出的内容范围。 */
export const exportScopeSchema = z
  .object({
    /** 源会话或制品。 */
    source: exportSourceSchema,
    /** 内容范围。 */
    scope: contentScopeSchema,
    /** 导出格式。 */
    format: z.enum(EXPORT_FORMATS),
    /** 是否包含工具阅读记录。 */
    includeToolReads: z.boolean(),
    /** 附件处理方式。 */
    attachmentPolicy: z.enum(ATTACHMENT_POLICIES),
    /** 时间显示方式。 */
    timeDisplay: z.enum(['local', 'utc']),
    /** 脱敏方式。 */
    redaction: z.enum(['default', 'strict']),
    /** 具备私有导出权限；原始 JSONL 需要它。 */
    privateExport: z.boolean(),
  })
  .superRefine((scope, context) => {
    if (scope.format === 'jsonl' && !scope.privateExport) {
      context.addIssue({
        code: 'custom',
        message: '原始 JSONL 导出需要私有导出权限',
        path: ['privateExport'],
      });
    }
  });

/** 导出的内容范围。 */
export type ExportScope = z.infer<typeof exportScopeSchema>;

/** 建立导出的请求。重复提交使用同一操作标识。 */
export const exportCreateRequestSchema = z.object({
  /** 操作标识。 */
  operationId: operationIdSchema,
  /** 请求摘要。 */
  requestDigest: requestDigestSchema,
  /** 导出的内容范围。 */
  scope: exportScopeSchema,
});

/** 建立导出的请求。 */
export type ExportCreateRequest = z.infer<typeof exportCreateRequestSchema>;

/** 附件在导出里的状态。 */
export const EXPORT_ATTACHMENT_STATES = ['downloadable', 'missing', 'needs-source-device'] as const;

/** 附件在导出里的状态取值。 */
export type ExportAttachmentState = (typeof EXPORT_ATTACHMENT_STATES)[number];

/** 导出里的一项附件。 */
export const exportAttachmentSchema = z.object({
  /** 附件标识。 */
  id: identifierSchema,
  /** 原始文件名。 */
  filename: z.string().min(1).max(255),
  /** 状态。 */
  state: z.enum(EXPORT_ATTACHMENT_STATES),
  /** 字节数；缺失时缺省。 */
  size: countSchema.optional(),
});

/** 导出里的一项附件。 */
export type ExportAttachment = z.infer<typeof exportAttachmentSchema>;

/** 导出预估。 */
export const exportEstimateSchema = z.object({
  /** 预估事件条数。 */
  eventCount: countSchema,
  /** 预估字符数。 */
  charCount: countSchema,
  /** 预估字节数。 */
  bytes: countSchema,
  /** 逐项附件。 */
  attachments: z.array(exportAttachmentSchema),
});

/** 导出预估。 */
export type ExportEstimate = z.infer<typeof exportEstimateSchema>;

/** 一次导出任务。 */
export const exportJobSchema = z.object({
  /** 导出任务标识。 */
  jobId: identifierSchema,
  /** 任务状态。 */
  state: z.enum(EXPORT_STATES),
  /** 内容范围。 */
  scope: exportScopeSchema,
  /** 预估。 */
  estimate: exportEstimateSchema,
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 完成时刻的毫秒时间戳。 */
  completedAt: epochMillisSchema.optional(),
  /** 下载地址失效时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema.optional(),
  /** 失败原因码。 */
  code: chatdshErrorCodeSchema.optional(),
});

/** 一次导出任务。 */
export type ExportJob = z.infer<typeof exportJobSchema>;

/** 打印范围。 */
export const printScopeSchema = z.object({
  /** 打印标题。 */
  title: z.string().min(1).max(300),
  /** 内容范围。 */
  scope: contentScopeSchema,
  /** 是否显示页码。 */
  pageNumbers: z.boolean(),
  /** 代码换行方式。 */
  codeWrapping: z.enum(['wrap', 'scroll']),
  /** 长表格跨页时重复表头。 */
  repeatTableHeader: z.boolean(),
  /** 去掉的界面部分。 */
  excluded: z.array(z.enum(PRINT_EXCLUSIONS)),
});

/** 打印范围。 */
export type PrintScope = z.infer<typeof printScopeSchema>;
