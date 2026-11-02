/**
 * 有界队列与并发受理。
 *
 * 队列满时明确拒绝，已受理的工作不丢弃：拒绝发生在入队之前，入队之后一定被执行或由调用方
 * 显式取消。导出与备份各用一个受理器，并发上限与排队深度取自额度表。
 * @module @chatdsh/core-limits/admission
 */

import { rejectionOf, type ResourceRejection } from './errors.ts';
import { limitOf, type ResourceScope } from './policy.ts';

/** 队列快照。 */
export interface QueueSnapshot {
  /** 当前排队数量。 */
  readonly depth: number;
  /** 排队深度上限。 */
  readonly capacity: number;
}

/** 入队结果。 */
export type QueueResult =
  | { readonly ok: true; readonly position: number }
  | { readonly ok: false; readonly rejection: ResourceRejection };

/** 有界队列。 */
export class BoundedQueue<T> {
  private readonly items: T[] = [];

  constructor(private readonly scope: ResourceScope) {
    const limit = limitOf(scope);
    if (limit.unit !== 'items') throw new Error(`队列额度必须按个数计：${scope}`);
  }

  /** 排队深度上限。 */
  get capacity(): number {
    return limitOf(this.scope).value;
  }

  /** 当前排队数量。 */
  get depth(): number {
    return this.items.length;
  }

  /**
   * 入队。队列满时返回拒绝，并且不改变队列内容。
   * @param item - 待入队的工作。
   * @returns 入队结果。
   */
  enqueue(item: T): QueueResult {
    if (this.items.length >= this.capacity) {
      return { ok: false, rejection: rejectionOf(this.scope, this.items.length + 1) };
    }
    this.items.push(item);
    return { ok: true, position: this.items.length };
  }

  /**
   * 取出最早入队的一项。
   * @returns 取出的工作；队列为空时为 `undefined`。
   */
  take(): T | undefined {
    return this.items.shift();
  }

  /**
   * 按入队顺序取出全部剩余项。
   * @returns 取出的工作列表。
   */
  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }

  /** 当前快照。 */
  snapshot(): QueueSnapshot {
    return { depth: this.items.length, capacity: this.capacity };
  }
}

/** 受理事件，供计数与当前量上报。 */
export type AdmissionEvent =
  | { readonly kind: 'started'; readonly running: number; readonly queued: number }
  | { readonly kind: 'queued'; readonly running: number; readonly queued: number }
  | { readonly kind: 'rejected'; readonly running: number; readonly queued: number; readonly rejection: ResourceRejection }
  | { readonly kind: 'finished'; readonly running: number; readonly queued: number };

/** 受理结果。 */
export type AdmissionOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly waitedMs: number }
  | { readonly ok: false; readonly rejection: ResourceRejection };

/** 受理器选项。 */
export interface AdmissionOptions {
  /** 任务种类，只能是导出或备份。 */
  readonly kind: 'export' | 'backup';
  /** 受理事件回调。 */
  readonly onEvent?: (event: AdmissionEvent) => void;
}

/** 有界并发受理器。 */
export class BoundedAdmission {
  private readonly waiters: (() => void)[] = [];
  private active = 0;
  private waitDepth = 0;
  private completed = 0;
  private refusedCount = 0;
  private readonly concurrencyScope: ResourceScope;
  private readonly queueScope: ResourceScope;

  constructor(private readonly options: AdmissionOptions) {
    this.concurrencyScope = options.kind === 'export' ? 'export-concurrency' : 'backup-concurrency';
    this.queueScope = options.kind === 'export' ? 'export-queue' : 'backup-queue';
  }

  /** 正在执行的任务数。 */
  get running(): number {
    return this.active;
  }

  /** 排队中的任务数。 */
  get queued(): number {
    return this.waitDepth;
  }

  /** 已完成的任务数。 */
  get finished(): number {
    return this.completed;
  }

  /** 已拒绝的任务数。 */
  get refused(): number {
    return this.refusedCount;
  }

  /** 并发上限。 */
  get concurrency(): number {
    return limitOf(this.concurrencyScope).value;
  }

  /** 排队深度上限。 */
  get queueCapacity(): number {
    return limitOf(this.queueScope).value;
  }

  /**
   * 受理一件工作。
   *
   * 并发未满立即执行；并发已满排进队列；并发与队列都满时返回拒绝，工作不执行。
   * @param work - 实际执行函数。
   * @returns 执行结果与排队等待时长。
   */
  async run<T>(work: () => Promise<T>): Promise<AdmissionOutcome<T>> {
    const reserved = await this.reserve();
    if (reserved.ok === false) return { ok: false, rejection: reserved.rejection };
    try {
      const value = await work();
      return { ok: true, value, waitedMs: reserved.waitedMs };
    } finally {
      this.release();
    }
  }

  /** 等待全部工作结束。 */
  async idle(): Promise<void> {
    while (this.active > 0 || this.waitDepth > 0) {
      await new Promise((settle) => setTimeout(settle, 5));
    }
  }

  /** 当前快照。 */
  snapshot(): { readonly running: number; readonly queued: number; readonly concurrency: number; readonly queueCapacity: number } {
    return {
      running: this.active,
      queued: this.waitDepth,
      concurrency: this.concurrency,
      queueCapacity: this.queueCapacity,
    };
  }

  /**
   * 预占一个执行位置。
   * @returns 成功时给出排队等待毫秒数；并发与队列都满时给出拒绝。
   */
  private async reserve(): Promise<{ readonly ok: true; readonly waitedMs: number } | { readonly ok: false; readonly rejection: ResourceRejection }> {
    if (this.active < this.concurrency) {
      this.active += 1;
      this.emit({ kind: 'started', running: this.active, queued: this.waitDepth });
      return { ok: true, waitedMs: 0 };
    }
    if (this.waitDepth >= this.queueCapacity) {
      this.refusedCount += 1;
      const rejection = rejectionOf(this.queueScope, this.waitDepth + 1);
      this.emit({ kind: 'rejected', running: this.active, queued: this.waitDepth, rejection });
      return { ok: false, rejection };
    }
    this.waitDepth += 1;
    this.emit({ kind: 'queued', running: this.active, queued: this.waitDepth });
    const started = Date.now();
    await new Promise<void>((settle) => {
      this.waiters.push(settle);
    });
    return { ok: true, waitedMs: Date.now() - started };
  }

  /** 释放一个执行位置，并启动排队里最早的一项。 */
  private release(): void {
    this.active -= 1;
    this.completed += 1;
    const next = this.waiters.shift();
    if (next === undefined) {
      this.emit({ kind: 'finished', running: this.active, queued: this.waitDepth });
      return;
    }
    this.waitDepth -= 1;
    this.active += 1;
    this.emit({ kind: 'finished', running: this.active, queued: this.waitDepth });
    next();
  }

  private emit(event: AdmissionEvent): void {
    this.options.onEvent?.(event);
  }
}
