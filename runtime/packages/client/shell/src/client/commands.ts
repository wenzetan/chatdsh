/**
 * 命令面板的数据与键盘约定。
 *
 * 命令按当前设备、会话、能力与权限过滤，显示名称、分组、说明、快捷键与禁用原因；最近使用
 * 只保存命令标识。面板本身是模态层：方向键选择、Home/End 跳到首尾、Enter 执行、Escape
 * 关闭并回到打开它的控件。
 * @module @chatdsh/client-shell/commands
 */

import { SETTINGS_SECTIONS, type SettingsSection } from './route.ts';

/** 设置区段的中文名。 */
export const SETTINGS_SECTION_TITLES: Readonly<Record<SettingsSection, string>> = {
  general: '通用',
  models: '模型',
  plugins: '插件',
  runtime: '运行参数',
  assistants: '助手',
  skills: '技能',
  memory: '记忆',
  connectors: '连接器',
  automation: '自动化',
  share: '分享',
  devices: '设备',
  access: '访问',
  notifications: '通知',
  data: '数据',
  diagnostics: '诊断',
};

/** 命令作用范围。与导航契约一致。 */
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
  readonly disabledReason?: string;
}

/** 最近使用命令的保存上限。与导航契约的 `RECENT_COMMANDS_MAX` 一致。 */
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
 * 按输入文本过滤命令。
 *
 * 匹配名称、分组与说明，大小写不敏感；空文本返回全部命令。
 * @param commands - 全部命令。
 * @param text - 输入文本。
 * @returns 匹配的命令，保持原顺序。
 */
export function filterCommands(commands: readonly CommandDescriptor[], text: string): CommandDescriptor[] {
  const needle = text.trim().toLowerCase();
  if (needle === '') return [...commands];
  return commands.filter((command) => {
    const haystack = [command.name, command.group, command.description ?? ''].join('\n').toLowerCase();
    return haystack.includes(needle);
  });
}

/** 面板里可用的键。 */
export const PALETTE_NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const;

/** 面板里可用的键取值。 */
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

/**
 * 最近使用命令的存储键。
 * @param clientId - 浏览器侧客户端标识。
 * @returns 存储键。
 */
export function recentCommandsStorageKey(clientId: string): string {
  if (clientId === '') throw new Error('客户端标识不能为空');
  return `chatdsh-shell.recent-commands.v1:${clientId}`;
}

/**
 * 读最近使用的命令标识。
 * @param storage - 浏览器存储。
 * @param clientId - 浏览器侧客户端标识。
 * @returns 命令标识，最近的在前；存储不可用时为空数组。
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
  if (storage !== undefined) {
    try {
      storage.setItem(recentCommandsStorageKey(clientId), JSON.stringify(next));
    } catch {
      // 存储被拒绝只影响下次打开面板时的最近使用，不影响本次执行。
    }
  }
  return next;
}

/**
 * 按最近使用给命令排序。
 *
 * 最近的在前，未使用过的保持原顺序排在后面。
 * @param commands - 全部命令。
 * @param recent - 最近使用过的命令标识。
 * @returns 排序后的命令。
 */
export function orderByRecent(commands: readonly CommandDescriptor[], recent: readonly string[]): CommandDescriptor[] {
  const rank = new Map(recent.map((id, index) => [id, index] as const));
  return [...commands].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightRank = rank.get(right.id) ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank;
  });
}

/** 外壳命令的可用条件。 */
export interface ShellCommandInput {
  /** 当前是否选中了一条会话。 */
  readonly hasSelection: boolean;
  /** 本机运行时是否可用。 */
  readonly localAvailable: boolean;
  /** 本机不可用的原因。 */
  readonly localReason: string | undefined;
}

/**
 * 列出外壳自己的命令。
 *
 * 命令按当前会话与本机能力过滤：没有选中会话时「在本机继续」禁用并说明原因；本机运行时
 * 不可用时同样禁用。设置区段的入口逐段列出，与路由的区段取值一一对应。
 * @param input - 可用条件。
 * @returns 命令列表。
 */
export function buildShellCommands(input: ShellCommandInput): CommandDescriptor[] {
  const commands: CommandDescriptor[] = [
    {
      id: 'go-list',
      name: '会话列表',
      group: '导航',
      description: '回到聚合会话与设备列表',
      shortcut: 'G',
      scope: 'global',
      enabled: true,
    },
    {
      id: 'new-session',
      name: '新建会话',
      group: '导航',
      description: '选择设备与目录创建会话',
      shortcut: 'N',
      scope: 'global',
      enabled: true,
    },
    {
      id: 'continue-local',
      name: '在本机继续',
      group: '会话',
      description: '在本机新建带血缘的会话',
      scope: 'session',
      enabled: input.hasSelection && input.localAvailable,
      ...(input.hasSelection
        ? input.localAvailable
          ? {}
          : { disabledReason: input.localReason ?? '本机运行时不可用' }
        : { disabledReason: '先选择一条会话' }),
    },
    {
      id: 'refresh',
      name: '刷新',
      group: '导航',
      description: '重新读取会话、设备与本机状态',
      scope: 'global',
      enabled: true,
    },
    {
      id: 'diagnostics',
      name: '诊断',
      group: '导航',
      description: '查看客户端与选中设备的状态',
      scope: 'global',
      enabled: true,
    },
  ];
  for (const section of SETTINGS_SECTIONS) {
    commands.push({
      id: `settings:${section}`,
      name: `设置：${SETTINGS_SECTION_TITLES[section]}`,
      group: '设置',
      description: `打开 /settings/${section}`,
      scope: 'global',
      enabled: true,
    });
  }
  return commands;
}

