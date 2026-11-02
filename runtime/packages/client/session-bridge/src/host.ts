/**
 * 宿主侧的导航桥。
 *
 * 宿主任命一个 iframe 承载目标设备的设备内容席位：页面装载后先发 `source` 声明席位要服务的
 * 设备与状态，内容端回 `ready` 之后才开始导航。每次 `select` 发一条 `navigate` 并等待同一个
 * 请求标识的回执；等待超过时限按有限次数重试，全部尝试都没有回执才判定超时。
 *
 * 只接受同时满足三个条件的回执：`origin` 等于内容端的期望来源、消息来源窗口等于承载内容端
 * 的窗口、载荷通过契约校验。任何一条不满足就丢弃并记录，绝不把未确认的请求上报为成功。
 * @module @chatdsh/client-session-bridge/host
 */

import {
  DEFAULT_NAVIGATION_ATTEMPTS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  MAX_NAVIGATION_ATTEMPTS,
  errorTypeOf,
  navigateMessage,
  parseBridgeMessage,
  sourceMessage,
  type BridgeCapability,
  type ContentState,
  type NavigationRejection,
  type NavigationRejectionCode,
  type ReadyReport,
  type RejectedReport,
  type SelectedReport,
} from './contract.ts';
import type { NavigationTelemetry } from './telemetry.ts';

/** 被丢弃消息的保留条数。 */
const REJECTION_LOG_MAX = 16;

/** 一次导航的结果。 */
export type NavigationOutcome =
  | {
    readonly outcome: 'selected';
    readonly deviceId: string;
    readonly sessionId: string;
    /** 会话标题；内容端未给出时缺省。 */
    readonly title?: string;
    /** 实际尝试次数。 */
    readonly attempts: number;
  }
  | {
    readonly outcome: 'rejected';
    readonly code: NavigationRejectionCode;
    /** 实际尝试次数。 */
    readonly attempts: number;
  }
  | {
    readonly outcome: 'timeout';
    readonly code: 'navigation-timeout';
    /** 实际尝试次数。 */
    readonly attempts: number;
  };

/** 握手的结果。 */
export type HandshakeOutcome =
  | { readonly ok: true; readonly ready: ReadyReport }
  | { readonly ok: false; readonly rejection: NavigationRejection };

/** 已收到的一条回执。 */
type ReplyResult =
  | { readonly kind: 'selected'; readonly report: SelectedReport }
  | { readonly kind: 'rejected'; readonly report: RejectedReport }
  | { readonly kind: 'invalid'; readonly rejection: NavigationRejection };

/** 一件在等的回执。 */
interface PendingNavigation {
  readonly requestId: string;
  readonly settle: (result: ReplyResult | undefined) => void;
}

/** 一件在等的就绪上报。 */
interface PendingReady {
  readonly requestId: string;
  readonly settle: (ready: ReadyReport | undefined) => void;
}

/** 导航桥的输入。 */
export interface NavigationHostOptions {
  /** 宿主窗口：消息监听、计时器与默认的内容端来源。 */
  readonly window: Window;
  /** 承载内容端的 iframe。 */
  readonly frame: HTMLIFrameElement;
  /** 本席位所属设备。 */
  readonly deviceId: string;
  /** 遥测面。 */
  readonly telemetry: NavigationTelemetry;
  /** 内容端的期望来源；缺省取宿主窗口的 `origin`。 */
  readonly contentOrigin?: string;
  /** 宿主认定的设备状态，随席位声明下发给内容端。 */
  readonly state?: ContentState;
  /** 一次回执的等待时限，单位毫秒。 */
  readonly timeoutMs?: number;
  /** 一次导航的尝试次数，含首次尝试，上限 {@link MAX_NAVIGATION_ATTEMPTS}。 */
  readonly attempts?: number;
  /** 当前时刻的毫秒时间戳；缺省用 `Date.now`。 */
  readonly now?: () => number;
  /** 请求标识生成器；缺省用 `crypto.randomUUID`。 */
  readonly createRequestId?: () => string;
}

/**
 * 宿主侧的导航桥。
 *
 * 构造即开始监听消息；页面装载事件由 iframe 的 `load` 事件与 `data-loaded` 属性共同判定，
 * 与外壳记录装载状态的方式一致。
 */
export class NavigationHost {
  private readonly window: Window;
  private readonly frame: HTMLIFrameElement;
  private readonly deviceId: string;
  private readonly telemetry: NavigationTelemetry;
  private readonly contentOrigin: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly now: () => number;
  private readonly createRequestId: () => string;
  private readonly onMessage: (event: MessageEvent) => void;
  private readonly onLoad: () => void;
  private readonly rejectionLog: NavigationRejection[] = [];
  private pendingNavigation: PendingNavigation | undefined;
  private pendingReady: PendingReady | undefined;
  private loadWaiters: ((value: boolean) => void)[] = [];
  private latestReady: ReadyReport | undefined;
  private latestSelection: SelectedReport | undefined;
  private requestedState: ContentState;
  private loaded = false;
  private started = false;
  private disposed = false;

  /**
   * @param options - 宿主窗口、iframe、设备与遥测面。
   */
  constructor(options: NavigationHostOptions) {
    this.window = options.window;
    this.frame = options.frame;
    this.deviceId = options.deviceId;
    this.telemetry = options.telemetry;
    this.contentOrigin = options.contentOrigin ?? options.window.location.origin;
    this.requestedState = options.state ?? 'writable';
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS));
    this.attempts = Math.min(
      MAX_NAVIGATION_ATTEMPTS,
      Math.max(1, Math.trunc(options.attempts ?? DEFAULT_NAVIGATION_ATTEMPTS)),
    );
    this.now = options.now ?? (() => Date.now());
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.onMessage = (event) => this.handleMessage(event);
    this.onLoad = () => this.markLoaded();
    this.start();
  }

  /** 内容端是否已经上报就绪。 */
  get ready(): boolean {
    return this.latestReady !== undefined;
  }

  /** 内容端上报的数据状态；未就绪时缺省。 */
  get contentState(): ContentState | undefined {
    return this.latestReady?.state;
  }

  /** 内容端声明的能力；未就绪时为空。 */
  get capabilities(): readonly BridgeCapability[] {
    return this.latestReady?.capabilities ?? [];
  }

  /** 内容端当前选中的会话；未就绪时缺省。 */
  get selectedSessionId(): string | undefined {
    return this.latestSelection?.sessionId ?? this.latestReady?.sessionId;
  }

  /**
   * 取最近被丢弃的消息记录，最新的在后。
   * @returns 记录的副本。
   */
  rejections(): readonly NavigationRejection[] {
    return [...this.rejectionLog];
  }

  /** 开始监听消息与页面装载事件；重复调用无副作用。 */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.window.addEventListener('message', this.onMessage);
    this.frame.addEventListener('load', this.onLoad);
    if (this.frame.dataset['loaded'] === 'true') this.loaded = true;
  }

  /**
   * 声明席位并等待内容端就绪。
   *
   * 每次尝试先发 `source`，再等 `ready`；两次尝试都没有就绪上报就判定超时。内容端上报的
   * 设备与本席位不一致、或上报的状态能力不合法时直接失败，不再重试。
   * @returns 就绪上报或拒绝结果。
   */
  async handshake(): Promise<HandshakeOutcome> {
    this.start();
    let lastRejection: NavigationRejection = {
      code: 'navigation-timeout',
      type: 'timeout',
      detail: '内容端页面未装载，席位声明无法投递',
    };
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      if (this.disposed) break;
      const loaded = await this.waitForLoaded();
      const frameWindow = this.frame.contentWindow;
      if (!loaded || frameWindow === null) {
        lastRejection = {
          code: 'navigation-timeout',
          type: 'timeout',
          detail: '内容端页面未装载，席位声明无法投递',
        };
        continue;
      }
      const ready = await this.requestReady(frameWindow);
      if (ready === undefined) {
        lastRejection = {
          code: 'navigation-timeout',
          type: 'timeout',
          detail: `等待就绪上报超过 ${this.timeoutMs} 毫秒`,
        };
        continue;
      }
      if (ready.deviceId !== this.deviceId) {
        lastRejection = {
          code: 'device-mismatch',
          type: 'device-mismatch',
          detail: `内容端属于设备 ${ready.deviceId}，本席位为 ${this.deviceId}`,
        };
        this.telemetry.navigationFailed({
          deviceId: this.deviceId,
          attempt,
          outcome: 'rejected',
          errorType: lastRejection.type,
          errorCode: lastRejection.code,
        });
        return { ok: false, rejection: lastRejection };
      }
      this.latestReady = ready;
      return { ok: true, ready };
    }
    return { ok: false, rejection: lastRejection };
  }

  /**
   * 请求内容端打开指定会话。
   *
   * 回执必须带同一个请求标识、来自承载内容端的窗口与期望来源，并且回报的设备与会话都与请求
   * 一致；否则按拒绝处理。等待超时按 {@link NavigationHostOptions.attempts} 重试，全部尝试
   * 都没有回执才返回超时。导航不写入任何会话，重复请求只由内容端去重。
   * @param sessionId - 目标会话。
   * @returns 导航结果。
   */
  async select(sessionId: string): Promise<NavigationOutcome> {
    this.start();
    const startedAt = this.now();
    this.abortNavigation({
      code: 'navigation-timeout',
      type: 'superseded',
      detail: '被同一窗口的后一次导航请求取代',
    });
    let attemptsUsed = 0;
    let lastRejection: NavigationRejection = {
      code: 'navigation-timeout',
      type: 'timeout',
      detail: '内容端页面未装载，导航消息无法投递',
    };
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      attemptsUsed = attempt;
      if (this.disposed) {
        lastRejection = { code: 'navigation-timeout', type: 'timeout', detail: '导航桥已经销毁' };
        break;
      }
      const loaded = await this.waitForLoaded();
      const frameWindow = this.frame.contentWindow;
      if (!loaded || frameWindow === null) {
        lastRejection = {
          code: 'navigation-timeout',
          type: 'timeout',
          detail: '内容端页面未装载，导航消息无法投递',
        };
        continue;
      }
      const requestId = this.createRequestId();
      // 内容端要求先收到席位声明才接受导航。同一对窗口之间消息按发送顺序投递，先发声明再发
      // 导航就能保证顺序；每次导航重发一次，顺带把最新的设备状态带给内容端。
      this.postDeclaration(frameWindow, this.createRequestId());
      const result = await this.requestReply(requestId, sessionId, frameWindow);
      if (result === undefined) {
        lastRejection = {
          code: 'navigation-timeout',
          type: 'timeout',
          detail: `等待回执超过 ${this.timeoutMs} 毫秒`,
        };
        continue;
      }
      if (result.kind === 'invalid') {
        // 被后一次导航取代或被销毁，按超时结束，不再重试。
        if (result.rejection.type === 'superseded' || result.rejection.type === 'cancelled') {
          return this.finishTimeout(startedAt, sessionId, attemptsUsed, result.rejection);
        }
        return this.finishFailure(startedAt, sessionId, attemptsUsed, result.rejection);
      }
      if (result.kind === 'rejected') {
        return this.finishFailure(startedAt, sessionId, attemptsUsed, {
          code: result.report.code,
          type: errorTypeOf(result.report.code),
          detail: '内容端拒绝打开指定会话',
        });
      }
      if (result.report.deviceId !== this.deviceId) {
        return this.finishFailure(startedAt, sessionId, attemptsUsed, {
          code: 'device-mismatch',
          type: 'device-mismatch',
          detail: `回执属于设备 ${result.report.deviceId}，本席位为 ${this.deviceId}`,
        });
      }
      if (result.report.sessionId !== sessionId) {
        return this.finishFailure(startedAt, sessionId, attemptsUsed, {
          code: 'navigation-rejected',
          type: 'session-mismatch',
          detail: '内容端确认的会话与请求的会话不一致',
        });
      }
      this.latestSelection = result.report;
      this.telemetry.navigateSpan({
        deviceId: this.deviceId,
        sessionId,
        attempt: attemptsUsed,
        outcome: 'selected',
        startedAt,
        endedAt: this.now(),
      });
      this.telemetry.navigationCounted('selected');
      return {
        outcome: 'selected',
        deviceId: result.report.deviceId,
        sessionId: result.report.sessionId,
        ...(result.report.title === undefined ? {} : { title: result.report.title }),
        attempts: attemptsUsed,
      };
    }
    return this.finishTimeout(startedAt, sessionId, attemptsUsed, lastRejection);
  }

  /**
   * 把一次超时收尾：写 span、失败事件与计数。
   * @param startedAt - 开始时刻。
   * @param sessionId - 目标会话。
   * @param attempts - 实际尝试次数。
   * @param rejection - 超时原因。
   * @returns 以超时结束的导航结果。
   */
  private finishTimeout(
    startedAt: number,
    sessionId: string,
    attempts: number,
    rejection: NavigationRejection,
  ): NavigationOutcome {
    this.telemetry.navigateSpan({
      deviceId: this.deviceId,
      sessionId,
      attempt: attempts,
      outcome: 'timeout',
      errorType: rejection.type,
      errorCode: rejection.code,
      startedAt,
      endedAt: this.now(),
    });
    this.telemetry.navigationFailed({
      deviceId: this.deviceId,
      attempt: attempts,
      outcome: 'timeout',
      errorType: rejection.type,
      errorCode: rejection.code,
    });
    this.telemetry.navigationCounted('timeout');
    return { outcome: 'timeout', code: 'navigation-timeout', attempts };
  }

  /** 停止监听并作废在等的回执。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.window.removeEventListener('message', this.onMessage);
    this.frame.removeEventListener('load', this.onLoad);
    this.abortNavigation({ code: 'navigation-timeout', type: 'cancelled', detail: '导航桥已经销毁' });
    this.abortReady();
    const waiters = this.loadWaiters;
    this.loadWaiters = [];
    for (const waiter of waiters) waiter(false);
  }

  /**
   * 把一次失败收尾：写 span、失败事件与计数。
   * @param startedAt - 开始时刻。
   * @param sessionId - 目标会话。
   * @param attempts - 实际尝试次数。
   * @param rejection - 失败原因。
   * @returns 以拒绝结束的导航结果。
   */
  private finishFailure(
    startedAt: number,
    sessionId: string,
    attempts: number,
    rejection: NavigationRejection,
  ): NavigationOutcome {
    this.telemetry.navigateSpan({
      deviceId: this.deviceId,
      sessionId,
      attempt: attempts,
      outcome: 'rejected',
      errorType: rejection.type,
      errorCode: rejection.code,
      startedAt,
      endedAt: this.now(),
    });
    this.telemetry.navigationFailed({
      deviceId: this.deviceId,
      attempt: attempts,
      outcome: 'rejected',
      errorType: rejection.type,
      errorCode: rejection.code,
    });
    this.telemetry.navigationCounted('rejected');
    return { outcome: 'rejected', code: rejection.code, attempts };
  }

  /**
   * 处理一条来自窗口的消息。
   * @param event - 消息事件。
   */
  private handleMessage(event: MessageEvent): void {
    if (this.disposed) return;
    const frameWindow = this.frame.contentWindow;
    if (event.origin !== this.contentOrigin) {
      this.record({
        code: 'origin-rejected',
        type: 'origin-mismatch',
        detail: `消息来源 ${event.origin}，期望 ${this.contentOrigin}`,
      });
      return;
    }
    if (frameWindow === null || event.source !== frameWindow) {
      this.record({
        code: 'message-source-mismatch',
        type: 'source-mismatch',
        detail: '消息来源窗口不是承载内容端的窗口',
      });
      return;
    }
    const parsed = parseBridgeMessage(event.data);
    if (!parsed.ok) {
      this.record(parsed.rejection);
      return;
    }
    const message = parsed.message;
    if ('action' in message) {
      this.record({
        code: 'message-schema-invalid',
        type: 'schema-invalid',
        detail: `宿主收到了发往内容端的 ${message.action} 消息`,
      });
      return;
    }
    if (message.outcome === 'ready') {
      if (message.deviceId === this.deviceId) this.latestReady = message;
      const pending = this.pendingReady;
      if (pending === undefined) return;
      // 只有带回本次声明标识的就绪上报才算握手成功；更早的自主上报只更新已知状态。
      if (message.requestId !== pending.requestId) return;
      this.pendingReady = undefined;
      pending.settle(message);
      return;
    }
    const pending = this.pendingNavigation;
    if (pending === undefined) {
      if (message.outcome === 'rejected') {
        this.record({
          code: message.code,
          type: errorTypeOf(message.code),
          detail: '收到没有对应导航请求的拒绝回执',
        });
      } else {
        this.record({
          code: 'navigation-rejected',
          type: 'superseded',
          detail: '收到没有对应导航请求的选中回执',
        });
      }
      return;
    }
    if (message.requestId !== pending.requestId) {
      this.record({
        code: 'message-schema-invalid',
        type: 'schema-invalid',
        detail: '回执的请求标识与在等的请求不一致',
      });
      return;
    }
    this.pendingNavigation = undefined;
    if (message.outcome === 'selected') {
      pending.settle({ kind: 'selected', report: message });
      return;
    }
    pending.settle({ kind: 'rejected', report: message });
  }

  /**
   * 记录一条被丢弃的消息，并写失败事件。
   * @param rejection - 丢弃原因。
   */
  private record(rejection: NavigationRejection): void {
    this.rejectionLog.push(rejection);
    if (this.rejectionLog.length > REJECTION_LOG_MAX) this.rejectionLog.shift();
    this.telemetry.navigationFailed({
      deviceId: this.deviceId,
      attempt: 0,
      outcome: 'ignored',
      errorType: rejection.type,
      errorCode: rejection.code,
    });
  }

  /**
   * 发席位声明并等待就绪上报。
   * @param target - 承载内容端的窗口。
   * @returns 就绪上报；超时为空。
   */
  private async requestReady(target: Window): Promise<ReadyReport | undefined> {
    const requestId = this.createRequestId();
    return await new Promise<ReadyReport | undefined>((resolve) => {
      const timer = this.window.setTimeout(() => {
        if (this.pendingReady?.requestId !== requestId) return;
        this.pendingReady = undefined;
        resolve(undefined);
      }, this.timeoutMs);
      this.abortReady();
      this.pendingReady = {
        requestId,
        settle: (ready) => {
          this.window.clearTimeout(timer);
          resolve(ready);
        },
      };
      this.postDeclaration(target, requestId);
    });
  }

  /**
   * 向内容端投递席位声明。
   * @param target - 承载内容端的窗口。
   * @param requestId - 声明标识；内容端在就绪上报里带回。
   */
  private postDeclaration(target: Window, requestId: string): void {
    target.postMessage(
      sourceMessage({
        requestId,
        deviceId: this.deviceId,
        state: this.requestedState,
        capabilities: ['open-session', 'report-selection', 'readonly-mode', 'offline-mode'],
      }),
      this.contentOrigin,
    );
  }

  /**
   * 发导航请求并等待回执。
   * @param requestId - 本次请求标识。
   * @param sessionId - 目标会话。
   * @param target - 承载内容端的窗口。
   * @returns 回执；超时为空。
   */
  private async requestReply(requestId: string, sessionId: string, target: Window): Promise<ReplyResult | undefined> {
    return await new Promise<ReplyResult | undefined>((resolve) => {
      const timer = this.window.setTimeout(() => {
        if (this.pendingNavigation?.requestId !== requestId) return;
        this.pendingNavigation = undefined;
        resolve(undefined);
      }, this.timeoutMs);
      this.pendingNavigation = {
        requestId,
        settle: (result) => {
          this.window.clearTimeout(timer);
          resolve(result);
        },
      };
      target.postMessage(navigateMessage({ requestId, deviceId: this.deviceId, sessionId }), this.contentOrigin);
    });
  }

  /**
   * 作废在等的导航回执。
   * @param rejection - 作废原因。
   */
  private abortNavigation(rejection: NavigationRejection): void {
    const pending = this.pendingNavigation;
    if (pending === undefined) return;
    this.pendingNavigation = undefined;
    pending.settle({ kind: 'invalid', rejection });
  }

  /** 作废在等的就绪上报。 */
  private abortReady(): void {
    const pending = this.pendingReady;
    if (pending === undefined) return;
    this.pendingReady = undefined;
    pending.settle(undefined);
  }

  /** 页面已经装载。 */
  private markLoaded(): void {
    this.loaded = true;
    const waiters = this.loadWaiters;
    this.loadWaiters = [];
    for (const waiter of waiters) waiter(true);
  }

  /**
   * 等内容端页面装载完成。
   * @returns 页面已装载时为真。
   */
  private async waitForLoaded(): Promise<boolean> {
    if (this.loaded || this.frame.dataset['loaded'] === 'true') return true;
    return await new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        this.window.clearTimeout(timer);
        this.loadWaiters = this.loadWaiters.filter((item) => item !== waiter);
        resolve(value);
      };
      const waiter = (value: boolean): void => finish(value);
      this.loadWaiters.push(waiter);
      const timer = this.window.setTimeout(() => finish(false), this.timeoutMs);
    });
  }
}
