/**
 * 审批投影的类型登记。
 *
 * 投影键注册进 `SessionProjectionMap` 与 `SessionProjectionStateMap`：前者是宿主的折叠状态，
 * 后者是状态快照的形状。两处都要登记，注册表才认这个键。
 * @module @chatdsh/host-approval/types
 */

import { SESSION_EVENT_TYPES } from '@chatdsh/adapter/events';

/** 待处理的一条审批。 */
export interface PendingApproval {
  readonly id: string;
  /** 工具调用标识，作答时用它与等待表配对。 */
  readonly callId?: string;
  readonly toolName: string;
  readonly reason?: string;
  readonly askedAt: number;
}

/** 投影状态。 */
export interface ApprovalsState {
  /** 尚在等待回答的审批。 */
  readonly pending: PendingApproval[];
  /** 累计提出的审批数。 */
  readonly askedCount: number;
  /** 最近一次结果。 */
  readonly lastOutcome?: string;
  /** 最近一次结果发生的时刻。 */
  readonly lastAt?: number;
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    chatdshApprovals: ApprovalsState;
  }

  interface SessionProjectionStateMap {
    chatdshApprovals: ApprovalsState;
  }
}

/**
 * 从审批请求里取关联键。
 *
 * 上游的 `approval/request` 水位事件带的是 `agent`、`toolName`、`callId`、`reason`，
 * 没有 `id` 字段——`id` 只出现在会话日志的 `approval/asked` 与 `approval/decided`
 * 两条审计事件里，而那两条事件由审批服务在提出问题时自行生成，请求方看不到。
 *
 * 因此关联键取 `callId`：它是请求与工具调用之间上游明确保证的稳定关联点。
 * 没有 `callId` 的请求无法与审计事件配对。
 * @param request - 审批请求的关联字段。
 * @returns 关联键；没有可用的关联点时返回 `undefined`。
 */
export function correlationKeyOf(request: { callId?: unknown }): string | undefined {
  const callId = request.callId;
  if (typeof callId !== 'string' || callId === '') return undefined;
  return callId;
}

/** 事件形状，只取用到的字段。 */
export interface ApprovalEvent {
  readonly type: string;
  readonly time?: number;
  readonly data?: {
    id?: string;
    /** 工具调用标识：审批请求与审计事件之间唯一可配对的关联点。 */
    callId?: string;
    toolName?: string;
    reason?: string;
    outcome?: string;
  };
}

/**
 * 折叠一条事件。
 *
 * 与审批无关的事件原样返回同一个对象，避免投影层做多余的复制。
 * @param state - 当前状态。
 * @param event - 会话事件。
 * @returns 新状态或原状态。
 */
export function applyApprovalEvent(state: ApprovalsState, event: ApprovalEvent): ApprovalsState {
  const data = event.data;
  if (data?.id === undefined) return state;
  if (event.type === SESSION_EVENT_TYPES.approvalAsked) {
    const pending: PendingApproval = {
      id: data.id,
      callId: data.callId,
      toolName: data.toolName ?? 'unknown',
      reason: data.reason,
      askedAt: event.time ?? 0,
    };
    return { ...state, pending: [...state.pending, pending], askedCount: state.askedCount + 1 };
  }
  if (event.type === SESSION_EVENT_TYPES.approvalDecided) {
    return {
      pending: state.pending.filter((item) => item.id !== data.id),
      askedCount: state.askedCount,
      lastOutcome: data.outcome,
      lastAt: event.time ?? 0,
    };
  }
  return state;
}

/** 卡片失效的原因。 */
export const INVALID_REASONS = [
  'already-decided',
  'expired',
  'session-ended',
  'device-offline',
  'policy-changed',
  'waiter-gone',
] as const;

/** 卡片失效的原因取值。 */
export type InvalidReason = (typeof INVALID_REASONS)[number];

/** 失效原因的中文说明。 */
export const INVALID_REASON_TEXT: Readonly<Record<InvalidReason, string>> = {
  'already-decided': '另一客户端已经处理了这张卡片',
  expired: '卡片已超过失效时刻',
  'session-ended': '会话已经结束，等待者不再存在',
  'device-offline': '设备不在线，决定没有发出',
  'policy-changed': '会话审批策略已经变化，这张卡片不再适用',
  'waiter-gone': '等待该项决定的工具调用已经结束',
};

/** 审批卡片的运行期状态。 */
export const LIVE_CARD_STATES = ['pending', 'answering', 'decided', 'expired', 'unavailable'] as const;

/** 审批卡片的运行期状态取值。 */
export type LiveCardState = (typeof LIVE_CARD_STATES)[number];

/** 一张审批卡片在界面上需要的全部字段。 */
export interface ApprovalCardView {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 运行标识。 */
  readonly runId?: string;
  /** 工具调用标识，与状态版本共同构成关联键。 */
  readonly callId: string;
  /** 状态版本。 */
  readonly stateVersion: number;
  /** 当前状态。 */
  readonly state: LiveCardState;
  /** 来源执行体。 */
  readonly origin: 'dsh' | 'hermes';
  /** 工具名称。 */
  readonly toolName: string;
  /** 脱敏后的摘要，不含参数原文。 */
  readonly summary: string;
  /** 提出原因。 */
  readonly reason?: string;
  /** 目标设备。 */
  readonly deviceId: string;
  /** 目标工作目录。 */
  readonly cwd?: string;
  /** 能力范围说明。 */
  readonly capabilityScope: string;
  /** 实际策略允许的选项。 */
  readonly choices: readonly string[];
  /** 展示优先级，数值小的先展示。 */
  readonly priority: number;
  /** 提出时刻的毫秒时间戳。 */
  readonly raisedAt: number;
  /** 失效时刻的毫秒时间戳。 */
  readonly expiresAt: number;
  /** 已经失效时的原因。 */
  readonly invalidReason?: InvalidReason;
  /** 失效原因的中文说明。 */
  readonly invalidText?: string;
  /** 作出决定的客户端。 */
  readonly decidedBy?: string;
  /** 决定采用的选项。 */
  readonly decidedChoice?: string;
  /** 决定时刻的毫秒时间戳。 */
  readonly decidedAt?: number;
}

/** 待处理列表里的一组卡片。 */
export interface ApprovalToolGroup {
  /** 工具名称。 */
  readonly toolName: string;
  /** 该工具下等待处理的卡片数。 */
  readonly count: number;
  /** 卡片标识。 */
  readonly callIds: readonly string[];
}

/** 一个会话的分组。 */
export interface ApprovalSessionGroup {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 会话标识，供跳转使用。 */
  readonly sessionHref: string;
  /** 该会话等待处理的卡片数。 */
  readonly count: number;
  /** 按工具分组。 */
  readonly tools: readonly ApprovalToolGroup[];
}

/** 一个设备的分组。 */
export interface ApprovalDeviceGroup {
  /** 设备标识。 */
  readonly deviceId: string;
  /** 该设备等待处理的卡片数。 */
  readonly count: number;
  /** 按会话分组。 */
  readonly sessions: readonly ApprovalSessionGroup[];
}

/** 待处理列表的整体读取结果。 */
export interface PendingOverview {
  /** 全部卡片，可操作的在前，失效的在后。 */
  readonly cards: readonly ApprovalCardView[];
  /** 按设备、会话、工具分组。 */
  readonly groups: readonly ApprovalDeviceGroup[];
  /** 可操作的卡片数。 */
  readonly actionable: number;
  /** 读取时刻的毫秒时间戳。 */
  readonly readAt: number;
}

/** 最近一条决定记录。 */
export interface DecisionRecord {
  /** 工具调用标识。 */
  readonly callId: string;
  /** 会话标识。 */
  readonly sessionId: string;
  /** 工具名称。 */
  readonly toolName: string;
  /** 结果：批准、拒绝、超时、自动批准。 */
  readonly result: 'approved' | 'denied' | 'timeout' | 'auto-approved';
  /** 采用的选项。 */
  readonly choice?: string;
  /** 作出决定的客户端。 */
  readonly decidedBy: string;
  /** 决定时刻的毫秒时间戳。 */
  readonly decidedAt: number;
}

/** 审批统计。 */
export interface ApprovalStats {
  /** 会话标识；全局统计时缺省。 */
  readonly sessionId?: string;
  /** 批准数。 */
  readonly approved: number;
  /** 拒绝数。 */
  readonly denied: number;
  /** 超时数。 */
  readonly timeout: number;
  /** 按策略自动批准数。 */
  readonly autoApproved: number;
  /** 决定总数。 */
  readonly total: number;
  /** 仍在等待的卡片数。 */
  readonly pending: number;
  /** 最近的决定记录，按时间倒序。 */
  readonly recent: readonly DecisionRecord[];
  /** 读取时刻的毫秒时间戳。 */
  readonly readAt: number;
}

/** 一条生效中的会话策略。 */
export interface PolicyRecord {
  /** 策略标识。 */
  readonly id: string;
  /** 作用范围。 */
  readonly scope: 'session' | 'device';
  /** 会话标识；设备范围时缺省。 */
  readonly sessionId?: string;
  /** 工具名称。 */
  readonly toolName: string;
  /** 采纳的选项。 */
  readonly choice: string;
  /** 建立时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 作用范围的说明。 */
  readonly description: string;
}

/** 一张提问卡片在界面上需要的字段。 */
export interface QuestionView {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 工具调用标识。 */
  readonly callId: string;
  /** 状态版本。 */
  readonly stateVersion: number;
  /** 当前状态。 */
  readonly state: 'pending' | 'answering' | 'submitted' | 'expired' | 'cancelled';
  /** 卡片类型：普通提问或计划审阅。 */
  readonly kind: 'question' | 'plan-review';
  /** 问题列表。 */
  readonly questions: readonly QuestionItemView[];
  /** 计划正文；计划审阅卡片才有。 */
  readonly planMarkdown?: string;
  /** 提出时刻的毫秒时间戳。 */
  readonly raisedAt: number;
  /** 失效时刻的毫秒时间戳。 */
  readonly expiresAt: number;
  /** 失效原因。 */
  readonly invalidReason?: InvalidReason;
  /** 失效说明。 */
  readonly invalidText?: string;
  /** 计划接管的当前状态。 */
  readonly takeover?: TakeoverStateView;
}

/** 一个问题在界面上的形状。 */
export interface QuestionItemView {
  /** 问题标识。 */
  readonly id: string;
  /** 问题文本。 */
  readonly question: string;
  /** 补充说明。 */
  readonly detail?: string;
  /** 分组标题。 */
  readonly header?: string;
  /** 候选项。 */
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  /** 是否多选。 */
  readonly multiple: boolean;
  /** 是否允许自由输入。 */
  readonly allowFreeText: boolean;
}

/** 计划接管的当前状态。 */
export interface TakeoverStateView {
  /** 当前持有者标识。 */
  readonly holderId?: string;
  /** 当前持有者的展示名。 */
  readonly holderLabel?: string;
  /** 草稿文本。 */
  readonly draft: string;
  /** 草稿版本。 */
  readonly draftRevision: number;
  /** 草稿更新时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}
