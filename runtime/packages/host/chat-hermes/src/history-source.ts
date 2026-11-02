/**
 * 从 DSH 权威历史读出完整消息。
 *
 * 读取按页进行直到日志结束；再用上游的会话重建与派生历史把表面折叠好，压缩与撤销
 * 产生的替换在派生时已经生效，被替换的消息不会出现在结果里。会话不存在时直接抛出，
 * 不替调用方创建没有归属的会话。
 * @module @chatdsh/host-chat-hermes/history-source
 */

import { sessionPersistenceOf, sessionsOf, type Context, type SessionId } from '@chatdsh/adapter';
import {
  normalizeHistory,
  readHistoryPages,
  type HistoryEventLike,
  type HistoryProjectedMessage,
  type HistoryReadResult,
  type HistorySnapshot,
} from '@chatdsh/hermes-adapter';

/** 消息内容块的最小形状。 */
interface ContentBlockLike {
  readonly type: string;
  readonly text?: string;
}

/** 派生消息的最小形状。 */
interface MessageLike {
  readonly role: string;
  readonly id?: string;
  readonly content: readonly ContentBlockLike[];
  readonly source?: {
    readonly kind?: string;
    readonly provider?: string;
    readonly model?: string;
  };
}

/** 读取结果。 */
export interface SessionHistory {
  /** 规范化后的历史。 */
  readonly snapshot: HistorySnapshot;
  /** 完整事件序列。 */
  readonly events: readonly HistoryEventLike[];
  /** 分叉继承的前缀条数。 */
  readonly inheritedEventCount: number;
}

/** 把一条派生消息投影成规范化输入。 */
function projectMessage(message: MessageLike): HistoryProjectedMessage {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  const provider = message.role === 'assistant' ? message.source?.provider : undefined;
  const model = message.role === 'assistant' ? message.source?.model : undefined;
  return {
    role: message.role,
    text,
    contentTypes: message.content.map((block) => block.type),
    ...(message.id === undefined ? {} : { messageId: message.id }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * 读出一个会话的完整历史。
 * @param ctx - 宿主上下文。
 * @param sessionId - 会话标识。
 * @param options - 分页条数与配置的模型元数据。
 * @returns 完整历史、事件与继承前缀。
 */
export async function readSessionHistory(
  ctx: Context,
  sessionId: string,
  options: { readonly pageSize: number; readonly configuredModel?: { readonly provider?: string; readonly model?: string } },
): Promise<SessionHistory> {
  const id = sessionId as SessionId;
  const snapshot = await sessionPersistenceOf(ctx).stat(id);
  if (snapshot === undefined) throw new Error(`会话不存在：${sessionId}`);
  const handle = await sessionPersistenceOf(ctx).open(id, 'read');
  try {
    const read: HistoryReadResult = await readHistoryPages({
      read: async (offset, length) => {
        const page = await handle.read(offset, length);
        return {
          events: page.events as unknown as readonly HistoryEventLike[],
          eventState: page.eventState,
        };
      },
    }, options.pageSize);
    const restored = sessionsOf(ctx).prepare(id, {
      seed: read.events as never,
      meta: handle.header,
      inheritedEventCount: handle.inheritedEventCount,
      eventState: read.eventState as 'detached' | 'shared-frozen',
    });
    const messages = restored.deriveMessages().map((message) => projectMessage(message as unknown as MessageLike));
    const normalized = normalizeHistory({
      events: read.events,
      projection: { messages },
      pages: read.pages,
      ...(options.configuredModel === undefined ? {} : { configuredModel: options.configuredModel }),
    });
    return { snapshot: normalized, events: read.events, inheritedEventCount: handle.inheritedEventCount };
  } finally {
    await handle.close();
  }
}
