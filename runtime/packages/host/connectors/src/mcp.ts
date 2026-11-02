/**
 * 把连接器记录转成 MCP 客户端的行配置。
 *
 * MCP 客户端每个实例连接一个服务器，工具注册为 `mcp__<serverName>__<rawName>`，因此
 * `serverName` 要满足 `[A-Za-z0-9_-]{1,32}` 的约束。凭据值不写进记录：计划里只带凭据
 * 所在的环境变量名，装配行时再从本机环境读出值注入子进程环境或请求头。
 * @module @chatdsh/host-connectors/mcp
 */

/** 一条连接器记录里与配置生成相关的字段。 */
export interface ConnectorSpec {
  readonly id?: string;
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
  /** 装配时注入的子进程环境变量，键是凭据所在的环境变量名。 */
  readonly env?: Record<string, string>;
}

/** streamable-http 传输的行配置。 */
export interface HttpRowConfig {
  readonly transport: 'streamable-http';
  readonly serverName: string;
  readonly url: string;
  /** 装配时注入的请求头。 */
  readonly headers?: Record<string, string>;
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
      ...(spec.credentialEnv === undefined ? {} : { credentialEnv: spec.credentialEnv }),
    };
  }
  if ((spec.url ?? '') === '') throw new Error(`连接器 ${spec.name} 缺少地址`);
  return {
    row: {
      transport: 'streamable-http',
      serverName,
      url: spec.url as string,
    },
    ...(spec.credentialEnv === undefined ? {} : { credentialEnv: spec.credentialEnv }),
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
  /** 凭据所在的环境变量名；计划里只有名字，没有值。 */
  readonly credentialEnv?: string;
}

/** 名称规范化后的冲突：两条记录想要同一个服务器名。 */
export interface McpNameConflict {
  /** 冲突的条目 id。 */
  readonly rowId: string;
  /** 冲突的连接器标识。 */
  readonly ids: string[];
  /** 冲突的展示名。 */
  readonly names: string[];
}

/** 同步计划：把现有行调整到与连接器记录一致。 */
export interface McpSyncPlan {
  /** 需要新建的行。 */
  readonly create: PlannedRow[];
  /** 已经存在、需要按最新记录覆盖的行。 */
  readonly update: PlannedRow[];
  /** 记录里已经不存在、需要移除的行 id。 */
  readonly remove: string[];
  /** 名称规范化后互相冲突的连接器；非空时同步必须整体拒绝。 */
  readonly conflicts: McpNameConflict[];
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

/**
 * 算出把现有行调整到与连接器记录一致所需的动作。
 *
 * 只处理本插件生成的行（按前缀识别），落在前缀之外的条目一律不动。两条启用的记录
 * 规范化成同一个服务器名时收进 `conflicts`：同一个工具命名空间不能由两种连接方式共占。
 * @param specs - 连接器记录。
 * @param existingRowIds - 当前加载器里的全部条目 id。
 * @returns 新建、覆盖、移除三组动作与名称冲突。
 */
export function planMcpSync(specs: readonly ConnectorSpec[], existingRowIds: readonly string[]): McpSyncPlan {
  const results = buildMcpRows(specs);
  const desired: PlannedRow[] = results.map((result) => ({
    rowId: rowIdOf(result.row.serverName),
    row: result.row,
    ...(result.credentialEnv === undefined ? {} : { credentialEnv: result.credentialEnv }),
  }));
  const grouped = new Map<string, { ids: string[]; names: string[] }>();
  for (const spec of specs) {
    if (!spec.enabled) continue;
    const rowId = rowIdOf(toServerName(spec.name));
    const slot = grouped.get(rowId) ?? { ids: [], names: [] };
    slot.ids.push(spec.id ?? spec.name);
    slot.names.push(spec.name);
    grouped.set(rowId, slot);
  }
  const conflicts: McpNameConflict[] = [...grouped]
    .filter(([, slot]) => slot.names.length > 1)
    .map(([rowId, slot]) => ({ rowId, ids: slot.ids, names: slot.names }));

  const existing = new Set(existingRowIds.filter((id) => id.startsWith(ROW_PREFIX)));
  const create: PlannedRow[] = [];
  const update: PlannedRow[] = [];
  for (const planned of desired) {
    if (existing.has(planned.rowId)) update.push(planned);
    else create.push(planned);
  }
  const desiredIds = new Set(desired.map((planned) => planned.rowId));
  const remove = [...existing].filter((id) => !desiredIds.has(id));
  return { create, update, remove, conflicts };
}

/** 装配结果。 */
export interface RowAssembly {
  /** 可用于加载器的行。 */
  readonly row: StdioRowConfig | HttpRowConfig;
  /** 凭据变量在本机环境里没有值时给出变量名。 */
  readonly missingCredential?: string;
}

/**
 * 装配一行：按本机环境把凭据注入子进程环境或请求头。
 *
 * 记录里只有变量名，值只出现在这次装配产出的行里，不会回到记录、也不会经 Remote 读出。
 * @param row - 计划里的行配置。
 * @param credentialEnv - 凭据所在的环境变量名。
 * @param env - 本机环境。
 * @returns 装配后的行；变量没有值时给出缺失的变量名。
 */
export function assembleRowConfig(
  row: StdioRowConfig | HttpRowConfig,
  credentialEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): RowAssembly {
  if (credentialEnv === undefined) return { row };
  const value = env[credentialEnv];
  if (value === undefined || value === '') return { row, missingCredential: credentialEnv };
  if (row.transport === 'stdio') {
    return { row: { ...row, env: { [credentialEnv]: value } } };
  }
  return { row: { ...row, headers: { ...(row.headers ?? {}), Authorization: `Bearer ${value}` } } };
}
