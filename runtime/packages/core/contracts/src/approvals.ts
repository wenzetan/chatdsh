/**
 * 审批卡片、审批决定与状态机契约。
 *
 * 决定携带工具调用标识 `callId` 与状态版本；服务端据此验证卡片仍未处理且在有效期内。
 * 两个客户端竞争同一卡片时只有一次决定成功，另一侧收到 `approval-already-decided`。
 * 决定事件撤回同关联键的待投递通知，审计记录不丢失。
 * @module @chatdsh/core-contracts/approvals
 */

import { z } from 'zod';
import { APPROVAL_CHOICES, APPROVAL_ORIGINS } from './approval.ts';
import { chatdshErrorCodeSchema } from './errors.ts';
import {
  countSchema,
  epochMillisSchema,
  identifierSchema,
  operationIdSchema,
  requestDigestSchema,
  revisionSchema,
} from './primitives.ts';

/** 审批卡片的状态。 */
export const APPROVAL_CARD_STATES = [
  'pending',
  'answering',
  'decided',
  'expired',
  'superseded',
  'unavailable',
] as const;

/** 审批卡片的状态取值。 */
export type ApprovalCardState = (typeof APPROVAL_CARD_STATES)[number];

/** 审批卡片状态的迁移表。 */
export const APPROVAL_CARD_TRANSITIONS: Readonly<Record<ApprovalCardState, readonly ApprovalCardState[]>> = {
  pending: ['answering', 'decided', 'expired', 'superseded', 'unavailable'],
  answering: ['decided', 'expired', 'unavailable'],
  decided: [],
  expired: [],
  superseded: [],
  unavailable: [],
};

/**
 * 判定审批卡片能否迁移到目标状态。
 * @param from - 当前状态。
 * @param to - 目标状态。
 * @returns 允许迁移时为真。
 */
export function canTransitionApproval(from: ApprovalCardState, to: ApprovalCardState): boolean {
  return APPROVAL_CARD_TRANSITIONS[from].includes(to);
}

/** 一张审批卡片。 */
export const approvalCardSchema = z.object({
  /** 会话标识。 */
  sessionId: identifierSchema,
  /** 运行标识。 */
  runId: identifierSchema.optional(),
  /** 工具调用标识，与状态版本共同构成关联键。 */
  callId: identifierSchema,
  /** 状态版本，服务端每次状态变化递增。 */
  stateVersion: revisionSchema,
  /** 当前状态。 */
  state: z.enum(APPROVAL_CARD_STATES),
  /** 来源执行体。 */
  origin: z.enum(APPROVAL_ORIGINS),
  /** 工具名称。 */
  toolName: z.string().min(1).max(200),
  /** 脱敏后的命令或参数摘要。 */
  summary: z.string().min(1).max(2000),
  /** 提出原因。 */
  reason: z.string().max(2000).optional(),
  /** 目标设备。 */
  deviceId: identifierSchema,
  /** 目标工作目录。 */
  cwd: z.string().min(1).optional(),
  /** 能力范围说明。 */
  capabilityScope: z.string().min(1).max(500),
  /** 实际策略允许的选项。 */
  choices: z.array(z.enum(APPROVAL_CHOICES)).min(1),
  /** 展示优先级，数值小的先展示。 */
  priority: countSchema,
  /** 提出时刻的毫秒时间戳。 */
  raisedAt: epochMillisSchema,
  /** 失效时刻的毫秒时间戳。 */
  expiresAt: epochMillisSchema,
});

/** 一张审批卡片。 */
export type ApprovalCard = z.infer<typeof approvalCardSchema>;

/** 审批列表的过滤条件。 */
export const APPROVAL_LIST_FILTERS = ['waiting', 'handled', 'all'] as const;

/** 审批列表查询。 */
export const approvalListQuerySchema = z.object({
  /** 过滤条件。 */
  filter: z.enum(APPROVAL_LIST_FILTERS).default('waiting'),
  /** 会话过滤。 */
  sessionId: identifierSchema.optional(),
  /** 上一页游标。 */
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  /** 每页条数。 */
  limit: z.number().int().min(1).max(200).default(50),
});

/** 审批列表查询。 */
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;

/** 审批决定的请求。 */
export const approvalDecisionRequestSchema = z
  .object({
    /** 工具调用标识。 */
    callId: identifierSchema,
    /** 卡片状态版本。 */
    stateVersion: revisionSchema,
    /** 采纳的选项。 */
    choice: z.enum(APPROVAL_CHOICES),
    /** 操作标识。 */
    operationId: operationIdSchema,
    /** 请求摘要。 */
    requestDigest: requestDigestSchema,
    /** 扩大范围时的再次确认；选择 `session` 或 `always` 时必填为真。 */
    escalationConfirmed: z.boolean(),
  })
  .superRefine((request, context) => {
    const escalates = request.choice === 'session' || request.choice === 'always';
    if (escalates && !request.escalationConfirmed) {
      context.addIssue({
        code: 'custom',
        message: '扩大审批范围需要再次确认',
        path: ['escalationConfirmed'],
      });
    }
  });

/** 审批决定的请求。 */
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;

/** 审批决定的结果。 */
export const approvalDecisionResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('decided'),
    /** 工具调用标识。 */
    callId: identifierSchema,
    /** 状态版本。 */
    stateVersion: revisionSchema,
    /** 采纳的选项。 */
    choice: z.enum(APPROVAL_CHOICES),
    /** 决定时刻的毫秒时间戳。 */
    decidedAt: epochMillisSchema,
  }),
  z.object({
    outcome: z.literal('already-decided'),
    /** 工具调用标识。 */
    callId: identifierSchema,
    /** 另一客户端采纳的选项。 */
    choice: z.enum(APPROVAL_CHOICES),
    /** 决定时刻的毫秒时间戳。 */
    decidedAt: epochMillisSchema,
  }),
  z.object({
    outcome: z.literal('rejected'),
    /** 错误码。 */
    code: chatdshErrorCodeSchema,
  }),
]);

/** 审批决定的结果。 */
export type ApprovalDecisionResult = z.infer<typeof approvalDecisionResultSchema>;

/** 待处理计数。 */
export const approvalPendingCountSchema = z.object({
  /** 等待处理的卡片数。 */
  waiting: countSchema,
  /** 已处理的卡片数。 */
  handled: countSchema,
  /** 读取时刻的毫秒时间戳。 */
  readAt: epochMillisSchema,
});

/** 待处理计数。 */
export type ApprovalPendingCount = z.infer<typeof approvalPendingCountSchema>;
