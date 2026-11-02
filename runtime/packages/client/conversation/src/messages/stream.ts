/**
 * 跟随流的装配：逐段追加、最终一致性与迟到片段丢弃。
 *
 * 装配器吃三种帧：`snapshot` 建立打开窗口，`event` 追加已落盘的会话事件，
 * `assistant-stream` 的 `start`、`chunk`、`end` 承载模型流式片段。流式片段先进入一份临时
 * 累积，收到 `end` 的 `committed` 之后，等对应序号的事件落盘，再用落盘内容替换累积并与
 * 累积做一致性比较：一致记为 `consistent`，落盘内容以累积开头记为 `appended`，其余记为
 * `reconciled` 并以落盘内容为准。
 *
 * 三类片段会被丢弃并计数：尝试已经结束之后到达的、序号已经用过的、修订号更旧的。停止确认
 * 之后被丢弃的尝试整份丢弃，因此停止不会让迟到内容再出现在消息区。
 * @module @chatdsh/client-conversation/messages/stream
 */

import {
  appendReasoning,
  appendText,
  appendToolArguments,
  projectConversation,
  segmentsText,
  type ExecutionSource,
  type MessageEntry,
  type MessageSegment,
  type TraceEntry,
} from './model.ts';
import type { AssistantStreamFrame, FollowFrame, SessionWireEvent } from './frames.ts';
import { fieldOf, recordOf, stringOf } from './frames.ts';

/** 跟随流的状态。 */
export const STREAM_STATUSES = ['idle', 'waiting-first-token', 'streaming', 'interrupted', 'completed', 'failed'] as const;

/** 跟随流状态取值。 */
export type StreamStatus = (typeof STREAM_STATUSES)[number];

/** 一帧的处理结果。 */
export type FrameOutcome = 'applied' | 'duplicate' | 'gap' | 'late' | 'suspended' | 'ignored';

/** 装配计数。 */
export interface StreamCounters {
  /** 收到的跟随帧数量。 */
  readonly frames: number;
  /** 应用的会话事件数量。 */
  readonly events: number;
  /** 因序号重复丢弃的事件数量。 */
  readonly duplicates: number;
  /** 因序号不连续要求重新订阅的次数。 */
  readonly gaps: number;
  /** 收到的流式片段数量。 */
  readonly chunks: number;
  /** 丢弃的迟到片段数量。 */
  readonly lateChunks: number;
  /** 完成的一致性比较次数。 */
  readonly reconciles: number;
  /** 落盘内容与累积内容不一致的次数。 */
  readonly mismatches: number;
}

/** 进行中的流式尝试。 */
export interface LiveAttemptView {
  readonly attemptId: string;
  readonly turn: number;
  readonly step: number;
  readonly segments: readonly MessageSegment[];
  readonly status: 'waiting-first-token' | 'streaming' | 'interrupted';
}

/** 装配器对外快照。 */
export interface StreamSnapshot {
  readonly messages: readonly MessageEntry[];
  readonly trace: readonly TraceEntry[];
  /** 进行中的流式尝试；没有时缺省。 */
  readonly live?: LiveAttemptView;
  readonly status: StreamStatus;
  readonly suspended: boolean;
  /** 断线原因；未断线时缺省。 */
  readonly suspendReason?: string;
  /** 已应用的最大事件序号。 */
  readonly cursor: number;
  readonly counters: StreamCounters;
  readonly ignoredEvents: number;
  readonly ignoredBlocks: number;
}

/** 一致性比较的结论。 */
export type ReconcileOutcome = 'consistent' | 'appended' | 'reconciled';

/** 装配器的依赖。 */
export interface ConversationStreamOptions {
  /** 执行来源：本机执行或远程执行。 */
  readonly source: ExecutionSource;
  /** 工具结果展示上限，单位字节。 */
  readonly truncateBytes?: number;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 丢弃迟到片段时的回调，用于计数与遥测。 */
  readonly onLate?: (reason: string) => void;
  /** 流式中断时的回调。 */
  readonly onInterrupted?: (reason: string) => void;
}

/** 进行中的流式尝试的内部状态。 */
interface LiveAttempt {
  readonly attemptId: string;
  readonly turn: number;
  readonly step: number;
  readonly startedAt: number;
  segments: MessageSegment[];
  lastIndex: number;
  revision: number;
  closed: boolean;
  committedSeq?: number;
}

/**
 * 会话跟随流的装配器。
 */
export class ConversationStream {
  private events: SessionWireEvent[] = [];
  private cursor = -1;
  private live: LiveAttempt | undefined;
  private suspended = false;
  private suspendReason: string | undefined;
  private status: StreamStatus = 'idle';
  private readonly discarded = new Set<string>();
  private counters: StreamCounters = {
    frames: 0,
    events: 0,
    duplicates: 0,
    gaps: 0,
    chunks: 0,
    lateChunks: 0,
    reconciles: 0,
    mismatches: 0,
  };
  private lastReconcile: { outcome: ReconcileOutcome; liveChars: number; finalChars: number } | undefined;
  private readonly source: ExecutionSource;
  private readonly truncateBytes: number | undefined;
  private readonly now: () => number;
  private readonly onLate: ((reason: string) => void) | undefined;
  private readonly onInterrupted: ((reason: string) => void) | undefined;

  /**
   * 建立装配器。
   * @param options - 执行来源、展示上限与回调。
   */
  constructor(options: ConversationStreamOptions) {
    this.source = options.source;
    this.truncateBytes = options.truncateBytes;
    this.now = options.now ?? (() => Date.now());
    this.onLate = options.onLate;
    this.onInterrupted = options.onInterrupted;
  }

  /** 是否处于断线暂停。 */
  get isSuspended(): boolean {
    return this.suspended;
  }

  /** 断线原因。 */
  get suspendedReason(): string | undefined {
    return this.suspendReason;
  }

  /** 当前状态。 */
  get currentStatus(): StreamStatus {
    return this.suspended ? 'interrupted' : this.status;
  }

  /** 已应用的最大事件序号。 */
  get currentCursor(): number {
    return this.cursor;
  }

  /** 最近一次一致性比较的结论。 */
  get reconcile(): { outcome: ReconcileOutcome; liveChars: number; finalChars: number } | undefined {
    return this.lastReconcile;
  }

  /**
   * 应用一帧跟随帧。
   * @param frame - 已校验的跟随帧。
   * @returns 处理结果。
   */
  apply(frame: FollowFrame): FrameOutcome {
    this.counters = { ...this.counters, frames: this.counters.frames + 1 };
    if (frame.type === 'snapshot') return this.applySnapshot(frame);
    if (frame.type === 'event') return this.applyEvent(frame.event);
    return this.applyStreamFrame(frame.frame);
  }

  /**
   * 应用打开窗口。
   *
   * 打开窗口来自一次真实订阅的开头，因此它重置本地状态：事件列表、游标与进行中的尝试都以
   * 窗口为准。断线期间收到窗口说明连接已经恢复，读取随之恢复。
   * @param frame - 打开窗口。
   * @returns 处理结果。
   */
  private applySnapshot(frame: Extract<FollowFrame, { type: 'snapshot' }>): FrameOutcome {
    const events = frame.records.map((record) => record.event);
    let previous = -1;
    for (const event of events) {
      if (event.seq <= previous) throw new Error(`打开窗口的事件序号不递增：${event.seq}`);
      previous = event.seq;
    }
    this.events = [...events];
    this.cursor = Math.max(frame.cursor, events.length === 0 ? frame.cursor - 1 : events.at(-1)!.seq);
    this.live = undefined;
    this.lastReconcile = undefined;
    const baseline = frame.assistantStream?.activeAttempt;
    if (baseline !== undefined && !this.discarded.has(baseline.attemptId)) {
      this.live = {
        attemptId: baseline.attemptId,
        turn: baseline.turn,
        step: baseline.step,
        startedAt: this.now(),
        segments: [],
        lastIndex: -1,
        revision: baseline.revision,
        closed: false,
      };
      this.status = 'waiting-first-token';
    } else {
      this.status = events.length === 0 ? 'idle' : this.statusAfterEvents(events);
    }
    if (this.suspended) {
      this.suspended = false;
      this.suspendReason = undefined;
    }
    return 'applied';
  }

  /**
   * 追加一条已落盘的会话事件。
   * @param event - 会话事件。
   * @returns 处理结果。
   */
  private applyEvent(event: SessionWireEvent): FrameOutcome {
    if (this.suspended) return 'suspended';
    if (event.seq <= this.cursor) {
      this.counters = { ...this.counters, duplicates: this.counters.duplicates + 1 };
      return 'duplicate';
    }
    if (event.seq !== this.cursor + 1) {
      this.counters = { ...this.counters, gaps: this.counters.gaps + 1 };
      return 'gap';
    }
    this.events = [...this.events, event];
    this.cursor = event.seq;
    this.counters = { ...this.counters, events: this.counters.events + 1 };
    if (this.live !== undefined && this.live.closed && this.live.committedSeq === event.seq) {
      this.finalize(event);
      return 'applied';
    }
    this.status = this.statusAfterEvents([event]);
    return 'applied';
  }

  /**
   * 应用一帧流式片段。
   * @param frame - 流式帧。
   * @returns 处理结果。
   */
  private applyStreamFrame(frame: AssistantStreamFrame): FrameOutcome {
    if (this.suspended) return 'suspended';
    if (frame.type === 'start') {
      if (this.discarded.has(frame.attemptId)) {
        this.dropLate('discarded-attempt');
        return 'late';
      }
      this.live = {
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        startedAt: this.now(),
        segments: [],
        lastIndex: -1,
        revision: frame.revision,
        closed: false,
      };
      this.status = 'waiting-first-token';
      return 'applied';
    }
    const live = this.live;
    if (live === undefined || live.attemptId !== frame.attemptId) {
      this.dropLate('unknown-attempt');
      return 'late';
    }
    if (frame.revision < live.revision) {
      this.dropLate('older-revision');
      return 'late';
    }
    if (frame.type === 'end') {
      if (live.closed) {
        this.dropLate('duplicate-end');
        return 'late';
      }
      live.closed = true;
      live.revision = frame.revision;
      live.lastIndex = Math.max(live.lastIndex, frame.index);
      const outcome = frame.outcome;
      if (outcome.kind === 'committed') {
        const committedSeq = outcome.seq;
        live.committedSeq = committedSeq;
        if (this.cursor >= committedSeq) {
          const committed = this.events.find((event) => event.seq === committedSeq);
          if (committed !== undefined) {
            this.finalize(committed);
            return 'applied';
          }
        }
        return 'applied';
      }
      this.live = undefined;
      this.status = 'interrupted';
      this.onInterrupted?.('abandoned');
      return 'applied';
    }
    if (live.closed) {
      this.dropLate('after-end');
      return 'late';
    }
    if (frame.index <= live.lastIndex) {
      this.dropLate('out-of-order');
      return 'late';
    }
    live.lastIndex = frame.index;
    live.revision = frame.revision;
    this.counters = { ...this.counters, chunks: this.counters.chunks + 1 };
    const chunk = frame.chunk;
    switch (chunk.type) {
      case 'text-delta':
        live.segments = appendText(live.segments, chunk.text);
        break;
      case 'reasoning-delta':
        live.segments = appendReasoning(live.segments, chunk.text);
        break;
      case 'tool-call-delta':
        live.segments = appendToolArguments(
          live.segments,
          chunk.id,
          chunk.name ?? '工具',
          chunk.argumentsDelta,
          frame.time
        );
        break;
      default:
        break;
    }
    this.status = 'streaming';
    return 'applied';
  }

  /**
   * 用落盘内容收尾一次流式尝试，并做一致性比较。
   * @param event - 承载最终内容的会话事件。
   */
  private finalize(event: SessionWireEvent): void {
    const live = this.live;
    if (live === undefined) return;
    const liveText = segmentsText(live.segments);
    const finalText = this.finalMessageText(event);
    const outcome: ReconcileOutcome =
      liveText === finalText ? 'consistent' : finalText.startsWith(liveText) ? 'appended' : 'reconciled';
    this.lastReconcile = { outcome, liveChars: liveText.length, finalChars: finalText.length };
    this.counters = {
      ...this.counters,
      reconciles: this.counters.reconciles + 1,
      mismatches: this.counters.mismatches + (outcome === 'reconciled' ? 1 : 0),
    };
    this.live = undefined;
    this.status = 'completed';
  }

  /**
   * 取一条助手消息事件的最终正文。
   * @param event - 助手消息事件。
   * @returns 正文文本。
   */
  private finalMessageText(event: SessionWireEvent): string {
    const data = recordOf(event.data);
    const message = fieldOf(data, 'message');
    const content = fieldOf(message, 'content');
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (stringOf(block, 'type') !== 'text') continue;
        const text = stringOf(block, 'text');
        if (text !== undefined) parts.push(text);
      }
      return parts.join('');
    }
    return stringOf(data, 'text') ?? '';
  }

  /**
   * 按最近一条事件推断状态。
   * @param events - 最近应用的事件。
   * @returns 状态。
   */
  private statusAfterEvents(events: readonly SessionWireEvent[]): StreamStatus {
    const last = events.at(-1);
    if (last === undefined) return 'idle';
    if (last.type === 'turn/end') return 'completed';
    if (last.type === 'assistant/message') return 'completed';
    if (last.type === 'tool/call' || last.type === 'tool/result') return 'completed';
    if (last.type === 'turn/start' || last.type === 'step/start' || last.type === 'user/message') return 'idle';
    return this.status === 'idle' ? 'completed' : this.status;
  }

  /**
   * 记一次迟到片段丢弃。
   * @param reason - 丢弃原因。
   */
  private dropLate(reason: string): void {
    this.counters = { ...this.counters, lateChunks: this.counters.lateChunks + 1 };
    this.onLate?.(reason);
  }

  /**
   * 断线暂停。
   *
   * 暂停之后到达的帧不再应用，状态显示为连接中断；队列的暂停由队列模块自己维护。
   * @param reason - 中断原因。
   */
  suspend(reason: string): void {
    if (this.suspended) return;
    this.suspended = true;
    this.suspendReason = reason;
    if (this.live !== undefined) this.status = 'interrupted';
    this.onInterrupted?.(reason);
  }

  /**
   * 恢复读取。恢复只恢复接收，不会代替用户发送任何内容。
   * @returns 恢复后的游标与状态。
   */
  resume(): { readonly cursor: number; readonly status: StreamStatus } {
    this.suspended = false;
    this.suspendReason = undefined;
    if (this.status === 'interrupted' && this.live === undefined) this.status = 'completed';
    return { cursor: this.cursor, status: this.currentStatus };
  }

  /**
   * 丢弃一个尝试之后的全部片段。
   *
   * 停止确认后调用：该尝试后续到达的帧整份丢弃，不再进入消息区。
   * @param attemptId - 被丢弃的尝试标识。
   */
  discardAttempt(attemptId: string): void {
    this.discarded.add(attemptId);
    if (this.live?.attemptId === attemptId) this.live = undefined;
  }

  /**
   * 取当前快照。
   * @returns 消息、轨迹、进行中的尝试与计数。
   */
  snapshot(): StreamSnapshot {
    const projection = projectConversation(this.events, {
      source: this.source,
      ...(this.truncateBytes === undefined ? {} : { truncateBytes: this.truncateBytes }),
    });
    const live = this.live;
    const liveView: LiveAttemptView | undefined =
      live === undefined
        ? undefined
        : {
            attemptId: live.attemptId,
            turn: live.turn,
            step: live.step,
            segments: live.segments,
            status: this.suspended
              ? 'interrupted'
              : live.segments.length === 0
                ? 'waiting-first-token'
                : 'streaming',
          };
    const messages: MessageEntry[] =
      liveView === undefined
        ? [...projection.messages]
        : [
            ...projection.messages,
            {
              id: `live:${liveView.attemptId}`,
              role: 'assistant',
              source: this.source,
              at: live?.startedAt ?? this.now(),
              status: liveView.status,
              segments: liveView.segments,
            },
          ];
    return {
      messages,
      trace: projection.trace,
      ...(liveView === undefined ? {} : { live: liveView }),
      status: this.currentStatus,
      suspended: this.suspended,
      ...(this.suspendReason === undefined ? {} : { suspendReason: this.suspendReason }),
      cursor: this.cursor,
      counters: this.counters,
      ignoredEvents: projection.ignoredEvents,
      ignoredBlocks: projection.ignoredBlocks,
    };
  }
}
