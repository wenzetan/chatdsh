/**
 * 按会话串行的幂等写入。
 *
 * 同一会话的写入排队执行：取写句柄、读现有日志、判定批次是否已经写过、追加并取得
 * 耐久屏障，全程只允许一个写者。批次带业务标识，重试时先按标识比对已有日志，已有
 * 相同批次就直接跳过，因此宿主重启或客户端重连不会重复写入同一运行事件。
 * 写入句柄被别人（例如活动 Agent）持有时直接失败，不降级到另一条路径。
 * @module @chatdsh/host-chat-hermes/writer
 */

import { sessionPersistenceOf, type Context, type SessionId } from '@chatdsh/adapter';
import { readHistoryPages, type HistoryEventLike } from '@chatdsh/hermes-adapter';

/** 写入前读取现有日志的分页条数。 */
const PAGE_SIZE = 200;

/** 一条待写入的会话事件。 */
export interface PendingSessionEvent {
  /** 事件类型。 */
  readonly type: string;
  /** 事件载荷。 */
  readonly data: Record<string, unknown>;
  /** 表面追加标记；消息事件必需。 */
  readonly surfaceOp?: 'append';
}

/** 批次的业务标识。 */
export type BatchIdentity =
  | { readonly kind: 'user-message'; readonly id: string }
  | { readonly kind: 'assistant-message'; readonly id: string }
  | { readonly kind: 'plugin-record'; readonly type: string; readonly match: Readonly<Record<string, string | number | boolean>> };

/** 一次写入的批次。 */
export interface WriteBatch {
  readonly identity: BatchIdentity;
  readonly events: readonly PendingSessionEvent[];
}

/** 写入结果。 */
export interface WriteResult {
  /** 本次真正追加的事件条数；批次已存在时为 0。 */
  readonly appended: number;
  /** 批次是否因为已经存在而跳过。 */
  readonly skipped: boolean;
  /** 写入前后的下一个序号。 */
  readonly nextSeq: number;
}

/** 取插件记录载荷。 */
function dataOf(event: HistoryEventLike): Record<string, unknown> {
  const data = event.data;
  return data !== null && typeof data === 'object' ? data as Record<string, unknown> : {};
}

/**
 * 判断批次是否已经在日志里。
 * @param events - 现有事件。
 * @param identity - 批次标识。
 * @returns 已经写过时为 true。
 */
export function batchExists(events: readonly HistoryEventLike[], identity: BatchIdentity): boolean {
  switch (identity.kind) {
    case 'user-message':
      return events.some((event) => event.type === 'user/message' && dataOf(event).id === identity.id);
    case 'assistant-message':
      return events.some((event) => {
        if (event.type !== 'assistant/message') return false;
        const message = dataOf(event).message;
        return message !== null && typeof message === 'object' && (message as { id?: unknown }).id === identity.id;
      });
    case 'plugin-record':
      return events.some((event) => {
        if (event.type !== identity.type) return false;
        const data = dataOf(event);
        return Object.entries(identity.match).every(([key, value]) => data[key] === value);
      });
  }
}

/** 会话写入器。 */
export class SessionWriter {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly ctx: Context) {}

  /**
   * 在一个会话的串行队列里执行任务。
   * @param sessionId - 会话标识。
   * @param task - 任务。
   * @returns 任务结果。
   */
  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.chains.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * 幂等追加一个批次。
   * @param sessionId - 会话标识。
   * @param batch - 批次与业务标识。
   * @returns 追加结果。
   */
  append(sessionId: string, batch: WriteBatch): Promise<WriteResult> {
    return this.serialize(sessionId, async () => {
      const handle = await sessionPersistenceOf(this.ctx).open(sessionId as SessionId, 'write');
      try {
        const read = await readHistoryPages({
          read: async (offset, length) => {
            const page = await handle.read(offset, length);
            return { events: page.events as unknown as readonly HistoryEventLike[], eventState: page.eventState };
          },
        }, PAGE_SIZE);
        if (batchExists(read.events, batch.identity)) {
          return { appended: 0, skipped: true, nextSeq: read.events.length };
        }
        const now = Date.now();
        const events = batch.events.map((event, index) => ({
          type: event.type,
          seq: read.events.length + index,
          time: now,
          data: event.data,
          ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
          ...(event.type.startsWith('plugin:') ? { ignorable: true as const } : {}),
        }));
        await handle.append(events as never);
        await handle.flush();
        return { appended: events.length, skipped: false, nextSeq: read.events.length + events.length };
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * 读取一个会话的现有事件，供调用方计算回合号或查找运行记录。
   * @param sessionId - 会话标识。
   * @returns 完整事件序列。
   */
  read(sessionId: string): Promise<readonly HistoryEventLike[]> {
    return this.serialize(sessionId, async () => {
      const handle = await sessionPersistenceOf(this.ctx).open(sessionId as SessionId, 'read');
      try {
        const read = await readHistoryPages({
          read: async (offset, length) => {
            const page = await handle.read(offset, length);
            return { events: page.events as unknown as readonly HistoryEventLike[], eventState: page.eventState };
          },
        }, PAGE_SIZE);
        return read.events;
      } finally {
        await handle.close();
      }
    });
  }
}
