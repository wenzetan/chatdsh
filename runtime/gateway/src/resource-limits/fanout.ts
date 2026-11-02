/**
 * 跨设备事件分发：公平调度、慢消费隔离与游标续读。
 *
 * 每台订阅设备占自己的排队与在途字节。调度按已发送字节最少者优先，因此一台读得慢的设备
 * 只能拖住自己，其他设备照常收到事件。写阻塞时该目标被挂起，对端消费完成后自动恢复；排队
 * 超过额度时明确拒绝并把目标从分发里摘掉，同时在关闭前发一帧带错误码与续读游标的事件，
 * 内容仍留在权威存储里，重连后用游标补齐。
 *
 * 事件只带序号、类别、字节数与编码后的数据行；分发不保存业务正文以外的东西，也不把正文
 * 写进遥测。
 * @module @chatdsh/gateway/resource-limits/fanout
 */

import type { ServerResponse } from 'node:http';
import {
  FairDispatcher,
  guardCount,
  rejectionOf,
  type ResourceRejection,
  type TargetSnapshot,
} from '@chatdsh/core-limits';
import type { ResourceGovernor } from './governor.ts';
import { RESOURCE_SPANS, type ResourceTelemetry } from './telemetry.ts';

/** 一帧的写入结果。 */
type FrameWrite = 'written' | 'blocked' | 'closed';

/**
 * 写一帧数据。
 *
 * 订阅目标是真实套接字，断开随时可能发生。「写不进去」与「对端已关闭」都作为正常结果返回，
 * 由一个订阅的断开决定分发器的记账，绝不打断其他订阅。
 */
function writeFrame(response: ServerResponse, text: string): FrameWrite {
  if (response.writableEnded || response.destroyed) return 'closed';
  try {
    return response.write(text) ? 'written' : 'blocked';
  } catch {
    return 'closed';
  }
}

/** 一帧待分发事件。 */
export interface FanoutEvent {
  /** 事件所属会话。 */
  readonly sessionId: string;
  /** 事件序号，同一会话内连续。 */
  readonly seq: number;
  /** 事件类别。 */
  readonly kind: string;
  /** 编码后数据行的字节数。 */
  readonly bytes: number;
  /** SSE 的 `data:` 之后的内容，不含前缀与空行。 */
  readonly frame: string;
}

/** 订阅结果。 */
export type FanoutSubscription =
  | { readonly ok: true; readonly connectionId: string; readonly unsubscribe: () => void; readonly replayed: number }
  | { readonly ok: false; readonly rejection: ResourceRejection };

/** 一次分发结果。 */
export interface PublishResult {
  /** 成功写入的连接数。 */
  readonly delivered: number;
  /** 因排队已满被终止的连接数。 */
  readonly terminated: number;
  /** 被终止的连接标识。 */
  readonly terminatedIds: readonly string[];
}

/** 分发器选项。 */
export interface FanoutOptions {
  /** 资源治理器，用于连接与拒绝记录。 */
  readonly governor: ResourceGovernor;
  /** 遥测出口。 */
  readonly telemetry: ResourceTelemetry;
  /** 从权威存储按游标读取事件，条数与字节都有界。 */
  readonly replay: (sessionId: string, sinceSeq: number, limit: number) => readonly FanoutEvent[];
}

/** 一台订阅设备的连接状态。 */
interface Subscriber {
  readonly deviceId: string;
  readonly sessionId: string;
  readonly response: ServerResponse;
  readonly queue: { readonly event: FanoutEvent; readonly publishedAt: number }[];
  lastWrittenSeq: number;
  replayTruncatedAt: number | undefined;
}

/** 单次补发最多带出的事件条数，与列表分页上限一致。 */
const REPLAY_ITEM_LIMIT = 200;

/** 单次补发最多带出的字节数，与事件流缓冲的一半相当。 */
const REPLAY_BYTE_LIMIT = 512 * 1024;

/** 公平分发器。 */
export class FairFanout {
  private readonly dispatcher: FairDispatcher;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly samplesMs: number[] = [];
  private disposed = false;

  constructor(private readonly options: FanoutOptions) {
    this.dispatcher = new FairDispatcher({
      bufferScope: 'sse-buffer',
      onSuspend: (_id, pendingBytes) => {
        options.telemetry.backpressure('sse-buffer', 'suspended', pendingBytes);
        const span = options.telemetry.start(RESOURCE_SPANS.backpressure, { kind: 'sse-buffer', outcome: 'suspended' });
        span?.setAttribute('bytes', pendingBytes);
        span?.end();
        void _id;
      },
      onResume: (id) => {
        options.telemetry.backpressure('sse-buffer', 'resumed', this.pendingOf(id));
        const span = options.telemetry.start(RESOURCE_SPANS.backpressure, { kind: 'sse-buffer', outcome: 'resumed' });
        span?.end();
      },
      onTerminate: () => undefined,
    });
  }

  /** 当前订阅数。 */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * 订阅一台设备的事件。
   *
   * 先按游标补发受条数与字节双重限制的历史事件，再登记为在线订阅。补发被截断时写一帧
   * `resume` 告知客户端继续读取的起点。
   * @param deviceId - 设备标识。
   * @param sessionId - 订阅的会话标识，补发按它会话的事件。
   * @param response - 已写好响应头的连接。
   * @param sinceSeq - 客户端已确认的游标；补发序号大于它的事件。
   * @returns 订阅结果。
   */
  subscribe(deviceId: string, sessionId: string, response: ServerResponse, sinceSeq: number): FanoutSubscription {
    if (this.disposed) throw new Error('分发器已关闭');
    const existing = this.subscribers.get(deviceId);
    if (existing !== undefined) {
      // 同一设备重复订阅时先结束旧连接，避免同一设备占两份额度。
      this.detach(deviceId);
    }
    this.dispatcher.register(deviceId);
    const subscriber: Subscriber = {
      deviceId,
      sessionId,
      response,
      queue: [],
      lastWrittenSeq: sinceSeq,
      replayTruncatedAt: undefined,
    };
    this.subscribers.set(deviceId, subscriber);
    response.on('error', () => {
      this.detach(deviceId);
    });
    if (writeFrame(response, ': connected\n\n') === 'closed') {
      this.detach(deviceId);
      return { ok: true, connectionId: deviceId, unsubscribe: () => undefined, replayed: 0 };
    }
    const replayed = this.replayInto(subscriber, sinceSeq);
    this.pump();
    const unsubscribe = (): void => {
      this.detach(deviceId);
    };
    return { ok: true, connectionId: deviceId, unsubscribe, replayed };
  }

  /**
   * 发布一条事件到全部在线订阅。
   * @param event - 待分发事件。
   * @returns 分发结果。
   */
  publish(event: FanoutEvent): PublishResult {
    const publishedAt = Date.now();
    let delivered = 0;
    const terminatedIds: string[] = [];
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.sessionId !== event.sessionId) continue;
      const verdict = this.dispatcher.enqueue(subscriber.deviceId, event.bytes);
      if (verdict.ok === false) {
        terminatedIds.push(subscriber.deviceId);
        this.terminateSubscriber(subscriber, verdict.rejection);
        continue;
      }
      subscriber.queue.push({ event, publishedAt });
      delivered += 1;
    }
    this.pump();
    return { delivered, terminated: terminatedIds.length, terminatedIds };
  }

  /** 全部订阅的快照。 */
  snapshot(): readonly (TargetSnapshot & { readonly lastWrittenSeq: number })[] {
    return this.dispatcher.snapshot().map((target) => {
      const subscriber = this.subscribers.get(target.id);
      return { ...target, lastWrittenSeq: subscriber?.lastWrittenSeq ?? 0 };
    });
  }

  /** 当前排队总条数。 */
  totalQueuedItems(): number {
    return this.dispatcher.totalQueuedItems();
  }

  /** 分发耗时的原始采样，毫秒。 */
  dispatchSamplesMs(): readonly number[] {
    return this.samplesMs;
  }

  /** 清空耗时采样，供下一个场景重新计时。 */
  resetSamples(): void {
    this.samplesMs.length = 0;
  }

  /** 关闭全部分发状态。 */
  close(): void {
    this.disposed = true;
    for (const deviceId of [...this.subscribers.keys()]) this.detach(deviceId);
  }

  /** 按游标补发。 */
  private replayInto(subscriber: Subscriber, sinceSeq: number): number {
    const events = this.options.replay(subscriber.sessionId, sinceSeq, REPLAY_ITEM_LIMIT);
    let bytes = 0;
    let written = 0;
    for (const event of events) {
      if (written >= REPLAY_ITEM_LIMIT || bytes + event.bytes > REPLAY_BYTE_LIMIT) {
        subscriber.replayTruncatedAt = subscriber.lastWrittenSeq;
        break;
      }
      const outcome = writeFrame(subscriber.response, `data: ${event.frame}\n\n`);
      bytes += event.bytes;
      written += 1;
      subscriber.lastWrittenSeq = event.seq;
      if (outcome === 'closed') {
        this.detach(subscriber.deviceId);
        return written;
      }
      if (outcome === 'blocked') {
        this.dispatcher.suspend(subscriber.deviceId);
        this.observeDrain(subscriber);
        break;
      }
    }
    if (subscriber.replayTruncatedAt !== undefined) {
      const resume = JSON.stringify({ sinceSeq: subscriber.replayTruncatedAt, entry: 'resume-cursor' });
      writeFrame(subscriber.response, `event: resume\ndata: ${resume}\n\n`);
    }
    return written;
  }

  /** 按公平顺序写出排队事件。 */
  private pump(): void {
    if (this.disposed) return;
    for (;;) {
      const deviceId = this.dispatcher.next();
      if (deviceId === undefined) return;
      const subscriber = this.subscribers.get(deviceId);
      if (subscriber === undefined) {
        this.dispatcher.unregister(deviceId);
        continue;
      }
      const next = subscriber.queue[0];
      if (next === undefined) {
        // 记账与帧队列不一致时清掉剩余额度，避免死循环。
        this.dispatcher.takeOne(deviceId);
        continue;
      }
      const started = performance.now();
      const outcome = writeFrame(subscriber.response, `data: ${next.event.frame}\n\n`);
      this.samplesMs.push(performance.now() - started);
      subscriber.queue.shift();
      this.dispatcher.takeOne(deviceId);
      if (outcome === 'closed') {
        this.detach(deviceId);
        continue;
      }
      this.dispatcher.markWritten(deviceId, next.event.bytes);
      subscriber.lastWrittenSeq = next.event.seq;
      if (outcome === 'blocked') {
        this.dispatcher.suspend(deviceId);
        this.observeDrain(subscriber);
        return;
      }
    }
  }

  /** 等待对端消费完成并恢复该目标。 */
  private observeDrain(subscriber: Subscriber): void {
    const pending = this.pendingOf(subscriber.deviceId);
    subscriber.response.once('drain', () => {
      this.dispatcher.markFlushed(subscriber.deviceId, pending);
      this.dispatcher.resume(subscriber.deviceId);
      this.pump();
    });
  }

  /** 终止一个订阅：写明确的错误帧、结束连接、摘除记账。 */
  private terminateSubscriber(subscriber: Subscriber, rejection: ResourceRejection): void {
    // 游标是最后一条已经写给对端的事件序号；客户端带着它重新订阅即可从下一条继续。
    const sinceSeq = subscriber.lastWrittenSeq;
    if (!subscriber.response.writableEnded && !subscriber.response.destroyed) {
      const payload = JSON.stringify({
        error: rejection.code,
        kind: rejection.scope,
        limit: rejection.limit,
        observed: rejection.observed,
        entry: rejection.entry,
        sinceSeq,
      });
      writeFrame(subscriber.response, `event: backpressure\ndata: ${payload}\n\n`);
      subscriber.response.end();
    }
    this.options.telemetry.backpressure('sse-buffer', 'terminated', this.pendingOf(subscriber.deviceId));
    this.options.telemetry.backpressureRejected(rejection, subscriber.lastWrittenSeq);
    const span = this.options.telemetry.start(RESOURCE_SPANS.backpressure, { kind: rejection.scope, outcome: 'terminated' });
    span?.setAttribute('count', subscriber.lastWrittenSeq);
    span?.setAttribute('error.type', 'backpressure');
    span?.setAttribute('error.code', rejection.code);
    span?.end();
    this.options.governor.recordRejection('sse-buffer', rejection);
    this.detach(subscriber.deviceId);
  }

  /** 摘除一个订阅。 */
  private detach(deviceId: string): void {
    const subscriber = this.subscribers.get(deviceId);
    if (subscriber === undefined) return;
    this.subscribers.delete(deviceId);
    this.dispatcher.unregister(deviceId);
    if (!subscriber.response.writableEnded && !subscriber.response.destroyed) subscriber.response.end();
  }

  /** 某目标的在途字节。 */
  private pendingOf(deviceId: string): number {
    const target = this.dispatcher.snapshot().find((entry) => entry.id === deviceId);
    return target?.pendingBytes ?? 0;
  }
}

/** 分页读取事件时的条数判定；超过上限给出拒绝。 */
export function guardReplayLimit(limit: number): void {
  const verdict = guardCount('list-page', limit);
  if (verdict.ok === false) throw new Error(`${verdict.rejection.code}：分页条数 ${String(limit)}`);
}

/** 超限事件的拒绝描述。 */
export function eventTooLarge(bytes: number): ResourceRejection {
  return rejectionOf('event', bytes);
}

/** 分发 span 名称。 */
export const FANOUT_SPAN = RESOURCE_SPANS.backpressure;
