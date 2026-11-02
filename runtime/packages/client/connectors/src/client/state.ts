/**
 * 连接器面板的纯逻辑：字段标识、条件校验、名称规范化冲突、状态徽标与失败说明。
 *
 * 这一层不接触网络与 React。名称规范化与服务名规则与宿主 `toServerName` 一致：非法字符换成
 * 连字符、截断到 32 个字符、空名回退到固定值。同一台服务器的工具命名空间只能由一个连接器
 * 占用，因此两项记录的规范化结果相同时，保存必须在界面先被拦下。
 * @module @chatdsh/client-connectors/state
 */

import type {
  ConnectorRecord,
  ConnectorStateView,
  ConnectorSyncState,
  ConnectorTransport,
} from './types.ts';

/** 连接器名称的长度上限，与宿主校验一致。 */
export const CONNECTOR_NAME_LIMIT = 80;

/** 凭据环境变量名的形状，与宿主校验一致。 */
export const CREDENTIAL_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** 服务器名的形状：工具名前缀只能用这些字符。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

/** 连接器生成的加载器行前缀，与宿主一致。 */
export const ROW_PREFIX = 'chatdsh-connector-';

/** 控制平面注册表下发到本机的行前缀，与宿主一致。 */
export const REGISTRY_ROW_PREFIX = 'chatdsh-mcp-endpoint-';

/** 表单字段的标识，错误摘要按这些标识跳转。 */
export const FIELD_IDS = {
  name: 'wp13-connector-name',
  transport: 'wp13-connector-transport',
  command: 'wp13-connector-command',
  args: 'wp13-connector-args',
  url: 'wp13-connector-url',
  credential: 'wp13-connector-credential',
  enabled: 'wp13-connector-enabled',
} as const;

/** 失败说明用到的客户端错误码。 */
export const CLIENT_ERROR_CODES = {
  /** 控制平面不可达。 */
  offline: 'client/offline',
  /** 当前组合没有提供该命名空间或方法。 */
  unavailable: 'client/unavailable',
} as const;

/** 表单草稿：全部字段以字符串保存，提交时再转成写入输入。 */
export interface ConnectorDraft {
  readonly name: string;
  readonly transport: ConnectorTransport;
  readonly command: string;
  /** 参数按 JSON 字符串数组保存，提交前用 JSON 解析器展开。 */
  readonly argsText: string;
  readonly url: string;
  /** 凭据所在的环境变量名；值不进入表单。 */
  readonly credentialEnv: string;
  readonly enabled: boolean;
}

/** 一条字段校验结果。 */
export interface FieldError {
  readonly fieldId: string;
  readonly message: string;
}

/** 徽标的展示取值。 */
export interface BadgeView {
  readonly tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';
  readonly label: string;
}

/** 空草稿：默认 stdio、启用。 */
export const EMPTY_DRAFT: ConnectorDraft = {
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  url: '',
  credentialEnv: '',
  enabled: true,
};

/**
 * 把展示名规范成 MCP 服务器名，规则与宿主 `toServerName` 相同。
 * @param name - 连接器的展示名。
 * @returns 满足 `[A-Za-z0-9_-]{1,32}` 的服务器名。
 */
export function toServerName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 32);
  return normalized === '' ? 'connector' : normalized;
}

/**
 * 算出一个服务器名对应的连接器行标识。
 * @param serverName - 服务器名。
 * @returns 加载器行标识。
 */
export function rowIdOf(serverName: string): string {
  return `${ROW_PREFIX}${serverName}`;
}

/**
 * 从注册表行标识里取服务器名。
 * @param rowId - 加载器行标识。
 * @returns 服务器名；不是注册表行时返回 undefined。
 */
export function registryServerOf(rowId: string): string | undefined {
  if (!rowId.startsWith(REGISTRY_ROW_PREFIX)) return undefined;
  return rowId.slice(REGISTRY_ROW_PREFIX.length);
}

/**
 * 把一行 MCP 工具名拆出服务器段。
 * @param toolName - 形如 `mcp__<server>__<raw>` 的工具名。
 * @returns 服务器名；形状不符时返回 undefined。
 */
export function toolServerOf(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  return separator < 0 ? undefined : rest.slice(0, separator);
}

/**
 * 把草稿里的参数字符串解析成字符串数组。
 * @param text - 参数原文，空串表示没有参数。
 * @returns 参数数组。
 * @throws {@link Error} 不是合法 JSON 或不是字符串数组时抛出；调用前必须已经通过字段校验。
 */
export function parseArgs(text: string): string[] {
  if (text.trim() === '') return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('连接器参数必须是 JSON 字符串数组');
  }
  return [...(value as string[])];
}

/**
 * 判定地址能否作为 http 连接器的目标。
 * @param value - 地址原文。
 * @returns 判定结果与原因文字。
 */
function urlVerdictOf(value: string): { readonly ok: boolean; readonly message?: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: '地址必须是完整的 URL，例如 https://example.test/mcp' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: `地址只支持 http 与 https，实际 ${parsed.protocol}` };
  }
  return { ok: true };
}

/**
 * 校验一份草稿。
 *
 * 名称先查空与长度，再查完全重复与规范化后冲突；参数按 JSON 字符串数组校验；凭据只接受
 * 环境变量名；条件字段按传输方式互斥：stdio 必须有命令且不带地址，http 必须有地址且不带
 * 命令与参数。
 * @param draft - 表单草稿。
 * @param others - 除本次提交这一条之外的现有记录。
 * @returns 字段错误列表，按字段出现顺序排列。
 */
export function validateDraft(draft: ConnectorDraft, others: readonly ConnectorRecord[]): FieldError[] {
  const errors: FieldError[] = [];
  const name = draft.name.trim();
  if (name === '') {
    errors.push({ fieldId: FIELD_IDS.name, message: '连接器名称不能为空' });
  } else if ([...name].length > CONNECTOR_NAME_LIMIT) {
    errors.push({ fieldId: FIELD_IDS.name, message: `连接器名称最多 ${String(CONNECTOR_NAME_LIMIT)} 个字符` });
  } else {
    const duplicated = others.find((record) => record.name === name);
    if (duplicated !== undefined) {
      errors.push({ fieldId: FIELD_IDS.name, message: `连接器名称 ${name} 已被占用` });
    } else {
      const serverName = toServerName(name);
      const clash = others.find((record) => toServerName(record.name) === serverName);
      if (clash !== undefined) {
        errors.push({
          fieldId: FIELD_IDS.name,
          message: `名称规范化后与「${clash.name}」冲突：服务器名 ${serverName} 只能由一个连接器占用`,
        });
      }
    }
  }

  const argsText = draft.argsText.trim();
  if (argsText !== '') {
    let parsed: unknown;
    let readable = true;
    try {
      parsed = JSON.parse(argsText);
    } catch {
      readable = false;
    }
    if (!readable) {
      errors.push({ fieldId: FIELD_IDS.args, message: '参数必须是 JSON 字符串数组，当前文本无法解析' });
    } else if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      errors.push({ fieldId: FIELD_IDS.args, message: '参数必须是 JSON 字符串数组，例如 ["--dir","/srv"]' });
    }
  }

  const credential = draft.credentialEnv.trim();
  if (credential !== '' && !CREDENTIAL_ENV_PATTERN.test(credential)) {
    errors.push({
      fieldId: FIELD_IDS.credential,
      message: `凭据只填环境变量名：${credential} 不是合法的变量名，这里不接受凭据值`,
    });
  }

  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') {
      errors.push({ fieldId: FIELD_IDS.command, message: 'stdio 方式的连接器必须给出命令' });
    }
    if (draft.url.trim() !== '') {
      errors.push({ fieldId: FIELD_IDS.url, message: 'stdio 方式的连接器不接受地址' });
    }
  } else {
    const url = draft.url.trim();
    if (url === '') {
      errors.push({ fieldId: FIELD_IDS.url, message: 'http 方式的连接器必须给出地址' });
    } else {
      const verdict = urlVerdictOf(url);
      if (!verdict.ok) errors.push({ fieldId: FIELD_IDS.url, message: verdict.message as string });
    }
    if (draft.command.trim() !== '') {
      errors.push({ fieldId: FIELD_IDS.command, message: 'http 方式的连接器不接受命令' });
    }
    if (argsText !== '') {
      errors.push({ fieldId: FIELD_IDS.args, message: 'http 方式的连接器不接受参数' });
    }
  }
  return errors;
}

/**
 * 把草稿转成写入输入；条件字段按传输方式剔除。
 * @param draft - 已通过校验的草稿。
 * @param id - 修改时的连接器标识。
 * @returns 写入输入。
 */
export function inputOf(draft: ConnectorDraft, id?: string): {
  readonly id?: string;
  readonly name: string;
  readonly transport: ConnectorTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentialEnv?: string;
  readonly enabled: boolean;
} {
  const credentialEnv = draft.credentialEnv.trim();
  const common = {
    ...(id === undefined ? {} : { id }),
    name: draft.name.trim(),
    transport: draft.transport,
    ...(credentialEnv === '' ? {} : { credentialEnv }),
    enabled: draft.enabled,
  };
  if (draft.transport === 'stdio') {
    const args = parseArgs(draft.argsText);
    return {
      ...common,
      transport: 'stdio',
      command: draft.command.trim(),
      ...(args.length === 0 ? {} : { args }),
    };
  }
  return { ...common, transport: 'http', url: draft.url.trim() };
}

/**
 * 把一条记录转成草稿。
 * @param record - 连接器记录。
 * @returns 表单草稿。
 */
export function draftOfRecord(record: ConnectorRecord): ConnectorDraft {
  return {
    name: record.name,
    transport: record.transport,
    command: record.command ?? '',
    argsText: record.args === undefined || record.args.length === 0 ? '' : JSON.stringify(record.args),
    url: record.url ?? '',
    credentialEnv: record.credentialEnv ?? '',
    enabled: record.enabled,
  };
}

/**
 * 列表行的目标说明。
 * @param record - 连接器记录。
 * @returns 命令与参数或地址。
 */
export function targetOf(record: ConnectorRecord): string {
  if (record.transport === 'http') return record.url ?? '地址未填写';
  const args = record.args === undefined || record.args.length === 0 ? '' : ` ${record.args.join(' ')}`;
  return `${record.command ?? '命令未填写'}${args}`;
}

/** 传输方式的展示名。 */
export function transportLabelOf(transport: ConnectorTransport): string {
  return transport === 'stdio' ? 'stdio' : 'http';
}

/** 配置保存徽标：记录已经落在结构化存储里。 */
export function configBadge(): BadgeView {
  return { tone: 'neutral', label: '已保存' };
}

/**
 * 同步徽标；`syncing` 表示本次调用进行中。
 * @param state - 状态视图。
 * @param syncing - 是否有同步调用在途。
 * @returns 徽标取值。
 */
export function syncBadgeOf(state: ConnectorStateView, syncing = false): BadgeView {
  if (syncing) return { tone: 'warn', label: '同步中' };
  const sync: ConnectorSyncState | undefined = state.sync;
  if (sync === undefined) return { tone: 'neutral', label: '未同步' };
  return sync.status === 'failed' ? { tone: 'danger', label: '同步失败' } : { tone: 'ok', label: '同步成功' };
}

/**
 * 启用徽标。
 * @param state - 状态视图。
 * @returns 徽标取值。
 */
export function enabledBadgeOf(state: ConnectorStateView): BadgeView {
  return state.enabled ? { tone: 'ok', label: '启用' } : { tone: 'neutral', label: '已停用' };
}

/**
 * 连接状态徽标：有行且目录里有工具才算连上。
 * @param state - 状态视图。
 * @returns 徽标取值。
 */
export function connectionBadgeOf(state: ConnectorStateView): BadgeView {
  if (state.rows.length > 0 && state.tools.length > 0) return { tone: 'ok', label: '已连接' };
  if (state.rows.length > 0) return { tone: 'warn', label: '已生成行，等待工具' };
  return { tone: 'neutral', label: '未接入目录' };
}

/**
 * 把毫秒时间戳写成 `YYYY-MM-DD HH:mm:ss`。
 * @param at - 毫秒时间戳。
 * @returns 展示文字。
 */
export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 一条同步状态的完整说明：状态、错误码、错误类型与最近时间。
 * @param sync - 同步状态。
 * @returns 说明文字。
 */
export function describeSync(sync: ConnectorSyncState | undefined): string {
  if (sync === undefined) return '还没有同步过：等待第一次同步。';
  const outcome = sync.status === 'failed' ? '同步失败' : '同步成功';
  if (sync.status === 'failed') {
    const code = sync.errorCode ?? 'unknown';
    const type = sync.errorType ?? 'Error';
    return `${outcome}：错误码 ${code}（${type}），最近 ${formatTime(sync.at)}；配置已保存，加载器行没有生效。`;
  }
  return `${outcome}：${String(sync.rows)} 行，最近 ${formatTime(sync.at)}。`;
}

/**
 * 工具调用被界面拦下的原因。
 * @param state - 状态视图。
 * @returns 原因文字；可以调用时返回 undefined。
 */
export function callDeniedReason(state: ConnectorStateView): string | undefined {
  if (!state.enabled) return '这个连接器已停用：工具已从目录移除，宿主会拒绝这次测试。';
  if (state.tools.length === 0) return '目录里没有这台服务器的工具：先重新同步并等待服务器握手完成。';
  return undefined;
}

/**
 * 从同步计划里取名称冲突说明。
 * @param plan - 同步计划。
 * @returns 冲突说明；没有冲突时返回 undefined。
 */
export function describeConflicts(plan: { readonly conflicts: readonly { readonly names: readonly string[] }[] }): string | undefined {
  if (plan.conflicts.length === 0) return undefined;
  const names = plan.conflicts.flatMap((conflict) => conflict.names);
  return `名称规范化后冲突，服务器名只能由一个连接器占用：${names.join('、')}`;
}

/**
 * 从注册表行标识里取本机端点覆盖的服务器名。
 * @param rows - 加载器行标识。
 * @returns 去重并排序的服务器名。
 */
export function registryServersOf(rows: readonly string[]): string[] {
  const servers = new Set<string>();
  for (const row of rows) {
    const server = registryServerOf(row);
    if (server !== undefined && server !== '') servers.add(server);
  }
  return [...servers].sort((left, right) => left.localeCompare(right));
}

/**
 * 把宿主返回的一条错误说明对应到最可能的字段。
 * @param message - 宿主错误说明。
 * @returns 字段标识；无法判定时返回 undefined。
 */
export function fieldOfHostMessage(message: string): string | undefined {
  if (message.includes('名称')) return FIELD_IDS.name;
  if (message.includes('参数')) return FIELD_IDS.args;
  if (message.includes('凭据') || message.includes('变量名')) return FIELD_IDS.credential;
  if (message.includes('命令')) return FIELD_IDS.command;
  if (message.includes('地址') || message.includes('URL')) return FIELD_IDS.url;
  return undefined;
}

/**
 * 把一次失败写成面向用户的一句话。
 *
 * 宿主抛出的业务错误经过 Remote 边界后只剩通用错误码与原始说明，业务错误码只出现在同步
 * 状态里（见 {@link describeSync}），因此这里按说明文字给出信息，不臆造错误码。
 * @param error - 失败对象。
 * @returns 说明文字。
 */
export function describeFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly code?: unknown; readonly message?: unknown };
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (code === CLIENT_ERROR_CODES.offline) return '控制平面不可达，恢复连接后重新加载。';
    if (code === CLIENT_ERROR_CODES.unavailable) return '当前部署没有提供这项能力。';
    if (code === 'gateway/internal') {
      return message === '' ? '宿主没有完成这次调用，也没有给出说明。' : `${message}。`;
    }
    if (message !== '') return code === '' ? message : `${message}（${code}）`;
    if (code !== '') return `操作没有完成（${code}）。`;
  }
  return '操作没有完成，请稍后再试。';
}
