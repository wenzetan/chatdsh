/**
 * 审批、提问与计划接管的对外请求与结果形状。
 *
 * 字段与共享契约的同名声明保持一致：决定结果与共享契约里的判别联合同形，错误码取共享错误码
 * 登记表里的取值，因此客户端可以用同一份判别逻辑处理三个入口。审批决定的请求额外带
 * `decidedBy`，用于统计里区分是哪个客户端做的决定。
 * @module @chatdsh/host-approval/contracts
 */

import { z } from 'zod';

/** 审批选项。 */
export const DECISION_CHOICES = ['once', 'session', 'always', 'deny'] as const;

/** 审批选项取值。 */
export type DecisionChoice = (typeof DECISION_CHOICES)[number];

/** 扩展范围的两个选项：本会话与始终。 */
export const ESCALATING_CHOICES: readonly DecisionChoice[] = ['session', 'always'];

/** 选项的中文说明。 */
export const CHOICE_TEXT: Readonly<Record<DecisionChoice, string>> = {
  once: '本次允许',
  session: '本会话允许',
  always: '始终允许',
  deny: '拒绝',
};

/** 审批选项映射到运行时审批结果。 */
export const CHOICE_OUTCOME: Readonly<Record<DecisionChoice, 'allowed-once' | 'rejected'>> = {
  once: 'allowed-once',
  session: 'allowed-once',
  always: 'allowed-once',
  deny: 'rejected',
};

/** 操作标识的写法。 */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 请求摘要的写法：SHA-256 的十六进制。 */
const REQUEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** 通用关联字段。 */
const correlation = {
  /** 工具调用标识。 */
  callId: z.string().min(1).max(200),
  /** 卡片状态版本。 */
  stateVersion: z.number().int().nonnegative(),
  /** 操作标识。 */
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  /** 请求摘要。 */
  requestDigest: z.string().regex(REQUEST_DIGEST_PATTERN),
};

/** 一次审批决定的请求。 */
export const decisionRequestSchema = z
  .object({
    ...correlation,
    /** 采纳的选项。 */
    choice: z.enum(DECISION_CHOICES),
    /** 扩大范围时的再次确认。 */
    escalationConfirmed: z.boolean(),
    /** 作出决定的客户端标识。 */
    decidedBy: z.string().min(1).max(120).optional(),
  })
  .superRefine((request, context) => {
    if (ESCALATING_CHOICES.includes(request.choice) && !request.escalationConfirmed) {
      context.addIssue({ code: 'custom', message: '扩大审批范围需要再次确认', path: ['escalationConfirmed'] });
    }
  });

/** 一次审批决定的请求。 */
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

/** 审批决定的结果。 */
export type DecisionResult =
  | {
    readonly outcome: 'decided';
    readonly callId: string;
    readonly stateVersion: number;
    readonly choice: DecisionChoice;
    readonly decidedAt: number;
  }
  | {
    readonly outcome: 'already-decided';
    readonly callId: string;
    readonly choice: DecisionChoice;
    readonly decidedAt: number;
  }
  | {
    readonly outcome: 'rejected';
    readonly code: string;
  };

/** 提问应答的一题。 */
export const answerItemSchema = z.object({
  /** 问题标识。 */
  id: z.string().min(1).max(200),
  /** 选中的选项文本。 */
  selected: z.array(z.string().min(1).max(300)).max(50),
  /** 自由输入。 */
  custom: z.string().max(20000).optional(),
});

/** 提问应答的一题。 */
export type AnswerItem = z.infer<typeof answerItemSchema>;

/** 提问应答的请求。 */
export const questionAnswerRequestSchema = z.object({
  ...correlation,
  /** 逐问题的应答。 */
  answers: z.array(answerItemSchema).min(1),
});

/** 提问应答的请求。 */
export type QuestionAnswerRequest = z.infer<typeof questionAnswerRequestSchema>;

/** 跳过的请求。 */
export const questionSkipRequestSchema = z.object({ ...correlation });

/** 跳过的请求。 */
export type QuestionSkipRequest = z.infer<typeof questionSkipRequestSchema>;

/** 提问应答的结果。 */
export type QuestionResult =
  | {
    readonly outcome: 'submitted';
    readonly stateVersion: number;
    readonly submittedAt: number;
  }
  | {
    readonly outcome: 'rejected';
    readonly code: string;
    readonly problems?: readonly string[];
  };

/** 计划接管的动作。 */
export const TAKEOVER_ACTIONS = ['acquire', 'release'] as const;

/** 计划接管的动作取值。 */
export type TakeoverAction = (typeof TAKEOVER_ACTIONS)[number];

/** 计划接管的请求。 */
export const takeoverRequestSchema = z.object({
  /** 动作。 */
  action: z.enum(TAKEOVER_ACTIONS),
  /** 计划卡片对应的工具调用标识。 */
  callId: z.string().min(1).max(200),
  /** 接管者标识。 */
  holderId: z.string().min(1).max(120),
  /** 接管者的展示名。 */
  holderLabel: z.string().min(1).max(120),
  /** 卡片状态版本。 */
  stateVersion: z.number().int().nonnegative(),
});

/** 计划接管的请求。 */
export type TakeoverRequest = z.infer<typeof takeoverRequestSchema>;

/** 计划接管的结果。 */
export interface TakeoverResult {
  /** 结果：取得、已被他人持有、已释放、被拒绝。 */
  readonly outcome: 'granted' | 'held' | 'released' | 'rejected';
  /** 当前持有者。 */
  readonly holderId?: string;
  /** 当前持有者的展示名。 */
  readonly holderLabel?: string;
  /** 可编辑的草稿文本。 */
  readonly draft?: string;
  /** 草稿版本。 */
  readonly draftRevision?: number;
  /** 被拒绝或无法接管的原因说明。 */
  readonly reason?: string;
  /** 被拒绝时的错误码。 */
  readonly code?: string;
}

/** 计划草稿的保存请求。 */
export const planDraftRequestSchema = z.object({
  /** 计划卡片对应的工具调用标识。 */
  callId: z.string().min(1).max(200),
  /** 接管者标识。 */
  holderId: z.string().min(1).max(120),
  /** 草稿文本。 */
  text: z.string().max(200000),
  /** 客户端已知的草稿版本。 */
  revision: z.number().int().nonnegative(),
  /** 卡片状态版本。 */
  stateVersion: z.number().int().nonnegative(),
});

/** 计划草稿的保存请求。 */
export type PlanDraftRequest = z.infer<typeof planDraftRequestSchema>;

/** 计划草稿的保存结果。 */
export interface PlanDraftResult {
  /** 结果：已保存、版本冲突、被拒绝。 */
  readonly outcome: 'saved' | 'conflict' | 'rejected';
  /** 保存后的草稿版本。 */
  readonly revision: number;
  /** 保存时刻的毫秒时间戳。 */
  readonly updatedAt: number;
  /** 说明。 */
  readonly reason?: string;
  /** 错误码。 */
  readonly code?: string;
}

/** 计划提交的方式。 */
export const PLAN_SUBMIT_DECISIONS = ['approve', 'revise'] as const;

/** 计划提交的方式取值。 */
export type PlanSubmitDecision = (typeof PLAN_SUBMIT_DECISIONS)[number];

/** 计划提交的请求。 */
export const planSubmitRequestSchema = z.object({
  ...correlation,
  /** 接管者标识。 */
  holderId: z.string().min(1).max(120),
  /** 提交方式。 */
  decision: z.enum(PLAN_SUBMIT_DECISIONS),
  /** 修改意见。 */
  feedback: z.string().max(20000),
});

/** 计划提交的请求。 */
export type PlanSubmitRequest = z.infer<typeof planSubmitRequestSchema>;
