/**
 * 会话席位的控制器：把跟随流、输入区、队列、命令、引用与反馈串成一份可订阅的状态。
 *
 * 控制器不碰界面：所有状态变化写成快照，界面通过订阅重绘。发送在空闲时直接提交，运行中则
 * 进入在线队列；提交结果不确定时先按操作标识查询实际结果，不重复写入。跟随流中断时暂停
 * 队列消费并冻结流式接收，连接恢复只恢复读取，发送与队列消费由用户显式触发。
 * @module @chatdsh/client-conversation/client/controller
 */

import { z } from 'zod';
import { draftRecordSchema, stopAckSchema } from '@chatdsh/core-contracts';
import {
  LiveAnnouncer,
  conversationKeyIntent,
  type Announcement,
  type ConversationKeyIntent,
} from '../a11y.ts';
import { Composer, type ComposerIntent, type ComposerSnapshot, type SendCheck } from '../composer/state.ts';
import { CommandPalette, buildConversationCommands, type CommandDescriptor } from '../commands/palette.ts';
import {
  detectTrigger,
  filterTriggerItems,
  groupTriggerItems,
  toTriggerItems,
  type TriggerGroup,
  type TriggerItem,
  type TriggerKind,
  type TriggerMatch,
} from '../commands/triggers.ts';
import { FeedbackBoard, type FeedbackRating, type FeedbackReason, type FeedbackState } from '../messages/feedback.ts';
import { ConversationStream, type StreamSnapshot } from '../messages/stream.ts';
import { ActiveRun, type RunState } from '../messages/run.ts';
import { latestWindow, newMessagesLabel, shouldAutoFollow, type MessageWindow, type ScrollMetrics } from '../messages/paging.ts';
import { segmentsText, type ExecutionSource } from '../messages/model.ts';
import type { FollowFrame } from '../messages/frames.ts';
import { PendingQueue, type QueueConsumeResult, type QueueSnapshot } from '../queue/queue.ts';
import type { PersistedReference, ReferenceCandidate, ReferenceObjectKind } from '../references/references.ts';
import type { ConversationTelemetry } from '../telemetry.ts';
import { FollowStream, type FollowStatus } from './follow-stream.ts';

/** 席位用到的端点。 */
export interface ConversationEndpoints {
  /** 跟随流（SSE）。 */
  readonly streamUrl: string;
  /** 发送消息。 */
  readonly sendUrl: string;
  /** 停止当前运行。 */
  readonly stopUrl: string;
  /** 按操作标识查询提交结果。 */
  readonly queryUrl: string;
  /** 提交消息反馈。 */
  readonly feedbackUrl: string;
}

/** 席位选项。 */
export interface ConversationSeatOptions {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly source: ExecutionSource;
  readonly endpoints: ConversationEndpoints;
  readonly fetchImpl?: typeof fetch;
  readonly storage?: Storage;
  readonly clientId?: string;
  readonly windowId?: string;
  readonly maxLength?: number;
  readonly truncateBytes?: number;
  readonly pageSize?: number;
  readonly telemetry?: ConversationTelemetry;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly deviceOnline?: boolean;
  /** 实时播报的节流间隔，单位毫秒。 */
  readonly announceThrottleMs?: number;
  /** 实时播报的缓冲上限，字符数。 */
  readonly announcementSegmentChars?: number;
  /** 发送与停止请求的超时，单位毫秒。 */
  readonly requestTimeoutMs?: number;
}

/** 发送结论。 */
export type SendOutcome =
  | { readonly outcome: 'sent'; readonly requestId: string; readonly seq?: number }
  | { readonly outcome: 'queued'; readonly itemId: string }
  | { readonly outcome: 'rejected'; readonly code: string; readonly message: string }
  | { readonly outcome: 'unconfirmed'; readonly requestId: string; readonly message: string };

/** 停止结论。 */
export type StopOutcome =
  | { readonly outcome: 'stopped' }
  | { readonly outcome: 'unconfirmed'; readonly code: string }
  | { readonly outcome: 'rejected'; readonly code: string }
  | { readonly outcome: 'ignored' };

/** 队列动作结论。 */
export type QueueActionOutcome =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'rejected'; readonly code: string; readonly message: string };

/** 恢复队列的结论。 */
export type QueueResumeOutcome =
  | { readonly outcome: 'ok'; readonly pending: number }
  | { readonly outcome: 'rejected'; readonly code: string; readonly message: string };

/** 命令面板的视图状态。 */
export interface PaletteView {
  readonly open: boolean;
  readonly levelLabel: string;
  readonly canGoBack: boolean;
  readonly query: string;
  readonly activeId?: string;
  readonly commands: readonly CommandDescriptor[];
}

/** 触发面板的视图状态。 */
export interface TriggerView {
  readonly kind: TriggerKind;
  readonly query: string;
  readonly items: readonly TriggerItem[];
  readonly groups: readonly TriggerGroup[];
  readonly activeId?: string;
  /** 触发区间，选中条目时用它替换查询文本。 */
  readonly match: TriggerMatch;
}

/** 席位状态快照。 */
export interface SeatState {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly source: ExecutionSource;
  readonly deviceOnline: boolean;
  readonly composer: ComposerSnapshot;
  readonly sendCheck: SendCheck;
  readonly stream: StreamSnapshot;
  readonly queue: QueueSnapshot;
  readonly run: RunState;
  readonly messageWindow: MessageWindow;
  readonly announcementsPaused: boolean;
  readonly announcement?: string;
  readonly notice?: string;
  readonly failure?: string;
  readonly palette: PaletteView;
  readonly trigger?: TriggerView;
  readonly feedback: readonly FeedbackState[];
  readonly copiedAt: (messageId: string) => number | undefined;
  readonly copyFailure?: { readonly messageId: string; readonly detail: string };
  readonly feedbackFailure?: string;
  readonly newMessages?: string;
  readonly attachUnavailableReason: string;
  /** 需要把焦点交给的元素标识。 */
  readonly focusTarget?: string;
}

/** 发送请求体。 */
const sendResponseSchema = z.looseObject({
  accepted: z.boolean(),
  duplicate: z.boolean().optional(),
  seq: z.number().int().nonnegative().optional(),
  code: z.string().min(1).optional(),
});

/** 状态查询响应体。 */
const queryResponseSchema = z.looseObject({
  state: z.enum(['confirmed', 'pending', 'unknown']),
  seq: z.number().int().nonnegative().optional(),
});

/** 反馈响应体。 */
const feedbackResponseSchema = z.looseObject({
  accepted: z.boolean(),
  code: z.string().min(1).optional(),
});

/**
 * 会话席位的控制器。
 */
export class ConversationController {
  private readonly options: ConversationSeatOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly storage: Storage | undefined;
  private readonly stream: ConversationStream;
  private readonly follow: FollowStream;
  private readonly composer: Composer;
  private readonly queue: PendingQueue;
  private readonly run: ActiveRun;
  private readonly feedback: FeedbackBoard;
  private readonly palette: CommandPalette;
  private readonly announcer: LiveAnnouncer;
  private readonly listeners = new Set<() => void>();
  private notice: string | undefined;
  private failure: string | undefined;
  private announcement: string | undefined;
  private pageOffset = 0;
  private candidates: readonly ReferenceCandidate[] = [];
  private runtimeCommands: readonly CommandDescriptor[] = [];
  private trigger: { readonly match: TriggerMatch; readonly items: readonly TriggerItem[]; activeIndex: number } | undefined;
  private focusTarget: string | undefined;
  private newMessageCount = 0;
  private lastMessageCount = 0;
  private draftRevision = 0;
  private cachedState: SeatState | undefined;
  private atBottom = true;
  private deviceOnline: boolean;
  private disposed = false;
  private readonly pageSize: number;

  /**
   * 建立控制器。
   * @param options - 会话、设备、端点与依赖。
   */
  constructor(options: ConversationSeatOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.storage = options.storage;
    this.deviceOnline = options.deviceOnline ?? true;
    this.pageSize = options.pageSize ?? 40;
    this.stream = new ConversationStream({
      source: options.source,
      ...(options.truncateBytes === undefined ? {} : { truncateBytes: options.truncateBytes }),
      now: this.now,
      onLate: (reason) => {
        this.options.telemetry?.counted('chatdsh_client_stream_events_total', 'dropped', { reason });
      },
      onInterrupted: (reason) => {
        this.options.telemetry?.streamInterrupted({
          sessionId: options.sessionId,
          deviceId: options.deviceId,
          action: 'stream',
          outcome: 'dropped',
          errorType: 'stream',
          errorCode: reason,
        });
      },
    });
    this.follow = new FollowStream({
      url: options.endpoints.streamUrl,
      onFrame: (frame) => this.handleFrame(frame),
      onStatus: (status, detail) => this.handleFollowStatus(status, detail),
    });
    this.composer = new Composer({
      ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
    });
    this.queue = new PendingQueue({
      submit: (submission) => this.submitPrompt(submission),
      query: (requestId) => this.queryPrompt(requestId),
      now: this.now,
      createId: this.createId,
    });
    this.run = new ActiveRun({ now: this.now });
    this.feedback = new FeedbackBoard({
      submit: (input) => this.submitFeedback(input),
      createOperationId: this.createId,
      now: this.now,
    });
    this.palette = new CommandPalette({
      ...(this.storage === undefined ? {} : { storage: this.storage }),
      ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    });
    this.announcer = new LiveAnnouncer({
      ...(options.announceThrottleMs === undefined ? {} : { throttleMs: options.announceThrottleMs }),
      ...(options.announcementSegmentChars === undefined ? {} : { segmentChars: options.announcementSegmentChars }),
      now: this.now,
    });
  }

  /**
   * 订阅状态变化。
   * @param listener - 变化回调。
   * @returns 取消订阅的函数。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 开始订阅跟随流并恢复草稿。 */
  start(): void {
    if (this.disposed) throw new Error('控制器已经销毁');
    this.restoreDraft();
    this.follow.start();
    this.emit();
  }

  /** 销毁控制器：关闭订阅并释放监听。 */
  dispose(): void {
    this.disposed = true;
    this.follow.stop();
    this.listeners.clear();
  }

  /** 目标设备是否在线。 */
  get online(): boolean {
    return this.deviceOnline;
  }

  /**
   * 设置目标设备的在线状态。
   * @param online - 是否在线。
   */
  setDeviceOnline(online: boolean): void {
    this.deviceOnline = online;
    if (!online) this.queue.pause('目标设备离线');
    this.emit();
  }

  /**
   * 设置引用目录。
   * @param candidates - 可引用的条目。
   */
  setCandidates(candidates: readonly ReferenceCandidate[]): void {
    this.candidates = [...candidates];
    this.emit();
  }

  /**
   * 设置运行时命令。
   * @param commands - 命令条目。
   */
  setRuntimeCommands(commands: readonly CommandDescriptor[]): void {
    this.runtimeCommands = [...commands];
    this.emit();
  }

  /**
   * 取当前状态快照。
   * @returns 席位状态。
   */
  state(): SeatState {
    if (this.cachedState !== undefined) return this.cachedState;
    const value = this.computeState();
    this.cachedState = value;
    return value;
  }

  /**
   * 计算状态快照。快照在两次变化之间保持同一个对象，界面据此判断是否重绘。
   * @returns 席位状态。
   */
  private computeState(): SeatState {
    const messages = this.stream.snapshot();
    const window = latestWindow(messages.messages.length, this.pageSize * (this.pageOffset + 1));
    const commands = this.commandList();
    return {
      sessionId: this.options.sessionId,
      deviceId: this.options.deviceId,
      deviceName: this.options.deviceName,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      source: this.options.source,
      deviceOnline: this.deviceOnline,
      composer: this.composer.state,
      sendCheck: this.composer.sendCheck(),
      stream: messages,
      queue: this.queue.snapshot(),
      run: this.run.runState,
      messageWindow: window,
      announcementsPaused: this.announcer.isPaused,
      ...(this.announcement === undefined ? {} : { announcement: this.announcement }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      palette: {
        open: this.palette.isOpen,
        levelLabel: this.palette.levelLabel,
        canGoBack: this.palette.canGoBack,
        query: this.palette.query,
        ...(this.palette.active() === undefined ? {} : { activeId: this.palette.active()!.id }),
        commands: this.palette.isOpen ? this.palette.filtered() : commands,
      },
      ...(this.trigger === undefined
        ? {}
        : {
            trigger: {
              kind: this.trigger.match.kind,
              query: this.trigger.match.query,
              items: this.trigger.items,
              groups: groupTriggerItems(this.trigger.items),
              match: this.trigger.match,
              ...(this.trigger.items[this.trigger.activeIndex] === undefined
                ? {}
                : { activeId: this.triggerActiveId() }),
            },
          }),
      feedback: messages.messages.map((message) => this.feedback.stateOf(message.id)),
      copiedAt: (messageId: string) => this.feedback.copiedAt(messageId),
      ...(this.copyFailure === undefined ? {} : { copyFailure: this.copyFailure }),
      ...(this.feedbackFailure === undefined ? {} : { feedbackFailure: this.feedbackFailure }),
      ...(this.newMessagesLabelValue === undefined ? {} : { newMessages: this.newMessagesLabelValue }),
      attachUnavailableReason: '附件入口由工作区工具包提供',
      ...(this.focusTarget === undefined ? {} : { focusTarget: this.focusTarget }),
    };
  }

  private copyFailure: { readonly messageId: string; readonly detail: string } | undefined;
  private feedbackFailure: string | undefined;

  /**
   * 当前命令列表：会话命令加上运行时命令。
   * @returns 命令列表。
   */
  private commandList(): CommandDescriptor[] {
    const last = this.lastMessage();
    const commands = buildConversationCommands({
      canSend: this.composer.sendCheck().canSend && this.deviceOnline,
      ...(this.composer.sendCheck().reason === undefined ? {} : { sendBlockerReason: this.composer.sendCheck().reason }),
      running: this.run.isRunning,
      deviceOnline: this.deviceOnline,
      queued: this.queue.snapshot().pendingCount,
      hasLastMessage: last !== undefined,
      announcementsPaused: this.announcer.isPaused,
    });
    return [...commands, ...this.runtimeCommands];
  }

  /**
   * 取最后一条消息。
   * @returns 消息；没有时返回 `undefined`。
   */
  private lastMessage() {
    return this.stream.snapshot().messages.at(-1);
  }

  /** 「有新消息」入口的文字。 */
  private get newMessagesLabelValue(): string | undefined {
    return newMessagesLabel(this.newMessageCount);
  }

  /** 通知全部订阅者。 */
  private emit(): void {
    this.cachedState = undefined;
    for (const listener of this.listeners) listener();
  }

  /**
   * 处理一帧跟随帧。
   *
   * 序号出现缺口时重新订阅；流式片段驱动实时播报与运行状态；回合结束把运行收尾并把累积
   * 播报一次。
   * @param frame - 跟随帧。
   */
  private handleFrame(frame: FollowFrame): void {
    const outcome = this.stream.apply(frame);
    if (outcome === 'gap') {
      this.notice = '跟随流出现缺口，正在重新读取会话';
      this.follow.restart();
      this.emit();
      return;
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame;
      if (inner.type === 'start' && this.run.discardedAttempt !== inner.attemptId) {
        this.run.begin({ runId: inner.attemptId, attemptId: inner.attemptId });
      }
      if (inner.type === 'chunk' && inner.chunk.type === 'text-delta') {
        this.announce(inner.chunk.text);
      }
    }
    if (frame.type === 'event' && frame.event.type === 'turn/end') {
      this.run.end();
      this.announceFinal('回合完成');
    }
    this.trackMessages();
    this.emit();
  }

  /**
   * 处理跟随流的连接状态。
   *
   * 中断时冻结接收并暂停队列；连接恢复只恢复读取，队列保持暂停等用户显式恢复。
   * @param status - 连接状态。
   * @param detail - 原因说明。
   */
  private handleFollowStatus(status: FollowStatus, detail?: string): void {
    if (status === 'interrupted') {
      this.stream.suspend(detail ?? 'connection-error');
      this.queue.pause('连接中断');
      this.announceFinal('连接中断，读取与待发送队列已暂停', true);
      this.notice = '连接中断，读取与待发送队列已暂停；恢复后请显式处理待发送内容';
      this.options.telemetry?.streamSpan({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        frames: this.stream.snapshot().counters.frames,
        chunks: this.stream.snapshot().counters.chunks,
        lateChunks: this.stream.snapshot().counters.lateChunks,
        outcome: 'failed',
        errorType: 'stream',
        errorCode: detail ?? 'connection-error',
        startedAt: this.now(),
        endedAt: this.now(),
      });
    }
    if (status === 'open' && this.stream.isSuspended) {
      this.notice = '连接已恢复，待发送队列保持暂停，请显式恢复';
    }
    this.emit();
  }

  /**
   * 记录新消息数量：用户停在历史位置时只累加，不把视口拉到末尾。
   */
  private trackMessages(): void {
    const total = this.stream.snapshot().messages.length;
    const added = total - this.lastMessageCount;
    this.lastMessageCount = total;
    if (added <= 0) return;
    if (this.atBottom) {
      this.newMessageCount = 0;
      return;
    }
    this.newMessageCount += added;
  }

  /**
   * 播报一段流式文本。
   * @param text - 片段文本。
   */
  private announce(text: string): void {
    const announcement: Announcement | undefined = this.announcer.push(text);
    if (announcement !== undefined) this.announcement = announcement.text;
  }

  /**
   * 播报一次终态。
   * @param text - 播报文本。
   * @param urgent - 是否立即播报。
   */
  private announceFinal(text: string, urgent = false): void {
    const announcement = this.announcer.flush(text, urgent);
    if (announcement !== undefined) this.announcement = announcement.text;
  }

  /**
   * 提交一条消息。
   * @param submission - 请求标识、会话、正文与引用。
   * @returns 提交结果。
   */
  private async submitPrompt(submission: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly references: readonly PersistedReference[];
  }): Promise<{ readonly accepted: boolean; readonly duplicate?: boolean; readonly seq?: number; readonly code?: string }> {
    const response = await this.fetchImpl(this.options.endpoints.sendUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: submission.requestId,
        sessionId: submission.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: submission.text }],
        references: submission.references,
      }),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15000),
    });
    if (!response.ok) return { accepted: false, code: `http-${String(response.status)}` };
    const parsed = sendResponseSchema.parse(await response.json());
    return {
      accepted: parsed.accepted,
      ...(parsed.duplicate === undefined ? {} : { duplicate: parsed.duplicate }),
      ...(parsed.seq === undefined ? {} : { seq: parsed.seq }),
      ...(parsed.code === undefined ? {} : { code: parsed.code }),
    };
  }

  /**
   * 按操作标识查询提交结果。
   * @param requestId - 操作标识。
   * @returns 查询结果。
   */
  private async queryPrompt(requestId: string): Promise<{ readonly state: 'confirmed' | 'pending' | 'unknown'; readonly seq?: number }> {
    const url = new URL(this.options.endpoints.queryUrl, 'http://local.invalid');
    url.searchParams.set('requestId', requestId);
    const response = await this.fetchImpl(url.pathname + url.search, { method: 'GET' });
    if (!response.ok) return { state: 'unknown' };
    const parsed = queryResponseSchema.parse(await response.json());
    return {
      state: parsed.state,
      ...(parsed.seq === undefined ? {} : { seq: parsed.seq }),
    };
  }

  /**
   * 提交一条消息反馈。
   * @param input - 消息、类型、原因、说明与操作标识。
   * @returns 提交结果。
   */
  private async submitFeedback(input: {
    readonly messageId: string;
    readonly rating: FeedbackRating;
    readonly reason?: FeedbackReason;
    readonly note?: string;
    readonly operationId: string;
  }): Promise<{ readonly accepted: boolean; readonly code?: string }> {
    try {
      const response = await this.fetchImpl(this.options.endpoints.feedbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15000),
      });
      if (!response.ok) return { accepted: false, code: `http-${String(response.status)}` };
      const parsed = feedbackResponseSchema.parse(await response.json());
      return {
        accepted: parsed.accepted,
        ...(parsed.code === undefined ? {} : { code: parsed.code }),
      };
    } catch {
      return { accepted: false, code: 'unconfirmed' };
    }
  }

  /**
   * 草稿的存储键：客户端、窗口、设备与会话四段。
   * @returns 存储键。
   */
  private draftStorageKey(): string {
    const clientId = this.options.clientId ?? 'client';
    const windowId = this.options.windowId ?? 'window';
    return `chatdsh-conversation.draft.v1:${clientId}:${windowId}:${this.options.deviceId}:${this.options.sessionId}`;
  }

  /**
   * 从本地草稿恢复输入区。
   *
   * 草稿按草稿契约校验，形状不合法时按没有草稿处理；需要重新选择的附件给出提示。
   */
  private restoreDraft(): void {
    if (this.storage === undefined) return;
    const raw = this.storage.getItem(this.draftStorageKey());
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = draftRecordSchema.safeParse(parsed);
    if (!result.success) return;
    const restored = this.composer.restoreDraft({
      text: result.data.text,
      references: result.data.references,
      attachments: result.data.attachments,
    });
    this.draftRevision = result.data.revision;
    if (restored.needsReselect.length > 0) this.notice = '有附件需要重新选择';
  }

  /**
   * 把输入区内容写入本地草稿。
   *
   * 写入失败时记录原因，界面据此提示存储不可用，输入内容留在界面上。
   */
  private persistDraft(): void {
    if (this.storage === undefined) return;
    const draft = this.composer.snapshotForDraft();
    const revision = this.draftRevision + 1;
    const record = {
      key: {
        clientId: this.options.clientId ?? 'client',
        windowId: this.options.windowId ?? 'window',
        deviceId: this.options.deviceId,
        sessionId: this.options.sessionId,
      },
      text: draft.text,
      references: draft.references,
      attachments: draft.attachments.map((attachment) => ({ ...attachment, confirmed: true as const })),
      revision,
      updatedAt: this.now(),
    };
    const validated = draftRecordSchema.safeParse(record);
    if (!validated.success) throw new Error('草稿内容不满足草稿契约');
    try {
      this.storage.setItem(this.draftStorageKey(), JSON.stringify(record));
      this.draftRevision = revision;
      this.composer.markDraft({ revision });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const reason = name === 'QuotaExceededError' ? '存储空间不足' : name === 'SecurityError' ? '隐私模式禁止本地存储' : '本地存储不可用';
      this.composer.markDraft({ failure: reason });
      this.failure = `草稿保存失败：${reason}`;
    }
  }

  /** 清掉本地草稿。 */
  private clearDraft(): void {
    if (this.storage === undefined) return;
    this.storage.removeItem(this.draftStorageKey());
    this.draftRevision = 0;
  }

  /**
   * 处理输入区文本变化。
   *
   * 界面给出新的完整文本，这里按前后缀差异算出替换区间，引用范围随之平移；落在被替换区间
   * 内的引用对象整条删除。写入草稿之后刷新类型触发面板。
   * @param text - 新的完整文本。
   * @param selectionStart - 选区起点。
   * @param selectionEnd - 选区终点。
   */
  handleTextChange(text: string, selectionStart: number, selectionEnd: number): void {
    const previous = this.composer.value;
    if (text === previous) {
      const safe = this.clampSelection(selectionStart, selectionEnd);
      this.composer.setSelection(safe.start, safe.end);
      this.emit();
      return;
    }
    let prefix = 0;
    while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < previous.length - prefix &&
      suffix < text.length - prefix &&
      previous[previous.length - 1 - suffix] === text[text.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const inserted = text.slice(prefix, text.length - suffix);
    this.composer.replaceRange(prefix, previous.length - suffix, inserted);
    const safe = this.clampSelection(selectionStart, selectionEnd);
    this.composer.setSelection(safe.start, safe.end);
    this.updateTrigger();
    this.persistDraft();
    this.emit();
  }

  /**
   * 记录输入区选区。
   * @param start - 选区起点。
   * @param end - 选区终点。
   */
  handleSelectionChange(start: number, end: number): void {
    const safe = this.clampSelection(start, end);
    this.composer.setSelection(safe.start, safe.end);
    this.updateTrigger();
    this.emit();
  }

  /**
   * 把界面报告的选区收敛到当前正文范围。
   *
   * 受控输入框在程序化清空之后仍可能报出旧值上的选区，收敛之后不会把越界值当成编程错误。
   * @param start - 选区起点。
   * @param end - 选区终点。
   * @returns 落在正文范围内的选区。
   */
  private clampSelection(start: number, end: number): { readonly start: number; readonly end: number } {
    const length = this.composer.value.length;
    const safeStart = Math.max(0, Math.min(start, length));
    const safeEnd = Math.max(safeStart, Math.min(end, length));
    return { start: safeStart, end: safeEnd };
  }

  /** 输入法开始组合。 */
  compositionStart(): void {
    this.composer.compositionStart();
    this.emit();
  }

  /**
   * 输入法组合过程更新。组合中的文本只进缓冲，正文不变。
   * @param data - 组合中的文本。
   */
  compositionUpdate(data: string): void {
    this.composer.compositionUpdate(data);
    this.emit();
  }

  /**
   * 输入法组合结束，缓冲写入正文。
   * @param data - 组合结束时的文本。
   */
  compositionEnd(data: string): void {
    this.composer.compositionEnd(data);
    this.updateTrigger();
    this.persistDraft();
    this.emit();
  }

  /**
   * 处理输入区的按键。
   *
   * 触发面板打开时方向键与回车交给面板；否则按输入区的快捷键判定执行发送、换行与中断。
   * @param event - 键盘事件。
   * @returns 按键意图。
   */
  handleKeyDown(event: SeatKeyEvent): ComposerIntent {
    if (this.trigger !== undefined) {
      const handled = this.handleTriggerKey(event);
      if (handled) return 'none';
    }
    const composing = this.composer.isComposing || event.isComposing === true || event.keyCode === 229;
    if (composing && event.key === 'Enter') {
      // 输入法组合中的回车由输入法处理，不插入换行也不发送。
      event.preventDefault();
      return 'none';
    }
    const intent = this.composer.keyIntent(event);
    if (intent === 'send') {
      event.preventDefault();
      void this.send();
    }
    if (intent === 'interrupt') {
      event.preventDefault();
      if (this.run.isRunning) void this.stop();
      else {
        this.composer.clear();
        this.persistDraft();
        this.emit();
      }
    }
    return intent;
  }

  /**
   * 处理整屏按键。
   * @param event - 键盘事件。
   * @returns 按键意图。
   */
  handleGlobalKey(event: SeatKeyEvent): ConversationKeyIntent {
    const intent = conversationKeyIntent(event, {
      paletteOpen: this.palette.isOpen,
      running: this.run.isRunning,
    });
    if (intent === 'open-palette') {
      event.preventDefault();
      this.openPalette();
    }
    if (intent === 'close-palette') {
      event.preventDefault();
      this.closePalette();
    }
    if (intent === 'stop-run') {
      event.preventDefault();
      void this.stop();
    }
    if (intent === 'toggle-announcements') {
      event.preventDefault();
      this.toggleAnnouncements();
    }
    if (intent === 'focus-composer') {
      event.preventDefault();
      this.focusTarget = 'composer';
      this.emit();
    }
    return intent;
  }

  /**
   * 发送输入区内容。
   *
   * 空闲时直接提交，运行中进入在线队列。提交期间不清除草稿，确认之后才清空；提交结果不确定
   * 时先按操作标识查询实际结果，确认过的不再重复提交。
   * @returns 发送结论。
   */
  async send(): Promise<SendOutcome> {
    const check = this.composer.sendCheck();
    if (!check.canSend) {
      const code = check.blockers[0] ?? 'empty';
      this.failure = check.reason ?? '没有可以发送的内容';
      this.options.telemetry?.messageRejected({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        action: 'send',
        outcome: 'rejected',
        errorType: 'validation',
        errorCode: code,
      });
      this.options.telemetry?.counted('chatdsh_client_message_sends_total', 'rejected');
      this.emit();
      return { outcome: 'rejected', code, message: this.failure };
    }
    if (!this.deviceOnline) {
      this.failure = '目标设备离线，发送失败，草稿已保留';
      this.options.telemetry?.messageRejected({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        action: 'send',
        outcome: 'rejected',
        errorType: 'device',
        errorCode: 'device-offline',
      });
      this.options.telemetry?.counted('chatdsh_client_message_sends_total', 'rejected');
      this.emit();
      return { outcome: 'rejected', code: 'device-offline', message: this.failure };
    }
    const draft = this.composer.snapshotForDraft();
    if (this.run.isRunning) {
      const item = this.queue.enqueue({
        sessionId: this.options.sessionId,
        text: this.composer.value,
        references: draft.references,
      });
      this.notice = '当前运行中，已加入待发送队列';
      this.options.telemetry?.queueSpan({
        sessionId: this.options.sessionId,
        action: 'enqueue',
        count: 1,
        outcome: 'ok',
        startedAt: this.now(),
        endedAt: this.now(),
      });
      this.options.telemetry?.counted('chatdsh_client_queue_actions_total', 'ok', { action: 'enqueue' });
      this.composer.clearAfterSend();
      this.clearDraft();
      this.emit();
      return { outcome: 'queued', itemId: item.id };
    }
    const requestId = this.createId();
    const startedAt = this.now();
    try {
      const result = await this.submitPrompt({
        requestId,
        sessionId: this.options.sessionId,
        text: this.composer.value,
        references: draft.references,
      });
      if (result.accepted) {
        this.composer.clearAfterSend();
        this.clearDraft();
        this.notice = result.duplicate === true ? '这条消息已经提交过，没有重复发送' : '已发送';
        this.failure = undefined;
        this.options.telemetry?.messageSpan({
          sessionId: this.options.sessionId,
          deviceId: this.options.deviceId,
          mode: 'direct',
          chars: draft.text.length,
          references: draft.references.length,
          attachments: draft.attachments.length,
          outcome: result.duplicate === true ? 'duplicate' : 'ok',
          startedAt,
          endedAt: this.now(),
        });
        this.options.telemetry?.counted(
          'chatdsh_client_message_sends_total',
          result.duplicate === true ? 'duplicate' : 'ok'
        );
        this.emit();
        return { outcome: 'sent', requestId, ...(result.seq === undefined ? {} : { seq: result.seq }) };
      }
      const code = result.code ?? 'send-rejected';
      this.failure = `发送失败：${code}，草稿已保留`;
      this.options.telemetry?.messageRejected({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        action: 'send',
        outcome: 'rejected',
        errorType: 'server',
        errorCode: code,
      });
      this.options.telemetry?.counted('chatdsh_client_message_sends_total', 'rejected');
      this.emit();
      return { outcome: 'rejected', code, message: this.failure };
    } catch {
      const status = await this.queryPrompt(requestId);
      if (status.state === 'confirmed') {
        this.composer.clearAfterSend();
        this.clearDraft();
        this.notice = '已发送（网络超时后查询确认）';
        this.failure = undefined;
        this.options.telemetry?.counted('chatdsh_client_message_sends_total', 'ok');
        this.emit();
        return { outcome: 'sent', requestId, ...(status.seq === undefined ? {} : { seq: status.seq }) };
      }
      this.failure = '结果尚未确认，请稍后查询实际结果；草稿已保留';
      this.options.telemetry?.messageRejected({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        action: 'send',
        outcome: 'unconfirmed',
        errorType: 'network',
        errorCode: 'unconfirmed',
      });
      this.options.telemetry?.counted('chatdsh_client_message_sends_total', 'unconfirmed');
      this.emit();
      return { outcome: 'unconfirmed', requestId, message: this.failure };
    }
  }

  /**
   * 请求停止当前运行。
   *
   * 只有宿主确认之后才显示已停止；未确认与拒绝分别显示对应说明。停止确认之后该尝试的迟到
   * 片段整份丢弃。
   * @returns 停止结论。
   */
  async stop(): Promise<StopOutcome> {
    if (!this.run.isRunning) return { outcome: 'ignored' };
    const request = this.run.requestStop(this.createId());
    this.notice = '已发出停止请求，等待宿主确认';
    this.emit();
    try {
      const response = await this.fetchImpl(this.options.endpoints.stopUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: this.options.sessionId }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15000),
      });
      if (!response.ok) {
        const result = this.run.acknowledge({
          outcome: 'unconfirmed',
          runId: request.runId,
          code: `http-${String(response.status)}`,
        });
        this.failure = '停止请求未确认';
        this.emit();
        return { outcome: 'unconfirmed', code: result.code ?? 'http-error' };
      }
      const ack = stopAckSchema.parse(await response.json());
      const result = this.run.acknowledge(ack);
      if (!result.applied) return { outcome: 'ignored' };
      if (result.state === 'stopped') {
        const attempt = this.run.discardedAttempt;
        if (attempt !== undefined) this.stream.discardAttempt(attempt);
        this.notice = '已停止';
        this.failure = undefined;
        this.announceFinal('已停止');
      } else if (result.state === 'stop-unconfirmed') {
        this.failure = '停止请求未确认';
        this.notice = undefined;
        this.announceFinal('停止请求未确认', true);
      } else {
        this.failure = `停止请求失败：${result.code ?? 'stop-rejected'}`;
        this.notice = undefined;
        this.announceFinal('停止请求失败', true);
      }
      this.emit();
      return result.state === 'stopped'
        ? { outcome: 'stopped' }
        : result.state === 'stop-unconfirmed'
          ? { outcome: 'unconfirmed', code: result.code ?? 'stop-unconfirmed' }
          : { outcome: 'rejected', code: result.code ?? 'stop-rejected' };
    } catch {
      this.run.acknowledge({ outcome: 'unconfirmed', runId: request.runId, code: 'timeout' });
      this.failure = '停止请求未确认';
      this.notice = undefined;
      this.announceFinal('停止请求未确认', true);
      this.emit();
      return { outcome: 'unconfirmed', code: 'timeout' };
    }
  }

  /**
   * 刷新类型触发面板。
   *
   * 光标前的 `/` 或 `@` 打开对应面板；触发字符与光标之间有空白时不打开，正文里的斜杠与
   * 邮箱地址因此不会误触发。
   */
  private updateTrigger(): void {
    const state = this.composer.state;
    const match = detectTrigger(state.text, state.selectionStart);
    if (match === undefined) {
      this.trigger = undefined;
      return;
    }
    const pool = match.kind === 'command' ? this.commandTriggerItems() : this.referenceTriggerItems();
    const items = filterTriggerItems(pool, match.query);
    this.trigger = { match, items, activeIndex: items.length === 0 ? -1 : 0 };
  }

  /**
   * 命令触发面板的条目：运行时命令。
   * @returns 触发条目。
   */
  private commandTriggerItems(): TriggerItem[] {
    return this.runtimeCommands.map((command) => ({
      id: command.id,
      kind: 'command' as const,
      label: command.name,
      group: command.group,
      origin: 'local' as const,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.enabled ? {} : { unavailableReason: command.disabledReason ?? '当前不可用' }),
    }));
  }

  /**
   * 引用触发面板的条目：目录里的文件、技能、子代理、会话与记忆条目。
   * @returns 触发条目。
   */
  private referenceTriggerItems(): TriggerItem[] {
    return toTriggerItems(this.candidates.filter((candidate) => candidate.kind !== 'command'));
  }

  /**
   * 当前触发面板条目的标识。
   * @returns `种类:标识` 形式的条目标识。
   */
  private triggerActiveId(): string | undefined {
    const item = this.trigger?.items[this.trigger.activeIndex];
    return item === undefined ? undefined : `${item.kind}:${item.id}`;
  }

  /**
   * 处理触发面板打开时的按键。
   * @param event - 键盘事件。
   * @returns 已经处理时为真。
   */
  private handleTriggerKey(event: SeatKeyEvent): boolean {
    const panel = this.trigger;
    if (panel === undefined) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.trigger = undefined;
      this.emit();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (event.shiftKey) return false;
      event.preventDefault();
      const item = panel.items[panel.activeIndex];
      if (item !== undefined && item.unavailableReason === undefined) this.applyTrigger(item);
      return true;
    }
    const count = panel.items.length;
    if (count === 0) return false;
    const index = panel.activeIndex;
    const next = event.key === 'ArrowDown' ? (index + 1) % count
      : event.key === 'ArrowUp' ? (index <= 0 ? count - 1 : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? count - 1
            : undefined;
    if (next === undefined) return false;
    event.preventDefault();
    this.trigger = { ...panel, activeIndex: next };
    this.emit();
    return true;
  }

  /**
   * 选中触发面板里的一条条目。
   * @param item - 条目。
   */
  applyTrigger(item: TriggerItem): void {
    const panel = this.trigger;
    if (panel === undefined) throw new Error('触发面板没有打开');
    if (item.kind === 'command') {
      const command = this.runtimeCommands.find((entry) => entry.id === item.id);
      if (command === undefined) throw new Error(`运行时命令不存在：${item.id}`);
      this.composer.replaceRange(panel.match.start, panel.match.end, `/${command.name} `);
      this.trigger = undefined;
      this.persistDraft();
      this.emit();
      return;
    }
    const candidate = this.candidates.find((entry) => entry.id === item.id && entry.kind === item.kind);
    if (candidate === undefined) throw new Error(`引用对象不在目录里：${item.id}`);
    this.composer.insertReferenceForTrigger(candidate, { start: panel.match.start, end: panel.match.end });
    this.trigger = undefined;
    this.options.telemetry?.referenceInvalidated({
      sessionId: this.options.sessionId,
      action: 'insert',
      kind: candidate.kind,
      outcome: 'ok',
    });
    this.options.telemetry?.counted('chatdsh_client_reference_changes_total', 'ok', { kind: candidate.kind });
    this.persistDraft();
    this.emit();
  }

  /** 关闭触发面板。 */
  closeTrigger(): void {
    this.trigger = undefined;
    this.emit();
  }

  /** 打开命令面板。 */
  openPalette(): void {
    this.palette.open(this.commandList());
    this.focusTarget = 'palette';
    this.emit();
  }

  /** 关闭命令面板，并把焦点交给输入区。 */
  closePalette(): void {
    this.palette.close();
    this.focusTarget = 'composer';
    this.emit();
  }

  /**
   * 修改命令面板的查询文本。
   * @param query - 查询文本。
   */
  paletteSetQuery(query: string): void {
    this.palette.setQuery(query);
    this.emit();
  }

  /**
   * 移动命令面板的选中位置。
   * @param key - 移动键。
   */
  paletteMove(key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): void {
    this.palette.move(key);
    this.emit();
  }

  /**
   * 接管命令面板的当前条目。
   * @param id - 条目标识。
   */
  paletteSetActive(id: string): void {
    const index = this.palette.filtered().findIndex((command) => command.id === id);
    if (index < 0) return;
    this.palette.move('Home');
    for (let step = 0; step < index; step += 1) this.palette.move('ArrowDown');
    this.emit();
  }

  /**
   * 执行命令面板的当前条目。
   * @returns 执行的命令标识；没有执行时返回 `undefined`。
   */
  async paletteSelect(): Promise<string | undefined> {
    const selection = this.palette.select();
    if (selection.kind === 'none') {
      this.failure = selection.reason;
      this.emit();
      return undefined;
    }
    if (selection.kind === 'enter') {
      this.emit();
      return undefined;
    }
    const command = selection.command;
    this.palette.close();
    this.focusTarget = 'composer';
    const startedAt = this.now();
    try {
      await this.runCommand(command.id);
      this.options.telemetry?.commandSpan({ commandId: command.id, outcome: 'ok', startedAt, endedAt: this.now() });
      this.options.telemetry?.counted('chatdsh_client_command_runs_total', 'ok');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'command-failed';
      this.options.telemetry?.commandRejected({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        action: command.id,
        outcome: 'failed',
        errorType: 'command',
        errorCode: code,
      });
      this.options.telemetry?.counted('chatdsh_client_command_runs_total', 'failed');
      this.failure = `命令执行失败：${code}`;
    }
    this.emit();
    return command.id;
  }

  /**
   * 执行一个命令。
   * @param id - 命令标识。
   */
  private async runCommand(id: string): Promise<void> {
    switch (id) {
      case 'send-message':
        await this.send();
        return;
      case 'stop-run':
        await this.stop();
        return;
      case 'open-queue':
        this.focusTarget = 'queue';
        return;
      case 'clear-composer':
        this.composer.clear();
        this.persistDraft();
        return;
      case 'toggle-announcements':
        this.toggleAnnouncements();
        return;
      case 'copy-last-message': {
        const last = this.lastMessage();
        if (last === undefined) throw new Error('当前没有消息');
        await this.copyMessage(last.id);
        return;
      }
      case 'feedback': {
        const last = this.lastMessage();
        if (last === undefined) throw new Error('当前没有消息');
        this.focusTarget = `feedback:${last.id}`;
        return;
      }
      case 'insert-reference':
        this.trigger = {
          match: { kind: 'reference', start: this.composer.state.selectionStart, end: this.composer.state.selectionStart, query: '' },
          items: this.referenceTriggerItems(),
          activeIndex: 0,
        };
        return;
      case 'insert-command':
        this.trigger = {
          match: { kind: 'command', start: this.composer.state.selectionStart, end: this.composer.state.selectionStart, query: '' },
          items: this.commandTriggerItems(),
          activeIndex: 0,
        };
        return;
      default:
        throw new Error(`没有这个命令：${id}`);
    }
  }

  /**
   * 修改一条待发送内容。
   * @param id - 条目标识。
   * @param text - 新正文。
   * @returns 动作结论。
   */
  queueEdit(id: string, text: string): QueueActionOutcome {
    return this.runQueueAction('edit', () => {
      this.queue.edit(id, text);
      this.notice = '待发送内容已更新';
    });
  }

  /**
   * 删除一条待发送内容。
   * @param id - 条目标识。
   * @returns 动作结论。
   */
  queueRemove(id: string): QueueActionOutcome {
    return this.runQueueAction('remove', () => {
      this.queue.remove(id);
      this.notice = '待发送内容已删除';
    });
  }

  /**
   * 暂停队列消费。
   * @returns 动作结论。
   */
  queuePause(): QueueActionOutcome {
    return this.runQueueAction('pause', () => {
      this.queue.pause('用户暂停');
      this.notice = '队列已暂停';
    });
  }

  /**
   * 恢复队列消费并重新读取每条的实际状态。
   *
   * 恢复不会自动发送：已确认的条目落定，其余保持待发送等用户显式发送。
   * @returns 动作结论与待发送条数。
   */
  async queueResume(): Promise<QueueResumeOutcome> {
    const startedAt = this.now();
    try {
      const result = await this.queue.resume();
      this.notice = `队列已恢复，${String(result.pending.length)} 条待发送内容等你显式发送`;
      this.options.telemetry?.queueSpan({
        sessionId: this.options.sessionId,
        action: 'resume',
        count: result.pending.length,
        outcome: 'ok',
        startedAt,
        endedAt: this.now(),
      });
      this.options.telemetry?.counted('chatdsh_client_queue_actions_total', 'ok', { action: 'resume' });
      this.emit();
      return { outcome: 'ok', pending: result.pending.length };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'resume-failed';
      this.failure = `恢复队列失败：${code}`;
      this.options.telemetry?.queueRejected({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        action: 'resume',
        outcome: 'failed',
        errorType: 'queue',
        errorCode: code,
      });
      this.emit();
      return { outcome: 'rejected', code, message: this.failure };
    }
  }

  /**
   * 按顺序发送队列里的下一条。
   * @returns 消费结果。
   */
  async queueSendNext(): Promise<QueueConsumeResult> {
    const startedAt = this.now();
    const result = await this.queue.consume();
    const outcome = result.outcome === 'sent' || result.outcome === 'confirmed-already' ? 'ok' : result.outcome === 'paused' ? 'paused' : 'rejected';
    this.options.telemetry?.queueSpan({
      sessionId: this.options.sessionId,
      action: 'consume',
      count: result.outcome === 'sent' ? 1 : 0,
      outcome,
      ...(result.outcome === 'failed' ? { errorType: 'queue', errorCode: result.code } : {}),
      startedAt,
      endedAt: this.now(),
    });
    this.options.telemetry?.counted('chatdsh_client_queue_actions_total', outcome, { action: 'consume' });
    if (result.outcome === 'sent') {
      this.notice = '队列里的下一条已发送';
      this.failure = undefined;
    } else if (result.outcome === 'paused') {
      this.notice = `队列已暂停：${result.reason}`;
    } else if (result.outcome === 'failed') {
      this.failure = `队列发送失败：${result.code}`;
    } else if (result.outcome === 'unconfirmed') {
      this.failure = '队列发送结果尚未确认，请稍后查询';
    } else if (result.outcome === 'confirmed-already') {
      this.notice = '这条内容此前已经确认，没有重复提交';
    } else if (result.outcome === 'requeued') {
      this.notice = '服务端没有收到这条内容，已退回待发送';
    } else if (result.outcome === 'empty') {
      this.notice = '队列里没有待发送内容';
    }
    this.emit();
    return result;
  }

  /**
   * 执行一次队列动作并登记遥测。
   * @param action - 动作名。
   * @param work - 动作本体。
   * @returns 动作结论。
   */
  private runQueueAction(action: 'edit' | 'remove' | 'pause', work: () => void): QueueActionOutcome {
    const startedAt = this.now();
    try {
      work();
      this.options.telemetry?.queueSpan({
        sessionId: this.options.sessionId,
        action,
        count: 1,
        outcome: 'ok',
        startedAt,
        endedAt: this.now(),
      });
      this.options.telemetry?.counted('chatdsh_client_queue_actions_total', 'ok', { action });
      this.emit();
      return { outcome: 'ok' };
    } catch (error) {
      const code = error instanceof Error ? error.message : `${action}-failed`;
      this.failure = `队列操作失败：${code}`;
      this.options.telemetry?.queueRejected({
        sessionId: this.options.sessionId,
        deviceId: this.options.deviceId,
        action,
        outcome: 'rejected',
        errorType: 'queue',
        errorCode: code,
      });
      this.options.telemetry?.counted('chatdsh_client_queue_actions_total', 'rejected', { action });
      this.emit();
      return { outcome: 'rejected', code, message: this.failure };
    }
  }

  /**
   * 选择反馈类型。
   * @param messageId - 消息标识。
   * @param rating - 反馈类型。
   */
  feedbackRate(messageId: string, rating: FeedbackRating): void {
    this.feedback.rate(messageId, rating);
    this.feedbackFailure = undefined;
    this.emit();
  }

  /**
   * 选择踩的原因。
   * @param messageId - 消息标识。
   * @param reason - 原因。
   */
  feedbackReason(messageId: string, reason: FeedbackReason): void {
    const state = this.feedback.stateOf(messageId);
    this.feedback.rate(messageId, state.rating ?? 'dislike', reason, state.note);
    this.emit();
  }

  /**
   * 填写反馈说明。
   * @param messageId - 消息标识。
   * @param note - 说明。
   */
  feedbackNote(messageId: string, note: string): void {
    const state = this.feedback.stateOf(messageId);
    this.feedback.rate(messageId, state.rating ?? 'dislike', state.reason, note);
    this.emit();
  }

  /**
   * 提交一条反馈。
   * @param messageId - 消息标识。
   */
  async feedbackSubmit(messageId: string): Promise<void> {
    const state = await this.feedback.submit(messageId);
    this.feedbackFailure = state.status === 'failed' ? `反馈提交失败：${state.failureCode ?? 'unknown'}` : undefined;
    this.emit();
  }

  /**
   * 复制一条消息的正文。
   * @param messageId - 消息标识。
   * @returns 复制结论。
   */
  async copyMessage(messageId: string): Promise<{ readonly outcome: 'copied' | 'failed'; readonly detail?: string }> {
    const message = this.stream.snapshot().messages.find((entry) => entry.id === messageId);
    if (message === undefined) throw new Error(`消息不存在：${messageId}`);
    const result = await this.feedback.copy(messageId, segmentsText(message.segments));
    this.copyFailure = result.outcome === 'copied'
      ? undefined
      : { messageId, detail: result.detail ?? '复制失败' };
    this.emit();
    return {
      outcome: result.outcome,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
  }

  /** 切换实时播报的暂停状态。 */
  toggleAnnouncements(): void {
    if (this.announcer.isPaused) {
      this.announcer.resume();
      this.announcement = undefined;
    } else {
      this.announcer.pause();
      this.announcement = '';
    }
    this.emit();
  }

  /**
   * 移除一个引用对象。
   * @param id - 引用对象标识。
   */
  removeReference(id: string): void {
    const reference = this.composer.state.references.find((entry) => entry.id === id);
    this.composer.removeReference(id);
    this.options.telemetry?.referenceInvalidated({
      sessionId: this.options.sessionId,
      action: 'remove',
      kind: reference?.kind ?? 'file',
      outcome: 'ok',
    });
    this.options.telemetry?.counted('chatdsh_client_reference_changes_total', 'ok', { kind: reference?.kind ?? 'file' });
    this.persistDraft();
    this.emit();
  }

  /**
   * 引用失效后按种类重新打开引用面板。
   * @param kind - 引用对象种类。
   */
  reselectReference(kind: ReferenceObjectKind): void {
    const items = filterTriggerItems(this.referenceTriggerItems(), '');
    this.trigger = {
      match: { kind: 'reference', start: this.composer.state.selectionStart, end: this.composer.state.selectionStart, query: '' },
      items: items.filter((item) => item.kind === kind),
      activeIndex: 0,
    };
    this.emit();
  }

  /**
   * 按宿主给出的可用清单刷新引用状态。
   * @param availability - 可用清单。
   */
  refreshReferences(
    availability: readonly { readonly kind: ReferenceObjectKind; readonly id: string; readonly reason?: 'deleted' | 'forbidden' | 'unreachable' | 'stale' }[]
  ): void {
    const invalidated = this.composer.invalidateReferences(availability);
    for (const reference of invalidated) {
      this.options.telemetry?.referenceInvalidated({
        sessionId: this.options.sessionId,
        action: 'invalidate',
        kind: reference.kind,
        outcome: 'rejected',
      });
      this.options.telemetry?.counted('chatdsh_client_reference_changes_total', 'rejected', { kind: reference.kind });
    }
    if (invalidated.length > 0) this.notice = '有引用失效，请重新选择或移除';
    this.persistDraft();
    this.emit();
  }

  /**
   * 记录视口滚动位置。
   * @param metrics - 视口滚动量。
   */
  handleScroll(metrics: ScrollMetrics): void {
    const atBottom = shouldAutoFollow(metrics);
    this.atBottom = atBottom;
    if (atBottom) this.newMessageCount = 0;
    this.emit();
  }

  /** 回到末尾并清掉新消息计数。 */
  showNewMessages(): void {
    this.newMessageCount = 0;
    this.focusTarget = 'messages-bottom';
    this.emit();
  }

  /** 读取更早的一段消息。 */
  loadOlder(): void {
    this.pageOffset += 1;
    this.emit();
  }

  /** 清掉操作提示与失败提示。 */
  dismissNotice(): void {
    this.notice = undefined;
    this.failure = undefined;
    this.copyFailure = undefined;
    this.feedbackFailure = undefined;
    this.emit();
  }

  /**
   * 取走并清掉焦点目标。
   * @returns 焦点目标标识。
   */
  takeFocusTarget(): string | undefined {
    const target = this.focusTarget;
    this.focusTarget = undefined;
    return target;
  }
}

/** 席位键盘事件：界面事件里控制器关心的字段与阻止默认动作的方法。 */
export interface SeatKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  preventDefault(): void;
}
