/**
 * 连接器。
 *
 * 记录用户要接入的外部能力：名字、传输方式、可执行文件或地址、凭据所在的环境变量名。
 * 凭据本身不落库，只保存变量名，读取时由运行环境提供。这一层负责记录的增删与启停，
 * 把记录转成 MCP 条目、以及凭据的授权流程由后续的集成步骤完成。
 * @module @chatdsh/host-connectors
 */

import {
  loaderOf,
  Remote,
  storageDomainOf,
  TypertRemoteService,
  type Context,
  type EntryOptions,
} from '@chatdsh/adapter';
import { UPSTREAM_MCP_CLIENT } from '@chatdsh/adapter/upstream';
import { CONNECTORS_DOMAIN, TRANSPORTS, type ConnectorRecord } from './domain.ts';
import { buildMcpRows, loaderEntryOf, planMcpSync, type McpRowResult, type McpSyncPlan } from './mcp.ts';
import { toLoaderConfig, MCP_ROW_PREFIX } from './config.ts';
import { McpRegistryClient } from './registry-client.ts';

export type { ConnectorRecord } from './domain.ts';
export { CONNECTORS_DOMAIN, TRANSPORTS } from './domain.ts';
export { buildMcpRow, buildMcpRows, loaderEntryOf, planMcpSync, rowIdOf, toServerName } from './mcp.ts';
export { McpConfigError, parseMcpConfig, resolveEnvReference, rowsOf } from './config.ts';
export type { HttpRow, McpLoaderRow, McpServerEntry, StdioRow } from './config.ts';
export type {
  ConnectorSpec,
  HttpRowConfig,
  LoaderEntryOptions,
  McpRowResult,
  McpSyncPlan,
  PlannedRow,
  StdioRowConfig,
} from './mcp.ts';

/** MCP 客户端的包名，连接器的行都指向它。 */
export const MCP_CLIENT_PACKAGE = UPSTREAM_MCP_CLIENT;

/** 插件名。 */
export const name = 'chatdsh-connectors';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshConnectors';

/** 建立或更新连接器的输入。 */
export interface ConnectorInput {
  readonly id?: string;
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentialEnv?: string;
  readonly enabled?: boolean;
}

/** 表格形状，只用到的方法。 */
interface Table<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  /** 写入是异步的：结构化存储落盘在返回后才算完成。 */
  put(key: string, value: V): Promise<void>;
  /** 删除是异步的：返回值表示这一行确实存在并被删掉。 */
  delete(key: string): Promise<boolean>;
}

/**
 * 校验一条记录是否完整。
 * @param input - 待校验的输入。
 * @returns 校验通过的说明，或缺失项的描述。
 */
export function validateConnector(input: ConnectorInput): { ok: true } | { ok: false; missing: string } {
  if (input.name.trim() === '') return { ok: false, missing: 'name' };
  if (!TRANSPORTS.includes(input.transport)) return { ok: false, missing: 'transport' };
  if (input.transport === 'stdio' && (input.command ?? '') === '') return { ok: false, missing: 'command' };
  if (input.transport === 'http' && (input.url ?? '') === '') return { ok: false, missing: 'url' };
  return { ok: true };
}

/** 需要的遥测面。 */
interface ConnectorsTelemetry {
  runSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  /** 取得计数器句柄；句柄的 `add` 才真正累加计数。 */
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
  /** 记一条日志；条数写进正文，便于在日志信号里直接读出同步结果。 */
  log(level: string, message: string, attributes?: Record<string, unknown>): void;
}

/** 连接器服务。 */
/** 连接器服务配置。 */
export interface ConnectorsConfig {
  /** 控制平面地址；缺省不拉取注册表。 */
  readonly gatewayUrl?: string;
  /** 本设备标识，与控制平面的设备记录一致。 */
  readonly deviceId?: string;
  /** 读取注册表的超时，单位毫秒。 */
  readonly requestTimeoutMs?: number;
}

export class ChatdshConnectorService extends TypertRemoteService {
  static inject = ['storageDomain', 'loader'];

  private readonly config: { gatewayUrl?: string; deviceId: string; requestTimeoutMs: number };

  private connectors: Table<ConnectorRecord> | undefined;

  constructor(ctx: Context, config: ConnectorsConfig = {}) {
    super(ctx, SERVICE_NAME);
    this.config = {
      ...(config.gatewayUrl === undefined ? {} : { gatewayUrl: config.gatewayUrl }),
      deviceId: config.deviceId ?? 'local',
      requestTimeoutMs: config.requestTimeoutMs ?? 5000,
    };
  }

  /** 控制平面客户端；没有配置地址时返回 undefined。 */
  private registryClient(): McpRegistryClient | undefined {
    if (this.config.gatewayUrl === undefined) return undefined;
    return new McpRegistryClient({
      gatewayUrl: this.config.gatewayUrl,
      deviceId: this.config.deviceId,
      requestTimeoutMs: this.config.requestTimeoutMs,
    });
  }

  /** 取遥测客户端；关闭遥测时返回 undefined。 */
  private telemetry(): ConnectorsTelemetry | undefined {
    return this.ctx.reflect.get('chatdshTelemetry') as ConnectorsTelemetry | undefined;
  }

  /** 打开存储域，把已启用的连接器同步成加载器行，并从控制平面拉取 MCP 注册表。 */
  async [TypertRemoteService.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(CONNECTORS_DOMAIN);
    this.connectors = domain.table('connectors') as unknown as Table<ConnectorRecord>;
    // 启动时同步一次：连接器记录是持久化的，加载器行是派生物，重启后要让两者重新对上。
    await this.syncMcpRows();
    // 控制平面里的 MCP 注册表是本机接入的来源；拉取失败不阻断启动，只记一条告警。
    await this.refreshMcpRegistry();
  }

  /** 列出全部连接器，按名字排序。 */
  @Remote('list')
  list(): ConnectorRecord[] {
    if (this.connectors === undefined) return [];
    return [...this.connectors.entries()]
      .map(([, record]) => record)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** 为全部启用的连接器生成 MCP 客户端行配置。 */
  @Remote('mcpRows')
  mcpRows(): McpRowResult[] {
    return buildMcpRows(this.list());
  }

  /**
   * 把加载器里的连接器行调整到与记录一致。
   *
   * 只动本插件生成的行（按前缀识别）；新建的行指向 MCP 客户端包，插入后由加载器启动。
   * @returns 本次执行的动作。
   */
  @Remote('syncMcpRows')
  async syncMcpRows(): Promise<McpSyncPlan> {
    const telemetry = this.telemetry();
    const apply = async (span: { setAttribute(key: string, value: unknown): void }): Promise<McpSyncPlan> => {
      const existing = [...loaderOf(this.ctx).entries()].map((entry) => entry.options.id);
      const plan = planMcpSync(this.list(), existing);
      span.setAttribute('create.count', plan.create.length);
      span.setAttribute('update.count', plan.update.length);
      span.setAttribute('remove.count', plan.remove.length);
      for (const item of plan.create) {
        // 显式给出条目标识：加载器在缺标识时自己生成一个随机值，那样生成出来的
        // 标识与同步计划里的对不上，下一轮同步会把同一台服务器当成新的再建一次，
        // 停用的连接器也永远匹配不到要移除的旧行。
        await loaderOf(this.ctx).create(loaderEntryOf(item.rowId, MCP_CLIENT_PACKAGE, item.row) as EntryOptions, null);
      }
      for (const item of plan.update) {
        await loaderOf(this.ctx).update(item.rowId, { config: item.row });
      }
      for (const id of plan.remove) loaderOf(this.ctx).remove(id);
      return plan;
    };

    if (telemetry === undefined) return apply({ setAttribute: () => {} });
    return telemetry.runSpan('chatdsh.connectors.sync', { 'connectors.count': this.list().length }, async (span) => {
      try {
        const plan = await apply(span);
        span.setAttribute('outcome', 'ok');
        telemetry.counter('chatdsh_connectors_sync_total', { description: '连接器同步次数' })
          .add(1, { outcome: 'ok' });
        telemetry.log('info', `connectors synced create=${plan.create.length} update=${plan.update.length} remove=${plan.remove.length}`, {
          'connectors.count': this.list().length,
        });
        return plan;
      } catch (error) {
        span.setAttribute('outcome', 'failed');
        telemetry.event('chatdsh.connectors.sync.failed', {
          'error.type': error instanceof Error ? error.name : 'Unknown',
        });
        telemetry.counter('chatdsh_connectors_sync_total', { description: '连接器同步次数' })
          .add(1, { outcome: 'failed' });
        throw error;
      }
    });
  }

  /**
   * 从控制平面拉取 MCP 注册表，按本设备的端点重建加载器行。
   *
   * 只取 `deviceId` 与自己一致的那一段：同一台服务器在不同设备上可以是完全不同的连接
   * 方式。加载器行指向 DSH 原生的 MCP 客户端插件，连接与工具注册由它承担。
   * @returns 本设备接入的服务器数量；控制平面不可达时返回 `undefined`。
   */
  @Remote('refreshMcpRegistry')
  async refreshMcpRegistry(): Promise<{ servers: number; endpoints: number } | undefined> {
    const client = this.registryClient();
    if (client === undefined) return undefined;
    let snapshot;
    try {
      snapshot = await client.snapshot();
    } catch {
      // 控制平面不可达时保留现有加载器行：本机已接入的能力不该因为一次读取失败而消失。
      return undefined;
    }
    const mine = snapshot.endpoints.filter((endpoint) => endpoint.deviceId === this.config.deviceId);
    const desired = mine.map((endpoint) => ({
      rowId: `${MCP_ROW_PREFIX}${endpoint.server}`,
      name: MCP_CLIENT_PACKAGE,
      config: toLoaderConfig(endpoint),
    }));
    const existing = [...loaderOf(this.ctx).entries()].map((entry) => entry.options.id);
    const existingSet = new Set(existing.filter((id) => id.startsWith(MCP_ROW_PREFIX)));
    for (const row of desired) {
      if (existingSet.has(row.rowId)) await loaderOf(this.ctx).update(row.rowId, { config: row.config });
      else await loaderOf(this.ctx).create({ id: row.rowId, name: row.name, config: row.config } as EntryOptions, null);
    }
    const desiredIds = new Set(desired.map((row) => row.rowId));
    for (const id of existingSet) {
      if (!desiredIds.has(id)) loaderOf(this.ctx).remove(id);
    }
    return { servers: snapshot.servers.length, endpoints: desired.length };
  }

  /** 建立或更新一个连接器。 */  /** 建立或更新一个连接器。 */
  @Remote('save')
  async save(input: ConnectorInput): Promise<ConnectorRecord> {
    const check = validateConnector(input);
    if (!check.ok) throw new Error(`连接器缺少 ${check.missing}`);
    const table = this.require();
    const now = Date.now();
    const current = input.id === undefined ? undefined : table.get(input.id);
    const record: ConnectorRecord = {
      id: current?.id ?? input.id ?? crypto.randomUUID(),
      name: input.name,
      transport: input.transport,
      command: input.command,
      args: input.args,
      url: input.url,
      credentialEnv: input.credentialEnv,
      enabled: input.enabled ?? current?.enabled ?? true,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await table.put(record.id, record);
    return record;
  }

  /** 删除一个连接器。 */
  @Remote({ name: 'delete' })
  async remove(id: string): Promise<boolean> {
    const table = this.require();
    if (table.get(id) === undefined) return false;
    await table.delete(id);
    return true;
  }

  /** 启用或停用一个连接器。 */
  @Remote('setEnabled')
  async setEnabled(id: string, enabled: boolean): Promise<ConnectorRecord> {
    const table = this.require();
    const current = table.get(id);
    if (current === undefined) throw new Error(`连接器 ${id} 不存在`);
    const record: ConnectorRecord = { ...current, enabled, updatedAt: Date.now() };
    await table.put(id, record);
    return record;
  }

  private require(): Table<ConnectorRecord> {
    if (this.connectors === undefined) throw new Error('连接器存储还没有打开');
    return this.connectors;
  }
}

export { ChatdshConnectorService as default };
