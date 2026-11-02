/**
 * Hermes 运行写入 DSH 会话的批次构造。
 *
 * 一次运行的写入拆成四类批次：开回合、审批请求、审批决定、回合收尾与运行记录。
 * 审批批次在事件到达时立即写入并取得耐久屏障，因此审批卡片在运行结束之前就可见。
 * 每个批次都带业务标识，重复写入由写入器按标识跳过。
 * @module @chatdsh/host-chat-hermes/batches
 */

import { APPROVAL_RECORD_TYPE, type ApprovalChoice } from '@chatdsh/core-contracts';
import type { WriteBatch } from './writer.ts';

/** 运行记录的事件类型名。 */
export const HERMES_RUN_RECORD_TYPE = 'plugin:chatdsh-hermes-run';

/** 运行记录的状态取值。 */
export type RunRecordState = 'accepted' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** 回合收尾原因。 */
export type TurnCloseKind = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** 开回合批次的输入。 */
export interface TurnOpenInput {
  readonly runId: string;
  readonly turn: number;
  readonly step: number;
  readonly userText: string;
}

/**
 * 构造开回合批次：回合、步骤与用户消息。
 * @param input - 运行、回合号与用户输入。
 * @returns 写入批次。
 */
export function turnOpenBatch(input: TurnOpenInput): WriteBatch {
  return {
    identity: { kind: 'user-message', id: `hermes:${input.runId}:user` },
    events: [
      { type: 'turn/start', data: { turn: input.turn } },
      { type: 'step/start', data: { turn: input.turn, step: input.step } },
      {
        type: 'user/message',
        data: {
          id: `hermes:${input.runId}:user`,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: input.userText }],
        },
        surfaceOp: 'append',
      },
    ],
  };
}

/** 收尾批次的输入。 */
export interface TurnCloseInput {
  readonly runId: string;
  readonly turn: number;
  readonly step: number;
  readonly assistantText: string;
  readonly kind: TurnCloseKind;
  readonly provider: string;
  readonly model: string;
}

/** 回合收尾原因的形状。 */
function reasonOf(kind: TurnCloseKind): Record<string, unknown> {
  switch (kind) {
    case 'completed': return { kind: 'completed' };
    case 'cancelled': return { kind: 'aborted', reason: { kind: 'user' } };
    case 'interrupted': return { kind: 'interrupted' };
    case 'failed': return { kind: 'error', error: { code: 'UNKNOWN', message: 'Hermes 运行失败' } };
  }
}

/**
 * 构造收尾批次：助手消息、步骤结束与回合结束。
 * @param input - 运行、回合号、助手文本与终态。
 * @returns 写入批次。
 */
export function turnCloseBatch(input: TurnCloseInput): WriteBatch {
  return {
    identity: { kind: 'assistant-message', id: `hermes:${input.runId}:assistant` },
    events: [
      {
        type: 'assistant/message',
        data: {
          turn: input.turn,
          step: input.step,
          message: {
            id: `hermes:${input.runId}:assistant`,
            role: 'assistant',
            source: { kind: 'model', provider: input.provider, model: input.model },
            content: [{ type: 'text', text: input.assistantText }],
          },
          stream: [],
        },
        surfaceOp: 'append',
      },
      { type: 'step/end', data: { turn: input.turn, step: input.step } },
      { type: 'turn/end', data: { turn: input.turn, reason: reasonOf(input.kind) } },
    ],
  };
}

/** 审批请求批次的输入。 */
export interface ApprovalRequestInput {
  readonly runId: string;
  readonly requestId: string;
  readonly title: string;
  readonly detail?: string;
  readonly choices: readonly ApprovalChoice[];
  readonly expiresAt: number;
}

/**
 * 构造审批请求批次。
 * @param input - 运行、请求、标题、选项与过期时刻。
 * @returns 写入批次。
 */
export function approvalRequestBatch(input: ApprovalRequestInput): WriteBatch {
  return {
    identity: { kind: 'plugin-record', type: APPROVAL_RECORD_TYPE, match: { kind: 'request', runId: input.runId, requestId: input.requestId } },
    events: [{
      type: APPROVAL_RECORD_TYPE,
      data: {
        kind: 'request',
        runId: input.runId,
        requestId: input.requestId,
        origin: 'hermes',
        title: input.title,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        choices: [...input.choices],
        expiresAt: input.expiresAt,
      },
    }],
  };
}

/** 审批决定批次的输入。 */
export interface ApprovalDecisionInput {
  readonly runId: string;
  readonly requestId: string;
  readonly choice: ApprovalChoice;
  readonly answeredBy: string;
  readonly stale: boolean;
}

/**
 * 构造审批决定批次。
 * @param input - 运行、请求、选择、应答端与是否已失效。
 * @returns 写入批次。
 */
export function approvalDecisionBatch(input: ApprovalDecisionInput): WriteBatch {
  return {
    identity: {
      kind: 'plugin-record',
      type: APPROVAL_RECORD_TYPE,
      match: { kind: 'decision', runId: input.runId, requestId: input.requestId, stale: input.stale },
    },
    events: [{
      type: APPROVAL_RECORD_TYPE,
      data: {
        kind: 'decision',
        runId: input.runId,
        requestId: input.requestId,
        choice: input.choice,
        answeredBy: input.answeredBy,
        answeredAt: Date.now(),
        stale: input.stale,
      },
    }],
  };
}

/** 运行记录批次的输入。 */
export interface RunRecordInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly state: RunRecordState;
  readonly turn: number;
  readonly historyDigest: string;
  readonly historyPages: number;
  readonly model: { readonly provider?: string; readonly model?: string; readonly source: string };
  readonly firstUser: string;
  readonly loss: readonly { readonly code: string; readonly count: number }[];
  readonly approvals?: readonly string[];
  readonly assistantText?: string;
  readonly lastEvent?: string;
}

/**
 * 构造运行记录批次。
 * @param input - 运行、会话、操作标识、状态与结果摘要。
 * @returns 写入批次。
 */
export function runRecordBatch(input: RunRecordInput): WriteBatch {
  return {
    identity: { kind: 'plugin-record', type: HERMES_RUN_RECORD_TYPE, match: { runId: input.runId, state: input.state } },
    events: [{
      type: HERMES_RUN_RECORD_TYPE,
      data: {
        runId: input.runId,
        sessionId: input.sessionId,
        operationId: input.operationId,
        state: input.state,
        turn: input.turn,
        historyDigest: input.historyDigest,
        historyPages: input.historyPages,
        model: input.model,
        firstUser: input.firstUser,
        loss: input.loss.map((item) => ({ code: item.code, count: item.count })),
        updatedAt: Date.now(),
        ...(input.approvals === undefined ? {} : { approvals: [...input.approvals] }),
        ...(input.assistantText === undefined ? {} : { assistantText: input.assistantText }),
        ...(input.lastEvent === undefined ? {} : { lastEvent: input.lastEvent }),
      },
    }],
  };
}
