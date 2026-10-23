/**
 * MCP 接入配置的解析。
 *
 * 配置采用 VSCode 的 `mcp.json` 形状：顶层 `servers` 字典，键是服务器名，值是连接
 * 参数。`type` 取 `stdio`、`http` 或 `sse`；省略时按是否给出 `command` 推断。
 *
 * 凭据不写进配置：`env` 与 `headers` 的值可以是 `${env:NAME}` 形式的引用，装配时再
 * 解析成实际值。这一层是纯函数，不读环境、不连网络，便于单独验证。
 * @module @chatdsh/host-connectors/config
 */

import type { McpEndpointRecord } from '@chatdsh/core-contracts';

/** MCP 客户端的包名，生成的加载器行都指向它。 */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** 条目 id 前缀，同步时按它识别本插件生成的行。 */
export const MCP_ROW_PREFIX = 'chatdsh-mcp-endpoint-';

/** 一条 stdio 服务器的行配置。 */
export interface StdioRow {
  readonly transport: 'stdio';
  readonly serverName: string;
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/** 一条 Streamable HTTP 服务器的行配置。 */
export interface HttpRow {
  readonly transport: 'streamable-http';
  readonly serverName: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** 解析后的一条服务器。 */
export interface McpServerEntry {
  /** 规范化后的服务器名，用于工具名前缀与条目 id。 */
  readonly serverName: string;
  /** 配置里的原始名字，用于展示。 */
  readonly displayName: string;
  /** 加载器行配置。 */
  readonly row: StdioRow | HttpRow;
}

/** 一条待写入加载器的行。 */
export interface McpLoaderRow {
  /** 条目标识。 */
  readonly rowId: string;
  /** 条目指向的包名。 */
  readonly name: string;
  /** 条目配置。 */
  readonly config: StdioRow | HttpRow;
}

/** 配置不合法。 */
export class McpConfigError extends Error {
  /** 固定错误码，供遥测与界面按码分支。 */
  readonly code = 'mcp-config/invalid';

  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

/** 服务器名允许的形状。 */
const SERVER_NAME = /[^A-Za-z0-9_-]/g;

/**
 * 把展示名规范成合法的服务器名。
 *
 * 只保留字母、数字、下划线与连字符，截断到 32 个字符；结果为空时抛错，让配置错误在
 * 装配阶段暴露，而不是在连接阶段变成难查的命名冲突。
 * @param name - 配置里的服务器名。
 * @returns 规范化后的名字。
 */
export function toServerName(name: string): string {
  const normalized = name.replace(SERVER_NAME, '-').slice(0, 32);
  if (normalized === '' || !/[A-Za-z0-9]/.test(normalized)) {
    throw new McpConfigError(`服务器名 ${name} 规范化后为空，只允许字母、数字、下划线与连字符`);
  }
  return normalized;
}

/** 读一个可选的字符串表。 */
function stringRecord(value: unknown, field: string, server: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpConfigError(`服务器 ${server} 的 ${field} 必须是字符串字典`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new McpConfigError(`服务器 ${server} 的 ${field}.${key} 必须是字符串`);
    out[key] = item;
  }
  return out;
}

/** 读一个字符串数组。 */
function stringArray(value: unknown, field: string, server: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new McpConfigError(`服务器 ${server} 的 ${field} 必须是字符串数组`);
  }
  return [...value] as string[];
}

/**
 * 解析一份 VSCode 形状的 MCP 配置。
 * @param value - 配置对象。
 * @returns 按配置里的顺序解析出的服务器。
 * @throws {@link McpConfigError} 结构、类型或必填项不合法。
 */
export function parseMcpConfig(value: unknown): McpServerEntry[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpConfigError('MCP 配置必须是 JSON 对象');
  }
  const servers = (value as { servers?: unknown }).servers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new McpConfigError('MCP 配置缺少 servers 字典');
  }
  const entries: McpServerEntry[] = [];
  const seen = new Set<string>();
  for (const [displayName, raw] of Object.entries(servers)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new McpConfigError(`服务器 ${displayName} 的配置必须是对象`);
    }
    const record = raw as Record<string, unknown>;
    const declaredType = record.type;
    if (declaredType !== undefined && declaredType !== 'stdio' && declaredType !== 'http' && declaredType !== 'sse') {
      throw new McpConfigError(`服务器 ${displayName} 的 type 只支持 stdio、http 或 sse，实际 ${String(declaredType)}`);
    }
    const type = declaredType ?? (typeof record.command === 'string' ? 'stdio' : 'http');
    const serverName = toServerName(displayName);
    if (seen.has(serverName)) throw new McpConfigError(`服务器名 ${displayName} 规范化后与另一条重复：${serverName}`);
    seen.add(serverName);

    if (type === 'stdio') {
      if (typeof record.command !== 'string' || record.command === '') {
        throw new McpConfigError(`服务器 ${displayName} 是 stdio 方式，缺少 command`);
      }
      entries.push({
        serverName,
        displayName,
        row: {
          transport: 'stdio',
          serverName,
          command: record.command,
          args: stringArray(record.args, 'args', displayName),
          env: stringRecord(record.env, 'env', displayName),
        },
      });
      continue;
    }
    if (typeof record.url !== 'string' || record.url === '') {
      throw new McpConfigError(`服务器 ${displayName} 是 ${type} 方式，缺少 url`);
    }
    entries.push({
      serverName,
      displayName,
      row: {
        transport: 'streamable-http',
        serverName,
        url: record.url,
        headers: stringRecord(record.headers, 'headers', displayName),
      },
    });
  }
  return entries;
}

/**
 * 把解析结果转成加载器行。
 * @param entries - 解析出的服务器。
 * @returns 带条目标识的加载器行。
 */
export function rowsOf(entries: readonly McpServerEntry[]): McpLoaderRow[] {
  return entries.map((entry) => ({
    rowId: `${MCP_ROW_PREFIX}${entry.serverName}`,
    name: MCP_CLIENT_PACKAGE,
    config: entry.row,
  }));
}

/**
 * 解析 `${env:NAME}` 形式的引用；不含引用的值原样返回。
 * @param value - 配置里的值。
 * @param env - 环境变量表。
 * @returns 解析后的值。
 * @throws {@link McpConfigError} 引用的环境变量不存在。
 */
export function resolveEnvReference(value: string, env: NodeJS.ProcessEnv): string {
  const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (match === null) return value;
  const name = match[1] as string;
  const resolved = env[name];
  if (resolved === undefined || resolved === '') {
    throw new McpConfigError(`环境变量 ${name} 没有值，MCP 服务器的凭据引用无法解析`);
  }
  return resolved;
}

/**
 * 把控制平面里的一条端点记录转成 MCP 客户端的加载器配置。
 *
 * 凭据由本机环境提供：记录里只有环境变量名，这里读出值填进 `env` 或 `headers`。
 * 变量缺失时不填，让 DSH 原生客户端在握手阶段失败，由它报告不可达。
 * @param endpoint - 端点记录。
 * @returns 加载器配置。
 */
export function toLoaderConfig(endpoint: McpEndpointRecord): StdioRow | HttpRow {
  if (endpoint.transport === 'stdio') {
    const env: Record<string, string> = {};
    if (endpoint.credentialEnv !== undefined) {
      const value = process.env[endpoint.credentialEnv];
      if (value !== undefined && value !== '') env[endpoint.credentialEnv] = value;
    }
    return {
      transport: 'stdio',
      serverName: endpoint.server,
      command: endpoint.row.command ?? '',
      args: [...(endpoint.row.args ?? [])],
      env,
    };
  }
  const headers: Record<string, string> = { ...(endpoint.row.headers ?? {}) };
  if (endpoint.credentialEnv !== undefined) {
    const value = process.env[endpoint.credentialEnv];
    if (value !== undefined && value !== '') headers.Authorization = `Bearer ${value}`;
  }
  return {
    transport: 'streamable-http',
    serverName: endpoint.server,
    url: endpoint.row.url ?? '',
    headers,
  };
}
