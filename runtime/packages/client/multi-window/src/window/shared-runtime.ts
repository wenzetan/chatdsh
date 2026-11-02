/**
 * 共用运行时：同一浏览器里的全部窗口共用一条运行时订阅。
 *
 * 窗口通过广播通道与 Web Locks 选出唯一的持连窗口：持连窗口建立一条真实订阅，收到的帧按
 * 序号转发给其他窗口；其他窗口只转发不建立连接。持连窗口关闭或被系统回收后，等待中的窗口
 * 按同一把锁顺序接管，仍然只保持一条订阅。窗口数量增加因此不增加运行时连接数与订阅数。
 *
 * 选举优先使用 Web Locks：锁在任何时刻只能被一个窗口持有，接管顺序由浏览器排队保证。环境
 * 没有 Web Locks 时退回到广播通道上的声明与应答，两个窗口同时声明时按标识排序，结果仍然
 * 只有一个持连窗口。
 * @module @chatdsh/client-multi-window/shared-runtime
 */

/** 窗口在共用运行时里的角色。 */
export type SharedRuntimeRole = 'idle' | 'leader' | 'follower';

/** 订阅状态。 */
export type SharedRuntimeState = 'connecting' | 'open' | 'interrupted' | 'closed';

/** 一条真实订阅的关闭入口。 */
export interface RuntimeConnection {
  /** 关闭订阅。 */
  close(): void;
}

/** 订阅建立时交给传输层的回调。 */
export interface RuntimeTransportHandlers {
  /** 收到一帧。 */
  onFrame(frame: unknown): void;
  /** 状态变化。 */
  onStatus(status: SharedRuntimeState, detail?: string): void;
}

/** 真实订阅的建立方式，由接入方提供。 */
export interface RuntimeTransport {
  /**
   * 建立一条订阅。
   * @param handlers - 帧与状态回调。
   * @returns 关闭入口。
   */
  open(handlers: RuntimeTransportHandlers): RuntimeConnection;
}

/** 共用运行时的构造参数。 */
export interface SharedRuntimeOptions {
  /** 真实订阅的建立方式。 */
  readonly transport: RuntimeTransport;
  /** 广播通道；`null` 表示只支持单窗口。 */
  readonly channel?: BroadcastChannel | null;
  /** Web Locks 面；不提供时走广播通道选举。 */
  readonly locks?: LockManager | null;
  /** 锁名。 */
  readonly lockName?: string;
  /** 广播通道名。 */
  readonly channelName?: string;
  /** 广播通道选举的等待上限，单位毫秒。 */
  readonly electionMs?: number;
}

/** 共用运行时的诊断快照。 */
export interface SharedRuntimeStats {
  /** 本窗口的角色。 */
  readonly role: SharedRuntimeRole;
  /** 本窗口看到的订阅状态。 */
  readonly state: SharedRuntimeState;
  /** 本窗口建立的连接数；跟随窗口恒为零。 */
  readonly connections: number;
  /** 本窗口注册的订阅者数量。 */
  readonly subscribers: number;
  /** 已经分发的最大帧序号。 */
  readonly lastSeq: number;
  /** 锁选举失败时的原因；没有失败时缺省。 */
  readonly electionFailure?: string;
}

/** 窗口间消息。 */
type RuntimeMessage =
  | { readonly type: 'leader?'; readonly from: string }
  | { readonly type: 'leader!'; readonly from: string }
  | { readonly type: 'leader-bye'; readonly from: string }
  | { readonly type: 'frame'; readonly from: string; readonly seq: number; readonly payload: unknown }
  | { readonly type: 'status'; readonly from: string; readonly status: SharedRuntimeState; readonly detail?: string };

/** 消息的发送窗口标识由调用方填入，这里只保留白名单字段。 */
function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record['type']) {
    case 'leader?':
    case 'leader!':
    case 'leader-bye':
      return typeof record['from'] === 'string';
    case 'frame':
      return typeof record['from'] === 'string'
        && typeof record['seq'] === 'number'
        && Number.isInteger(record['seq'])
        && record['seq'] > 0;
    case 'status':
      return typeof record['from'] === 'string'
        && (record['status'] === 'connecting'
          || record['status'] === 'open'
          || record['status'] === 'interrupted'
          || record['status'] === 'closed');
    default:
      return false;
  }
}

/**
 * 共用运行时。
 */
export class SharedRuntime {
  private readonly options: SharedRuntimeOptions;
  private readonly channel: BroadcastChannel | null;
  private readonly locks: LockManager | null;
  private readonly lockName: string;
  private readonly electionMs: number;
  private readonly subscribers = new Set<(frame: unknown) => void>();
  private readonly statusListeners = new Set<(state: SharedRuntimeState, detail?: string) => void>();
  private readonly self: string;
  private roleValue: SharedRuntimeRole = 'idle';
  private stateValue: SharedRuntimeState = 'closed';
  private connection: RuntimeConnection | undefined;
  private connections = 0;
  private lastSeq = 0;
  private started = false;
  private electionFailure: string | undefined;
  private electionTimer: ReturnType<typeof setTimeout> | undefined;
  private leaderKnown = false;
  private deferred = false;
  private releaseLeadership: (() => void) | undefined;

  /**
   * 建立共用运行时。
   * @param self - 本窗口标识。
   * @param options - 传输层、通道与选举参数。
   */
  constructor(self: string, options: SharedRuntimeOptions) {
    this.self = self;
    this.options = options;
    this.channel = options.channel ?? null;
    this.locks = options.locks ?? null;
    this.lockName = options.lockName ?? 'chatdsh-multi-window.runtime.v1';
    this.electionMs = options.electionMs ?? 120;
  }

  /** 本窗口的角色。 */
  get role(): SharedRuntimeRole {
    return this.roleValue;
  }

  /** 本窗口看到的订阅状态。 */
  get state(): SharedRuntimeState {
    return this.stateValue;
  }

  /** 本窗口建立的连接数。 */
  get connectionCount(): number {
    return this.connections;
  }

  /**
   * 订阅帧。
   * @param listener - 收到一帧时调用。
   * @returns 取消订阅的函数。
   */
  subscribe(listener: (frame: unknown) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * 订阅状态变化。
   * @param listener - 状态回调。
   * @returns 取消订阅的函数。
   */
  onStatus(listener: (state: SharedRuntimeState, detail?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** 诊断快照。 */
  stats(): SharedRuntimeStats {
    return {
      role: this.roleValue,
      state: this.stateValue,
      connections: this.connections,
      subscribers: this.subscribers.size,
      lastSeq: this.lastSeq,
      ...(this.electionFailure === undefined ? {} : { electionFailure: this.electionFailure }),
    };
  }

  /** 开始参与选举。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.electionFailure = undefined;
    if (this.channel !== null) this.channel.addEventListener('message', this.onMessage);
    this.setStatus('connecting');
    if (this.locks !== null) {
      void this.electWithLocks();
      return;
    }
    this.electWithChannel();
  }

  /** 停止参与：关闭连接、退出选举。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.electionTimer !== undefined) {
      clearTimeout(this.electionTimer);
      this.electionTimer = undefined;
    }
    if (this.channel !== null) {
      this.channel.removeEventListener('message', this.onMessage);
      this.post({ type: 'leader-bye', from: this.self });
    }
    this.closeConnection();
    this.roleValue = 'idle';
    this.setStatus('closed');
    const release = this.releaseLeadership;
    this.releaseLeadership = undefined;
    release?.();
  }

  /**
   * 用 Web Locks 选举：先尝试立即持有，未持有时排队等待接管。
   */
  private async electWithLocks(): Promise<void> {
    const locks = this.locks;
    if (locks === null) return;
    let immediate = false;
    try {
      immediate = await locks.request(this.lockName, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (lock === null) return false;
        if (!this.started) return false;
        this.roleValue = 'leader';
        this.post({ type: 'leader!', from: this.self });
        await this.holdLeadership();
        return true;
      });
    } catch (error) {
      this.electionFailure = `ifAvailable:${String(error)}`;
      return;
    }
    if (immediate || !this.started) return;
    this.becomeFollower();
    try {
      await locks.request(this.lockName, { mode: 'exclusive' }, async () => {
        if (!this.started) return;
        this.roleValue = 'leader';
        this.post({ type: 'leader!', from: this.self });
        await this.holdLeadership();
      });
    } catch (error) {
      this.electionFailure = `queued:${String(error)}`;
    }
  }

  /**
   * 持连窗口保持住锁，并在关闭时释放。
   * @returns 停止时兑现的等待对象。
   */
  private holdLeadership(): Promise<void> {
    this.openConnection();
    return new Promise((resolve) => {
      this.releaseLeadership = resolve;
    });
  }

  /** 广播通道选举：声明、等待应答、无人应答即持连。 */
  private electWithChannel(): void {
    this.leaderKnown = false;
    this.deferred = false;
    this.post({ type: 'leader?', from: this.self });
    this.electionTimer = setTimeout(() => this.resolveElection(), this.electionMs);
  }

  /**
   * 定夺通道选举：已有持连窗口就跟随，标识较小的候选优先，其余等一个窗口期后持连。
   */
  private resolveElection(): void {
    this.electionTimer = undefined;
    if (!this.started) return;
    if (this.deferred) {
      this.roleValue = 'follower';
      this.closeConnection();
      this.post({ type: 'leader?', from: this.self });
      this.electionTimer = setTimeout(() => {
        this.electionTimer = undefined;
        if (!this.started || this.leaderKnown) return;
        this.roleValue = 'leader';
        this.post({ type: 'leader!', from: this.self });
        this.openConnection();
      }, this.electionMs * 2);
      return;
    }
    if (this.leaderKnown) {
      this.becomeFollower();
      return;
    }
    this.roleValue = 'leader';
    this.post({ type: 'leader!', from: this.self });
    this.openConnection();
  }

  /** 成为跟随窗口。 */
  private becomeFollower(): void {
    this.roleValue = 'follower';
    this.closeConnection();
    this.setStatus('connecting');
  }

  /** 建立真实订阅。 */
  private openConnection(): void {
    if (this.connection !== undefined) return;
    this.connections += 1;
    this.setStatus('connecting');
    this.connection = this.options.transport.open({
      onFrame: (frame) => {
        this.deliverLocal(frame);
        this.broadcastFrame(frame);
      },
      onStatus: (status, detail) => {
        this.setStatus(status, detail);
        this.post({ type: 'status', from: this.self, status, ...(detail === undefined ? {} : { detail }) });
      },
    });
  }

  /** 关闭真实订阅。 */
  private closeConnection(): void {
    if (this.connection === undefined) return;
    this.connection.close();
    this.connection = undefined;
  }

  /**
   * 把一帧交给本窗口的订阅者。
   * @param frame - 帧内容。
   * @param seq - 帧序号；转发来的帧带序号，本窗口直接收到时缺省。
   * @returns 分发成功时为真。
   */
  private deliverLocal(frame: unknown, seq?: number): boolean {
    if (seq !== undefined) {
      if (seq <= this.lastSeq) return false;
      this.lastSeq = seq;
    } else {
      this.lastSeq += 1;
    }
    for (const listener of this.subscribers) listener(frame);
    return true;
  }

  /**
   * 把一帧转发给其他窗口。
   * @param frame - 帧内容。
   */
  private broadcastFrame(frame: unknown): void {
    this.post({ type: 'frame', from: this.self, seq: this.lastSeq, payload: frame });
  }

  /**
   * 设置状态并通知订阅者。
   * @param status - 新状态。
   * @param detail - 补充说明。
   */
  private setStatus(status: SharedRuntimeState, detail?: string): void {
    this.stateValue = status;
    for (const listener of this.statusListeners) listener(status, detail);
  }

  /**
   * 处理一条窗口间消息。
   * @param event - 广播事件。
   */
  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isRuntimeMessage(message)) return;
    if (message.from === this.self) return;
    switch (message.type) {
      case 'leader?':
        if (this.roleValue === 'leader') {
          this.post({ type: 'leader!', from: this.self });
          return;
        }
        if (this.started && !this.leaderKnown && message.from < this.self) this.deferred = true;
        return;
      case 'leader!':
        this.leaderKnown = true;
        if (this.electionTimer !== undefined) {
          clearTimeout(this.electionTimer);
          this.electionTimer = undefined;
        }
        if (this.roleValue !== 'leader') this.becomeFollower();
        return;
      case 'leader-bye':
        if (this.roleValue === 'leader') return;
        if (this.locks !== null) {
          // 持锁窗口退出后由浏览器的锁队列接管，这里只更新角色显示。
          this.becomeFollower();
          return;
        }
        this.roleValue = 'follower';
        this.closeConnection();
        this.electWithChannel();
        return;
      case 'frame':
        if (this.roleValue === 'leader') return;
        this.deliverLocal(message.payload, message.seq);
        return;
      case 'status':
        if (this.roleValue === 'leader') return;
        this.setStatus(message.status, message.detail);
        return;
    }
  };

  /**
   * 广播一条消息。
   * @param message - 消息内容。
   */
  private post(message: RuntimeMessage): void {
    if (this.channel === null) return;
    this.channel.postMessage(message);
  }
}

/**
 * 打开共用运行时。
 * @param self - 本窗口标识。
 * @param options - 传输层、通道与选举参数；通道与锁缺省取浏览器的实现。
 * @returns 共用运行时。
 */
export function openSharedRuntime(self: string, options: SharedRuntimeOptions): SharedRuntime {
  const channel = 'channel' in options
    ? options.channel ?? null
    : typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(options.channelName ?? 'chatdsh-multi-window.runtime.v1');
  const locks = 'locks' in options
    ? options.locks ?? null
    : typeof navigator === 'undefined' ? null : (navigator.locks ?? null);
  return new SharedRuntime(self, { ...options, channel, locks });
}
