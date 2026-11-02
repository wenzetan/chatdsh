/**
 * DSH 权威历史的规范化。
 *
 * 读取按页进行，直到日志结束；规范化只取模型可见表面上的纯文本，system 取第一条
 * 稳定文本，第一条 user 单独标出。压缩与撤销在 DSH 侧用表面替换表达，替换掉的节点
 * 已经不在表面上，这里不会让它们复活。被排除的内容逐项计入损失声明，调用方据此
 * 说明跨执行体继承的范围。
 * @module @chatdsh/hermes-adapter/history
 */

import { createHash } from 'node:crypto';

/** 默认分页条数。 */
export const DEFAULT_HISTORY_PAGE_SIZE = 200;

/** 分页读取用的事件形状。 */
export interface HistoryEventLike {
  readonly type: string;
  readonly seq: number;
  readonly data: unknown;
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number };
  readonly sourceEventSeqs?: readonly number[];
  readonly ignorable?: true;
}

/** 分页读取的当前页。 */
export interface HistoryPage {
  readonly events: readonly HistoryEventLike[];
  /** 事件值的所有权状态，构造 detached Session 时原样传回。 */
  readonly eventState: string;
}

/** 分页读取源。 */
export interface HistoryReadSource {
  read(offset: number, length: number): Promise<HistoryPage>;
}

/** 分页读取结果。 */
export interface HistoryReadResult {
  /** 完整事件序列，按序号连续。 */
  readonly events: readonly HistoryEventLike[];
  /** 实际读取的页数。 */
  readonly pages: number;
  /** 事件值的所有权状态。 */
  readonly eventState: string;
}

/** 一条投影后的消息，只含规范化需要的字段。 */
export interface HistoryProjectedMessage {
  /** 角色：system、user、assistant、developer、tool 等。 */
  readonly role: string;
  /** 纯文本内容；非文本块不进入这里。 */
  readonly text: string;
  /** 消息标识，存在时原样保留。 */
  readonly messageId?: string;
  /** 内容块类型列表，用于统计被排除的非文本内容。 */
  readonly contentTypes: readonly string[];
  /** 助手消息的来源执行体。 */
  readonly provider?: string;
  /** 助手消息的来源模型。 */
  readonly model?: string;
}

/** 表面投影结果。 */
export interface HistoryProjection {
  /** 当前模型可见表面上的消息，按顺序。 */
  readonly messages: readonly HistoryProjectedMessage[];
}

/** 一条损失声明。 */
export interface HistoryLossDeclaration {
  /** 损失种类。 */
  readonly code:
    | 'tool-traces-omitted'
    | 'non-text-blocks-omitted'
    | 'developer-messages-omitted'
    | 'system-revisions-superseded'
    | 'shadowed-messages-omitted';
  /** 受影响条数。 */
  readonly count: number;
}

/** 一条跨执行体传输的消息。 */
export interface HistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly messageId?: string;
}

/** 规范化后的历史。 */
export interface HistorySnapshot {
  /** 稳定的 system 文本：第一条非空 system 消息。 */
  readonly system: string;
  /** 表面上的第一条 user 文本；没有时为空串。 */
  readonly firstUser: string;
  /** 按顺序的 user 与 assistant 文本消息，不含 system。 */
  readonly messages: readonly HistoryMessage[];
  /** 完整历史的指纹：system 与消息序列的 SHA-256 十六进制。 */
  readonly historyDigest: string;
  /** 观察到的模型元数据。 */
  readonly model: {
    readonly provider?: string;
    readonly model?: string;
    readonly source: 'assistant' | 'configured' | 'none';
  };
  /** 损失声明，按种类排序。 */
  readonly loss: readonly HistoryLossDeclaration[];
  /** 读取的页数。 */
  readonly pages: number;
  /** 事件条数。 */
  readonly eventCount: number;
  /** 消息条数，含 system。 */
  readonly messageCount: number;
}

/** 规范化输入。 */
export interface NormalizeHistoryInput {
  readonly events: readonly HistoryEventLike[];
  readonly projection: HistoryProjection;
  readonly pages: number;
  readonly configuredModel?: { readonly provider?: string; readonly model?: string };
}

/**
 * 按页读完整个日志。
 * @param source - 读取源。
 * @param pageSize - 每页条数。
 * @returns 连续事件、页数与所有权状态。
 */
export async function readHistoryPages(
  source: HistoryReadSource,
  pageSize: number = DEFAULT_HISTORY_PAGE_SIZE,
): Promise<HistoryReadResult> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error(`历史分页条数非法：${pageSize}`);
  const events: HistoryEventLike[] = [];
  let pages = 0;
  let eventState = 'detached';
  for (let offset = 0; ; offset += pageSize) {
    const page = await source.read(offset, pageSize);
    pages += 1;
    eventState = page.eventState;
    if (page.events.length > pageSize) {
      throw new Error(`历史分页返回了 ${page.events.length} 条，超过请求的 ${pageSize} 条`);
    }
    for (const [index, event] of page.events.entries()) {
      const expected = offset + index;
      if (event.seq !== expected) {
        throw new Error(`历史分页不连续：期望序号 ${expected}，收到 ${event.seq}`);
      }
      events.push(event);
    }
    if (page.events.length < pageSize) break;
  }
  return { events: [...events], pages, eventState };
}

/**
 * 计算历史指纹。
 * @param system - 稳定 system 文本。
 * @param messages - 传输的消息序列。
 * @returns SHA-256 十六进制。
 */
export function historyDigestOf(system: string, messages: readonly HistoryMessage[]): string {
  const canonical = JSON.stringify({
    system,
    messages: messages.map((message) => [message.role, message.text]),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * 规范化一条完整历史。
 * @param input - 事件、表面投影与页数。
 * @returns 历史快照与损失声明。
 */
export function normalizeHistory(input: NormalizeHistoryInput): HistorySnapshot {
  const { messages } = input.projection;
  const systems = messages.filter((message) => message.role === 'system' && message.text !== '');
  const system = systems[0]?.text ?? '';
  const conversation: HistoryMessage[] = [];
  let firstUser = '';
  let nonTextBlocks = 0;
  let developerMessages = 0;
  for (const message of messages) {
    for (const contentType of message.contentTypes) {
      if (contentType !== 'text') nonTextBlocks += 1;
    }
    if (message.role === 'user' && message.text !== '') {
      if (firstUser === '') firstUser = message.text;
      conversation.push({ role: 'user', text: message.text, ...(message.messageId === undefined ? {} : { messageId: message.messageId }) });
      continue;
    }
    if (message.role === 'assistant' && message.text !== '') {
      conversation.push({ role: 'assistant', text: message.text, ...(message.messageId === undefined ? {} : { messageId: message.messageId }) });
      continue;
    }
    if (message.role === 'developer') developerMessages += 1;
  }

  const toolTraces = messages.filter((message) => message.role === 'tool').length;
  const bySeq = new Map(input.events.map((event) => [event.seq, event]));
  const shadowed = new Set<number>();
  for (const event of input.events) {
    if (event.surfaceOp === undefined || event.surfaceOp === 'append') continue;
    for (const seq of event.sourceEventSeqs ?? []) {
      const shadowedEvent = bySeq.get(seq);
      if (shadowedEvent !== undefined && shadowedEvent.seq !== event.seq) shadowed.add(seq);
    }
  }
  const loss: HistoryLossDeclaration[] = [];
  if (toolTraces > 0) loss.push({ code: 'tool-traces-omitted', count: toolTraces });
  if (nonTextBlocks > 0) loss.push({ code: 'non-text-blocks-omitted', count: nonTextBlocks });
  if (developerMessages > 0) loss.push({ code: 'developer-messages-omitted', count: developerMessages });
  if (systems.length > 1) loss.push({ code: 'system-revisions-superseded', count: systems.length - 1 });
  if (shadowed.size > 0) loss.push({ code: 'shadowed-messages-omitted', count: shadowed.size });

  const lastAssistant = [...messages].reverse().find(
    (message) => message.role === 'assistant' && message.provider !== undefined && message.model !== undefined,
  );
  const model = lastAssistant !== undefined
    ? { provider: lastAssistant.provider, model: lastAssistant.model, source: 'assistant' as const }
    : input.configuredModel !== undefined && (input.configuredModel.provider !== undefined || input.configuredModel.model !== undefined)
      ? { ...input.configuredModel, source: 'configured' as const }
      : { source: 'none' as const };

  return {
    system,
    firstUser,
    messages: conversation,
    historyDigest: historyDigestOf(system, conversation),
    model,
    loss,
    pages: input.pages,
    eventCount: input.events.length,
    messageCount: messages.length,
  };
}
