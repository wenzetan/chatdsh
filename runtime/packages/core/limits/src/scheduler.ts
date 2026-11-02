/**
 * 跨目标公平调度。
 *
 * 每个目标（一台订阅设备、一条事件流连接）有自己的排队与在途字节。调度按已发送字节数最少
 * 的目标优先，单个目标写得再慢也只能占用自己那一份待发送额度，其他目标照常推进。写阻塞的
 * 目标被挂起，恢复后才重新参与调度。排队超过额度时返回拒绝，内容留在调用方手里，不会因为
 * 调度拥塞被静默丢弃。
 * @module @chatdsh/core-limits/scheduler
 */

import { rejectionOf, type ResourceRejection } from './errors.ts';
import { GUARD_OK, guardBytes, type GuardVerdict } from './guard.ts';
import { limitOf, type ResourceScope } from './policy.ts';

/** 一个目标的调度状态。 */
export interface TargetSnapshot {
  /** 目标标识。 */
  readonly id: string;
  /** 排队待发的条数。 */
  readonly queuedItems: number;
  /** 排队待发的字节数。 */
  readonly queuedBytes: number;
  /** 已写入但对端尚未消费的字节数。 */
  readonly pendingBytes: number;
  /** 自我开始以来已发送的字节数，公平调度的比较基准。 */
  readonly servedBytes: number;
  /** 是否因写阻塞被挂起。 */
  readonly suspended: boolean;
  /** 是否已终止。 */
  readonly terminated: boolean;
}

/** 调度器选项。 */
export interface FairDispatcherOptions {
  /** 在途字节额度种类，按字节计；缺省取事件流缓冲额度。 */
  readonly bufferScope?: ResourceScope;
  /** 挂起回调。 */
  readonly onSuspend?: (id: string, pendingBytes: number) => void;
  /** 恢复回调。 */
  readonly onResume?: (id: string) => void;
  /** 终止回调，携带终止原因与已发送条数。 */
  readonly onTerminate?: (id: string, rejection: ResourceRejection, servedItems: number) => void;
}

interface TargetState {
  readonly id: string;
  readonly queue: number[];
  queuedBytes: number;
  pendingBytes: number;
  servedBytes: number;
  servedItems: number;
  suspended: boolean;
  terminated: boolean;
}

/** 公平调度器。 */
export class FairDispatcher {
  private readonly targets = new Map<string, TargetState>();
  private readonly order: string[] = [];
  private readonly bufferScope: ResourceScope;

  constructor(private readonly options: FairDispatcherOptions = {}) {
    this.bufferScope = options.bufferScope ?? 'sse-buffer';
  }

  /** 在途字节额度。 */
  get bufferCapacity(): number {
    return limitOf(this.bufferScope).value;
  }

  /**
   * 登记一个目标。
   * @param id - 目标标识。
   */
  register(id: string): void {
    if (this.targets.has(id)) return;
    this.targets.set(id, {
      id,
      queue: [],
      queuedBytes: 0,
      pendingBytes: 0,
      servedBytes: 0,
      servedItems: 0,
      suspended: false,
      terminated: false,
    });
    this.order.push(id);
  }

  /**
   * 注销一个目标，释放它的排队内容。
   * @param id - 目标标识。
   * @returns 被释放的排队条数。
   */
  unregister(id: string): number {
    const target = this.targets.get(id);
    if (target === undefined) return 0;
    const dropped = target.queue.length;
    this.targets.delete(id);
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);
    return dropped;
  }

  /** 目标是否已登记且未终止。 */
  isActive(id: string): boolean {
    const target = this.targets.get(id);
    return target !== undefined && !target.terminated;
  }

  /**
   * 把一条待发负载排进目标队列。
   * @param id - 目标标识。
   * @param bytes - 这条负载的字节数。
   * @returns 入队判定；排队字节超过额度时为拒绝。
   */
  enqueue(id: string, bytes: number): GuardVerdict {
    const target = this.requireTarget(id);
    if (target.terminated) return { ok: false, rejection: rejectionOf(this.bufferScope, target.queuedBytes + bytes) };
    const verdict = guardBytes(this.bufferScope, target.queuedBytes + bytes);
    if (verdict.ok === false) return verdict;
    target.queue.push(bytes);
    target.queuedBytes += bytes;
    return GUARD_OK;
  }

  /**
   * 选出下一个可写目标。
   *
   * 已发送字节最少的目标优先；同一目标最多连续发送一条，因此单个目标无法长期占住调度。
   * @returns 目标标识；没有可写目标时为 `undefined`。
   */
  next(): string | undefined {
    let chosen: TargetState | undefined;
    for (const id of this.order) {
      const target = this.targets.get(id);
      if (target === undefined || target.terminated || target.suspended) continue;
      if (target.queue.length === 0) continue;
      if (chosen === undefined || target.servedBytes < chosen.servedBytes) chosen = target;
    }
    return chosen?.id;
  }

  /**
   * 从目标队列取出一条待发负载。
   * @param id - 目标标识。
   * @returns 这条负载的字节数；队列为空时为 `undefined`。
   */
  takeOne(id: string): number | undefined {
    const target = this.targets.get(id);
    if (target === undefined) return undefined;
    const bytes = target.queue.shift();
    if (bytes === undefined) return undefined;
    target.queuedBytes -= bytes;
    return bytes;
  }

  /**
   * 登记一次成功的写入。
   * @param id - 目标标识。
   * @param bytes - 写入的字节数。
   */
  markWritten(id: string, bytes: number): void {
    const target = this.requireTarget(id);
    target.pendingBytes += bytes;
    target.servedBytes += bytes;
    target.servedItems += 1;
  }

  /**
   * 登记对端已经消费的字节，释放在途额度。
   * @param id - 目标标识。
   * @param bytes - 消费完成的字节数。
   */
  markFlushed(id: string, bytes: number): void {
    const target = this.targets.get(id);
    if (target === undefined) return;
    target.pendingBytes = Math.max(0, target.pendingBytes - bytes);
    if (target.suspended && target.pendingBytes < this.bufferCapacity) {
      target.suspended = false;
      this.options.onResume?.(id);
    }
  }

  /**
   * 标记目标写阻塞，把它从调度里摘出去。
   * @param id - 目标标识。
   */
  suspend(id: string): void {
    const target = this.requireTarget(id);
    if (target.suspended) return;
    target.suspended = true;
    this.options.onSuspend?.(id, target.pendingBytes);
  }

  /**
   * 恢复一个被挂起的目标。
   * @param id - 目标标识。
   */
  resume(id: string): void {
    const target = this.targets.get(id);
    if (target === undefined || !target.suspended) return;
    target.suspended = false;
    this.options.onResume?.(id);
  }

  /**
   * 终止一个目标，返回它尚未发出的排队条数。
   * @param id - 目标标识。
   * @param rejection - 终止原因。
   * @returns 未发出的排队条数；内容由调用方按游标重新补发。
   */
  terminate(id: string, rejection: ResourceRejection): number {
    const target = this.targets.get(id);
    if (target === undefined || target.terminated) return 0;
    target.terminated = true;
    target.suspended = true;
    const remaining = target.queue.length;
    target.queue.splice(0, target.queue.length);
    target.queuedBytes = 0;
    this.options.onTerminate?.(id, rejection, target.servedItems);
    return remaining;
  }

  /** 全部目标的快照，按登记顺序。 */
  snapshot(): readonly TargetSnapshot[] {
    return this.order.map((id) => {
      const target = this.targets.get(id);
      if (target === undefined) throw new Error(`调度目标丢失：${id}`);
      return {
        id: target.id,
        queuedItems: target.queue.length,
        queuedBytes: target.queuedBytes,
        pendingBytes: target.pendingBytes,
        servedBytes: target.servedBytes,
        suspended: target.suspended,
        terminated: target.terminated,
      };
    });
  }

  /** 排队总条数。 */
  totalQueuedItems(): number {
    let total = 0;
    for (const target of this.targets.values()) total += target.queue.length;
    return total;
  }

  /** 在途字节总数。 */
  totalPendingBytes(): number {
    let total = 0;
    for (const target of this.targets.values()) total += target.pendingBytes;
    return total;
  }

  /** 取目标状态；未登记时抛出。 */
  private requireTarget(id: string): TargetState {
    const target = this.targets.get(id);
    if (target === undefined) throw new Error(`调度目标未登记：${id}`);
    return target;
  }
}
