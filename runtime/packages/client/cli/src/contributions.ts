/**
 * 本机命令行的贡献点声明。
 *
 * 场景、命令组、扩展点与状态栏条目在这里各声明一份，命令树、交互模式与非交互模式都从这一份
 * 声明取值。声明是纯数据：接入终端宿主时由宿主侧把这些条目绑定到它自己的运行时，命令行自身
 * 只保证标识、标题与内容一致。
 * @module @chatdsh/client-cli/contributions
 */

/** 一个场景。 */
export interface SceneContribution {
  /** 场景标识。 */
  readonly id: string;
  /** 标题。 */
  readonly title: string;
  /** 说明。 */
  readonly summary: string;
  /** 打开之后显示的主要内容。 */
  readonly shows: string;
}

/** 命令组。 */
export interface CommandGroupContribution {
  /** 组标识，同时是命令标识的第一段。 */
  readonly id: string;
  /** 标题。 */
  readonly title: string;
  /** 说明。 */
  readonly summary: string;
}

/** 扩展点。 */
export interface ExtensionPointContribution {
  /** 扩展点标识。 */
  readonly id: string;
  /** 类别。 */
  readonly kind: 'scene' | 'settings' | 'command' | 'status' | 'workspace' | 'approval' | 'channel' | 'theme';
  /** 标题。 */
  readonly title: string;
  /** 提供方。 */
  readonly provider: string;
  /** 说明。 */
  readonly summary: string;
}

/** 状态栏条目。 */
export interface StatusEntryContribution {
  /** 条目标识。 */
  readonly id: string;
  /** 标题。 */
  readonly title: string;
  /** 取值来源。 */
  readonly source: string;
}

/** 场景。 */
export const SCENES: readonly SceneContribution[] = [
  {
    id: 'sessions',
    title: '会话列表',
    summary: '本机运行时可恢复的会话，按最近排列',
    shows: '会话标识与工作目录',
  },
  {
    id: 'session',
    title: '会话',
    summary: '打开一个会话，跟随消息、工具与回合状态',
    shows: '流式文本、工具标题与状态、回合结束原因',
  },
  {
    id: 'settings',
    title: '设置',
    summary: '会话公布的可配置项，取值来自运行时',
    shows: '配置标识、当前取值与可选取值',
  },
  {
    id: 'diagnostics',
    title: '诊断',
    summary: '通道状态、协议计数、待应答审批与遥测状态',
    shows: '连接状态、请求与通知计数、审批等待数',
  },
];

/** 命令组。 */
export const COMMAND_GROUPS: readonly CommandGroupContribution[] = [
  { id: 'scene', title: '场景', summary: '列出与打开终端场景' },
  { id: 'settings', title: '设置', summary: '读取与修改会话公布的配置项' },
  { id: 'command', title: '命令树', summary: '列出命令、取帮助、取补全候选' },
  { id: 'extension', title: '扩展', summary: '列出本机命令行的扩展点与运行时能力' },
  { id: 'session', title: '会话', summary: '新建、恢复、发送、取消与关闭会话' },
  { id: 'approval', title: '审批', summary: '列出待应答审批并提交决定' },
  { id: 'workspace', title: '工作区', summary: '列出已知工作目录并切换新会话的目录' },
  { id: 'status', title: '状态栏', summary: '连接、会话、审批、投递与遥测状态' },
  { id: 'help', title: '帮助', summary: '命令组的用法与参数' },
];

/** 扩展点。 */
export const EXTENSION_POINTS: readonly ExtensionPointContribution[] = [
  {
    id: 'scene.list',
    kind: 'scene',
    title: '场景注册表',
    provider: '@chatdsh/client-cli',
    summary: '终端场景：会话列表、会话、设置、诊断',
  },
  {
    id: 'settings.section',
    kind: 'settings',
    title: '设置区段',
    provider: '本机运行时',
    summary: '区段内容来自会话公布的可配置项，不另建独立面板',
  },
  {
    id: 'command.tree',
    kind: 'command',
    title: '命令树',
    provider: '@chatdsh/client-cli',
    summary: '九个命令组，带参数声明、补全、帮助与退出码',
  },
  {
    id: 'status.bar',
    kind: 'status',
    title: '状态栏',
    provider: '@chatdsh/client-cli',
    summary: '连接、会话、审批、投递与遥测五项状态',
  },
  {
    id: 'workspace.provider',
    kind: 'workspace',
    title: '工作区提供方',
    provider: '本机运行时',
    summary: '工作目录来自会话记录与当前进程目录',
  },
  {
    id: 'approval.responder',
    kind: 'approval',
    title: '审批应答者',
    provider: '@chatdsh/client-cli',
    summary: '应答运行时的权限请求，无人应答时按拒绝收尾',
  },
  {
    id: 'channel.local',
    kind: 'channel',
    title: '本机 Channel',
    provider: '@chatdsh/client-cli',
    summary: '以子进程启动本机运行时，仅 stdio，不经过控制平面',
  },
  {
    id: 'theme.nocolor',
    kind: 'theme',
    title: '无颜色主题',
    provider: '@chatdsh/client-cli',
    summary: '非 TTY 不加转义序列，高对比度只用粗体与下划线',
  },
];

/** 状态栏条目。 */
export const STATUS_ENTRIES: readonly StatusEntryContribution[] = [
  { id: 'connection', title: '连接', source: '本机 Channel 状态与运行时进程标识' },
  { id: 'session', title: '会话', source: '当前会话标识与工作目录' },
  { id: 'approval', title: '审批', source: '待应答审批数量与最近一次决定' },
  { id: 'delivery', title: '投递', source: '台账里已写出的消息数与重连次数' },
  { id: 'telemetry', title: '遥测', source: '遥测开关状态与关闭原因' },
];

/**
 * 取一个场景。
 * @param id - 场景标识。
 * @returns 场景；不存在时为 `undefined`。
 */
export function sceneOf(id: string): SceneContribution | undefined {
  return SCENES.find((scene) => scene.id === id);
}

/**
 * 取一个扩展点。
 * @param id - 扩展点标识。
 * @returns 扩展点；不存在时为 `undefined`。
 */
export function extensionPointOf(id: string): ExtensionPointContribution | undefined {
  return EXTENSION_POINTS.find((point) => point.id === id);
}
