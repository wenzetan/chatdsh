/**
 * 窗口登记与标签式呈现。
 *
 * 同一浏览器里的全部窗口通过广播通道互相登记：每个窗口上报自己的标识、上下文、标题与打开
 * 时刻，收到其他窗口的登记后合并成标签列表。选择、滚动与草稿只留在各自窗口，从不上报，
 * 因此第二窗口改选会话不会改变第一窗口的当前会话。
 *
 * 过期登记按最后见到的时间清理：窗口直接关闭时来不及发 `bye`，标签也不会一直留着。
 * @module @chatdsh/client-multi-window/registry
 */

import type { WindowTarget } from './deep-link.ts';
import { isIdentifier, WINDOW_CHANNEL } from './identifiers.ts';

/** 一个窗口在标签列表里的登记。 */
export interface WindowPresence {
  /** 窗口标识。 */
  readonly windowId: string;
  /** 浏览器侧客户端标识。 */
  readonly clientId: string;
  /** 窗口当前上下文。 */
  readonly target: WindowTarget;
  /** 标签标题，取当前会话标题；创建会话时是固定文案。 */
  readonly title: string;
  /** 打开时刻的毫秒时间戳。 */
  readonly openedAt: number;
}

/** 一个标签。 */
export interface WindowTab {
  /** 窗口标识。 */
  readonly windowId: string;
  /** 标签标题。 */
  readonly title: string;
  /** 标签描述：会话与设备的可读说明。 */
  readonly description: string;
  /** 是否就是当前窗口。 */
  readonly current: boolean;
}

/** 窗口间消息。 */
type WindowMessage =
  | { readonly type: 'hello'; readonly windowId: string }
  | { readonly type: 'presence'; readonly window: WindowPresence }
  | { readonly type: 'bye'; readonly windowId: string }
  | { readonly type: 'focus-request'; readonly from: string; readonly to: string };

/** 断言登记合法并收敛成白名单字段。 */
function normalizePresence(value: unknown): WindowPresence | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const windowId = record['windowId'];
  const clientId = record['clientId'];
  const title = record['title'];
  const openedAt = record['openedAt'];
  const target = record['target'];
  if (!isIdentifier(windowId) || !isIdentifier(clientId)) return undefined;
  if (typeof title !== 'string' || title === '' || title.length > 200) return undefined;
  if (typeof openedAt !== 'number' || !Number.isFinite(openedAt)) return undefined;
  if (typeof target !== 'object' || target === null) return undefined;
  const rawTarget = target as Record<string, unknown>;
  const sessionId = rawTarget['sessionId'];
  const deviceId = rawTarget['deviceId'];
  if (!isIdentifier(sessionId) || !isIdentifier(deviceId)) return undefined;
  const pane = rawTarget['pane'];
  if (pane === undefined) return { windowId, clientId, title, openedAt, target: { sessionId, deviceId } };
  if (typeof pane !== 'object' || pane === null) return undefined;
  const rawPane = pane as Record<string, unknown>;
  const kind = rawPane['kind'];
  const id = rawPane['id'];
  if (kind !== 'document' && kind !== 'artifact' && kind !== 'trace') return undefined;
  if (!isIdentifier(id)) return undefined;
  return { windowId, clientId, title, openedAt, target: { sessionId, deviceId, pane: { kind, id } } };
}

/** 登记的构造依赖。 */
export interface WindowRegistryOptions {
  /** 本窗口的登记。 */
  readonly self: WindowPresence;
  /** 广播通道；不支持时传 `null`，登记只在本地生效。 */
  readonly channel?: BroadcastChannel | null;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 多久没有见到登记就清理，单位毫秒。 */
  readonly ttlMs?: number;
  /** 同时允许的窗口数量上限。 */
  readonly maxWindows?: number;
}

/** 默认的登记过期时间。 */
export const WINDOW_TTL_MS = 15_000;

/** 默认的窗口数量上限。 */
export const MAX_WINDOWS = 6;

/**
 * 窗口登记表。
 */
export class WindowRegistry {
  private readonly channel: BroadcastChannel | null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxWindows: number;
  private readonly peers = new Map<string, { presence: WindowPresence; seenAt: number }>();
  private readonly changeListeners = new Set<() => void>();
  private readonly focusListeners = new Set<(from: string) => void>();
  private self: WindowPresence;
  private started = false;
  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    this.receive(event.data);
  };

  /**
   * 建立登记表。
   * @param options - 本窗口登记与通道参数。
   */
  constructor(options: WindowRegistryOptions) {
    this.channel = options.channel ?? null;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? WINDOW_TTL_MS;
    this.maxWindows = options.maxWindows ?? MAX_WINDOWS;
    this.self = options.self;
  }

  /** 本窗口的登记。 */
  get presence(): WindowPresence {
    return this.self;
  }

  /** 打开窗口的数量，含自己。 */
  get windowCount(): number {
    return this.peers.size + 1;
  }

  /**
   * 判断还能否再开一个窗口。
   * @returns 未到上限时为真。
   */
  canOpenMore(): boolean {
    return this.windowCount < this.maxWindows;
  }

  /** 开始登记：上报自己并询问已有窗口。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.channel !== null) {
      this.channel.addEventListener('message', this.onMessage);
      this.post({ type: 'hello', windowId: this.self.windowId });
    }
    this.post({ type: 'presence', window: this.self });
    this.emitChange();
  }

  /** 停止登记：通知其他窗口并摘掉监听。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.post({ type: 'bye', windowId: this.self.windowId });
    if (this.channel !== null) this.channel.removeEventListener('message', this.onMessage);
    this.peers.clear();
    this.emitChange();
  }

  /**
   * 更新本窗口的上下文与标题，并通知其他窗口。
   * @param target - 新的上下文。
   * @param title - 新的标题。
   */
  update(target: WindowTarget, title: string): void {
    this.self = { ...this.self, target, title };
    this.post({ type: 'presence', window: this.self });
    this.emitChange();
  }

  /**
   * 取全部窗口的登记，按打开时刻排列。
   * @returns 自己在前，其余按打开时刻升序。
   */
  presences(): WindowPresence[] {
    this.prune();
    const peers = [...this.peers.values()]
      .map((entry) => entry.presence)
      .filter((presence) => presence.windowId !== this.self.windowId)
      .sort((left, right) => left.openedAt - right.openedAt);
    return [this.self, ...peers];
  }

  /**
   * 取标签列表。
   * @returns 自己标记为当前窗口，其余窗口按打开时刻排列。
   */
  tabs(): WindowTab[] {
    return this.presences().map((presence) => ({
      windowId: presence.windowId,
      title: presence.title,
      description: `${presence.target.deviceId} · ${presence.target.sessionId}`,
      current: presence.windowId === this.self.windowId,
    }));
  }

  /**
   * 订阅登记变化。
   * @param listener - 变化回调。
   * @returns 取消订阅的函数。
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * 订阅聚焦请求。
   * @param listener - 收到请求时以发起窗口标识调用。
   * @returns 取消订阅的函数。
   */
  onFocusRequest(listener: (from: string) => void): () => void {
    this.focusListeners.add(listener);
    return () => {
      this.focusListeners.delete(listener);
    };
  }

  /**
   * 请求聚焦另一个窗口。
   * @param windowId - 目标窗口标识。
   * @returns 目标就是自己时为假。
   */
  requestFocus(windowId: string): boolean {
    if (windowId === this.self.windowId) return false;
    this.post({ type: 'focus-request', from: this.self.windowId, to: windowId });
    return true;
  }

  /**
   * 清理超期登记。
   * @returns 清理掉的窗口标识。
   */
  prune(): string[] {
    const now = this.now();
    const removed: string[] = [];
    for (const [windowId, entry] of this.peers) {
      if (now - entry.seenAt <= this.ttlMs) continue;
      this.peers.delete(windowId);
      removed.push(windowId);
    }
    if (removed.length > 0) this.emitChange();
    return removed;
  }

  /**
   * 处理一条窗口间消息。
   * @param raw - 消息内容。
   */
  private receive(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const record = raw as Record<string, unknown>;
    const type = record['type'];
    if (type === 'hello') {
      this.post({ type: 'presence', window: this.self });
      return;
    }
    if (type === 'presence') {
      const presence = normalizePresence(record['window']);
      if (presence === undefined || presence.windowId === this.self.windowId) return;
      this.peers.set(presence.windowId, { presence, seenAt: this.now() });
      this.emitChange();
      return;
    }
    if (type === 'bye') {
      const windowId = record['windowId'];
      if (!isIdentifier(windowId)) return;
      if (this.peers.delete(windowId)) this.emitChange();
      return;
    }
    if (type === 'focus-request') {
      const from = record['from'];
      const to = record['to'];
      if (!isIdentifier(from) || to !== this.self.windowId) return;
      for (const listener of this.focusListeners) listener(from);
    }
  }

  /**
   * 发一条窗口间消息。
   * @param message - 消息内容。
   */
  private post(message: WindowMessage): void {
    if (this.channel === null) return;
    this.channel.postMessage(message);
  }

  /** 通知登记变化的订阅者。 */
  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}

/**
 * 打开本窗口的登记表。
 * @param options - 登记参数；通道缺省按浏览器的广播通道建立。
 * @returns 登记表。
 */
export function openWindowRegistry(options: WindowRegistryOptions): WindowRegistry {
  const channel = 'channel' in options
    ? options.channel ?? null
    : typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(WINDOW_CHANNEL);
  return new WindowRegistry({ ...options, channel });
}
