/**
 * Hermes 运行事件到 DSH 会话事件的翻译。
 *
 * 这一层是纯函数：输入一次运行的标识、起止序号与已收集的 Hermes 事件，输出一段可以
 * 连续追加的 DSH 会话事件。它不写存储、不调网络，因此可以用上游的落盘校验器单独验证。
 *
 * 事件序列按 hermes-integration.md 第五节的约定：
 * `turn/start` → `step/start` → `user/message` → `assistant/message` → `step/end` → `turn/end`。
 * `assistant/message` 必须带 `surfaceOp: 'append'`，且禁止携带 `sourceEventSeqs`。
 * @module @chatdsh/host-chat-hermes/translate
 */

import type { ChatRunEvent } from '@chatdsh/core-contracts';

/** 一条会话事件的信封，只含落盘需要的字段。 */
export interface ChatSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Record<string, unknown>;
  readonly surfaceOp?: 'append';
}

/** 翻译输入。 */
export interface TranslateInput {
  /** 本次运行的 Hermes `run_id`，用于消息标识与幂等。 */
  readonly runId: string;
  /** 起止序号：第一条事件的 seq。 */
  readonly firstSeq: number;
  /** 事件时刻，毫秒；缺省取当前时间。 */
  readonly now?: number;
  /** 本回合的序号。 */
  readonly turn: number;
  /** 本步骤的序号。 */
  readonly step: number;
  /** 用户输入的原文。 */
  readonly userText: string;
  /** 用户消息标识；缺省由 runId 推导。 */
  readonly userMessageId?: string;
  /** 助手消息标识；缺省由 runId 推导。 */
  readonly assistantMessageId?: string;
  /** 来源标签，写进助手消息的 `source`。 */
  readonly provider?: string;
  /** 模型标签，写进助手消息的 `source`。 */
  readonly model?: string;
  /** 已从 Hermes 收到的事件。 */
  readonly events: readonly ChatRunEvent[];
}

/** 翻译结果。 */
export interface TranslateResult {
  /** 连续事件，seq 从 `firstSeq` 开始。 */
  readonly events: ChatSessionEvent[];
  /** 助手回复的可见文本。 */
  readonly assistantText: string;
  /** 收到的审批请求，供上层写 plugin 记录与呈现卡片。 */
  readonly approvals: readonly { readonly requestId: string; readonly title: string; readonly choices: readonly string[] }[];
  /** 运行是否以错误结束。 */
  readonly failed: boolean;
}

/** 取事件里的可见文本。 */
function textOf(events: readonly ChatRunEvent[]): string {
  return events
    .filter((event): event is { type: 'text'; text: string } => event.type === 'text')
    .map((event) => event.text)
    .join('');
}

/**
 * 把一次 Hermes 运行翻译成一段 DSH 会话事件。
 * @param input - 运行标识、起止序号与已收集的事件。
 * @returns 连续事件、助手文本、审批请求与是否失败。
 */
export function translateRun(input: TranslateInput): TranslateResult {
  const now = input.now ?? Date.now();
  const provider = input.provider ?? 'hermes';
  const model = input.model ?? 'hermes-0.21.7';
  const userMessageId = input.userMessageId ?? `hermes:${input.runId}:user`;
  const assistantMessageId = input.assistantMessageId ?? `hermes:${input.runId}:assistant`;
  const assistantText = textOf(input.events);
  const failed = input.events.some((event) => event.type === 'error');

  const approvals = input.events
    .filter((event): event is Extract<ChatRunEvent, { type: 'approval-request' }> => event.type === 'approval-request')
    .map((event) => ({ requestId: event.requestId, title: event.title, choices: event.choices }));

  let seq = input.firstSeq;
  const events: ChatSessionEvent[] = [];
  const push = (event: Omit<ChatSessionEvent, 'seq' | 'time'>): void => {
    events.push({ ...event, seq, time: now });
    seq += 1;
  };

  push({ type: 'turn/start', data: { turn: input.turn } });
  push({ type: 'step/start', data: { turn: input.turn, step: input.step } });
  push({
    type: 'user/message',
    data: {
      id: userMessageId,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: input.userText }],
    },
    surfaceOp: 'append',
  });
  push({
    type: 'assistant/message',
    data: {
      turn: input.turn,
      step: input.step,
      message: {
        id: assistantMessageId,
        role: 'assistant',
        source: { kind: 'model', provider, model },
        content: [{ type: 'text', text: assistantText }],
      },
      stream: [],
    },
    surfaceOp: 'append',
  });
  push({ type: 'step/end', data: { turn: input.turn, step: input.step } });
  push({
    type: 'turn/end',
    data: { turn: input.turn, reason: failed ? { kind: 'error', error: { code: 'UNKNOWN', message: 'Hermes 运行失败' } } : { kind: 'completed' } },
  });

  return { events, assistantText, approvals, failed };
}

/**
 * 把一条审批请求写成可落盘的插件记录事件。
 *
 * 记录类型必须是 `plugin:<小写段>`，并标 `ignorable: true`，因为这类状态在会话格式
 * 迁移中允许丢弃；它只承载可以重建的呈现信息，不参与内核语义。
 * @param input - 运行、审批请求与序号。
 * @returns 一条插件记录事件。
 */
export function approvalPluginEvent(input: {
  readonly runId: string;
  readonly requestId: string;
  readonly title: string;
  readonly choices: readonly string[];
  readonly seq: number;
  readonly now?: number;
}): ChatSessionEvent {
  return {
    type: 'plugin:hermes-approval',
    seq: input.seq,
    time: input.now ?? Date.now(),
    data: {
      runId: input.runId,
      requestId: input.requestId,
      title: input.title,
      choices: [...input.choices],
      status: 'pending',
    },
    // 插件记录是 log-only；surfaceOp 在这里不出现。
  };
}

/** 一次回复写入的完整计划。 */
export interface ReplyPlan {
  /** 连续事件，含审批插件记录。 */
  readonly batch: ChatSessionEvent[];
  /** 助手回复的可见文本。 */
  readonly assistantText: string;
  /** 审批请求标识，按出现顺序。 */
  readonly approvals: string[];
}

/**
 * 计划一次回复的完整写入批次。
 *
 * 回复事件由 {@link translateRun} 生成；每个审批请求再接一条 `plugin:hermes-approval`
 * 记录。审批记录放在回合事件之后，保证宿主事件与插件记录各自连续，序号不跳跃。
 * @param input - 与 {@link translateRun} 相同，另加运行标识。
 * @returns 写入批次、助手文本与审批标识。
 */
export function planReplyBatch(input: TranslateInput): ReplyPlan {
  const translated = translateRun(input);
  const batch = [...translated.events];
  for (const [index, approval] of translated.approvals.entries()) {
    batch.push(approvalPluginEvent({
      runId: input.runId,
      requestId: approval.requestId,
      title: approval.title,
      choices: approval.choices,
      seq: input.firstSeq + translated.events.length + index,
      ...(input.now === undefined ? {} : { now: input.now }),
    }));
  }
  return {
    batch,
    assistantText: translated.assistantText,
    approvals: translated.approvals.map((approval) => approval.requestId),
  };
}
