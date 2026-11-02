/**
 * 左栏：检索、筛选与按设备、工作区分组的历史导航。
 *
 * 左栏呈现三类事实：工作区（按显示名跨设备合并，同名多目录时标注）、条目（设备 + 目录，
 * 显示设备在线状态）与会话（标题、活动时间、未读）。筛选变化交给外层重新读取；本模块只
 * 负责呈现、输入收集与键盘焦点保持。
 * @module @chatdsh/client-shell/list-view
 */

import { ALL_DEVICES, isSessionGrouping, type SessionFilters } from './filters.ts';
import { countText, timeText, unreadText } from './format.ts';
import type { DeviceGroup, SessionEntry, SessionItem, WorkspaceGroup } from './sessions.ts';
import type { DeviceInfo } from './api.ts';

/** 当前选中的会话。 */
export interface Selection {
  readonly deviceId: string;
  readonly sessionId: string;
}

/** 一次渲染所需的全部数据。 */
export interface ListViewInput {
  /** 按工作区分组的结果；分组方式为设备时也为空。 */
  readonly workspaces: readonly WorkspaceGroup[];
  /** 按设备分组的结果；分组方式为工作区时也为空。 */
  readonly deviceGroups: readonly DeviceGroup[];
  /** 当前分组方式。 */
  readonly filters: SessionFilters;
  /** 已知设备，用于设备筛选下拉。 */
  readonly devices: readonly DeviceInfo[];
  /** 当前选中。 */
  readonly selection: Selection | undefined;
  /** 正在读取。 */
  readonly loading: boolean;
  /** 读取失败的原因。 */
  readonly error: string | undefined;
  /** 还有更多分页。 */
  readonly hasMore: boolean;
  /** 已加载的会话条数。 */
  readonly total: number;
  /** 正在进行的检索词（尚未提交）。 */
  readonly pendingQuery: string;
}

/** 左栏向外报告的动作。 */
export interface ListViewHandlers {
  /** 选中一条会话。 */
  onSelect(item: SessionItem): void;
  /** 筛选变化。 */
  onFiltersChange(filters: SessionFilters): void;
  /** 提交检索词。 */
  onQueryCommit(query: string): void;
  /** 加载下一页。 */
  onLoadMore(): void;
  /** 手动刷新。 */
  onRefresh(): void;
  /** 打开创建向导。 */
  onNewSession(): void;
  /** 打开命令面板。 */
  onOpenPalette(): void;
}

/** 检索输入的等待时间，单位毫秒；避免每次按键都读一次列表。 */
const QUERY_DEBOUNCE_MS = 250;

/**
 * 显示名转成可读的分组标题。
 * @param name - 工作区显示名。
 * @returns 标题。
 */
function workspaceTitle(name: string): string {
  return name === '' ? '未命名工作区' : name;
}

/** 左栏视图。 */
export class ShellListView {
  /** 左栏根元素。 */
  readonly element: HTMLElement;

  private readonly handlers: ListViewHandlers;
  private readonly search: HTMLInputElement;
  private readonly grouping: HTMLSelectElement;
  private readonly deviceFilter: HTMLSelectElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly note: HTMLElement;
  private readonly more: HTMLButtonElement;
  private readonly countLabel: HTMLElement;
  private queryTimer: number | undefined;
  private activeKey: string | undefined;

  /**
   * @param handlers - 对外动作。
   */
  constructor(handlers: ListViewHandlers) {
    this.handlers = handlers;
    const list = document.createElement('aside');
    list.className = 'shell-list';
    list.setAttribute('aria-label', '会话与工作区');
    this.element = list;

    const skip = document.createElement('a');
    skip.className = 'shell-skip';
    skip.href = '#shell-main';
    skip.textContent = '跳到主内容';

    const header = document.createElement('header');
    header.className = 'shell-header';
    const heading = document.createElement('h1');
    heading.textContent = 'ChatDSH';
    const actions = document.createElement('div');
    actions.className = 'shell-header-actions';
    const palette = document.createElement('button');
    palette.type = 'button';
    palette.className = 'shell-action shell-palette-trigger';
    palette.setAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    palette.title = '打开命令面板（Ctrl/Cmd+K）';
    palette.textContent = '搜索与命令';
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'shell-action shell-new';
    create.textContent = '新建会话';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'shell-action shell-refresh';
    refresh.textContent = '刷新';
    actions.append(palette, create, refresh);
    header.append(heading, actions);

    const searchForm = document.createElement('form');
    searchForm.className = 'shell-search';
    searchForm.setAttribute('role', 'search');
    const searchLabel = document.createElement('label');
    searchLabel.className = 'shell-visually-hidden';
    searchLabel.htmlFor = 'shell-search-input';
    searchLabel.textContent = '按标题检索会话';
    this.search = document.createElement('input');
    this.search.id = 'shell-search-input';
    this.search.type = 'search';
    this.search.className = 'shell-search-input';
    this.search.placeholder = '按标题检索';
    const searchNote = document.createElement('p');
    searchNote.className = 'shell-search-note';
    searchNote.textContent = '检索范围为会话标题；内容检索由会话界面提供。';
    searchForm.append(searchLabel, this.search, searchNote);

    const filters = document.createElement('div');
    filters.className = 'shell-filters';
    const groupingLabel = document.createElement('label');
    groupingLabel.className = 'shell-filter';
    groupingLabel.append(document.createTextNode('分组'));
    this.grouping = document.createElement('select');
    this.grouping.className = 'shell-grouping';
    for (const [value, text] of [
      ['workspace', '按工作区'],
      ['device', '按设备'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      this.grouping.append(option);
    }
    groupingLabel.append(this.grouping);
    const deviceLabel = document.createElement('label');
    deviceLabel.className = 'shell-filter';
    deviceLabel.append(document.createTextNode('设备'));
    this.deviceFilter = document.createElement('select');
    this.deviceFilter.className = 'shell-device-filter';
    deviceLabel.append(this.deviceFilter);
    filters.append(groupingLabel, deviceLabel);

    this.status = document.createElement('div');
    this.status.className = 'shell-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');

    this.body = document.createElement('div');
    this.body.className = 'shell-devices';

    this.countLabel = document.createElement('p');
    this.countLabel.className = 'shell-count';

    this.note = document.createElement('p');
    this.note.className = 'shell-notice';
    this.note.hidden = true;

    this.more = document.createElement('button');
    this.more.type = 'button';
    this.more.className = 'shell-action shell-more';
    this.more.textContent = '加载更多会话';
    this.more.hidden = true;

    list.append(skip, header, searchForm, filters, this.status, this.countLabel, this.note, this.body, this.more);

    this.search.addEventListener('input', () => {
      if (this.queryTimer !== undefined) window.clearTimeout(this.queryTimer);
      this.queryTimer = window.setTimeout(() => {
        this.queryTimer = undefined;
        this.handlers.onQueryCommit(this.search.value);
      }, QUERY_DEBOUNCE_MS);
    });
    this.search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (this.queryTimer !== undefined) window.clearTimeout(this.queryTimer);
      this.queryTimer = undefined;
      this.handlers.onQueryCommit(this.search.value);
    });
    this.grouping.addEventListener('change', () => {
      const value = this.grouping.value;
      this.handlers.onFiltersChange({
        ...this.readFilters(),
        grouping: isSessionGrouping(value) ? value : 'workspace',
      });
    });
    this.deviceFilter.addEventListener('change', () => {
      this.handlers.onFiltersChange({ ...this.readFilters(), deviceId: this.deviceFilter.value });
    });
    palette.addEventListener('click', () => this.handlers.onOpenPalette());
    create.addEventListener('click', () => this.handlers.onNewSession());
    refresh.addEventListener('click', () => this.handlers.onRefresh());
    this.more.addEventListener('click', () => this.handlers.onLoadMore());
  }

  /**
   * 取当前的筛选值。
   * @returns 筛选。
   */
  private readFilters(): SessionFilters {
    const grouping = isSessionGrouping(this.grouping.value) ? this.grouping.value : 'workspace';
    return { query: this.search.value.trim(), deviceId: this.deviceFilter.value, grouping };
  }

  /**
   * 把焦点移回列表里选中的会话。
   */
  focusSelection(): void {
    const target = this.body.querySelector<HTMLElement>('.session-selected');
    target?.focus();
  }

  /**
   * 写一条状态说明。
   * @param text - 说明。
   */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /**
   * 渲染左栏。
   * @param input - 渲染数据。
   */
  render(input: ListViewInput): void {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['sessionKey'] : undefined;
    this.activeKey = focused ?? this.activeKey;

    if (this.search.value !== input.filters.query && document.activeElement !== this.search) {
      this.search.value = input.filters.query;
    }
    this.search.setAttribute('aria-busy', input.loading ? 'true' : 'false');
    this.grouping.value = input.filters.grouping;
    this.renderDeviceFilter(input);

    this.body.setAttribute('aria-busy', input.loading ? 'true' : 'false');
    const groups = input.filters.grouping === 'device' ? input.deviceGroups : input.workspaces;
    const total = input.total;
    this.countLabel.textContent =
      total === 0 ? '没有会话' : `${String(total)} 条会话${input.hasMore ? '（还有更多）' : ''}`;

    if (input.error !== undefined) {
      this.note.hidden = false;
      this.note.textContent = input.error;
      this.body.replaceChildren();
      this.more.hidden = true;
      return;
    }
    this.note.hidden = true;

    if (groups.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'shell-notice';
      empty.textContent =
        input.filters.query === ''
          ? '还没有会话。新建会话后会出现在这里。'
          : `没有匹配「${input.filters.query}」的会话标题。`;
      this.body.replaceChildren(empty);
      this.more.hidden = true;
      return;
    }

    const children: HTMLElement[] = [];
    if (input.filters.grouping === 'device') {
      for (const group of input.deviceGroups) children.push(this.renderDeviceGroup(group, input.selection));
    } else {
      for (const group of input.workspaces) children.push(this.renderWorkspace(group, input.selection));
    }
    this.body.replaceChildren(...children);
    this.more.hidden = !input.hasMore;
    this.restoreFocus();
  }

  /**
   * 渲染设备筛选下拉。
   * @param input - 渲染数据。
   */
  private renderDeviceFilter(input: ListViewInput): void {
    const previous = input.filters.deviceId;
    const options: HTMLOptionElement[] = [];
    const all = document.createElement('option');
    all.value = ALL_DEVICES;
    all.textContent = '全部设备';
    options.push(all);
    const known = new Set<string>();
    for (const device of input.devices) {
      known.add(device.id);
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.online ? device.name : `${device.name}（离线）`;
      options.push(option);
    }
    if (previous !== ALL_DEVICES && !known.has(previous)) {
      const option = document.createElement('option');
      option.value = previous;
      option.textContent = `${previous}（未知设备）`;
      options.push(option);
    }
    this.deviceFilter.replaceChildren(...options);
    this.deviceFilter.value = previous;
  }

  /**
   * 焦点落回刷新前的会话。
   */
  private restoreFocus(): void {
    const key = this.activeKey;
    if (key === undefined) return;
    const target = this.body.querySelector<HTMLElement>(`[data-session-key="${CSS.escape(key)}"]`);
    if (target !== null) {
      target.focus();
      this.activeKey = undefined;
    }
  }

  /**
   * 渲染一个工作区节点。
   * @param group - 工作区。
   * @param selection - 当前选中。
   * @returns 节点元素。
   */
  private renderWorkspace(group: WorkspaceGroup, selection: Selection | undefined): HTMLElement {
    const section = document.createElement('section');
    section.className = 'workspace';
    section.dataset['workspaceName'] = group.workspaceName;
    const head = document.createElement('header');
    head.className = 'workspace-header';
    const name = document.createElement('h2');
    name.className = 'workspace-name';
    name.textContent = workspaceTitle(group.workspaceName);
    const count = document.createElement('span');
    count.className = 'workspace-count';
    count.textContent = `${String(group.entries.length)} 个位置 · ${String(group.sessionCount)} 条会话${
      group.unread > 0 ? ` · ${unreadText(group.unread)}` : ''
    }`;
    head.append(name, count);
    section.append(head);
    if (group.ambiguous) {
      const note = document.createElement('p');
      note.className = 'workspace-note';
      note.textContent = `同名工作区：${group.cwds.join('、')}`;
      section.append(note);
    }
    for (const entry of group.entries) section.append(this.renderEntry(entry, selection));
    return section;
  }

  /**
   * 渲染一个设备节点。
   * @param group - 设备。
   * @param selection - 当前选中。
   * @returns 节点元素。
   */
  private renderDeviceGroup(group: DeviceGroup, selection: Selection | undefined): HTMLElement {
    const section = document.createElement('section');
    section.className = 'workspace';
    section.dataset['deviceId'] = group.deviceId;
    const head = document.createElement('header');
    head.className = 'workspace-header';
    const name = document.createElement('h2');
    name.className = 'workspace-name';
    name.textContent = group.deviceLabel;
    const state = document.createElement('span');
    state.className = group.online ? 'device-state device-state-online' : 'device-state device-state-offline';
    state.textContent = group.online ? '在线' : '离线';
    const count = document.createElement('span');
    count.className = 'workspace-count';
    count.textContent = `${String(group.sessionCount)} 条会话${group.unread > 0 ? ` · ${unreadText(group.unread)}` : ''}`;
    head.append(name, state, count);
    section.append(head);
    for (const entry of group.entries) section.append(this.renderEntry(entry, selection));
    return section;
  }

  /**
   * 渲染一个「设备 + 目录」条目。
   * @param entry - 条目。
   * @param selection - 当前选中。
   * @returns 条目元素。
   */
  private renderEntry(entry: SessionEntry, selection: Selection | undefined): HTMLElement {
    const box = document.createElement('div');
    box.className = 'workspace-entry';
    const head = document.createElement('header');
    head.className = 'entry-header';
    const device = document.createElement('span');
    device.className = 'entry-device';
    device.textContent = entry.deviceLabel;
    const state = document.createElement('span');
    state.className = entry.online ? 'device-state device-state-online' : 'device-state device-state-offline';
    state.textContent = entry.online ? '在线' : '离线';
    const path = document.createElement('span');
    path.className = 'entry-path';
    path.textContent = entry.cwd;
    head.append(device, state, path);
    box.append(head);
    const ul = document.createElement('ul');
    ul.className = 'device-sessions';
    for (const session of entry.sessions) ul.append(this.renderSession(session, selection));
    box.append(ul);
    return box;
  }

  /**
   * 渲染一条会话。
   * @param session - 会话。
   * @param selection - 当前选中。
   * @returns 列表项。
   */
  private renderSession(session: SessionItem, selection: Selection | undefined): HTMLElement {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const chosen = selection?.deviceId === session.deviceId && selection.sessionId === session.sessionId;
    const key = `${session.deviceId}\u0000${session.sessionId}`;
    button.type = 'button';
    button.className = chosen ? 'session session-selected' : 'session';
    button.dataset['deviceId'] = session.deviceId;
    button.dataset['sessionId'] = session.sessionId;
    button.dataset['sessionKey'] = key;
    if (chosen) button.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = session.title;
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    const cwd = document.createElement('span');
    cwd.className = 'session-cwd';
    cwd.textContent = session.kind === 'chat' ? '聊天' : session.cwd;
    const time = document.createElement('span');
    time.textContent = timeText(session.updatedAt);
    meta.append(cwd, time);
    button.append(title, meta);
    if (session.unreadMessages > 0) {
      const unread = document.createElement('span');
      unread.className = 'session-unread';
      unread.textContent = countText(session.unreadMessages);
      button.append(unread);
    }
    button.setAttribute(
      'aria-label',
      `${session.title}，${session.deviceName}${session.online ? '' : '（离线）'}，${
        session.kind === 'chat' ? '聊天' : session.cwd
      }${session.unreadMessages > 0 ? `，${unreadText(session.unreadMessages)}` : ''}`
    );
    button.addEventListener('click', () => {
      this.activeKey = key;
      this.handlers.onSelect(session);
    });
    item.append(button);
    return item;
  }
}
