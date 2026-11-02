/**
 * 客户端共同状态契约。
 *
 * 所有列表、详情、表单与会话接受同一组状态；每个场景同时验证适用的状态，不能用一个
 * 全局提示替代字段与业务结果。写操作另有 validating、submitting、succeeded、failed、
 * conflict、unconfirmed 六个状态，反馈不依赖短暂提示。
 * @module @chatdsh/core-contracts/client-state
 */

import { z } from 'zod';
import { chatdshErrorCodeSchema } from './errors.ts';
import { countSchema, epochMillisSchema, identifierSchema } from './primitives.ts';

/** 读取与呈现状态。 */
export const CLIENT_VIEW_STATES = [
  'loading',
  'empty',
  'error',
  'readonly',
  'offline',
  'pending',
  'forbidden',
  'disabled',
  'danger',
  'degraded',
  'long',
] as const;

/** 读取与呈现状态取值。 */
export type ClientViewState = (typeof CLIENT_VIEW_STATES)[number];

/** 空状态的区分方式。 */
export const EMPTY_REASONS = ['no-records', 'no-results', 'filtered-out'] as const;

/** 空状态的区分方式取值。 */
export type EmptyReason = (typeof EMPTY_REASONS)[number];

/** 写操作状态。 */
export const WRITE_ACTION_STATES = [
  'validating',
  'submitting',
  'succeeded',
  'failed',
  'conflict',
  'unconfirmed',
] as const;

/** 写操作状态取值。 */
export type WriteActionState = (typeof WRITE_ACTION_STATES)[number];

/** 共同状态的对外形状。 */
export const clientViewStateSchema = z.object({
  /** 当前状态。 */
  state: z.enum(CLIENT_VIEW_STATES),
  /** 空状态的区分方式；仅 `empty` 携带。 */
  emptyReason: z.enum(EMPTY_REASONS).optional(),
  /** 失败原因码；仅 `error`、`forbidden`、`disabled` 携带。 */
  code: chatdshErrorCodeSchema.optional(),
  /** 失败对象的稳定标识。 */
  objectRef: identifierSchema.optional(),
  /** 局部重试可行。 */
  retryable: z.boolean().optional(),
  /** 只读原因；仅 `readonly` 携带。 */
  readOnlyReason: z.enum(['device-offline', 'replica-only', 'public-snapshot', 'permission']).optional(),
  /** 待处理数量；仅 `pending` 携带。 */
  pendingCount: countSchema.optional(),
  /** 状态开始时刻的毫秒时间戳；长任务用于显示已运行时长。 */
  since: epochMillisSchema.optional(),
  /** 读取时刻的毫秒时间戳；只读内容显示它。 */
  readAt: epochMillisSchema.optional(),
  /** 服务器提供的阶段说明；仅 `long` 携带。 */
  stage: z.string().max(200).optional(),
  /** 已知进度，取 0 到 1 的小数；未知进度缺省。 */
  progress: z.number().min(0).max(1).optional(),
  /** 依赖不可用的说明；仅 `degraded` 携带。 */
  degradedDependency: z.string().max(200).optional(),
});

/** 共同状态的对外形状。 */
export type ClientViewStateView = z.infer<typeof clientViewStateSchema>;

/** 写操作状态的迁移表。 */
export const WRITE_ACTION_TRANSITIONS: Readonly<Record<WriteActionState, readonly WriteActionState[]>> = {
  validating: ['submitting', 'failed', 'succeeded'],
  submitting: ['succeeded', 'failed', 'conflict', 'unconfirmed'],
  unconfirmed: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['validating', 'submitting'],
  conflict: ['validating', 'submitting'],
};

/**
 * 判定写操作能否迁移到目标状态。
 * @param from - 当前状态。
 * @param to - 目标状态。
 * @returns 允许迁移时为真。
 */
export function canTransitionWriteAction(from: WriteActionState, to: WriteActionState): boolean {
  return WRITE_ACTION_TRANSITIONS[from].includes(to);
}
