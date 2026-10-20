/**
 * 把连接器记录转成 MCP 客户端的行配置。
 *
 * MCP 客户端每个实例连接一个服务器，工具注册为 `mcp__<serverName>__<rawName>`，因此
 * `serverName` 要满足 `[A-Za-z0-9_-]{1,32}` 的约束。凭据值不写进配置：函数只回传凭据
 * 所在的环境变量名，由装配方在注入时读取。
 * @module @chatdsh/host-connectors/mcp
 */

/** 一条连接器记录里与配置生成相关的字段。 */
export interface ConnectorSpec {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentialEnv?: string;
  readonly enabled: boolean;
}

/** stdio 传输的行配置。 */
export interface StdioRowConfig {
  readonly transport: 'stdio';
  readonly serverName: string;
  readonly command: string;
  readonly args: string[];
}

/** streamable-http 传输的行配置。 */
export interface HttpRowConfig {
  readonly transport: 'streamable-http';
  readonly serverName: string;
  readonly url: string;
}

/** 生成结果。 */
export interface McpRowResult {
  /** 可直接写进 loader 的行配置。 */
  readonly row: StdioRowConfig | HttpRowConfig;
  /** 凭据所在的环境变量名，装配方据此注入请求头或子进程环境。 */
  readonly credentialEnv?: string;
}

/**
 * 把展示名规范成合法的服务器名。
 *
 * 非法字符替换为连字符，超长截断；名字为空时给一个固定值，保证约束始终满足。
 * @param name - 连接器的展示名。
 * @returns 满足约束的服务器名。
 */
export function toServerName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
  return normalized === '' ? 'connector' : normalized;
}

/**
 * 生成一个连接器的 MCP 行配置。
 * @param spec - 连接器记录。
 * @returns 行配置与凭据来源；连接器信息不完整时抛出，说明缺哪一项。
 */
export function buildMcpRow(spec: ConnectorSpec): McpRowResult {
  const serverName = toServerName(spec.name);
  if (spec.transport === 'stdio') {
    if ((spec.command ?? '') === '') throw new Error(`连接器 ${spec.name} 缺少命令`);
    return {
      row: {
        transport: 'stdio',
        serverName,
        command: spec.command as string,
        args: [...(spec.args ?? [])],
      },
      credentialEnv: spec.credentialEnv,
    };
  }
  if ((spec.url ?? '') === '') throw new Error(`连接器 ${spec.name} 缺少地址`);
  return {
    row: {
      transport: 'streamable-http',
      serverName,
      url: spec.url as string,
    },
    credentialEnv: spec.credentialEnv,
  };
}

/**
 * 为全部启用的连接器生成行配置。
 * @param specs - 连接器记录。
 * @returns 行配置列表，顺序与输入一致；停用的条目被跳过。
 */
export function buildMcpRows(specs: readonly ConnectorSpec[]): McpRowResult[] {
  return specs.filter((spec) => spec.enabled).map((spec) => buildMcpRow(spec));
}

/** 连接器生成的加载器条目 id 前缀。 */
export const ROW_PREFIX = 'chatdsh-connector-';

/**
 * 算出某个服务器名对应的条目 id。
 * @param serverName - 服务器名。
 * @returns 条目 id。
 */
export function rowIdOf(serverName: string): string {
  return `${ROW_PREFIX}${serverName}`;
}

/** 一条待写入的行。 */
export interface PlannedRow {
  readonly rowId: string;
  readonly row: StdioRowConfig | HttpRowConfig;
}

/**
 * 加载器条目的配置。
 *
 * 加载器在条目缺标识时自己生成一个随机值，生成出来的标识与同步计划里的对不上：
 * 下一轮同步会把同一台服务器当成新的再建一次，停用的连接器也永远匹配不到要
 * 移除的旧行。因此标识必须显式给出。
 */
export interface LoaderEntryOptions {
  readonly id: string;
  readonly name: string;
  readonly config: StdioRowConfig | HttpRowConfig;
}

/**
 * 造出一个加载器条目。
 * @param rowId - 条目标识，与同步计划里的一致。
 * @param packageName - 条目指向的插件包名。
 * @param row - 条目的配置。
 * @returns 可直接交给加载器的条目。
 */
export function loaderEntryOf(rowId: string, packageName: string, row: StdioRowConfig | HttpRowConfig): LoaderEntryOptions {
  return { id: rowId, name: packageName, config: row };
}

/** 同步计划：把现有行调整到与连接器记录一致。 */
export interface McpSyncPlan {
  /** 需要新建的行。 */
  readonly create: PlannedRow[];
  /** 已经存在、需要按最新记录覆盖的行。 */
  readonly update: PlannedRow[];
  /** 记录里已经不存在、需要移除的行 id。 */
  readonly remove: string[];
}

/**
 * 算出把现有行调整到与连接器记录一致所需的动作。
 *
 * 只处理本插件生成的行（按前缀识别），落在前缀之外的条目一律不动。
 * @param specs - 连接器记录。
 * @param existingRowIds - 当前加载器里的全部条目 id。
 * @returns 新建、覆盖与移除三组动作。
 */
export function planMcpSync(specs: readonly ConnectorSpec[], existingRowIds: readonly string[]): McpSyncPlan {
  const desired = buildMcpRows(specs).map((result) => ({ rowId: rowIdOf(result.row.serverName), row: result.row }));
  const existing = new Set(existingRowIds.filter((id) => id.startsWith(ROW_PREFIX)));
  const create: PlannedRow[] = [];
  const update: PlannedRow[] = [];
  for (const planned of desired) {
    if (existing.has(planned.rowId)) update.push(planned);
    else create.push(planned);
  }
  const desiredIds = new Set(desired.map((planned) => planned.rowId));
  const remove = [...existing].filter((id) => !desiredIds.has(id));
  return { create, update, remove };
}
