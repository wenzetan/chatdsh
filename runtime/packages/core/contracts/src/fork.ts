/**
 * 跨设备继续、fork 预估与写租约契约。
 *
 * 「在远程继续」打开源设备上的原会话，编号不变；「在本机继续」在本机运行时新建会话，
 * 新编号带 `parentSession`。fork 表单只显示内容范围、事件与字符预估、附件缺失与压缩损失，
 * 内部副本水位不出现在任何对外形状里。
 * @module @chatdsh/core-contracts/fork
 */

import { z } from 'zod';
import { contentScopeSchema, replicaAvailabilitySchema } from './content-scope.ts';
import { IMPORT_MODES } from './session-events.ts';
import {
  countSchema,
  displayNameSchema,
  epochMillisSchema,
  identifierSchema,
  operationIdSchema,
  requestDigestSchema,
} from './primitives.ts';

/** 继续会话的方式。 */
export const CONTINUE_MODES = ['remote', 'local'] as const;

/** 继续会话的方式取值。 */
export type ContinueMode = (typeof CONTINUE_MODES)[number];

/** 在远程继续：打开源设备上的原会话。 */
export const remoteContinueSchema = z.object({
  mode: z.literal('remote'),
  /** 源会话标识，继续后保持不变。 */
  sessionId: identifierSchema,
  /** 源设备标识。 */
  deviceId: identifierSchema,
});

/** 在本机继续：在本机运行时新建 fork 会话。 */
export const localContinueSchema = z.object({
  mode: z.literal('local'),
  /** 复制内容的方式。 */
  importMode: z.enum(IMPORT_MODES),
  /** 源会话标识。 */
  sourceSessionId: identifierSchema,
  /** 源设备标识。 */
  sourceDeviceId: identifierSchema,
  /** 目标设备；必须是已登记且在线的本机运行时。 */
  targetDeviceId: identifierSchema,
  /** 目标工作目录的绝对路径。 */
  targetCwd: z.string().min(1),
  /** 复制的历史范围。 */
  scope: contentScopeSchema,
  /** 新会话使用的助手。 */
  assistantId: identifierSchema.optional(),
  /** 新会话使用的模型路由名。 */
  model: displayNameSchema.optional(),
  /** 建立新会话的操作标识与摘要。 */
  operationId: operationIdSchema,
  requestDigest: requestDigestSchema,
});

/** 继续会话的请求。 */
export const continueRequestSchema = z.discriminatedUnion('mode', [remoteContinueSchema, localContinueSchema]);

/** 继续会话的请求。 */
export type ContinueRequest = z.infer<typeof continueRequestSchema>;

/** fork 预估。 */
export const forkEstimateSchema = z.object({
  /** 复制方式。 */
  importMode: z.enum(IMPORT_MODES),
  /** 目标历史范围。 */
  scope: contentScopeSchema,
  /** 预估复制的事件条数。 */
  eventCount: countSchema,
  /** 预估复制的字符数。 */
  charCount: countSchema,
  /** 源设备副本的可用状态；源设备离线时用于判断能否复制。 */
  source: replicaAvailabilitySchema,
  /** 缺失的附件标识。 */
  missingAttachmentIds: z.array(identifierSchema),
  /** 压缩复制会丢失工具输出原文。 */
  compressionLoss: z.boolean(),
});

/** fork 预估。 */
export type ForkEstimate = z.infer<typeof forkEstimateSchema>;

/** fork 建立结果。 */
export const forkResultSchema = z.object({
  /** 新会话标识。 */
  sessionId: identifierSchema,
  /** 新会话归属设备。 */
  deviceId: identifierSchema,
  /** 新会话工作目录。 */
  cwd: z.string().min(1),
  /** 分叉来源会话。 */
  parentSession: identifierSchema,
  /** 建立时刻的毫秒时间戳。 */
  createdAt: epochMillisSchema,
});

/** fork 建立结果。 */
export type ForkResult = z.infer<typeof forkResultSchema>;

/** 写租约状态。 */
export const WRITE_LEASE_STATES = ['free', 'held', 'expired'] as const;

/** 写租约状态取值。 */
export type WriteLeaseState = (typeof WRITE_LEASE_STATES)[number];

/** 会话写租约。界面只显示占用方与等待入口。 */
export const writeLeaseSchema = z.object({
  sessionId: identifierSchema,
  state: z.enum(WRITE_LEASE_STATES),
  /** 占用方设备。 */
  holderDeviceId: identifierSchema.optional(),
  /** 占用方进程标识；宿主未提供时缺省。 */
  holderProcess: identifierSchema.optional(),
  /** 占用开始时刻的毫秒时间戳。 */
  acquiredAt: epochMillisSchema.optional(),
  /** 租约到期时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema.optional(),
});

/** 会话写租约。 */
export type WriteLease = z.infer<typeof writeLeaseSchema>;
