/**
 * 通知中心的状态与动作。
 *
 * 列表、过滤、分页、已读、业务已处理与推送事件都收敛在这里，界面只渲染状态并转发动作。
 * 已读按访问客户端标识上报，宿主把同一通知的已读状态同步给全部客户端；标记业务已处理
 * 写另一列，与审批决定互不影响。打开一条通知只给出业务目标，界面拿到目标之后再跳转，
 * 打开动作本身不写任何状态。
 * @module @chatdsh/client-notifications/center
 */

import type { NotificationGateway } from './gateway.ts';
import type {
  HandledResult,
  NotificationFilter,
  NotificationPage,
  NotificationQuery,
  NotificationView,
  OpenResult,
  PushEvent,
  ReadResult,
} from './types.ts';

/** 通知中心的当前状态。 */
export interface CenterState {
  /** 过滤条件。 */
  readonly filter: NotificationFilter;
  /** 设备过滤；空串表示全部设备。 */
  readonly deviceId: string;
  /** 会话过滤；空串表示全部会话。 */
  readonly sessionId: string;
  /** 起始日期，`YYYY-MM-DD`；空串表示不限。 */
  readonly since: string;
  /** 结束日期，`YYYY-MM-DD`；空串表示不限。 */
  readonly until: string;
  /** 当前页与已加载的后续页。 */
  readonly items: readonly NotificationView[];
  /** 下一页游标。 */
  readonly nextCursor?: string;
  /** 当前设备与会话范围里的未读条数。 */
  readonly unread: number;
  /** 当前设备与会话范围里的已处理条数。 */
  readonly handled: number;
  /** 加载状态。 */
  readonly status: 'loading' | 'ready' | 'failed';
  /** 读取失败的说明。 */
  readonly failure?: string;
  /** 是否有写入在进行。 */
  readonly busy: boolean;
  /** 是否正在加载后续页。 */
  readonly loadingMore: boolean;
  /** 最近一次动作的说明。 */
  readonly notice?: string;
}

/** 中心的构造依赖。 */
export interface NotificationCenterOptions {
  /** 数据入口。 */
  readonly gateway: NotificationGateway;
  /** 每页条数；缺省二十条。 */
  readonly limit?: number;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 撤回事件的处理者；界面用它按 tag 关闭已展示的系统通知。 */
  readonly onWithdraw?: (event: Extract<PushEvent, { kind: 'notification-withdraw' }>) => void;
}

/** 一次列表请求的结果。 */
interface PageResult {
  readonly page: NotificationPage;
  readonly reset: boolean;
}

/** 把一天的开始时刻换算成毫秒时间戳。 */
function dayStart(value: string): number | undefined {
  if (value === '') return undefined;
  const parsed = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** 把一天的结束时刻换算成毫秒时间戳。 */
function dayEnd(value: string): number | undefined {
  const start = dayStart(value);
  return start === undefined ? undefined : start + 24 * 3600 * 1000 - 1;
}

/** 通知中心的状态机。 */
export class NotificationCenter {
  private readonly gateway: NotificationGateway;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly onWithdraw: ((event: Extract<PushEvent, { kind: 'notification-withdraw' }>) => void) | undefined;
  private readonly listeners = new Set<(state: CenterState) => void>();
  private state: CenterState = {
    filter: 'all',
    deviceId: '',
    sessionId: '',
    since: '',
    until: '',
    items: [],
    unread: 0,
    handled: 0,
    status: 'loading',
    busy: false,
    loadingMore: false,
  };
  private generation = 0;
  private silent: Promise<void> | undefined;

  constructor(options: NotificationCenterOptions) {
    this.gateway = options.gateway;
    this.limit = options.limit ?? 20;
    this.now = options.now ?? (() => Date.now());
    this.onWithdraw = options.onWithdraw;
  }

  /**
   * 读当前状态。
   * @returns 状态快照。
   */
  snapshot(): CenterState {
    return this.state;
  }

  /**
   * 订阅状态变化。
   * @param listener - 状态变化后的回调。
   * @returns 取消订阅的函数。
   */
  subscribe(listener: (state: CenterState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 改过滤条件并重新读取。 */
  setFilter(filter: NotificationFilter): void {
    this.patch({ filter });
    void this.reload();
  }

  /** 改设备过滤并重新读取。 */
  setDeviceFilter(deviceId: string): void {
    this.patch({ deviceId: deviceId.trim() });
    void this.reload();
  }

  /** 改会话过滤并重新读取。 */
  setSessionFilter(sessionId: string): void {
    this.patch({ sessionId: sessionId.trim() });
    void this.reload();
  }

  /**
   * 改时间范围。
   * @param since - 起始日期，`YYYY-MM-DD` 或空串。
   * @param until - 结束日期，`YYYY-MM-DD` 或空串。
   * @returns 范围成立时为真；起始晚于结束时写说明并返回假。
   */
  setTimeRange(since: string, until: string): boolean {
    const from = dayStart(since);
    const to = dayEnd(until);
    if (from !== undefined && to !== undefined && from > to) {
      this.patch({ since, until, notice: '起始日期晚于结束日期，请调整时间范围。' });
      return false;
    }
    this.patch({ since, until });
    void this.reload();
    return true;
  }

  /**
   * 一次性改设备、会话与时间范围，只发起一次读取。
   * @param filters - 设备、会话与日期取值；空串表示不限。
   * @returns 时间范围成立时为真。
   */
  applyFilters(filters: { readonly deviceId: string; readonly sessionId: string; readonly since: string; readonly until: string }): boolean {
    const from = dayStart(filters.since);
    const to = dayEnd(filters.until);
    if (from !== undefined && to !== undefined && from > to) {
      this.patch({
        deviceId: filters.deviceId.trim(),
        sessionId: filters.sessionId.trim(),
        since: filters.since,
        until: filters.until,
        notice: '起始日期晚于结束日期，请调整时间范围。',
      });
      return false;
    }
    this.patch({
      deviceId: filters.deviceId.trim(),
      sessionId: filters.sessionId.trim(),
      since: filters.since,
      until: filters.until,
    });
    void this.reload();
    return true;
  }

  /** 重新读取第一页。 */
  async reload(): Promise<void> {
    const generation = ++this.generation;
    this.patch({ status: 'loading', failure: undefined });
    try {
      const result = await this.fetchPage(undefined);
      if (generation !== this.generation) return;
      this.applyPage(result);
    } catch (error) {
      if (generation !== this.generation) return;
      this.patch({
        status: 'failed',
        failure: `通知中心暂时无法读取，请稍后重新加载（${error instanceof Error ? error.message : String(error)}）。`,
        items: [],
        nextCursor: undefined,
      });
    }
  }

  /** 读取后续页。 */
  async loadMore(): Promise<void> {
    const cursor = this.state.nextCursor;
    if (cursor === undefined || this.state.loadingMore) return;
    this.patch({ loadingMore: true });
    try {
      const result = await this.fetchPage(cursor);
      this.applyPage(result);
    } catch (error) {
      this.patch({ notice: `读取后续页失败：${error instanceof Error ? error.message : String(error)}。` });
    } finally {
      this.patch({ loadingMore: false });
    }
  }

  /**
   * 标记已读。
   * @param ids - 要标记的通知标识。
   * @returns 宿主给出的新标记与未变化条数。
   */
  async markRead(ids: readonly string[]): Promise<ReadResult> {
    if (ids.length === 0) return { marked: 0, unchanged: 0 };
    this.patch({ busy: true });
    try {
      const result = await this.gateway.markRead(ids);
      const at = this.now();
      const changed = new Set(ids);
      const items = this.state.items.map((item) => (
        changed.has(item.id) && item.readAt === undefined ? { ...item, readAt: at } : item
      ));
      const newlyRead = this.state.items.filter((item) => changed.has(item.id) && item.readAt === undefined).length;
      this.patch({
        items,
        unread: Math.max(0, this.state.unread - newlyRead),
        busy: false,
        notice: result.marked > 0
          ? `已标记 ${result.marked} 条为已读。`
          : '这些通知已经处于已读状态，本次没有新的写入。',
      });
      this.scheduleRefresh();
      return result;
    } catch (error) {
      this.patch({ busy: false, notice: `标记已读失败：${error instanceof Error ? error.message : String(error)}。` });
      throw error;
    }
  }

  /**
   * 把当前范围里的未读通知全部标记为已读。
   * @returns 宿主给出的新标记与未变化条数。
   */
  async markAllRead(): Promise<ReadResult> {
    const ids = await this.collectUnreadIds();
    if (ids.length === 0) {
      this.patch({ notice: '当前范围里没有未读通知。' });
      return { marked: 0, unchanged: 0 };
    }
    let marked = 0;
    let unchanged = 0;
    for (let index = 0; index < ids.length; index += 500) {
      const result = await this.markRead(ids.slice(index, index + 500));
      marked += result.marked;
      unchanged += result.unchanged;
    }
    return { marked, unchanged };
  }

  /**
   * 标记业务已处理。
   * @param ids - 要标记的通知标识。
   * @returns 宿主给出的新标记与未变化条数。
   */
  async markHandled(ids: readonly string[]): Promise<HandledResult> {
    if (ids.length === 0) return { marked: 0, unchanged: 0 };
    this.patch({ busy: true });
    try {
      const result = await this.gateway.markHandled(ids);
      const at = this.now();
      const changed = new Set(ids);
      const items = this.state.items.map((item) => (
        changed.has(item.id) && item.handledAt === undefined ? { ...item, handledAt: at } : item
      ));
      this.patch({
        items,
        handled: this.state.handled + result.marked,
        busy: false,
        notice: result.marked > 0
          ? `已把 ${result.marked} 条标记为已处理；审批决定需要在审批页面完成。`
          : '这些通知已经处于已处理状态，本次没有新的写入。',
      });
      this.scheduleRefresh();
      return result;
    } catch (error) {
      this.patch({ busy: false, notice: `标记已处理失败：${error instanceof Error ? error.message : String(error)}。` });
      throw error;
    }
  }

  /**
   * 打开一条通知，给出业务目标。
   * @param id - 通知标识。
   * @returns 跳转目标或说明。
   */
  open(id: string): OpenResult {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (item === undefined) return { kind: 'missing', message: '这条通知已经不在列表里，请刷新后重试。' };
    if (item.sessionId === undefined) {
      return { kind: 'no-session', message: '这条通知没有关联会话，当前无法打开业务页面；业务记录请到对应页面查看。' };
    }
    return {
      kind: 'navigate',
      target: {
        sessionId: item.sessionId,
        ...(item.deviceId === undefined ? {} : { deviceId: item.deviceId }),
        ...(item.objectId === undefined ? {} : { objectId: item.objectId }),
        kind: item.kind,
      },
    };
  }

  /**
   * 应用一条推送事件。
   * @param event - 事件流下发的事件。
   */
  applyEvent(event: PushEvent): void {
    if (event.kind === 'notification') {
      this.applyNotificationEvent(event);
      return;
    }
    if (event.kind === 'notification-read') {
      this.applyReadEvent(event);
      return;
    }
    if (event.kind === 'notification-handled') {
      this.applyHandledEvent(event);
      return;
    }
    this.applyWithdrawEvent(event);
  }

  /**
   * 记录当前访问客户端聚焦的会话。
   * @param sessionId - 会话标识；空串表示离开。
   * @returns 宿主确认的结果。
   */
  async reportFocus(sessionId: string): Promise<{ focused: boolean; sessionId: string }> {
    return this.gateway.setFocus(sessionId);
  }

  /** 写一次状态并通知订阅者。 */
  private patch(partial: Partial<CenterState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  /** 组装一次列表查询。 */
  private query(cursor: string | undefined): NotificationQuery {
    const since = dayStart(this.state.since);
    const until = dayEnd(this.state.until);
    return {
      filter: this.state.filter,
      limit: this.limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(this.state.deviceId === '' ? {} : { deviceId: this.state.deviceId }),
      ...(this.state.sessionId === '' ? {} : { sessionId: this.state.sessionId }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    };
  }

  /** 请求一页。 */
  private async fetchPage(cursor: string | undefined): Promise<PageResult> {
    return { page: await this.gateway.list(this.query(cursor)), reset: cursor === undefined };
  }

  /** 把一页写进状态。 */
  private applyPage(result: PageResult): void {
    const items = result.reset
      ? [...result.page.items]
      : mergePage(this.state.items, result.page.items);
    this.patch({
      items,
      nextCursor: result.page.nextCursor,
      unread: result.page.unread,
      handled: result.page.handled,
      status: 'ready',
      failure: undefined,
    });
  }

  /** 在后台重新读取，保持当前可见内容。 */
  private scheduleRefresh(): void {
    if (this.silent !== undefined) return;
    this.silent = (async () => {
      try {
        const page = await this.gateway.list(this.query(undefined));
        this.patch({ items: page.items, nextCursor: page.nextCursor, unread: page.unread, handled: page.handled });
      } catch {
        // 后台刷新失败时保留已有内容，界面上的写入结果已经可见。
      } finally {
        this.silent = undefined;
      }
    })();
  }

  /** 收集当前范围里的未读标识。 */
  private async collectUnreadIds(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result: NotificationPage = await this.gateway.list({ ...this.query(cursor), filter: 'unread', limit: 100 });
      for (const item of result.items) {
        if (!ids.includes(item.id)) ids.push(item.id);
      }
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return ids;
  }

  /** 判断一条推送里的通知是否落在当前过滤条件里。 */
  private matches(item: { readonly kind: NotificationView['kind']; readonly deviceId?: string; readonly sessionId?: string; readonly createdAt: number; readonly readAt?: number }): boolean {
    const filter = this.state.filter;
    if (filter === 'unread' && item.readAt !== undefined) return false;
    if (filter === 'approval' && item.kind !== 'approval') return false;
    if (filter === 'run-result' && item.kind !== 'run-finished' && item.kind !== 'run-failed') return false;
    if (this.state.deviceId !== '' && item.deviceId !== this.state.deviceId) return false;
    if (this.state.sessionId !== '' && item.sessionId !== this.state.sessionId) return false;
    const since = dayStart(this.state.since);
    const until = dayEnd(this.state.until);
    if (since !== undefined && item.createdAt < since) return false;
    if (until !== undefined && item.createdAt > until) return false;
    return true;
  }

  /** 应用新通知事件。 */
  private applyNotificationEvent(event: Extract<PushEvent, { kind: 'notification' }>): void {
    const items = [...this.state.items];
    let unread = this.state.unread;
    let handled = this.state.handled;
    for (const incoming of event.items) {
      const index = items.findIndex((item) => item.id === incoming.id);
      if (index >= 0) {
        const existing = items[index] as NotificationView;
        items[index] = {
          ...existing,
          ...(incoming.readAt === undefined ? {} : { readAt: incoming.readAt }),
          ...(incoming.handledAt === undefined ? {} : { handledAt: incoming.handledAt }),
        };
        continue;
      }
      if (!this.matches(incoming)) continue;
      const view: NotificationView = {
        ...incoming,
        summary: incoming.summary ?? '',
        readClients: [],
      };
      items.unshift(view);
      if (view.readAt === undefined) unread += 1;
      if (view.handledAt !== undefined) handled += 1;
    }
    this.patch({ items, unread, handled });
    this.scheduleRefresh();
  }

  /** 应用已读事件。 */
  private applyReadEvent(event: Extract<PushEvent, { kind: 'notification-read' }>): void {
    const ids = new Set(event.ids);
    if (this.state.filter === 'unread') {
      const removed = this.state.items.filter((item) => ids.has(item.id) && item.readAt === undefined).length;
      this.patch({
        items: this.state.items.filter((item) => !ids.has(item.id)),
        unread: Math.max(0, this.state.unread - removed),
      });
      this.scheduleRefresh();
      return;
    }
    let newlyRead = 0;
    const items = this.state.items.map((item) => {
      if (!ids.has(item.id) || item.readAt !== undefined) return item;
      newlyRead += 1;
      return {
        ...item,
        readAt: event.readAt,
        readClients: item.readClients.includes(event.clientId) ? item.readClients : [...item.readClients, event.clientId],
      };
    });
    this.patch({ items, unread: Math.max(0, this.state.unread - newlyRead) });
    this.scheduleRefresh();
  }

  /** 应用已处理事件。 */
  private applyHandledEvent(event: Extract<PushEvent, { kind: 'notification-handled' }>): void {
    const ids = new Set(event.ids);
    let newlyHandled = 0;
    const items = this.state.items.map((item) => {
      if (!ids.has(item.id) || item.handledAt !== undefined) return item;
      newlyHandled += 1;
      return { ...item, handledAt: event.handledAt };
    });
    this.patch({ items, handled: this.state.handled + newlyHandled });
    this.scheduleRefresh();
  }

  /** 应用撤回事件。 */
  private applyWithdrawEvent(event: Extract<PushEvent, { kind: 'notification-withdraw' }>): void {
    const ids = new Set(event.ids);
    const removed = this.state.items.filter((item) => ids.has(item.id));
    this.patch({
      items: this.state.items.filter((item) => !ids.has(item.id)),
      unread: Math.max(0, this.state.unread - removed.filter((item) => item.readAt === undefined).length),
      notice: removed.length === 0 ? this.state.notice : '审批已经处理，对应的提醒已撤回。',
    });
    this.onWithdraw?.(event);
    this.scheduleRefresh();
  }
}

/** 把一页并进已加载的列表，重复标识以新页为准。 */
function mergePage(existing: readonly NotificationView[], incoming: readonly NotificationView[]): NotificationView[] {
  const seen = new Set(incoming.map((item) => item.id));
  return [...existing.filter((item) => !seen.has(item.id)), ...incoming];
}
