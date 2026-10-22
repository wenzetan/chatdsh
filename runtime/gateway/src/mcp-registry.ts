/**
 * MCP 服务器的全局注册与按设备端点记录。
 *
 * 两张表各管一件事：
 * - `mcp_servers` 是全局注册，记录「这个账号下有哪些 MCP」。任一设备上报的服务器都进
 *   这里，所有设备都能读到，因此 A 端配置的 MCP 在 B 端也看得见。
 * - `mcp_endpoints` 是每端一段连接参数。同一台服务器在内网机器上可以是 `npx` 启动，
 *   在外网设备上只能是 HTTPS 地址；两段共享同一个服务器名，模型看到的是同一项能力。
 *
 * 启用状态不进这两张表：是否启用由各端自己决定。凭据值也不进：只存环境变量名，值留在
 * 各端的环境里。
 * @module @chatdsh/gateway/mcp-registry
 */

import type { DatabaseSync } from 'node:sqlite';

import type {
  McpEndpointRecord,
  McpEndpointRow,
  McpServerInput,
  McpServerRecord,
  McpSnapshot,
  McpTransport,
} from '@chatdsh/core-contracts';

export type { McpEndpointRecord, McpEndpointRow, McpServerInput, McpServerRecord, McpSnapshot, McpTransport };

/** 服务器名允许的形状。 */
const SERVER_NAME = /[^A-Za-z0-9_-]/g;

/** 把展示名规范成合法的服务器名。 */
export function toServerName(name: string): string {
  const normalized = name.replace(SERVER_NAME, '-').slice(0, 32);
  if (normalized === '' || !/[A-Za-z0-9]/.test(normalized)) {
    throw new Error(`服务器名 ${name} 规范化后为空，只允许字母、数字、下划线与连字符`);
  }
  return normalized;
}

/** 上报结构不合法。 */
export class McpRegistryError extends Error {
  /** 固定错误码。 */
  readonly code = 'mcp-registry/invalid';

  constructor(message: string) {
    super(message);
    this.name = 'McpRegistryError';
  }
}

/** 校验一条上报。 */
function normalizeInput(name: string, input: McpServerInput): { transport: McpTransport; row: McpEndpointRow } {
  const type = input.type ?? (typeof input.command === 'string' ? 'stdio' : 'http');
  if (type === 'stdio') {
    if (typeof input.command !== 'string' || input.command === '') {
      throw new McpRegistryError(`服务器 ${name} 是 stdio 方式，缺少 command`);
    }
    return {
      transport: 'stdio',
      row: {
        command: input.command,
        ...(input.args === undefined ? {} : { args: [...input.args] }),
      },
    };
  }
  if (typeof input.url !== 'string' || input.url === '') {
    throw new McpRegistryError(`服务器 ${name} 是 ${type} 方式，缺少 url`);
  }
  return {
    transport: 'http',
    row: {
      url: input.url,
      ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
    },
  };
}

/** 注册表。 */
export class McpRegistry {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      create table if not exists mcp_servers (
        account_id text not null,
        name text not null,
        created_by text not null,
        created_at integer not null,
        primary key (account_id, name)
      );
      create table if not exists mcp_endpoints (
        account_id text not null,
        server text not null,
        device_id text not null,
        transport text not null,
        row text not null,
        credential_env text,
        updated_at integer not null,
        primary key (account_id, server, device_id)
      );
      create index if not exists mcp_endpoints_by_device on mcp_endpoints(account_id, device_id);
    `);
  }

  /**
   * 覆盖式上报一台设备的一组服务器。
   *
   * 同一设备本次没有出现的服务器，其端点会被移除；全局注册在该服务器已无任何端点时
   * 一并移除，避免留下没有连接方式的空条目。
   * @param accountId - 账号标识。
   * @param deviceId - 设备标识。
   * @param servers - VSCode 形状的 `servers` 字典。
   * @returns 写入的服务器数量。
   */
  upsertServers(accountId: string, deviceId: string, servers: Readonly<Record<string, McpServerInput>>): number {
    const now = Date.now();
    const prepared = Object.entries(servers).map(([name, input]) => {
      const serverName = toServerName(name);
      const { transport, row } = normalizeInput(name, input);
      return { serverName, transport, row, credentialEnv: input.credentialEnv };
    });
    const names = new Set(prepared.map((entry) => entry.serverName));
    const previous = this.database
      .prepare('select server from mcp_endpoints where account_id = ? and device_id = ?')
      .all(accountId, deviceId) as unknown as { server: string }[];

    this.database.exec('begin');
    try {
      for (const entry of prepared) {
        this.database.prepare(
          `insert into mcp_servers (account_id, name, created_by, created_at) values (?, ?, ?, ?)
           on conflict(account_id, name) do nothing`,
        ).run(accountId, entry.serverName, deviceId, now);
        this.database.prepare(
          `insert into mcp_endpoints (account_id, server, device_id, transport, row, credential_env, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(account_id, server, device_id) do update set
             transport = excluded.transport,
             row = excluded.row,
             credential_env = excluded.credential_env,
             updated_at = excluded.updated_at`,
        ).run(accountId, entry.serverName, deviceId, entry.transport, JSON.stringify(entry.row), entry.credentialEnv ?? null, now);
      }
      for (const item of previous) {
        if (names.has(item.server)) continue;
        this.database.prepare('delete from mcp_endpoints where account_id = ? and device_id = ? and server = ?')
          .run(accountId, deviceId, item.server);
        this.pruneServer(accountId, item.server);
      }
      this.database.exec('commit');
    } catch (error) {
      this.database.exec('rollback');
      throw error;
    }
    return prepared.length;
  }

  /**
   * 移除一台设备的一段端点。
   * @param accountId - 账号标识。
   * @param deviceId - 设备标识。
   * @param server - 服务器名。
   */
  removeServer(accountId: string, deviceId: string, server: string): void {
    this.database.prepare('delete from mcp_endpoints where account_id = ? and device_id = ? and server = ?')
      .run(accountId, deviceId, toServerName(server));
    this.pruneServer(accountId, toServerName(server));
  }

  /** 某账号的注册快照。 */
  snapshot(accountId: string): McpSnapshot {
    const servers = this.database
      .prepare('select name, created_by, created_at from mcp_servers where account_id = ? order by name')
      .all(accountId) as unknown as { name: string; created_by: string; created_at: number }[];
    const endpoints = this.database
      .prepare('select server, device_id, transport, row, credential_env, updated_at from mcp_endpoints where account_id = ? order by server, device_id')
      .all(accountId) as unknown as {
        server: string;
        device_id: string;
        transport: string;
        row: string;
        credential_env: string | null;
        updated_at: number;
      }[];
    return {
      servers: servers.map((server) => ({ name: server.name, createdBy: server.created_by, createdAt: server.created_at })),
      endpoints: endpoints.map((endpoint) => ({
        server: endpoint.server,
        deviceId: endpoint.device_id,
        transport: endpoint.transport === 'stdio' ? 'stdio' : 'http',
        row: JSON.parse(endpoint.row) as McpEndpointRow,
        ...(endpoint.credential_env === null ? {} : { credentialEnv: endpoint.credential_env }),
        updatedAt: endpoint.updated_at,
      })),
    };
  }

  /** 没有任何端点时移除全局注册。 */
  private pruneServer(accountId: string, server: string): void {
    const row = this.database
      .prepare('select count(*) as count from mcp_endpoints where account_id = ? and server = ?')
      .get(accountId, server) as { count: number } | undefined;
    if ((row?.count ?? 0) === 0) {
      this.database.prepare('delete from mcp_servers where account_id = ? and name = ?').run(accountId, server);
    }
  }
}
