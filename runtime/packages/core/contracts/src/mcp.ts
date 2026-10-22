/**
 * MCP 接入的跨组件契约。
 *
 * 控制平面保存全局注册与每端一段的端点记录，运行时读取本设备那一段生成 MCP 客户端行。
 * 两端共用这些形状，因此放在契约包里。协议细节不在这里：连接、握手与工具注册由 DSH
 * 原生的 MCP 客户端插件承担。
 * @module @chatdsh/core-contracts/mcp
 */

/** 一条端点的传输方式。 */
export type McpTransport = 'stdio' | 'http';

/** 一条端点里与连接相关的字段。 */
export interface McpEndpointRow {
  /** stdio 方式下的可执行文件。 */
  readonly command?: string;
  /** stdio 方式下的参数。 */
  readonly args?: readonly string[];
  /** http 方式下的地址。 */
  readonly url?: string;
  /** 静态请求头；凭据请用 `credentialEnv` 引用，不写值。 */
  readonly headers?: Readonly<Record<string, string>>;
}

/** 上报里的一条服务器。 */
export interface McpServerInput {
  /** 传输方式；省略时按是否给出 command 推断。 */
  readonly type?: 'stdio' | 'http' | 'sse';
  /** stdio 方式下的可执行文件。 */
  readonly command?: string;
  /** stdio 方式下的参数。 */
  readonly args?: readonly string[];
  /** http 方式下的地址。 */
  readonly url?: string;
  /** 静态请求头。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 凭据所在的环境变量名；值不上报。 */
  readonly credentialEnv?: string;
}

/** 全局注册里的一台服务器。 */
export interface McpServerRecord {
  /** 服务器名，同时是工具名前缀。 */
  readonly name: string;
  /** 创建者设备。 */
  readonly createdBy: string;
  /** 创建时间。 */
  readonly createdAt: number;
}

/** 一条端点记录。 */
export interface McpEndpointRecord {
  /** 服务器名。 */
  readonly server: string;
  /** 设备标识。 */
  readonly deviceId: string;
  /** 规范化后的传输方式。 */
  readonly transport: McpTransport;
  /** 连接参数。 */
  readonly row: McpEndpointRow;
  /** 凭据所在的环境变量名。 */
  readonly credentialEnv?: string;
  /** 最后上报时间。 */
  readonly updatedAt: number;
}

/** 一次快照。 */
export interface McpSnapshot {
  /** 全局注册的服务器。 */
  readonly servers: readonly McpServerRecord[];
  /** 全部设备的端点。 */
  readonly endpoints: readonly McpEndpointRecord[];
}
