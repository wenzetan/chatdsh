/**
 * 内容端（设备内容席位）的导航桥。
 *
 * 内容端在页面挂载完成后向宿主上报 `ready`，并在每次收到宿主的 `source` 声明后按声明的设备
 * 与状态重新上报。收到 `navigate` 时调用真实的打开实现，只有真实打开成功、并且当前选中的
 * 会话确实等于请求的会话时才回 `selected`；其余情况一律回 `rejected` 并带原因码。
 *
 * 只接受来自宿主窗口、来源等于期望 `origin` 的消息。来自其他窗口的消息被丢弃并记录，绝不
 * 回复，避免把会话信息投递给未知来源。
 * @module @chatdsh/client-session-bridge/content
 */

import {
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  errorTypeOf,
  parseBridgeMessage,
  readyMessage,
  rejectedMessage,
  selectedMessage,
  stricterState,
  type BridgeCapability,
  type ContentState,
  type NavigationRejection,
  type NavigationRejectionCode,
  type ReadyReport,
  type RejectedReport,
  type SelectedReport,
} from './contract.ts';
import type { NavigationTelemetry } from './telemetry.ts';

/** 已处理请求的缓存条数，用于同一请求标识的重复投递。 */
const HANDLED_REQUEST_MAX = 32;

/** 被丢弃消息的保留条数。 */
const REJECTION_LOG_MAX = 16;

/** 一次真实打开的结果。 */
export interface OpenedSession {
  /** 实际打开的会话。 */
  readonly sessionId: string;
  /** 会话标题。 */
  readonly title: string;
}

/**
 * 打开会话失败时携带已登记的原因码。
 *
 * 打开实现用它区分“设备离线”与“会话不存在”，内容端把原因码原样回给宿主。
 */
export class NavigationOpenError extends Error {
  /** 已登记的原因码。 */
  readonly code: NavigationRejectionCode;

  /**
   * @param code - 原因码。
   * @param message - 诊断说明，不含会话内容。
   */
  constructor(code: NavigationRejectionCode, message: string) {
    super(message);
    this.name = 'NavigationOpenError';
    this.code = code;
  }
}

/** 内容端的输入。 */
export interface NavigationContentOptions {
  /** 内容端窗口。 */
  readonly window: Window;
  /** 宿主窗口，通常是 `window.parent`。 */
  readonly parent: Window;
  /** 本席位所属设备。 */
  readonly deviceId: string;
  /** 遥测面。 */
  readonly telemetry: NavigationTelemetry;
  /** 宿主的期望来源；缺省取内容端窗口的 `origin`。 */
  readonly hostOrigin?: string;
  /** 内容端自身的数据状态；缺省为可写。 */
  readonly state?: ContentState;
  /** 内容端提供的能力；缺省为全部能力。 */
  readonly capabilities?: readonly BridgeCapability[];
  /** 真实打开会话的实现。 */
  readonly openSession: (sessionId: string) => Promise<OpenedSession>;
  /** 读取当前真实选中会话的实现；给出时用于核对打开结果。 */
  readonly currentSession?: () => string | undefined;
  /** 一次打开与一次就绪上报的时限，单位毫秒。 */
  readonly timeoutMs?: number;
}

/**
 * 内容端的导航桥。
 *
 * 构造即安装消息监听并上报就绪。
 */
export class NavigationContent {
  private readonly window: Window;
  private readonly parent: Window;
  private readonly deviceId: string;
  private readonly telemetry: NavigationTelemetry;
  private readonly hostOrigin: string;
  private readonly openSession: (sessionId: string) => Promise<OpenedSession>;
  private readonly currentSession: (() => string | undefined) | undefined;
  private readonly timeoutMs: number;
  private readonly onMessage: (event: MessageEvent) => void;
  private readonly rejectionLog: NavigationRejection[] = [];
  private readonly handled = new Map<string, SelectedReport | RejectedReport>();
  private capabilities: readonly BridgeCapability[];
  private ownState: ContentState;
  private declaredState: ContentState | undefined;
  private latestReady: ReadyReport | undefined;
  private selectedId: string | undefined;
  private started = false;
  private disposed = false;

  /**
   * @param options - 窗口、设备、打开实现与遥测面。
   */
  constructor(options: NavigationContentOptions) {
    this.window = options.window;
    this.parent = options.parent;
    this.deviceId = options.deviceId;
    this.telemetry = options.telemetry;
    this.hostOrigin = options.hostOrigin ?? options.window.location.origin;
    this.openSession = options.openSession;
    this.currentSession = options.currentSession;
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS));
    this.ownState = options.state ?? 'writable';
    this.capabilities = options.capabilities ?? ['open-session', 'report-selection', 'readonly-mode', 'offline-mode'];
    this.onMessage = (event) => this.handleMessage(event);
    this.start();
  }

  /** 是否已经上报就绪。 */
  get ready(): boolean {
    return this.latestReady !== undefined;
  }

  /** 生效的数据状态。 */
  get state(): ContentState {
    return this.declaredState === undefined ? this.ownState : stricterState(this.ownState, this.declaredState);
  }

  /** 当前选中的会话。 */
  get selectedSessionId(): string | undefined {
    return this.selectedId;
  }

  /**
   * 取最近被丢弃的消息记录，最新的在后。
   * @returns 记录的副本。
   */
  rejections(): readonly NavigationRejection[] {
    return [...this.rejectionLog];
  }

  /**
   * 安装监听并上报就绪；重复调用只重发就绪上报。
   * @returns 就绪上报消息。
   */
  start(): ReadyReport {
    if (this.disposed) throw new Error('导航桥已经销毁');
    if (!this.started) {
      this.started = true;
      this.window.addEventListener('message', this.onMessage);
    }
    return this.announce();
  }

  /**
   * 更新自身的数据状态并重新上报就绪。
   * @param state - 新的数据状态。
   * @returns 就绪上报消息。
   */
  setState(state: ContentState): ReadyReport {
    this.ownState = state;
    return this.announce();
  }

  /** 停止监听。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.window.removeEventListener('message', this.onMessage);
  }

  /**
   * 向宿主上报就绪。
   * @param requestId - 对应的声明标识；自主上报时缺省。
   * @returns 上报的消息。
   */
  private announce(requestId?: string): ReadyReport {
    const current = this.currentSession?.();
    this.selectedId = current ?? this.selectedId;
    const report = readyMessage({
      ...(requestId === undefined ? {} : { requestId }),
      deviceId: this.deviceId,
      state: this.state,
      capabilities: this.capabilities,
      ...(this.selectedId === undefined ? {} : { sessionId: this.selectedId }),
    });
    this.latestReady = report;
    this.parent.postMessage(report, this.hostOrigin);
    return report;
  }

  /**
   * 处理一条来自窗口的消息。
   * @param event - 消息事件。
   */
  private handleMessage(event: MessageEvent): void {
    if (this.disposed) return;
    if (event.origin !== this.hostOrigin) {
      this.record({
        code: 'origin-rejected',
        type: 'origin-mismatch',
        detail: `消息来源 ${event.origin}，期望 ${this.hostOrigin}`,
      });
      return;
    }
    if (event.source !== this.parent) {
      this.record({
        code: 'message-source-mismatch',
        type: 'source-mismatch',
        detail: '消息来源窗口不是宿主窗口',
      });
      return;
    }
    const parsed = parseBridgeMessage(event.data);
    if (!parsed.ok) {
      this.record(parsed.rejection);
      const requestId = requestIdOf(event.data);
      if (requestId !== undefined) this.reply(rejectedMessage({ requestId, code: parsed.rejection.code }));
      return;
    }
    const message = parsed.message;
    if ('outcome' in message) {
      this.record({
        code: 'message-schema-invalid',
        type: 'schema-invalid',
        detail: `内容端收到了发往宿主的 ${message.outcome} 消息`,
      });
      return;
    }
    if (message.action === 'source') {
      this.handleSource(message.deviceId, message.state, message.requestId);
      return;
    }
    void this.handleNavigate(message.requestId, message.deviceId, message.sessionId);
  }

  /**
   * 处理宿主的席位声明。
   * @param deviceId - 声明要服务的设备。
   * @param state - 声明的数据状态。
   * @param requestId - 声明标识，原样带回就绪上报。
   */
  private handleSource(deviceId: string, state: ContentState, requestId?: string): void {
    if (deviceId !== this.deviceId) {
      this.record({
        code: 'device-mismatch',
        type: 'device-mismatch',
        detail: `席位声明为设备 ${deviceId}，内容是设备 ${this.deviceId}`,
      });
    } else {
      this.declaredState = state;
    }
    this.announce(requestId);
  }

  /**
   * 处理一次导航请求。
   * @param requestId - 请求标识。
   * @param deviceId - 目标设备。
   * @param sessionId - 目标会话。
   */
  private async handleNavigate(requestId: string, deviceId: string, sessionId: string): Promise<void> {
    const cached = this.handled.get(requestId);
    if (cached !== undefined) {
      this.reply(cached);
      return;
    }
    if (deviceId !== this.deviceId) {
      this.replyRejected(requestId, {
        code: 'device-mismatch',
        type: 'device-mismatch',
        detail: `请求属于设备 ${deviceId}，内容是设备 ${this.deviceId}`,
      });
      return;
    }
    if (this.declaredState === undefined) {
      this.replyRejected(requestId, {
        code: 'navigation-not-ready',
        type: 'not-ready',
        detail: '宿主尚未声明席位，导航请求暂不接收',
      });
      return;
    }
    const result = await this.openWithinLimit(sessionId);
    if (result.kind === 'rejected') {
      this.replyRejected(requestId, result.rejection);
      return;
    }
    const report = selectedMessage({
      requestId,
      deviceId: this.deviceId,
      sessionId: result.opened.sessionId,
      title: result.opened.title,
    });
    this.remember(requestId, report);
    this.selectedId = result.opened.sessionId;
    this.reply(report);
  }

  /**
   * 在时限内真实打开会话，并核对打开结果。
   * @param sessionId - 目标会话。
   * @returns 打开结果或拒绝原因。
   */
  private async openWithinLimit(
    sessionId: string,
  ): Promise<{ readonly kind: 'opened'; readonly opened: OpenedSession } | { readonly kind: 'rejected'; readonly rejection: NavigationRejection }> {
    const work = this.openSession(sessionId).then(
      (opened) => ({ kind: 'opened' as const, opened }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );
    const raced = await new Promise<
      { readonly kind: 'opened'; readonly opened: OpenedSession }
      | { readonly kind: 'failed'; readonly error: unknown }
      | { readonly kind: 'timeout' }
    >((resolve) => {
      const timer = this.window.setTimeout(() => resolve({ kind: 'timeout' } as const), this.timeoutMs);
      void work.then((result) => {
        this.window.clearTimeout(timer);
        resolve(result);
      });
    });
    if (raced.kind === 'timeout') {
      return {
        kind: 'rejected',
        rejection: { code: 'navigation-timeout', type: 'timeout', detail: `打开会话超过 ${this.timeoutMs} 毫秒` },
      };
    }
    if (raced.kind === 'failed') {
      if (raced.error instanceof NavigationOpenError) {
        return {
          kind: 'rejected',
          rejection: {
            code: raced.error.code,
            type: errorTypeOf(raced.error.code),
            detail: raced.error.message,
          },
        };
      }
      return {
        kind: 'rejected',
        rejection: {
          code: 'navigation-rejected',
          type: 'open-failed',
          detail: '打开会话的实现抛出异常',
        },
      };
    }
    if (raced.opened.sessionId !== sessionId) {
      return {
        kind: 'rejected',
        rejection: {
          code: 'navigation-rejected',
          type: 'session-mismatch',
          detail: '打开实现返回的会话与请求的会话不一致',
        },
      };
    }
    const current = this.currentSession?.() ?? raced.opened.sessionId;
    if (current !== raced.opened.sessionId) {
      return {
        kind: 'rejected',
        rejection: {
          code: 'navigation-rejected',
          type: 'session-mismatch',
          detail: '当前选中的会话与打开结果不一致',
        },
      };
    }
    return { kind: 'opened', opened: raced.opened };
  }

  /**
   * 回一条拒绝并记入拒绝记录。
   *
   * 送达宿主的拒绝由宿主写遥测；这里不再重复写同名事件。
   * @param requestId - 请求标识。
   * @param rejection - 拒绝原因。
   */
  private replyRejected(requestId: string, rejection: NavigationRejection): void {
    const report = rejectedMessage({ requestId, code: rejection.code });
    this.remember(requestId, report);
    this.rejectionLog.push(rejection);
    if (this.rejectionLog.length > REJECTION_LOG_MAX) this.rejectionLog.shift();
    this.reply(report);
  }

  /**
   * 记录一条被丢弃的消息并写失败事件。
   * @param rejection - 丢弃原因。
   */
  private record(rejection: NavigationRejection): void {
    this.rejectionLog.push(rejection);
    if (this.rejectionLog.length > REJECTION_LOG_MAX) this.rejectionLog.shift();
    this.telemetry.navigationFailed({
      deviceId: this.deviceId,
      attempt: 1,
      outcome: 'ignored',
      errorType: rejection.type,
      errorCode: rejection.code,
    });
  }

  /**
   * 记住一条回执，供同一请求标识的重复投递复用。
   * @param requestId - 请求标识。
   * @param report - 回执。
   */
  private remember(requestId: string, report: SelectedReport | RejectedReport): void {
    this.handled.set(requestId, report);
    while (this.handled.size > HANDLED_REQUEST_MAX) {
      const oldest = this.handled.keys().next();
      if (oldest.done === true) return;
      this.handled.delete(oldest.value);
    }
  }

  /**
   * 把回执投递给宿主。
   * @param report - 选中或拒绝回执。
   */
  private reply(report: SelectedReport | RejectedReport): void {
    this.parent.postMessage(report, this.hostOrigin);
  }
}

/**
 * 从原始载荷里取一个可用的请求标识。
 * @param raw - 消息通道投递的原始载荷。
 * @returns 请求标识；不可用时为空。
 */
function requestIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>)['requestId'];
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return undefined;
  return value;
}
