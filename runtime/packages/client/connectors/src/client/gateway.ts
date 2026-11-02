/**
 * 连接器面板的数据入口。
 *
 * 传输层只负责把 `<服务名>/<方法名>` 与位置参数送到 Remote 命名空间；这一层负责解包结果
 * 信封、校验返回形状，并把每次调用交给遥测。业务失败（名称冲突、凭据变量缺失、权限拒绝、
 * 记录不存在）以带错误码的失败抛出，由界面按码给出说明。
 *
 * 保存返回记录，同步结果单独查询：宿主保存配置后立即尝试同步，同步失败不会撤销配置，
 * 因此界面在保存之后必须再读一次 `states`，才能同时显示「已保存」与「同步失败」。
 * @module @chatdsh/client-connectors/gateway
 */

import { CLIENT_ERROR_CODES } from './state.ts';
import type {
  ActionOutcome,
  ConnectorInput,
  ConnectorRecord,
  ConnectorStateView,
  ConnectorUiAction,
  ConnectorsGateway,
  ConnectorsTransport,
  McpCallResult,
  McpRegistryRefresh,
  McpRowResult,
  McpStatusView,
  McpSyncPlan,
  PanelTelemetry,
  RemoteEnvelope,
} from './types.ts';

/** 一次 Remote 调用失败。 */
export class ConnectorCallError extends Error {
  /**
   * @param code - 错误码，取自结果信封或客户端自己的失败码。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ConnectorCallError';
  }
}

/** 一个 Remote 命名空间的最小形状。 */
export interface RemoteNamespace {
  readonly [method: string]: ((...args: never[]) => Promise<RemoteEnvelope>) | undefined;
}

/**
 * 从模块加载器给出的命名空间构造传输层。
 *
 * 缺命名空间与缺方法按能力不可用返回信封；调用本身的拒绝原样向上抛，由数据入口统一
 * 折算成离线失败。
 * @param namespaceOf - 按名取 Remote 命名空间。
 * @returns 传输层。
 */
export function createRemoteTransport(namespaceOf: (name: string) => RemoteNamespace | undefined): ConnectorsTransport {
  return {
    async call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope> {
      const separator = endpoint.indexOf('/');
      const service = endpoint.slice(0, separator);
      const method = endpoint.slice(separator + 1);
      const namespace = namespaceOf(service);
      if (namespace === undefined) {
        return { ok: false, error: { code: CLIENT_ERROR_CODES.unavailable, message: `当前部署没有提供 ${service} 命名空间` } };
      }
      const invoke = namespace[method];
      if (typeof invoke !== 'function') {
        return { ok: false, error: { code: CLIENT_ERROR_CODES.unavailable, message: `${service} 没有 ${method} 方法` } };
      }
      return await (invoke as (...input: unknown[]) => Promise<RemoteEnvelope>)(...args);
    },
  };
}

/** 断言结果是一个数组。 */
function requireArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new ConnectorCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  return value as T[];
}

/** 断言结果是一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConnectorCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  }
  return value as Record<string, unknown>;
}

/** 断言结果是一个布尔值。 */
function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new ConnectorCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  return value;
}

/** 断言结果是一个非负整数。 */
function requireCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConnectorCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  }
  return value;
}

/** 读注册表读数。 */
function statusOf(value: unknown): McpStatusView {
  const record = requireRecord(value, 'MCP 接入状态');
  return {
    servers: requireCount(record['servers'], 'MCP 接入状态的服务器数量'),
    endpoints: requireCount(record['endpoints'], 'MCP 接入状态的端点数量'),
    rows: requireArray<string>(record['rows'], 'MCP 接入状态的行列表'),
  };
}

/** 读一次同步计划。 */
function planOf(value: unknown): McpSyncPlan {
  const record = requireRecord(value, '同步计划');
  requireArray<string>(record['remove'], '同步计划的移除列表');
  requireArray<unknown>(record['conflicts'], '同步计划的冲突列表');
  requireArray<unknown>(record['create'], '同步计划的新建列表');
  requireArray<unknown>(record['update'], '同步计划的覆盖列表');
  return value as unknown as McpSyncPlan;
}

/** 构造数据入口所需的依赖。 */
export interface ConnectorsGatewayOptions {
  /** 传输层。 */
  readonly transport: ConnectorsTransport;
  /** 浏览器侧遥测。 */
  readonly telemetry: PanelTelemetry;
}

/**
 * 构造连接器面板的数据入口。
 * @param options - 传输层与遥测。
 * @returns 数据入口。
 */
export function createConnectorsGateway(options: ConnectorsGatewayOptions): ConnectorsGateway {
  const { transport, telemetry } = options;

  /**
   * 发一次调用，把失败信封与传输层拒绝都转成异常。
   * @param endpoint - `<服务名>/<方法名>`。
   * @param args - 位置参数。
   * @returns 成功时的值。
   */
  const call = async (endpoint: string, args: readonly unknown[]): Promise<unknown> =>
    telemetry.run(endpoint, async () => {
      const envelope = await transport.call(endpoint, args).then(
        (value) => value,
        (): RemoteEnvelope => ({
          ok: false,
          error: { code: CLIENT_ERROR_CODES.offline, message: '控制平面不可达，请恢复连接后重新加载' },
        }),
      );
      if (!envelope.ok) throw new ConnectorCallError(envelope.error.code, envelope.error.message);
      return envelope.value;
    });

  return {
    async list(): Promise<ConnectorRecord[]> {
      return requireArray<ConnectorRecord>(await call('chatdshConnectors/list', []), '连接器列表');
    },

    async get(id: string): Promise<ConnectorRecord> {
      return requireRecord(await call('chatdshConnectors/get', [id]), '连接器记录') as unknown as ConnectorRecord;
    },

    async states(): Promise<ConnectorStateView[]> {
      const rows = requireArray<ConnectorStateView>(await call('chatdshConnectors/states', []), '连接器状态');
      for (const row of rows) {
        requireArray<string>(row.rows, '连接器状态的行列表');
        requireArray<string>(row.tools, '连接器状态的工具列表');
        if (row.configSaved !== true) throw new ConnectorCallError('gateway/internal', '连接器状态的配置保存标记不符合约定');
      }
      return rows;
    },

    async state(id: string): Promise<ConnectorStateView> {
      return requireRecord(await call('chatdshConnectors/state', [id]), '连接器状态') as unknown as ConnectorStateView;
    },

    async save(input: ConnectorInput): Promise<ConnectorRecord> {
      return requireRecord(await call('chatdshConnectors/save', [input]), '连接器记录') as unknown as ConnectorRecord;
    },

    async remove(id: string): Promise<boolean> {
      return requireBoolean(await call('chatdshConnectors/delete', [id]), '删除结果');
    },

    async setEnabled(id: string, enabled: boolean): Promise<ConnectorRecord> {
      return requireRecord(await call('chatdshConnectors/setEnabled', [id, enabled]), '连接器记录') as unknown as ConnectorRecord;
    },

    async syncMcpRows(): Promise<McpSyncPlan> {
      return planOf(await call('chatdshConnectors/syncMcpRows', []));
    },

    async refreshMcpRegistry(): Promise<McpRegistryRefresh> {
      const record = requireRecord(await call('chatdshConnectors/refreshMcpRegistry', []), '注册表刷新结果');
      return {
        servers: requireCount(record['servers'], '注册表刷新结果的服务器数量'),
        endpoints: requireCount(record['endpoints'], '注册表刷新结果的端点数量'),
      };
    },

    async mcpStatus(): Promise<McpStatusView> {
      return statusOf(await call('chatdshConnectors/mcpStatus', []));
    },

    async mcpRows(): Promise<McpRowResult[]> {
      return requireArray<McpRowResult>(await call('chatdshConnectors/mcpRows', []), 'MCP 行配置');
    },

    async mcpTools(): Promise<Readonly<Record<string, readonly string[]>>> {
      const record = requireRecord(await call('chatdshConnectors/mcpTools', []), 'MCP 工具目录');
      const tools: Record<string, readonly string[]> = {};
      for (const [server, list] of Object.entries(record)) {
        tools[server] = requireArray<string>(list, `服务器 ${server} 的工具列表`);
      }
      return tools;
    },

    async callMcpTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
      const record = requireRecord(await call('chatdshConnectors/callMcpTool', [name, args]), '工具调用结果');
      if (typeof record['content'] !== 'string' || typeof record['isError'] !== 'boolean') {
        throw new ConnectorCallError('gateway/internal', '工具调用结果的返回形状不符合约定');
      }
      return { content: record['content'], isError: record['isError'] };
    },

    noteAction(action: ConnectorUiAction, outcome: ActionOutcome): void {
      telemetry.action(action, outcome);
    },
  };
}
