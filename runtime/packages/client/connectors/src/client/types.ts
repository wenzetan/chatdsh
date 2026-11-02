/**
 * 连接器面板的数据形状与依赖接口。
 *
 * 记录形状与宿主服务 `chatdshConnectors` 的返回值一致：配置（`ConnectorRecord`）与同步状态
 * （`ConnectorSyncState`）分开持有，二者可以同时成立——「配置已保存、同步失败」是一种合法的
 * 双重状态。面板只依赖本文件的接口，不直接接触网络与模块加载器。
 * @module @chatdsh/client-connectors/types
 */

/** 连接器的传输方式，与宿主记录取值一致。 */
export type ConnectorTransport = 'stdio' | 'http';

/** 加载器同步结果的取值。同步中只是调用进行中的界面状态，不落盘。 */
export type SyncStatus = 'ok' | 'failed';

/** 一条连接器记录。 */
export interface ConnectorRecord {
  readonly id: string;
  /** 展示名，同时作为 MCP 服务器名的来源。 */
  readonly name: string;
  readonly transport: ConnectorTransport;
  /** stdio 方式下的可执行文件。 */
  readonly command?: string;
  /** stdio 方式下的参数，字符串数组。 */
  readonly args?: readonly string[];
  /** http 方式下的地址。 */
  readonly url?: string;
  /** 凭据所在的环境变量名；值不落库。 */
  readonly credentialEnv?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 一次写入的输入；省略的字段表示按传输方式剔除。 */
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

/** 一条连接器的加载器同步状态。 */
export interface ConnectorSyncState {
  readonly id: string;
  readonly status: SyncStatus;
  /** 本次同步为该连接器生成的行数。 */
  readonly rows: number;
  /** 失败时的错误类型。 */
  readonly errorType?: string;
  /** 失败时的错误码。 */
  readonly errorCode?: string;
  /** 记录时刻的毫秒时间戳。 */
  readonly at: number;
}

/** 连接器的对外状态：配置保存结果与加载器同步结果分开给出。 */
export interface ConnectorStateView {
  readonly id: string;
  readonly name: string;
  readonly transport: ConnectorTransport;
  readonly enabled: boolean;
  /** 记录已经落在结构化存储里。 */
  readonly configSaved: true;
  /** 当前加载器里属于该连接器的行。 */
  readonly rows: readonly string[];
  /** 当前工具目录里由该连接器带来的工具名。 */
  readonly tools: readonly string[];
  /** 最近一次同步的结果；还没有同步过时省略。 */
  readonly sync?: ConnectorSyncState;
}

/** 名称规范化后的一次冲突。 */
export interface McpNameConflict {
  readonly rowId: string;
  readonly ids: readonly string[];
  readonly names: readonly string[];
}

/** 一次同步的计划：新建、覆盖、移除的行与名称冲突。 */
export interface McpSyncPlan {
  readonly create: readonly unknown[];
  readonly update: readonly unknown[];
  readonly remove: readonly string[];
  readonly conflicts: readonly McpNameConflict[];
}

/** 一条 MCP 行配置；凭据只以环境变量名的形式出现。 */
export interface McpRowResult {
  readonly row: {
    readonly transport: 'stdio' | 'streamable-http';
    readonly serverName: string;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly url?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
  };
  readonly credentialEnv?: string;
}

/** 本机 MCP 接入状态的读数。 */
export interface McpStatusView {
  /** 控制平面注册表里的服务器数量。 */
  readonly servers: number;
  /** 本机接入的端点行数量。 */
  readonly endpoints: number;
  /** 本机接入的端点行标识。 */
  readonly rows: readonly string[];
}

/** 一次注册表刷新后的读数。 */
export interface McpRegistryRefresh {
  readonly servers: number;
  readonly endpoints: number;
}

/** 一次工具调用的结果。 */
export interface McpCallResult {
  /** 结果里的文本内容，按行拼接。 */
  readonly content: string;
  /** 服务器是否把这次调用标记为错误。 */
  readonly isError: boolean;
}

/** Remote 失败的信封形状。 */
export interface RemoteFailure {
  readonly code: string;
  readonly message: string;
}

/** Remote 调用的结果信封；业务失败走 `ok: false` 分支。 */
export type RemoteEnvelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RemoteFailure };

/**
 * 一次 Remote 调用的传输层。
 *
 * `endpoint` 采用 `<服务名>/<方法名>` 的写法，`args` 是按位置排列的参数。成功与业务失败都以
 * 信封返回，连接失败以拒绝表示，由数据入口统一折算成离线失败。
 */
export interface ConnectorsTransport {
  /**
   * 发出一次调用。
   * @param endpoint - `<服务名>/<方法名>`。
   * @param args - 按位置排列的参数。
   * @returns 结果信封；连接失败以拒绝表示。
   */
  call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope>;
}

/** 界面动作名，写入 `chatdsh.client.ui.action` 事件的 `action` 属性。 */
export type ConnectorUiAction =
  | 'connector.create'
  | 'connector.update'
  | 'connector.enable'
  | 'connector.disable'
  | 'connector.delete'
  | 'connector.sync'
  | 'connector.call'
  | 'connector.registry.refresh';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed' | 'rejected';

/** 浏览器侧遥测面：只用到 span、事件与计数器。 */
export interface PanelTelemetry {
  /**
   * 跑一次带 span 的调用，失败时补失败事件与计数。
   * @param method - `rpc.method` 属性取值。
   * @param work - 实际调用。
   * @returns 调用结果。
   */
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  /**
   * 记一次界面动作。
   * @param action - 动作名。
   * @param outcome - 结果。
   */
  action(action: ConnectorUiAction, outcome: ActionOutcome): void;
  /**
   * 记一次失败事件。
   * @param error - 失败对象。
   */
  failure(error: unknown): void;
}

/** 面板使用的数据入口。 */
export interface ConnectorsGateway {
  /** 列出全部连接器记录，按名称排序。 */
  list(): Promise<ConnectorRecord[]>;
  /** 读一条连接器记录。 */
  get(id: string): Promise<ConnectorRecord>;
  /** 读全部连接器的状态视图。 */
  states(): Promise<ConnectorStateView[]>;
  /** 读一个连接器的状态视图。 */
  state(id: string): Promise<ConnectorStateView>;
  /** 建立或更新一个连接器；配置先落盘，再同步加载器。 */
  save(input: ConnectorInput): Promise<ConnectorRecord>;
  /** 删除一个连接器，并同步加载器行。 */
  remove(id: string): Promise<boolean>;
  /** 启用或停用一个连接器，并同步加载器行。 */
  setEnabled(id: string, enabled: boolean): Promise<ConnectorRecord>;
  /** 把加载器行调整到与记录一致。 */
  syncMcpRows(): Promise<McpSyncPlan>;
  /** 从控制平面拉取注册表并按本设备端点重建行。 */
  refreshMcpRegistry(): Promise<McpRegistryRefresh>;
  /** 读本机 MCP 接入状态的读数。 */
  mcpStatus(): Promise<McpStatusView>;
  /** 读为启用连接器生成的行配置；只有凭据变量名。 */
  mcpRows(): Promise<McpRowResult[]>;
  /** 读本机工具目录里按服务器分组的 MCP 工具。 */
  mcpTools(): Promise<Readonly<Record<string, readonly string[]>>>;
  /** 调用一个 MCP 工具。 */
  callMcpTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** 记一次界面动作。 */
  noteAction(action: ConnectorUiAction, outcome: ActionOutcome): void;
}
