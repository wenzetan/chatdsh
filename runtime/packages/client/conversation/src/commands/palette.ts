/**
 * 命令面板：命令过滤、层级返回、最近使用与键盘操作。
 *
 * 命令按当前设备、会话、能力与权限过滤，条目显示名称、分组、说明、快捷键与禁用原因；最近
 * 使用只保存命令标识。面板是模态层：方向键选择、Home/End 跳到首尾、Enter 执行、Escape
 * 关闭，查询为空时按退格返回上一级。
 * @module @chatdsh/client-conversation/commands/palette
 */

/** 命令作用范围。 */
export const COMMAND_SCOPES = ['global', 'session', 'device'] as const;

/** 命令作用范围取值。 */
export type CommandScope = (typeof COMMAND_SCOPES)[number];

/** 一个命令。 */
export interface CommandDescriptor {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly description?: string;
  readonly shortcut?: string;
  readonly scope: CommandScope;
  readonly enabled: boolean;
  /** 禁用原因；可用时缺省。 */
  readonly disabledReason?: string;
  /** 子级命令；有子级的命令执行时进入下一级。 */
  readonly children?: readonly CommandDescriptor[];
}

/** 最近使用命令的保存上限。 */
export const RECENT_COMMANDS_MAX = 20;

/** 命令面板的快捷键说明。 */
export const PALETTE_SHORTCUT_LABEL = 'Ctrl/Cmd+K';

/** 键盘事件里本模块关心的字段。 */
export interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/**
 * 判断一次按键是否要打开命令面板。
 * @param event - 键盘事件。
 * @returns 是 Ctrl+K 或 Cmd+K 时为真。
 */
export function isPaletteShortcut(event: KeyboardEventLike): boolean {
  if (event.key.toLowerCase() !== 'k') return false;
  if (event.altKey || event.shiftKey) return false;
  return event.ctrlKey !== event.metaKey;
}

/**
 * 按查询文本过滤命令。
 *
 * 匹配名称、分组、说明与快捷键，大小写不敏感；空查询返回全部命令并保持原顺序。
 * @param commands - 全部命令。
 * @param query - 查询文本。
 * @returns 匹配的命令。
 */
export function filterCommands(commands: readonly CommandDescriptor[], query: string): CommandDescriptor[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...commands];
  return commands.filter((command) => {
    const haystack = [command.name, command.group, command.description ?? '', command.shortcut ?? '']
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** 面板里可用的移动键。 */
export const PALETTE_NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const;

/** 面板移动键取值。 */
export type PaletteNavigationKey = (typeof PALETTE_NAVIGATION_KEYS)[number];

/**
 * 判断一个键是不是面板里的移动键。
 * @param key - 键名。
 * @returns 属于移动键时为真。
 */
export function isPaletteNavigationKey(key: string): key is PaletteNavigationKey {
  return (PALETTE_NAVIGATION_KEYS as readonly string[]).includes(key);
}

/**
 * 计算移动后的选中位置。
 *
 * 方向键在列表两端循环；列表为空时返回 -1。
 * @param index - 当前位置。
 * @param key - 移动键。
 * @param count - 可选项数量。
 * @returns 新的位置。
 */
export function movePaletteSelection(index: number, key: PaletteNavigationKey, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : (index + 1) % count;
    case 'ArrowUp':
      return index <= 0 ? count - 1 : index - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

/** 面板按键意图。 */
export type PaletteKeyIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'select' }
  | { readonly kind: 'back' }
  | { readonly kind: 'move'; readonly key: PaletteNavigationKey }
  | { readonly kind: 'none' };

/**
 * 判定面板里的一次按键意图。
 *
 * 输入法组合期间的按键一律不处理；Escape 关闭面板；查询为空时的退格返回上一级。
 * @param event - 键盘事件。
 * @param context - 当前查询文本。
 * @returns 按键意图。
 */
export function paletteKeyIntent(event: KeyboardEventLike, context: { readonly query: string }): PaletteKeyIntent {
  if (event.isComposing === true || event.keyCode === 229) return { kind: 'none' };
  if (event.key === 'Escape') return { kind: 'close' };
  if (event.key === 'Enter') return { kind: 'select' };
  if (event.key === 'Backspace' && context.query === '') return { kind: 'back' };
  if (isPaletteNavigationKey(event.key)) return { kind: 'move', key: event.key };
  return { kind: 'none' };
}

/**
 * 最近使用命令的存储键。
 * @param clientId - 浏览器侧客户端标识。
 * @returns 存储键。
 */
export function recentCommandsStorageKey(clientId: string): string {
  if (clientId === '') throw new Error('客户端标识不能为空');
  return `chatdsh-conversation.recent-commands.v1:${clientId}`;
}

/**
 * 读最近使用的命令标识。
 * @param storage - 浏览器存储。
 * @param clientId - 浏览器侧客户端标识。
 * @returns 命令标识，最近的在前；没有记录或内容不合法时为空数组。
 */
export function readRecentCommands(storage: Storage | undefined, clientId: string): string[] {
  if (storage === undefined) return [];
  const raw = storage.getItem(recentCommandsStorageKey(clientId));
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry === '' || entry.length > 200) continue;
    if (ids.includes(entry)) continue;
    ids.push(entry);
    if (ids.length === RECENT_COMMANDS_MAX) break;
  }
  return ids;
}

/**
 * 记一次命令使用。
 * @param storage - 浏览器存储。
 * @param clientId - 浏览器侧客户端标识。
 * @param id - 命令标识。
 * @returns 更新后的最近使用列表。
 */
export function recordRecentCommand(storage: Storage | undefined, clientId: string, id: string): string[] {
  const existing = readRecentCommands(storage, clientId).filter((entry) => entry !== id);
  const next = [id, ...existing].slice(0, RECENT_COMMANDS_MAX);
  if (storage !== undefined) storage.setItem(recentCommandsStorageKey(clientId), JSON.stringify(next));
  return next;
}

/**
 * 按最近使用给命令排序。
 * @param commands - 全部命令。
 * @param recent - 最近使用过的命令标识。
 * @returns 最近的在前，未使用过的保持原顺序排在后面。
 */
export function orderByRecent(commands: readonly CommandDescriptor[], recent: readonly string[]): CommandDescriptor[] {
  const rank = new Map(recent.map((id, index) => [id, index] as const));
  return [...commands].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightRank = rank.get(right.id) ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank;
  });
}

/** 会话里的命令可用条件。 */
export interface ConversationCommandInput {
  /** 输入区能否发送。 */
  readonly canSend: boolean;
  /** 输入区不能发送的原因。 */
  readonly sendBlockerReason?: string;
  /** 当前是否有运行。 */
  readonly running: boolean;
  /** 目标设备是否在线。 */
  readonly deviceOnline: boolean;
  /** 队列里的待发送条数。 */
  readonly queued: number;
  /** 是否有可以反馈的消息。 */
  readonly hasLastMessage: boolean;
  /** 实时播报是否暂停。 */
  readonly announcementsPaused: boolean;
}

/**
 * 列出会话里的命令。
 *
 * 命令按当前能力过滤：不能发送时「发送消息」禁用并给出原因；没有运行时「停止当前运行」禁用；
 * 设备离线时写操作全部禁用并说明；队列为空时不提供「打开队列」。
 * @param input - 可用条件。
 * @returns 命令列表。
 */
export function buildConversationCommands(input: ConversationCommandInput): CommandDescriptor[] {
  const offline = !input.deviceOnline;
  return [
    {
      id: 'send-message',
      name: '发送消息',
      group: '会话',
      description: '把输入区的内容发给当前会话',
      shortcut: 'Enter',
      scope: 'session',
      enabled: input.canSend && !offline,
      ...(offline
        ? { disabledReason: '目标设备离线，发送会失败' }
        : input.canSend
          ? {}
          : { disabledReason: input.sendBlockerReason ?? '输入区没有可以发送的内容' }),
    },
    {
      id: 'stop-run',
      name: '停止当前运行',
      group: '会话',
      description: '请求宿主停止当前运行，等宿主确认后显示已停止',
      shortcut: 'Esc',
      scope: 'session',
      enabled: input.running,
      ...(input.running ? {} : { disabledReason: '当前没有运行' }),
    },
    {
      id: 'open-queue',
      name: '打开待发送队列',
      group: '会话',
      description: `查看 ${String(input.queued)} 条待发送内容`,
      scope: 'session',
      enabled: input.queued > 0,
      ...(input.queued > 0 ? {} : { disabledReason: '队列里没有待发送内容' }),
    },
    {
      id: 'clear-composer',
      name: '清空输入',
      group: '输入',
      description: '清空输入区文本与引用',
      scope: 'session',
      enabled: true,
    },
    {
      id: 'toggle-announcements',
      name: input.announcementsPaused ? '恢复实时播报' : '暂停实时播报',
      group: '无障碍',
      description: '控制读屏是否在流式输出中播报完成的片段',
      shortcut: 'Ctrl/Cmd+Shift+A',
      scope: 'global',
      enabled: true,
    },
    {
      id: 'copy-last-message',
      name: '复制最后一条消息',
      group: '消息',
      description: '把最后一条消息的正文复制到剪贴板',
      scope: 'session',
      enabled: input.hasLastMessage,
      ...(input.hasLastMessage ? {} : { disabledReason: '当前没有消息' }),
    },
    {
      id: 'feedback',
      name: '消息反馈',
      group: '消息',
      description: '对最后一条消息选择赞、踩或补充说明',
      scope: 'session',
      enabled: input.hasLastMessage,
      ...(input.hasLastMessage ? {} : { disabledReason: '当前没有消息' }),
    },
    {
      id: 'insert-reference',
      name: '插入引用',
      group: '输入',
      description: '选择文件、会话、记忆条目等对象插入输入区',
      shortcut: '@',
      scope: 'session',
      enabled: !offline,
      ...(offline ? { disabledReason: '目标设备离线，引用目录读不到' } : {}),
    },
    {
      id: 'insert-command',
      name: '插入命令',
      group: '输入',
      description: '选择运行时命令并带参数插入',
      shortcut: '/',
      scope: 'session',
      enabled: !offline,
      ...(offline ? { disabledReason: '目标设备离线，命令目录读不到' } : {}),
    },
  ];
}

/** 面板层级。 */
export interface PaletteLevel {
  /** 层级标识；根层用 `root`。 */
  readonly id: string;
  /** 层级标题。 */
  readonly label: string;
  readonly commands: readonly CommandDescriptor[];
}

/** 选择一条命令的结果。 */
export type PaletteSelection =
  | { readonly kind: 'execute'; readonly command: CommandDescriptor }
  | { readonly kind: 'enter'; readonly level: PaletteLevel }
  | { readonly kind: 'none'; readonly reason: string };

/** 命令面板的依赖。 */
export interface CommandPaletteOptions {
  /** 浏览器存储，用于最近使用。 */
  readonly storage?: Storage;
  /** 浏览器侧客户端标识。 */
  readonly clientId?: string;
  /** 最近使用的初始值；不给时从存储读取。 */
  readonly recent?: readonly string[];
}

/**
 * 命令面板的状态机。
 */
export class CommandPalette {
  private levels: PaletteLevel[] = [];
  private queryText = '';
  private index = -1;
  private visible = false;
  private recentIds: string[];
  private readonly storage: Storage | undefined;
  private readonly clientId: string | undefined;

  /**
   * 建立面板。
   * @param options - 存储与最近使用。
   */
  constructor(options: CommandPaletteOptions = {}) {
    this.storage = options.storage;
    this.clientId = options.clientId;
    this.recentIds = options.recent === undefined
      ? options.storage === undefined || options.clientId === undefined
        ? []
        : readRecentCommands(options.storage, options.clientId)
      : [...options.recent];
  }

  /** 面板是否打开。 */
  get isOpen(): boolean {
    return this.visible;
  }

  /** 当前查询文本。 */
  get query(): string {
    return this.queryText;
  }

  /** 当前层级标识。 */
  get levelId(): string {
    return this.levels.at(-1)?.id ?? 'root';
  }

  /** 当前层级标题。 */
  get levelLabel(): string {
    return this.levels.at(-1)?.label ?? '命令';
  }

  /** 是否在子级。 */
  get canGoBack(): boolean {
    return this.levels.length > 1;
  }

  /** 当前选中位置。 */
  get activeIndex(): number {
    return this.index;
  }

  /** 最近使用的命令标识。 */
  get recent(): readonly string[] {
    return this.recentIds;
  }

  /**
   * 打开面板。
   * @param commands - 根层命令。
   */
  open(commands: readonly CommandDescriptor[]): void {
    this.levels = [{ id: 'root', label: '命令', commands }];
    this.queryText = '';
    this.visible = true;
    const items = this.filtered();
    this.index = items.findIndex((command) => command.enabled);
    if (this.index < 0 && items.length > 0) this.index = 0;
  }

  /** 关闭面板并清空层级。 */
  close(): void {
    this.visible = false;
    this.levels = [];
    this.queryText = '';
    this.index = -1;
  }

  /**
   * 替换当前层级的命令，保持查询与选中位置不变。
   * @param commands - 新命令。
   */
  update(commands: readonly CommandDescriptor[]): void {
    const current = this.levels.at(-1);
    if (current === undefined) return;
    this.levels = [...this.levels.slice(0, -1), { ...current, commands }];
    const count = this.filtered().length;
    this.index = count === 0 ? -1 : Math.min(this.index < 0 ? 0 : this.index, count - 1);
  }

  /**
   * 修改查询文本，并把选中位置重置到第一条可用条目。
   * @param query - 查询文本。
   */
  setQuery(query: string): void {
    this.queryText = query;
    const items = this.filtered();
    this.index = items.findIndex((command) => command.enabled);
    if (this.index < 0 && items.length > 0) this.index = 0;
  }

  /**
   * 移动选中位置。
   * @param key - 移动键。
   */
  move(key: PaletteNavigationKey): void {
    this.index = movePaletteSelection(this.index, key, this.filtered().length);
  }

  /**
   * 返回上一级。
   * @returns 是否发生了返回。
   */
  back(): boolean {
    if (this.levels.length <= 1) return false;
    this.levels = this.levels.slice(0, -1);
    this.queryText = '';
    const items = this.filtered();
    this.index = items.findIndex((command) => command.enabled);
    return true;
  }

  /**
   * 当前过滤后的命令，按最近使用排序。
   * @returns 命令列表。
   */
  filtered(): CommandDescriptor[] {
    const current = this.levels.at(-1);
    if (current === undefined) return [];
    return orderByRecent(filterCommands(current.commands, this.queryText), this.recentIds);
  }

  /**
   * 当前选中的命令。
   * @returns 命令；没有选中时返回 `undefined`。
   */
  active(): CommandDescriptor | undefined {
    const items = this.filtered();
    return this.index < 0 ? undefined : items[this.index];
  }

  /**
   * 执行当前选中项。
   *
   * 有子级命令时进入下一级；禁用的命令返回原因，不执行。
   * @returns 选择结果。
   */
  select(): PaletteSelection {
    const command = this.active();
    if (command === undefined) return { kind: 'none', reason: '没有选中的命令' };
    if (!command.enabled) return { kind: 'none', reason: command.disabledReason ?? '命令当前不可用' };
    if (command.children !== undefined && command.children.length > 0) {
      const level: PaletteLevel = { id: command.id, label: command.name, commands: command.children };
      this.levels = [...this.levels, level];
      this.queryText = '';
      const items = this.filtered();
      this.index = items.findIndex((item) => item.enabled);
      return { kind: 'enter', level };
    }
    if (this.storage !== undefined && this.clientId !== undefined) {
      this.recentIds = recordRecentCommand(this.storage, this.clientId, command.id);
    } else {
      this.recentIds = [command.id, ...this.recentIds.filter((id) => id !== command.id)].slice(0, RECENT_COMMANDS_MAX);
    }
    return { kind: 'execute', command };
  }
}
