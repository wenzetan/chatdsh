/**
 * 内容范围与副本读取状态。
 *
 * 界面、导出、分享与继续会话都只描述「看到多少内容、何时读取」。控制平面的内部游标、
 * 连续前缀与同步落后条数属于实现细节，不出现在本文件的任何对外形状里。
 * @module @chatdsh/core-contracts/content-scope
 */

import { z } from 'zod';
import { countSchema, epochMillisSchema } from './primitives.ts';

/** 内容范围：按完整回合编号表达。 */
export const contentScopeSchema = z
  .object({
    /** 起始回合编号，从 1 开始。 */
    turnFrom: z.number().int().positive(),
    /** 结束回合编号，含该回合。 */
    turnTo: z.number().int().positive(),
    /** 范围内的事件条数。 */
    eventCount: countSchema,
    /** 范围内的字符数。 */
    charCount: countSchema,
    /** 复制时把工具输出替换成摘要则为真。 */
    compressed: z.boolean(),
    /** 范围内的附件是否全部可用。 */
    attachmentsComplete: z.boolean(),
  })
  .refine((scope) => scope.turnTo >= scope.turnFrom, {
    message: '结束回合必须不小于起始回合',
    path: ['turnTo'],
  });

/** 内容范围。 */
export type ContentScope = z.infer<typeof contentScopeSchema>;

/** 内容读取来源。 */
export const CONTENT_READ_SOURCES = ['authoritative', 'replica', 'snapshot'] as const;

/** 内容读取来源取值。 */
export type ContentReadSource = (typeof CONTENT_READ_SOURCES)[number];

/** 只读原因。 */
export const READ_ONLY_REASONS = ['device-offline', 'replica-only', 'public-snapshot', 'permission'] as const;

/** 只读原因取值。 */
export type ReadOnlyReason = (typeof READ_ONLY_REASONS)[number];

/** 内容读取状态。 */
export const contentReadStateSchema = z.object({
  /** 读取来源。 */
  source: z.enum(CONTENT_READ_SOURCES),
  /** 读取时刻的毫秒时间戳，界面显示为内容读取时间。 */
  readAt: epochMillisSchema,
  /** 读取到的内容范围。 */
  scope: contentScopeSchema,
  /** 只读原因；可写时缺省。 */
  readOnlyReason: z.enum(READ_ONLY_REASONS).optional(),
});

/** 内容读取状态。 */
export type ContentReadState = z.infer<typeof contentReadStateSchema>;

/** 副本可用状态。 */
export const REPLICA_AVAILABILITY = ['complete', 'partial', 'missing'] as const;

/** 副本可用状态取值。 */
export type ReplicaAvailability = (typeof REPLICA_AVAILABILITY)[number];

/** 副本可用状态与范围内可读内容。 */
export const replicaAvailabilitySchema = z
  .object({
    /** 可用状态。 */
    state: z.enum(REPLICA_AVAILABILITY),
    /** 可读内容范围；`missing` 时缺省。 */
    scope: contentScopeSchema.optional(),
    /** 可读内容的读取时刻；`missing` 时缺省。 */
    readAt: epochMillisSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.state === 'missing') {
      if (value.scope !== undefined || value.readAt !== undefined) {
        context.addIssue({ code: 'custom', message: '副本缺失时不得携带内容范围与读取时间' });
      }
      return;
    }
    if (value.scope === undefined) {
      context.addIssue({ code: 'custom', message: '副本可用时必须携带内容范围', path: ['scope'] });
    }
    if (value.readAt === undefined) {
      context.addIssue({ code: 'custom', message: '副本可用时必须携带读取时间', path: ['readAt'] });
    }
  });

/** 副本可用状态与范围内可读内容。 */
export type ReplicaAvailabilityState = z.infer<typeof replicaAvailabilitySchema>;

/** 副本保留周期的允许范围，单位天。 */
export const RETENTION_DAYS_RANGE = { min: 1, max: 3650, default: 90 } as const;

/** 副本保留周期。 */
export const retentionDaysSchema = z.number().int().min(RETENTION_DAYS_RANGE.min).max(RETENTION_DAYS_RANGE.max);
