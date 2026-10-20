/**
 * 审批投影的类型登记。
 *
 * 投影键注册进 `SessionProjectionMap` 与 `SessionProjectionStateMap`：前者是宿主的折叠状态，
 * 后者是状态快照的形状。两处都要登记，注册表才认这个键。
 * @module @chatdsh/plugin-approval/types
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
