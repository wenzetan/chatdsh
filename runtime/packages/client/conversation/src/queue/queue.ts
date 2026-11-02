/**
 * 在线执行队列：待发送条目、编辑、删除、暂停与恢复、顺序保持。
 *
 * 队列只在同一目标在线、宿主确认当前回合结束之后消费，按入队顺序一次消费一条。连接断开、
 * 目标离线或访问失效时暂停消费；恢复时先按操作标识查询每一条的实际状态，把已经确认的条目
 * 标记为已确认，其余保持待处理，等用户显式发送，因此恢复不会自动发出任何内容。
 *
 * 每条条目入队时就带操作标识，提交期间重复调用共享同一个进行中的提交；提交结果不确定时
 * 条目变成「结果尚未确认」，下一次处理先查询实际结果，不重复写入。
 * @module @chatdsh/client-conversation/queue/queue
 */

import type { PersistedReference } from '../references/references.ts';

/** 队列条目的状态。 */
export const QUEUE_ITEM_STATES = ['pending', 'sending', 'confirmed', 'failed', 'unconfirmed'] as const;

/** 队列条目状态取值。 */
export type QueueItemState = (typeof QUEUE_ITEM_STATES)[number];

/** 队列条目状态的展示文字。 */
export const QUEUE_STATE_TEXT: Readonly<Record<QueueItemState, string>> = {
  pending: '待发送',
  sending: '正在发送',
  confirmed: '已确认',
  failed: '发送失败',
  unconfirmed: '结果尚未确认',
};

/** 一条待发送条目。 */
export interface QueueItem {
  /** 条目标识，同时是提交的幂等键。 */
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  readonly references: readonly PersistedReference[];
  /** 入队时刻的毫秒时间戳。 */
  readonly createdAt: number;
  readonly state: QueueItemState;
  /** 提交标识；首次提交前与条目标识相同。 */
  readonly operationId: string;
  /** 确认后的事件序号。 */
  readonly seq?: number;
  /** 失败原因码。 */
  readonly failureCode?: string;
}

/** 一次提交。 */
export interface QueueSubmission {
  readonly requestId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly references: readonly PersistedReference[];
}

/** 提交结果。 */
export interface QueueSubmitResult {
  readonly accepted: boolean;
  /** 服务端判定为重复提交时为真。 */
  readonly duplicate?: boolean;
  readonly seq?: number;
  readonly code?: string;
}

/** 提交实现。 */
export type QueueSubmitter = (submission: QueueSubmission) => Promise<QueueSubmitResult>;

/** 状态查询结果。 */
export interface QueueStatusResult {
  readonly state: 'confirmed' | 'pending' | 'unknown';
  readonly seq?: number;
}

/** 状态查询实现。 */
export type QueueStatusQuery = (requestId: string) => Promise<QueueStatusResult>;

/** 一次消费的结果。 */
export type QueueConsumeResult =
  | { readonly outcome: 'sent'; readonly item: QueueItem; readonly seq?: number }
  | { readonly outcome: 'paused'; readonly reason: string }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'in-flight'; readonly item: QueueItem }
  | { readonly outcome: 'confirmed-already'; readonly item: QueueItem; readonly seq?: number }
  | { readonly outcome: 'requeued'; readonly item: QueueItem }
  | { readonly outcome: 'failed'; readonly item: QueueItem; readonly code: string }
  | { readonly outcome: 'unconfirmed'; readonly item: QueueItem };

/** 队列快照。 */
export interface QueueSnapshot {
  readonly items: readonly QueueItem[];
  readonly paused: boolean;
  /** 暂停原因；未暂停时缺省。 */
  readonly pauseReason?: string;
  /** 待发送条数。 */
  readonly pendingCount: number;
  /** 已确认条数。 */
  readonly confirmedCount: number;
}

/** 恢复时重新读取状态的结论。 */
export interface QueueResumeResult {
  readonly pending: readonly QueueItem[];
  readonly confirmed: readonly QueueItem[];
  readonly unconfirmed: readonly QueueItem[];
}

/** 队列的依赖。 */
export interface PendingQueueOptions {
  /** 提交实现。 */
  readonly submit: QueueSubmitter;
  /** 状态查询实现。 */
  readonly query: QueueStatusQuery;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 生成条目标识的实现。 */
  readonly createId: () => string;
}

/**
 * 在线执行队列。
 */
export class PendingQueue {
  private items: QueueItem[] = [];
  private paused = false;
  private pauseReason: string | undefined;
  private readonly inFlight = new Map<string, Promise<QueueConsumeResult>>();
  private readonly submitImpl: QueueSubmitter;
  private readonly queryImpl: QueueStatusQuery;
  private readonly now: () => number;
  private readonly createId: () => string;

  /**
   * 建立队列。
   * @param options - 提交、查询、时钟与标识生成。
   */
  constructor(options: PendingQueueOptions) {
    this.submitImpl = options.submit;
    this.queryImpl = options.query;
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId;
  }

  /** 是否暂停消费。 */
  get isPaused(): boolean {
    return this.paused;
  }

  /** 暂停原因。 */
  get pausedBy(): string | undefined {
    return this.pauseReason;
  }

  /**
   * 入队一条待发送内容。
   * @param input - 会话、正文与引用。
   * @returns 新建的条目。
   */
  enqueue(input: { readonly sessionId: string; readonly text: string; readonly references?: readonly PersistedReference[] }): QueueItem {
    if (input.text.trim() === '') throw new Error('待发送内容不能为空');
    const id = this.createId();
    const item: QueueItem = {
      id,
      sessionId: input.sessionId,
      text: input.text,
      references: [...(input.references ?? [])],
      createdAt: this.now(),
      state: 'pending',
      operationId: id,
    };
    this.items = [...this.items, item];
    return item;
  }

  /**
   * 修改一条待发送内容的正文。
   *
   * 只有待发送的条目可以修改；已发出或已确认的条目保持原样。
   * @param id - 条目标识。
   * @param text - 新正文。
   * @returns 修改后的条目。
   */
  edit(id: string, text: string): QueueItem {
    const index = this.indexOf(id);
    const current = this.items[index]!;
    if (current.state !== 'pending') throw new Error(`只有待发送的条目可以修改：${current.state}`);
    if (text.trim() === '') throw new Error('待发送内容不能为空');
    const next: QueueItem = { ...current, text };
    this.items = [...this.items.slice(0, index), next, ...this.items.slice(index + 1)];
    return next;
  }

  /**
   * 删除一条待发送内容。
   *
   * 正在提交的条目不能删除，避免删除之后提交结果无处落。
   * @param id - 条目标识。
   */
  remove(id: string): void {
    const index = this.indexOf(id);
    const current = this.items[index]!;
    if (current.state === 'sending') throw new Error('正在发送的条目不能删除');
    this.items = [...this.items.slice(0, index), ...this.items.slice(index + 1)];
  }

  /**
   * 暂停消费。
   * @param reason - 暂停原因，取固定枚举的说明文字。
   */
  pause(reason: string): void {
    if (reason === '') throw new Error('暂停原因不能为空');
    this.paused = true;
    this.pauseReason = reason;
  }

  /**
   * 恢复消费并重新读取每一条的实际状态。
   *
   * 恢复只恢复读取与可用性：已经确认的条目标记为已确认，其余保持待处理，不会自动发送。
   * @returns 恢复后各类条目的分布。
   */
  async resume(): Promise<QueueResumeResult> {
    this.paused = false;
    this.pauseReason = undefined;
    const unconfirmed = this.items.filter((item) => item.state === 'unconfirmed');
    for (const item of unconfirmed) {
      const status = await this.queryImpl(item.id);
      if (status.state === 'confirmed') this.markConfirmed(item.id, status.seq);
    }
    const pending = this.items.filter((item) => item.state === 'pending' || item.state === 'unconfirmed');
    return {
      pending,
      confirmed: this.items.filter((item) => item.state === 'confirmed'),
      unconfirmed: this.items.filter((item) => item.state === 'unconfirmed'),
    };
  }

  /**
   * 取顺序上的下一条待发送条目。
   * @returns 条目；没有时返回 `undefined`。
   */
  next(): QueueItem | undefined {
    return this.items.find((item) => item.state === 'pending');
  }

  /**
   * 按顺序消费一条。
   *
   * 暂停、没有待发送条目、条目正在提交时给出对应结论。结果不确定的条目先查询实际状态：
   * 已确认的直接落定，服务端从未收到的退回待发送，等用户显式发送。
   * @returns 消费结果。
   */
  async consume(): Promise<QueueConsumeResult> {
    if (this.paused) return { outcome: 'paused', reason: this.pauseReason ?? '已暂停' };
    const sending = this.items.find((item) => item.state === 'sending');
    if (sending !== undefined) {
      const running = this.inFlight.get(sending.id);
      if (running !== undefined) return running;
    }
    const item = this.next();
    if (item === undefined) return { outcome: 'empty' };
    const started = this.send(item);
    this.inFlight.set(item.id, started);
    try {
      return await started;
    } finally {
      this.inFlight.delete(item.id);
    }
  }

  /**
   * 实际提交一条条目。
   * @param item - 待发送条目。
   * @returns 消费结果。
   */
  private async send(item: QueueItem): Promise<QueueConsumeResult> {
    this.mark(item.id, { state: 'sending' });
    let result: QueueSubmitResult;
    try {
      result = await this.submitImpl({
        requestId: item.operationId,
        sessionId: item.sessionId,
        text: item.text,
        references: item.references,
      });
    } catch {
      const updated = this.mark(item.id, { state: 'unconfirmed' });
      return { outcome: 'unconfirmed', item: updated };
    }
    if (result.accepted) {
      const updated = this.mark(item.id, {
        state: 'confirmed',
        ...(result.seq === undefined ? {} : { seq: result.seq }),
      });
      return { outcome: 'sent', item: updated, ...(result.seq === undefined ? {} : { seq: result.seq }) };
    }
    const updated = this.mark(item.id, {
      state: 'failed',
      ...(result.code === undefined ? {} : { failureCode: result.code }),
    });
    return { outcome: 'failed', item: updated, code: result.code ?? 'send-rejected' };
  }

  /**
   * 处理结果不确定的条目：先查询实际状态。
   * @param id - 条目标识。
   * @returns 查询后的消费结论。
   */
  async resolveUnconfirmed(id: string): Promise<QueueConsumeResult> {
    const index = this.indexOf(id);
    const item = this.items[index]!;
    if (item.state !== 'unconfirmed') throw new Error(`条目不是未确认状态：${item.state}`);
    const status = await this.queryImpl(item.id);
    if (status.state === 'confirmed') {
      const updated = this.markConfirmed(item.id, status.seq);
      return { outcome: 'confirmed-already', item: updated, ...(status.seq === undefined ? {} : { seq: status.seq }) };
    }
    if (status.state === 'pending') {
      const updated = this.mark(item.id, { state: 'pending' });
      return { outcome: 'requeued', item: updated };
    }
    return { outcome: 'unconfirmed', item };
  }

  /**
   * 标记一条条目为已确认。
   * @param id - 条目标识。
   * @param seq - 确认后的事件序号。
   * @returns 更新后的条目。
   */
  markConfirmed(id: string, seq?: number): QueueItem {
    return this.mark(id, { state: 'confirmed', ...(seq === undefined ? {} : { seq }) });
  }

  /**
   * 按条目标识查已确认条目。
   * @param requestId - 条目标识，也就是提交的幂等键。
   * @returns 条目；没有时返回 `undefined`。
   */
  confirmedByRequestId(requestId: string): QueueItem | undefined {
    return this.items.find((item) => item.id === requestId && item.state === 'confirmed');
  }

  /**
   * 取当前快照。
   * @returns 条目与暂停状态。
   */
  snapshot(): QueueSnapshot {
    return {
      items: [...this.items],
      paused: this.paused,
      ...(this.pauseReason === undefined ? {} : { pauseReason: this.pauseReason }),
      pendingCount: this.items.filter((item) => item.state === 'pending').length,
      confirmedCount: this.items.filter((item) => item.state === 'confirmed').length,
    };
  }

  /**
   * 取条目的下标。
   * @param id - 条目标识。
   * @returns 下标。
   */
  private indexOf(id: string): number {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`队列条目不存在：${id}`);
    return index;
  }

  /**
   * 更新一条条目。
   * @param id - 条目标识。
   * @param patch - 要更新的字段。
   * @returns 更新后的条目。
   */
  private mark(
    id: string,
    patch: { readonly state: QueueItemState; readonly seq?: number; readonly failureCode?: string }
  ): QueueItem {
    const index = this.indexOf(id);
    const current = this.items[index]!;
    const next: QueueItem = {
      ...current,
      state: patch.state,
      ...(patch.seq === undefined ? {} : { seq: patch.seq }),
      ...(patch.failureCode === undefined ? {} : { failureCode: patch.failureCode }),
    };
    this.items = [...this.items.slice(0, index), next, ...this.items.slice(index + 1)];
    return next;
  }
}
