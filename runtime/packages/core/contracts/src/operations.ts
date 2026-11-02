/**
 * 写操作的信封、幂等与重放判定。
 *
 * 每个写操作携带 128 位随机 `operationId` 与请求摘要。同标识同摘要重放返回已保存的结果，
 * 同标识异摘要返回 `operation-digest-mismatch`。结果不确定时返回 `unconfirmed`，调用方
 * 必须先查询实际结果再决定，禁止自动重复写入。
 * @module @chatdsh/core-contracts/operations
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import {
  countSchema,
  epochMillisSchema,
  identifierSchema,
  operationIdSchema,
  requestDigestSchema,
  revisionSchema,
} from './primitives.ts';

/** 请求头里的操作标识。 */
export const OPERATION_HEADER = 'x-chatdsh-operation-id';

/** 请求头里的请求摘要。 */
export const REQUEST_DIGEST_HEADER = 'x-chatdsh-request-digest';

/** 幂等键：操作标识与请求摘要配对。 */
export const idempotencyKeySchema = z.object({
  operationId: operationIdSchema,
  requestDigest: requestDigestSchema,
});

/** 幂等键。 */
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

/** 操作记录的状态。 */
export const OPERATION_STATES = ['pending', 'applied', 'conflict', 'unconfirmed'] as const;

/** 操作记录状态。 */
export type OperationState = (typeof OPERATION_STATES)[number];

/** 操作记录。未确认的记录不按时间回收。 */
export const operationRecordSchema = z.object({
  operationId: operationIdSchema,
  requestDigest: requestDigestSchema,
  state: z.enum(OPERATION_STATES),
  /** 归属设备；建立会话与设备内写入携带它。 */
  deviceId: identifierSchema.optional(),
  /** 登记时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
  /** 到期时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema,
  /** 已完成结果的对象引用。 */
  resultRef: identifierSchema.optional(),
});

/** 操作记录。 */
export type OperationRecord = z.infer<typeof operationRecordSchema>;

/** 重放判定的取值。 */
export const REPLAY_DECISIONS = ['execute', 'replayed', 'digest-conflict'] as const;

/** 重放判定。 */
export type ReplayDecision = (typeof REPLAY_DECISIONS)[number];

/**
 * 按已登记的操作记录判定本次请求的处理方式。
 * @param record - 已登记的操作记录；没有登记时缺省。
 * @param key - 本次请求的幂等键。
 * @returns `execute` 表示首次执行，`replayed` 表示返回已保存结果，`digest-conflict` 表示同一标识换了内容。
 */
export function decideReplay(record: OperationRecord | undefined, key: IdempotencyKey): ReplayDecision {
  if (record === undefined) return 'execute';
  if (record.requestDigest !== key.requestDigest) return 'digest-conflict';
  return 'replayed';
}

/** 成功落定的写入结果。 */
export const appliedWriteSchema = z.object({
  outcome: z.literal('applied'),
  operationId: operationIdSchema,
  /** 写入后的记录版本；该操作不维护版本时缺省。 */
  revision: revisionSchema.optional(),
  /** 结果来自已保存记录时为真。 */
  replayed: z.boolean(),
  /** 返回给调用方的结果对象，形状由具体操作约定。 */
  result: z.unknown().optional(),
});

/** 被拒绝的写入结果。 */
export const rejectedWriteSchema = z.object({
  outcome: z.literal('rejected'),
  operationId: operationIdSchema,
  code: chatdshErrorCodeSchema,
  /** 一句话说明，不含业务原文。 */
  detail: z.string().max(500).optional(),
});

/** 冲突的写入结果。 */
export const conflictWriteSchema = z.object({
  outcome: z.literal('conflict'),
  operationId: operationIdSchema,
  code: chatdshErrorCodeSchema,
  /** 服务端当前版本。 */
  currentRevision: revisionSchema,
  /** 服务端当前值；敏感字段由服务端脱敏后再放入。 */
  serverValue: z.unknown().optional(),
  /** 冲突涉及的字段名。 */
  fields: z.array(identifierSchema).optional(),
});

/** 未确认的写入结果。 */
export const unconfirmedWriteSchema = z.object({
  outcome: z.literal('unconfirmed'),
  operationId: operationIdSchema,
  /** 建议的查询间隔，单位毫秒。 */
  retryAfterMs: countSchema,
  /** 查询实际结果的对象引用。 */
  resultRef: identifierSchema.optional(),
});

/** 写入结果。 */
export const writeOutcomeSchema = z.discriminatedUnion('outcome', [
  appliedWriteSchema,
  rejectedWriteSchema,
  conflictWriteSchema,
  unconfirmedWriteSchema,
]);

/** 写入结果。 */
export type WriteOutcome = z.infer<typeof writeOutcomeSchema>;

/** 写入是否已经落定。未确认与冲突都还需要后续动作。 */
export function isSettledOutcome(outcome: WriteOutcome): boolean {
  return outcome.outcome === 'applied' || outcome.outcome === 'rejected';
}

/** 停止请求的应答取值。 */
export const STOP_ACKNOWLEDGEMENTS = ['stopped', 'unconfirmed', 'rejected'] as const;

/** 停止请求的应答。 */
export const stopAckSchema = z.object({
  outcome: z.enum(STOP_ACKNOWLEDGEMENTS),
  /** 运行标识；没有启动运行时不带。 */
  runId: identifierSchema.optional(),
  /** 失败或未确认时的错误码。 */
  code: chatdshErrorCodeSchema.optional(),
});
