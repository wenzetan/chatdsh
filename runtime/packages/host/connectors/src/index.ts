/**
 * 连接器。
 *
 * 记录用户要接入的外部能力：名字、传输方式、可执行文件或地址、凭据所在的环境变量名。
 * 凭据本身不落库，只保存变量名，装配加载器行时再从本机环境取值。
 *
 * 配置与同步是两个可分开查询的结果：保存成功不代表加载器同步成功。启停与删除都必须
 * 同步加载器行，否则停用的连接器仍然会出现在工具目录里。
 * @module @chatdsh/host-connectors
 */

import { randomUUID } from 'node:crypto';
import { ChatdshError, type ChatdshErrorCode } from '@chatdsh/core-contracts';
import {
  loaderOf,
  toolsOf,
  Remote,
  storageDomainOf,
  TypertRemoteService,
  type Context,
  type EntryOptions,
} from '@chatdsh/adapter';
import { UPSTREAM_MCP_CLIENT } from '@chatdsh/adapter/upstream';
import {
  CONNECTORS_DOMAIN,
  CONNECTORS_SYNC_DOMAIN,
  type ConnectorRecord,
  type ConnectorSyncState,
  type ConnectorTransport,
} from './domain.ts';
import {
  assembleRowConfig,
  buildMcpRows,
  loaderEntryOf,
  planMcpSync,
  rowIdOf,
  toServerName,
  type McpRowResult,
  type McpSyncPlan,
} from './mcp.ts';
import { toLoaderConfig, MCP_ROW_PREFIX } from './config.ts';
import { McpRegistryClient } from './registry-client.ts';
import { assertConnectorDraft } from './validation.ts';

export type { ConnectorRecord, ConnectorSyncState, ConnectorTransport, SyncStatus } from './domain.ts';
export { CONNECTORS_DOMAIN, CONNECTORS_SYNC_DOMAIN, SYNC_STATUSES, TRANSPORTS, connectorSchema, syncStateSchema } from './domain.ts';
export {
  assembleRowConfig,
  buildMcpRow,
  buildMcpRows,
  loaderEntryOf,
  planMcpSync,
  rowIdOf,
  toServerName,
} from './mcp.ts';
export { McpConfigError, parseMcpConfig, resolveEnvReference, rowsOf } from './config.ts';
export type { HttpRow, McpLoaderRow, McpServerEntry, StdioRow } from './config.ts';
export type {
  ConnectorSpec,
  HttpRowConfig,
  LoaderEntryOptions,
  McpNameConflict,
  McpRowResult,
  McpSyncPlan,
  PlannedRow,
  RowAssembly,
  StdioRowConfig,
} from './mcp.ts';
export { assertConnectorDraft, CONNECTOR_NAME_LIMIT, CREDENTIAL_ENV_PATTERN, type ConnectorDraft } from './validation.ts';

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
  readonly transport: ConnectorTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentialEnv?: string;
  readonly enabled?: boolean;
}

/** 连接器的一个对外状态：配置保存结果与加载器同步结果分开给出。 */
export interface ConnectorStateView {
  readonly id: string;
  readonly name: string;
  readonly transport: ConnectorTransport;
  readonly enabled: boolean;
  /** 记录已经落在结构化存储里。 */
  readonly configSaved: true;
  /** 当前加载器里属于该连接器的行。 */
  readonly rows: string[];
  /** 当前工具目录里由该连接器带来的工具名。 */
  readonly tools: string[];
  /** 最近一次同步的结果；还没有同步过时为 undefined。 */
  readonly sync: ConnectorSyncState | undefined;
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

/** 同步被拒绝的原因。 */
interface SyncRejection {
  readonly code: ChatdshErrorCode;
  readonly type: string;
  readonly message: string;
  /** 受影响的连接器标识。 */
  readonly ids: string[];
}

/** 连接器动作名，写入 span 与错误事件。 */
export type ConnectorAction = 'save' | 'delete' | 'enable' | 'disable' | 'sync';

/** 连接器服务配置。 */
export interface ConnectorsConfig {
  /** 控制平面地址；缺省不拉取注册表。 */
  readonly gatewayUrl?: string;
  /** 本设备标识，与控制平面的设备记录一致。 */
  readonly deviceId?: string;
  /** 节点令牌，向控制平面证明设备身份；缺省取环境变量 `CHATDSH_NODE_TOKEN`。 */
  readonly nodeToken?: string;
  /** 读取注册表的超时，单位毫秒。 */
  readonly requestTimeoutMs?: number;
}

/** 连接器服务。 */
export class ChatdshConnectorService extends TypertRemoteService {
  static inject = ['storageDomain', 'loader'];

  private readonly config: { gatewayUrl?: string; deviceId: string; nodeToken: string; requestTimeoutMs: number };

  private connectors: Table<ConnectorRecord> | undefined;
  private syncStates: Table<ConnectorSyncState> | undefined;

  constructor(ctx: Context, config: ConnectorsConfig = {}) {
    super(ctx, SERVICE_NAME);
    this.config = {
      ...(config.gatewayUrl === undefined ? {} : { gatewayUrl: config.gatewayUrl }),
      deviceId: config.deviceId ?? 'local',
      nodeToken: config.nodeToken ?? process.env.CHATDSH_NODE_TOKEN ?? '',
      requestTimeoutMs: config.requestTimeoutMs ?? 5000,
    };
  }

  /** 控制平面客户端；没有配置地址时返回 undefined。 */
  private registryClient(): McpRegistryClient | undefined {
    if (this.config.gatewayUrl === undefined) return undefined;
    return new McpRegistryClient({
      gatewayUrl: this.config.gatewayUrl,
      deviceId: this.config.deviceId,
      nodeToken: this.config.nodeToken,
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
    const syncDomain = await storageDomainOf(this.ctx).open(CONNECTORS_SYNC_DOMAIN);
    this.syncStates = syncDomain.table('states') as unknown as Table<ConnectorSyncState>;
    // 启动时同步一次：连接器记录是持久化的，加载器行是派生物，重启后要让两者重新对上。
    // 同步失败不阻断启动，结果写进状态表供面板查询。
    await this.syncQuietly();
    // 控制平面里的 MCP 注册表是本机接入的来源；拉取失败不阻断启动。
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

  /** 读一条连接器记录。 */
  @Remote('get')
  get(id: string): ConnectorRecord {
    return this.requireRecord(id);
  }

  /** 为全部启用的连接器生成 MCP 客户端行配置。返回值里只有凭据变量名，没有值。 */
  @Remote('mcpRows')
  mcpRows(): McpRowResult[] {
    return buildMcpRows(this.list());
  }

  /**
   * 把加载器里的连接器行调整到与记录一致。
   *
   * 只动本插件生成的行（按前缀识别）；新建的行指向 MCP 客户端包，插入后由加载器启动。
   * 名称规范化后冲突或凭据变量在本机没有值时，整体拒绝并记录失败状态。
   * @returns 本次执行的动作。
   */
  @Remote('syncMcpRows')
  async syncMcpRows(): Promise<McpSyncPlan> {
    const telemetry = this.telemetry();
    const run = async (span?: { setAttribute(key: string, value: unknown): void }): Promise<McpSyncPlan> => {
      const records = this.list();
      const existing = [...loaderOf(this.ctx).entries()].map((entry) => String(entry.options.id));
      const plan = planMcpSync(records, existing);
      span?.setAttribute('connectors.count', records.length);
      span?.setAttribute('create.count', plan.create.length);
      span?.setAttribute('update.count', plan.update.length);
      span?.setAttribute('remove.count', plan.remove.length);

      const rejection = this.precheck(records, plan);
      if (rejection !== undefined) {
        await this.markFailed(records, rejection.ids, rejection.type, rejection.code);
        span?.setAttribute('outcome', 'failed');
        telemetry?.event('chatdsh.connectors.sync.failed', { 'error.type': rejection.type });
        this.reportRejection('sync', rejection.type, rejection.code);
        telemetry?.counter('chatdsh_connectors_sync_total', { description: '连接器同步次数' }).add(1, { outcome: 'failed' });
        throw new ChatdshError(rejection.code, rejection.message);
      }

      try {
        for (const item of plan.create) {
          const assembly = assembleRowConfig(item.row, item.credentialEnv, process.env);
          await loaderOf(this.ctx).create(loaderEntryOf(item.rowId, MCP_CLIENT_PACKAGE, assembly.row) as EntryOptions, null);
        }
        for (const item of plan.update) {
          const assembly = assembleRowConfig(item.row, item.credentialEnv, process.env);
          await loaderOf(this.ctx).update(item.rowId, { config: assembly.row });
        }
        for (const id of plan.remove) loaderOf(this.ctx).remove(id);
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = errorCodeOf(error);
        await this.markFailed(records, records.map((record) => record.id), type, code);
        span?.setAttribute('outcome', 'failed');
        telemetry?.event('chatdsh.connectors.sync.failed', { 'error.type': type });
        this.reportRejection('sync', type, code);
        telemetry?.counter('chatdsh_connectors_sync_total', { description: '连接器同步次数' }).add(1, { outcome: 'failed' });
        throw error;
      }

      await this.markSynced(records);
      span?.setAttribute('outcome', 'ok');
      telemetry?.counter('chatdsh_connectors_sync_total', { description: '连接器同步次数' }).add(1, { outcome: 'ok' });
      telemetry?.log('info', `connectors synced create=${plan.create.length} update=${plan.update.length} remove=${plan.remove.length}`, {
        'connectors.count': records.length,
      });
      return plan;
    };

    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.connectors.sync', { 'connectors.count': this.list().length }, run);
  }

  /**
   * 从控制平面拉取 MCP 注册表，按本设备的端点重建加载器行。
   *
   * 只取 `deviceId` 与自己一致的那一段：同一台服务器在不同设备上可以是完全不同的连接
   * 方式。加载器行指向 DSH 原生的 MCP 客户端插件，连接与工具注册由它承担。
   * @returns 本设备接入的服务器数量；控制平面不可达时返回零值。
   */
  @Remote('refreshMcpRegistry')
  async refreshMcpRegistry(): Promise<{ servers: number; endpoints: number }> {
    const client = this.registryClient();
    if (client === undefined) return { servers: 0, endpoints: 0 };
    let snapshot;
    try {
      snapshot = await client.snapshot();
    } catch {
      // 控制平面不可达时保留现有加载器行：本机已接入的能力不该因为一次读取失败而消失。
      return { servers: 0, endpoints: 0 };
    }
    const mine = snapshot.endpoints.filter((endpoint) => endpoint.deviceId === this.config.deviceId);
    const desired = mine.map((endpoint) => ({
      rowId: `${MCP_ROW_PREFIX}${endpoint.server}`,
      name: MCP_CLIENT_PACKAGE,
      config: toLoaderConfig(endpoint),
    }));
    const existing = [...loaderOf(this.ctx).entries()].map((entry) => String(entry.options.id));
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

  /**
   * 本机 MCP 接入状态：全局注册里有几台、本机生成几条加载器行。
   *
   * 只读，供客户端面板与验收读取。它不触发同步，也不连接远端。
   * @returns 注册表读数；控制平面不可达时给出零值。
   */
  @Remote('mcpStatus')
  async mcpStatus(): Promise<{ servers: number; endpoints: number; rows: string[] }> {
    const rows = [...loaderOf(this.ctx).entries()]
      .map((entry) => String(entry.options.id))
      .filter((id) => id.startsWith(MCP_ROW_PREFIX));
    const client = this.registryClient();
    if (client === undefined) return { servers: 0, endpoints: rows.length, rows };
    let snapshot;
    try {
      snapshot = await client.snapshot();
    } catch {
      return { servers: 0, endpoints: rows.length, rows };
    }
    const mine = snapshot.endpoints.filter((endpoint) => endpoint.deviceId === this.config.deviceId);
    return { servers: snapshot.servers.length, endpoints: mine.length, rows };
  }

  /**
   * 本机工具目录里来自 MCP 的工具。
   *
   * 名字由 DSH 原生客户端生成为 `mcp__<server>__<raw>_<hash>`，这里按前缀筛出来，
   * 供客户端面板显示「这台服务器接入了哪些工具」与验收核对。
   * @returns 按服务器名分组的工具名。
   */
  @Remote('mcpTools')
  mcpTools(): Record<string, string[]> {
    return groupMcpTools(toolsOf(this.ctx).schemas(undefined) as { name: string }[]);
  }

  /**
   * 调用一个 MCP 工具。
   *
   * 这是给验收与诊断用的直通入口：正常使用中模型通过工具目录调用，这里只是把同一条
   * 执行路径暴露出来。调用按连接器的启用状态判定权限：服务器停用或不在本机接入范围
   * 内时直接拒绝，参数不是对象时也拒绝。
   * @param name - 工具名，带 `mcp__` 前缀。
   * @param args - 工具参数。
   * @returns 执行结果的内容与错误标记。
   */
  @Remote('callMcpTool')
  async callMcpTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new ChatdshError('request-invalid', '工具参数必须是对象');
    }
    const server = serverOfTool(name);
    if (server === undefined) throw new ChatdshError('request-invalid', '工具名必须带 mcp__ 前缀与服务器名');
    if (!this.allowedServers().has(server)) {
      throw new ChatdshError('permission-denied', `服务器 ${server} 不在本机启用范围内，拒绝工具测试`);
    }
    const result = await toolsOf(this.ctx).execute({
      callId: `mcp-direct-${Date.now()}` as never,
      name,
      arguments: args,
      signal: AbortSignal.timeout(60_000),
    });
    const content = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    return { content, isError: result.isError };
  }

  /**
   * 每个连接器的状态：配置在存储里，同步结果在状态表里，工具目录给出实际接入。
   * @returns 按名字排序的状态视图。
   */
  @Remote('states')
  states(): ConnectorStateView[] {
    const tools = groupMcpTools(toolsOf(this.ctx).schemas(undefined) as { name: string }[]);
    const rows = [...loaderOf(this.ctx).entries()].map((entry) => String(entry.options.id));
    return this.list().map((record) => this.stateOf(record, rows, tools));
  }

  /** 读一个连接器的状态。 */
  @Remote('state')
  state(id: string): ConnectorStateView {
    const record = this.requireRecord(id);
    const tools = groupMcpTools(toolsOf(this.ctx).schemas(undefined) as { name: string }[]);
    const rows = [...loaderOf(this.ctx).entries()].map((entry) => String(entry.options.id));
    return this.stateOf(record, rows, tools);
  }

  /** 建立或更新一个连接器。配置先落盘，再同步加载器；同步失败不撤掉已保存的配置。 */
  @Remote('save')
  async save(input: ConnectorInput): Promise<ConnectorRecord> {
    return this.change('save', input.transport, async () => {
      const current = input.id === undefined ? undefined : this.require().get(input.id);
      if (input.id !== undefined && current === undefined) {
        throw new ChatdshError('object-not-found', `连接器 ${input.id} 不存在`);
      }
      const others = this.list().filter((record) => record.id !== input.id);
      const draft = assertConnectorDraft(input, others);
      const now = Date.now();
      const record: ConnectorRecord = {
        id: current?.id ?? input.id ?? randomUUID(),
        name: draft.name,
        transport: draft.transport,
        ...(draft.command === undefined ? {} : { command: draft.command }),
        ...(draft.args === undefined ? {} : { args: draft.args }),
        ...(draft.url === undefined ? {} : { url: draft.url }),
        ...(draft.credentialEnv === undefined ? {} : { credentialEnv: draft.credentialEnv }),
        enabled: draft.enabled ?? current?.enabled ?? true,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await this.require().put(record.id, record);
      await this.syncQuietly();
      return record;
    });
  }

  /** 删除一个连接器；删除后同步加载器行，让它的工具从目录里消失。 */
  @Remote({ name: 'delete' })
  async remove(id: string): Promise<boolean> {
    return this.change('delete', undefined, async () => {
      if (this.require().get(id) === undefined) return false;
      await this.require().delete(id);
      await this.requireStates().delete(id);
      await this.syncQuietly();
      return true;
    });
  }

  /** 启用或停用一个连接器；状态变化立即同步加载器行。 */
  @Remote('setEnabled')
  async setEnabled(id: string, enabled: boolean): Promise<ConnectorRecord> {
    const current = this.require().get(id);
    return this.change(enabled ? 'enable' : 'disable', current?.transport, async () => {
      if (current === undefined) throw new ChatdshError('object-not-found', `连接器 ${id} 不存在`);
      const record: ConnectorRecord = { ...current, enabled, updatedAt: Date.now() };
      await this.require().put(id, record);
      await this.syncQuietly();
      return record;
    });
  }

  /** 在一个动作 span 里执行，失败时补事件与计数。 */
  private async change<T>(
    action: ConnectorAction,
    transport: ConnectorTransport | undefined,
    body: (span: { setAttribute(key: string, value: unknown): void } | undefined) => Promise<T>,
  ): Promise<T> {
    const telemetry = this.telemetry();
    const run = async (span?: { setAttribute(key: string, value: unknown): void }): Promise<T> => {
      try {
        const value = await body(span);
        span?.setAttribute('action', action);
        span?.setAttribute('outcome', 'ok');
        telemetry?.counter('chatdsh_connector_changes_total', { description: '连接器变更结果' }).add(1, { action, outcome: 'ok' });
        return value;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = errorCodeOf(error);
        span?.setAttribute('action', action);
        span?.setAttribute('outcome', 'failed');
        span?.setAttribute('error.type', type);
        this.reportRejection(action, type, code);
        telemetry?.counter('chatdsh_connector_changes_total', { description: '连接器变更结果' }).add(1, { action, outcome: 'failed' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.connectors.change', {
      action,
      ...(transport === undefined ? {} : { transport }),
    }, run);
  }

  /**
   * 记一条连接器动作被拒绝的事件。
   * @param action - 动作名。
   * @param errorType - 错误类型。
   * @param errorCode - 错误码。
   */
  private reportRejection(action: ConnectorAction, errorType: string, errorCode: string): void {
    this.telemetry()?.event('chatdsh.connectors.rejected', {
      action,
      outcome: 'failed',
      'error.type': errorType,
      'error.code': errorCode,
    });
  }

  /** 同步一次；失败已经写进状态表与遥测，这里只把错误留在调用栈外。 */
  private async syncQuietly(): Promise<void> {
    try {
      await this.syncMcpRows();
    } catch {
      // 配置已经落盘，同步结果单独记录：两者都要能被查询，启动也不被同步失败阻断。
      this.telemetry()?.log('warn', 'connector sync failed; config kept and state recorded');
    }
  }

  /**
   * 应用同步计划之前先做整体拒绝判定。
   * @param records - 当前记录。
   * @param plan - 同步计划。
   * @returns 拒绝原因；可以应用时返回 undefined。
   */
  private precheck(records: readonly ConnectorRecord[], plan: McpSyncPlan): SyncRejection | undefined {
    if (plan.conflicts.length > 0) {
      const names = plan.conflicts.flatMap((conflict) => conflict.names);
      return {
        code: 'request-invalid',
        type: 'ChatdshError',
        message: `连接器名称规范化后冲突，服务器名只能由一个连接器占用：${names.join('、')}`,
        ids: plan.conflicts.flatMap((conflict) => conflict.ids),
      };
    }
    const missing = records.filter(
      (record) => record.enabled && record.credentialEnv !== undefined && (process.env[record.credentialEnv] ?? '') === '',
    );
    if (missing.length > 0) {
      return {
        code: 'connector-credential-missing',
        type: 'ChatdshError',
        message: `连接器声明的凭据环境变量在本机没有值：${missing.map((record) => record.credentialEnv).join('、')}`,
        ids: missing.map((record) => record.id),
      };
    }
    return undefined;
  }

  /** 把全部连接器的状态写成同步成功。 */
  private async markSynced(records: readonly ConnectorRecord[]): Promise<void> {
    const states = this.requireStates();
    const at = Date.now();
    for (const record of records) {
      await states.put(record.id, { id: record.id, status: 'ok', rows: record.enabled ? 1 : 0, at });
    }
  }

  /** 把受影响的连接器写成同步失败，保留配置。 */
  private async markFailed(
    records: readonly ConnectorRecord[],
    ids: readonly string[],
    errorType: string,
    errorCode: string,
  ): Promise<void> {
    const states = this.requireStates();
    const at = Date.now();
    for (const record of records) {
      if (!ids.includes(record.id)) continue;
      await states.put(record.id, {
        id: record.id,
        status: 'failed',
        rows: 0,
        errorType,
        errorCode,
        at,
      });
    }
  }

  /** 本机已接入的服务器名：启用的连接器与注册表生成的行。 */
  private allowedServers(): Set<string> {
    const allowed = new Set<string>();
    for (const record of this.list()) {
      if (record.enabled) allowed.add(toServerName(record.name));
    }
    for (const entry of loaderOf(this.ctx).entries()) {
      const id = String(entry.options.id);
      if (id.startsWith(MCP_ROW_PREFIX)) allowed.add(id.slice(MCP_ROW_PREFIX.length));
    }
    return allowed;
  }

  /** 一条记录的状态视图。 */
  private stateOf(
    record: ConnectorRecord,
    rows: readonly string[],
    tools: Readonly<Record<string, string[]>>,
  ): ConnectorStateView {
    const serverName = toServerName(record.name);
    const rowId = rowIdOf(serverName);
    return {
      id: record.id,
      name: record.name,
      transport: record.transport,
      enabled: record.enabled,
      configSaved: true,
      rows: rows.filter((id) => id === rowId),
      tools: tools[serverName] ?? [],
      sync: this.requireStates().get(record.id),
    };
  }

  /** 取一条记录，缺失时就地抛出。 */
  private requireRecord(id: string): ConnectorRecord {
    const record = this.require().get(id);
    if (record === undefined) throw new ChatdshError('object-not-found', `连接器 ${id} 不存在`);
    return record;
  }

  private require(): Table<ConnectorRecord> {
    if (this.connectors === undefined) throw new Error('连接器存储还没有打开');
    return this.connectors;
  }

  private requireStates(): Table<ConnectorSyncState> {
    if (this.syncStates === undefined) throw new Error('连接器同步状态存储还没有打开');
    return this.syncStates;
  }
}

/** 工具名里的服务器段。 */
function serverOfTool(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  return separator < 0 ? undefined : rest.slice(0, separator);
}

/** 按服务器名把 MCP 工具分组。 */
function groupMcpTools(schemas: readonly { name: string }[]): Record<string, string[]> {
  const tools: Record<string, string[]> = {};
  for (const schema of schemas) {
    const server = serverOfTool(schema.name);
    if (server === undefined) continue;
    const list = tools[server] ?? [];
    list.push(schema.name);
    tools[server] = list;
  }
  return tools;
}

/** 取错误码；非契约异常按内部故障归类。 */
function errorCodeOf(error: unknown): ChatdshErrorCode {
  if (error instanceof ChatdshError) return error.code;
  return 'internal-error';
}

export { ChatdshConnectorService as default };
