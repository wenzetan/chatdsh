/**
 * 命令树。
 *
 * 九个命令组各自声明参数、可选项、是否需要连接本机运行时以及是否属于危险动作。解析、补全与
 * 帮助都从同一份声明生成：未知命令、缺少必需参数、未知可选项与取值不在枚举内都在解析阶段
 * 以用法错误结束，命令本身不会被执行。
 * @module @chatdsh/client-cli/command-tree
 */

import { COMMAND_GROUPS } from './contributions.ts';
import { CliError } from './protocol.ts';

/** 位置参数的取值种类。 */
export type ArgumentKind = 'text' | 'path' | 'enum';

/** 位置参数。 */
export interface ArgumentSpec {
  /** 参数标识，同时是结构化请求里的键名。 */
  readonly id: string;
  /** 用法文本里的写法。 */
  readonly label: string;
  /** 是否必需。 */
  readonly required: boolean;
  /** 取值种类。 */
  readonly kind: ArgumentKind;
  /** 枚举取值；仅 `enum` 使用。 */
  readonly values?: readonly string[];
  /** 说明。 */
  readonly summary: string;
}

/** 可选项。 */
export interface OptionSpec {
  /** 选项名，不带 `--`。 */
  readonly name: string;
  /** 是否取一个值；假表示布尔开关。 */
  readonly takesValue: boolean;
  /** 是否必需。 */
  readonly required: boolean;
  /** 枚举取值。 */
  readonly values?: readonly string[];
  /** 说明。 */
  readonly summary: string;
}

/** 一条命令。 */
export interface CommandSpec {
  /** 命令标识，形如 `session.send`。 */
  readonly id: string;
  /** 所属组。 */
  readonly group: string;
  /** 标题。 */
  readonly title: string;
  /** 说明。 */
  readonly summary: string;
  /** 位置参数。 */
  readonly arguments: readonly ArgumentSpec[];
  /** 可选项。 */
  readonly options: readonly OptionSpec[];
  /** 是否需要连接本机运行时。 */
  readonly needsChannel: boolean;
  /** 危险动作的确认说明；不需要确认时为 `undefined`。 */
  readonly confirmation?: string;
}

/** 解析之后的调用。 */
export interface ParsedCall {
  /** 命中的命令。 */
  readonly spec: CommandSpec;
  /** 位置参数取值。 */
  readonly arguments: Readonly<Record<string, string>>;
  /** 可选项取值。 */
  readonly options: Readonly<Record<string, string | boolean>>;
  /** 原文。 */
  readonly raw: string;
}

/** 会话相关命令的公共可选项。 */
const SESSION_OPTION: OptionSpec = {
  name: 'session',
  takesValue: true,
  required: false,
  summary: '目标会话标识；省略时用当前会话',
};

/** 确认开关。 */
const YES_OPTION: OptionSpec = {
  name: 'yes',
  takesValue: false,
  required: false,
  summary: '确认执行危险动作',
};

/** 全部命令。 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'scene.list',
    group: 'scene',
    title: '列出场景',
    summary: '列出终端场景及其内容',
    arguments: [],
    options: [],
    needsChannel: false,
  },
  {
    id: 'scene.open',
    group: 'scene',
    title: '打开场景',
    summary: '打开一个场景；会话场景需要一个会话',
    arguments: [],
    options: [
      { name: 'scene', takesValue: true, required: true, values: ['sessions', 'session', 'settings', 'diagnostics'], summary: '场景标识' },
      SESSION_OPTION,
    ],
    needsChannel: true,
  },
  {
    id: 'settings.list',
    group: 'settings',
    title: '列出设置',
    summary: '列出会话公布的可配置项与当前取值',
    arguments: [],
    options: [SESSION_OPTION],
    needsChannel: true,
  },
  {
    id: 'settings.set',
    group: 'settings',
    title: '修改设置',
    summary: '更新会话的一项配置',
    arguments: [],
    options: [
      SESSION_OPTION,
      { name: 'option', takesValue: true, required: true, summary: '配置标识，例如 model' },
      { name: 'value', takesValue: true, required: true, summary: '目标取值' },
    ],
    needsChannel: true,
  },
  {
    id: 'command.tree',
    group: 'command',
    title: '命令树',
    summary: '列出全部命令组与命令',
    arguments: [],
    options: [],
    needsChannel: false,
  },
  {
    id: 'command.help',
    group: 'command',
    title: '命令帮助',
    summary: '打印一条命令或一个命令组的用法',
    arguments: [{ id: 'target', label: '<命令或组>', required: true, kind: 'text', summary: '命令标识或命令组标识' }],
    options: [],
    needsChannel: false,
  },
  {
    id: 'command.complete',
    group: 'command',
    title: '命令补全',
    summary: '按前缀给出补全候选',
    arguments: [{ id: 'prefix', label: '<前缀>', required: true, kind: 'text', summary: '已输入的前缀' }],
    options: [],
    needsChannel: false,
  },
  {
    id: 'extension.list',
    group: 'extension',
    title: '列出扩展',
    summary: '列出扩展点与运行时声明的能力',
    arguments: [],
    options: [],
    needsChannel: false,
  },
  {
    id: 'extension.show',
    group: 'extension',
    title: '扩展详情',
    summary: '查看一个扩展点的提供方与说明',
    arguments: [{ id: 'id', label: '<扩展标识>', required: true, kind: 'text', summary: '扩展点标识' }],
    options: [],
    needsChannel: false,
  },
  {
    id: 'session.list',
    group: 'session',
    title: '会话列表',
    summary: '列出本机运行时可恢复的会话',
    arguments: [],
    options: [
      { name: 'cwd', takesValue: true, required: false, summary: '按工作目录过滤' },
      { name: 'cursor', takesValue: true, required: false, summary: '分页游标' },
    ],
    needsChannel: true,
  },
  {
    id: 'session.new',
    group: 'session',
    title: '新建会话',
    summary: '在本机新建一个会话，并把它设为当前会话',
    arguments: [],
    options: [{ name: 'cwd', takesValue: true, required: false, summary: '工作目录；省略用工作区目录' }],
    needsChannel: true,
  },
  {
    id: 'session.resume',
    group: 'session',
    title: '恢复会话',
    summary: '恢复一个已持久化的会话，并把它设为当前会话',
    arguments: [{ id: 'sessionId', label: '<会话标识>', required: true, kind: 'text', summary: '要恢复的会话' }],
    options: [{ name: 'cwd', takesValue: true, required: false, summary: '工作目录；省略用工作区目录' }],
    needsChannel: true,
  },
  {
    id: 'session.send',
    group: 'session',
    title: '发送消息',
    summary: '向会话发送一条消息；同一投递标识不会发出第二遍',
    arguments: [{ id: 'text', label: '<文本>', required: true, kind: 'text', summary: '消息文本' }],
    options: [
      SESSION_OPTION,
      { name: 'delivery', takesValue: true, required: false, summary: '投递标识；省略时按内容与序号生成' },
    ],
    needsChannel: true,
  },
  {
    id: 'session.cancel',
    group: 'session',
    title: '取消回合',
    summary: '取消会话里正在进行的回合',
    arguments: [],
    options: [SESSION_OPTION],
    needsChannel: true,
  },
  {
    id: 'session.close',
    group: 'session',
    title: '关闭会话',
    summary: '关闭会话并释放该会话名下的待应答审批',
    arguments: [],
    options: [SESSION_OPTION, YES_OPTION],
    needsChannel: true,
    confirmation: '关闭会话会结束该会话上正在进行的回合',
  },
  {
    id: 'approval.list',
    group: 'approval',
    title: '待应答审批',
    summary: '列出等待决定的权限请求',
    arguments: [],
    options: [],
    needsChannel: true,
  },
  {
    id: 'approval.answer',
    group: 'approval',
    title: '应答审批',
    summary: '对一条权限请求提交决定',
    arguments: [{ id: 'requestId', label: '<请求标识>', required: true, kind: 'text', summary: '待应答请求' }],
    options: [
      {
        name: 'decision',
        takesValue: true,
        required: true,
        values: ['allow', 'deny'],
        summary: '决定：允许或拒绝',
      },
    ],
    needsChannel: true,
  },
  {
    id: 'workspace.list',
    group: 'workspace',
    title: '工作区列表',
    summary: '列出已知工作目录与当前工作区',
    arguments: [],
    options: [],
    needsChannel: false,
  },
  {
    id: 'workspace.use',
    group: 'workspace',
    title: '切换工作区',
    summary: '把新会话的工作目录切到一个存在的目录',
    arguments: [{ id: 'path', label: '<路径>', required: true, kind: 'path', summary: '工作目录' }],
    options: [],
    needsChannel: false,
  },
  {
    id: 'status',
    group: 'status',
    title: '状态栏',
    summary: '显示连接、会话、审批、投递与遥测状态',
    arguments: [],
    options: [],
    needsChannel: false,
  },
  {
    id: 'status.reconnect',
    group: 'status',
    title: '重新连接',
    summary: '断开之后重新连接本机运行时，并恢复断开前已知的会话',
    arguments: [],
    options: [],
    needsChannel: false,
  },
  {
    id: 'help',
    group: 'help',
    title: '帮助',
    summary: '打印命令组或命令的用法',
    arguments: [{ id: 'target', label: '<命令或组>', required: false, kind: 'text', summary: '省略时列出命令组' }],
    options: [],
    needsChannel: false,
  },
];

/** 按标识索引。 */
const BY_ID = new Map(COMMANDS.map((command) => [command.id, command] as const));

/** 按组索引。 */
const BY_GROUP = new Map(COMMAND_GROUPS.map((group) => [group.id, group] as const));

/**
 * 取一条命令。
 * @param id - 命令标识。
 * @returns 命令；不存在时为 `undefined`。
 */
export function commandOf(id: string): CommandSpec | undefined {
  return BY_ID.get(id);
}

/**
 * 取一个命令组。
 * @param id - 组标识。
 * @returns 命令组；不存在时为 `undefined`。
 */
export function commandGroupOf(id: string): (typeof COMMAND_GROUPS)[number] | undefined {
  return BY_GROUP.get(id);
}

/**
 * 取一个组下的命令。
 * @param group - 组标识。
 * @returns 命令列表。
 */
export function commandsOfGroup(group: string): readonly CommandSpec[] {
  return COMMANDS.filter((command) => command.group === group);
}

/**
 * 把一行文本切成词，支持单引号与双引号包裹。
 * @param text - 命令原文。
 * @returns 词列表。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    tokens.push(value);
    match = pattern.exec(text);
  }
  return tokens;
}

/**
 * 解析一行命令。
 * @param text - 命令原文。
 * @returns 解析结果。
 * @throws {CliError} 用法错误。
 */
export function parseCommandLine(text: string): ParsedCall {
  const tokens = tokenize(text.trim());
  if (tokens.length === 0) throw new CliError('usage', '命令为空');
  const head = tokens[0] as string;
  let spec: CommandSpec | undefined;
  let consumed = 1;
  if (head.includes('.')) {
    spec = BY_ID.get(head);
  } else if (tokens.length > 1) {
    const compound = `${head}.${tokens[1] as string}`;
    const candidate = BY_ID.get(compound);
    if (candidate !== undefined) {
      spec = candidate;
      consumed = 2;
    }
  } else if (head === 'status' || head === 'help') {
    spec = BY_ID.get(head);
  }
  if (spec === undefined) {
    const group = BY_GROUP.get(head);
    throw new CliError(
      'usage',
      group === undefined ? `未知命令：${head}` : `命令组 ${head} 需要子命令，例如 ${head}.list`,
    );
  }
  const values: Record<string, string> = {};
  const options: Record<string, string | boolean> = {};
  const optionSpecs = new Map(spec.options.map((option) => [option.name, option] as const));
  const positionals: string[] = [];
  for (let index = consumed; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body === '') throw new CliError('usage', '存在空的可选项名');
    const equals = body.indexOf('=');
    const name = equals < 0 ? body : body.slice(0, equals);
    const optionSpec = optionSpecs.get(name);
    if (optionSpec === undefined) {
      throw new CliError('usage', `${spec.id} 不认识可选项 --${name}`);
    }
    if (optionSpec.takesValue) {
      const value = equals < 0 ? tokens[++index] : body.slice(equals + 1);
      if (value === undefined) throw new CliError('usage', `--${name} 缺少取值`);
      if (optionSpec.values !== undefined && !optionSpec.values.includes(value)) {
        throw new CliError('usage', `--${name} 只接受 ${optionSpec.values.join('、')}，收到 ${value}`);
      }
      options[name] = value;
    } else {
      if (equals >= 0) throw new CliError('usage', `--${name} 是开关，不取值`);
      options[name] = true;
    }
  }
  if (positionals.length > spec.arguments.length) {
    throw new CliError('usage', `${spec.id} 只接受 ${spec.arguments.length} 个位置参数，收到 ${positionals.length} 个`);
  }
  spec.arguments.forEach((argument, index) => {
    const value = positionals[index];
    if (value === undefined) {
      if (argument.required) throw new CliError('usage', `${spec.id} 缺少必需参数 ${argument.label}`);
      return;
    }
    if (argument.kind === 'enum' && argument.values !== undefined && !argument.values.includes(value)) {
      throw new CliError('usage', `${argument.label} 只接受 ${argument.values.join('、')}，收到 ${value}`);
    }
    values[argument.id] = value;
  });
  for (const option of spec.options) {
    if (option.required && options[option.name] === undefined) {
      throw new CliError('usage', `${spec.id} 缺少必需可选项 --${option.name}`);
    }
  }
  return { spec, arguments: values, options, raw: text.trim() };
}

/**
 * 按标识与结构化参数构造一次调用。
 *
 * 结构化请求与命令行请求走同一份声明校验：未知键、类型不符、缺少必需项与取值不在枚举内都在
 * 这里以用法错误结束。
 * @param id - 命令标识。
 * @param fields - 参数表，键取位置参数标识或可选项名。
 * @returns 解析结果。
 * @throws {CliError} 用法错误。
 */
export function buildCall(id: string, fields: Readonly<Record<string, unknown>>): ParsedCall {
  const spec = BY_ID.get(id);
  if (spec === undefined) throw new CliError('usage', `未知命令：${id}`);
  const values: Record<string, string> = {};
  const options: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    const argument = spec.arguments.find((candidate) => candidate.id === key);
    if (argument !== undefined) {
      if (typeof value !== 'string') throw new CliError('usage', `${spec.id} 的参数 ${key} 需要字符串`);
      if (argument.kind === 'enum' && argument.values !== undefined && !argument.values.includes(value)) {
        throw new CliError('usage', `${argument.label} 只接受 ${argument.values.join('、')}，收到 ${value}`);
      }
      values[key] = value;
      continue;
    }
    const option = spec.options.find((candidate) => candidate.name === key);
    if (option === undefined) throw new CliError('usage', `${spec.id} 不认识参数 ${key}`);
    if (option.takesValue) {
      if (typeof value !== 'string') throw new CliError('usage', `可选项 --${key} 需要字符串`);
      if (option.values !== undefined && !option.values.includes(value)) {
        throw new CliError('usage', `--${key} 只接受 ${option.values.join('、')}，收到 ${value}`);
      }
      options[key] = value;
      continue;
    }
    if (value !== true) throw new CliError('usage', `可选项 --${key} 是开关，只接受 true`);
    options[key] = true;
  }
  for (const argument of spec.arguments) {
    if (argument.required && values[argument.id] === undefined) {
      throw new CliError('usage', `${spec.id} 缺少必需参数 ${argument.label}`);
    }
  }
  for (const option of spec.options) {
    if (option.required && options[option.name] === undefined) {
      throw new CliError('usage', `${spec.id} 缺少必需可选项 --${option.name}`);
    }
  }
  return { spec, arguments: values, options, raw: spec.id };
}

/**
 * 按前缀给出补全候选。
 * @param prefix - 已输入的前缀。
 * @returns 命令标识与组标识。
 */
export function completeCommands(prefix: string): string[] {
  const needle = prefix.trim().toLowerCase();
  if (needle === '') return COMMANDS.map((command) => command.id);
  const ids = COMMANDS.filter((command) => command.id.toLowerCase().startsWith(needle)).map((command) => command.id);
  const groups = COMMAND_GROUPS.filter((group) => group.id.toLowerCase().startsWith(needle)).map((group) => group.id);
  return [...groups, ...ids];
}

/**
 * 生成一条命令的用法行。
 * @param spec - 命令。
 * @returns 用法文本。
 */
export function usageOf(spec: CommandSpec): string {
  const parts = [spec.id];
  for (const argument of spec.arguments) parts.push(argument.required ? argument.label : `[${argument.label}]`);
  for (const option of spec.options) {
    const body = option.takesValue ? `--${option.name} <${option.values?.join('|') ?? '值'}>` : `--${option.name}`;
    parts.push(option.required ? body : `[${body}]`);
  }
  return parts.join(' ');
}

/**
 * 生成帮助文本。
 * @param target - 命令标识或组标识；省略时列出全部组。
 * @returns 帮助文本。
 */
export function helpText(target?: string): string[] {
  if (target === undefined || target === '') {
    const lines = ['用法：chatdsh-cli [选项] [命令]', '', '命令组：'];
    for (const group of COMMAND_GROUPS) {
      lines.push(`  ${group.id.padEnd(12)}${group.title}：${group.summary}`);
    }
    lines.push('', '用 help <命令或组> 查看具体用法。');
    return lines;
  }
  const command = BY_ID.get(target);
  if (command !== undefined) {
    const lines = [`${command.id}：${command.title}`, `用法：${usageOf(command)}`, command.summary];
    if (command.arguments.length > 0) {
      lines.push('', '位置参数：');
      for (const argument of command.arguments) {
        lines.push(`  ${argument.label.padEnd(16)}${argument.summary}${argument.required ? '（必需）' : ''}`);
      }
    }
    if (command.options.length > 0) {
      lines.push('', '可选项：');
      for (const option of command.options) {
        const values = option.values === undefined ? '' : `（${option.values.join('|')}）`;
        lines.push(`  --${option.name.padEnd(14)}${option.summary}${values}${option.required ? '（必需）' : ''}`);
      }
    }
    if (command.confirmation !== undefined) lines.push('', `危险动作：${command.confirmation}；确认时加 --yes。`);
    return lines;
  }
  const group = BY_GROUP.get(target);
  if (group !== undefined) {
    const lines = [`${group.id}：${group.title}`, group.summary, '', '命令：'];
    for (const command of commandsOfGroup(group.id)) {
      lines.push(`  ${command.id.padEnd(20)}${command.summary}`);
    }
    return lines;
  }
  throw new CliError('usage', `没有这个命令或命令组：${target}`);
}

/**
 * 命令树的结构化视图。
 * @returns 组与命令。
 */
export function commandTreeView(): {
  readonly groups: readonly {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly commands: readonly {
      readonly id: string;
      readonly title: string;
      readonly usage: string;
      readonly summary: string;
      readonly needsChannel: boolean;
      readonly confirmation: string | undefined;
    }[];
  }[];
} {
  return {
    groups: COMMAND_GROUPS.map((group) => ({
      id: group.id,
      title: group.title,
      summary: group.summary,
      commands: commandsOfGroup(group.id).map((command) => ({
        id: command.id,
        title: command.title,
        usage: usageOf(command),
        summary: command.summary,
        needsChannel: command.needsChannel,
        confirmation: command.confirmation,
      })),
    })),
  };
}
