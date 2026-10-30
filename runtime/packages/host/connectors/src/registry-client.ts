/**
 * 控制平面 MCP 注册表的客户端。
 *
 * 运行时向控制平面读取全局注册与全部端点，只取本设备那一段来生成加载器行；同时把本机
 * 的接入配置覆盖式上报。设备身份用节点令牌证明：`Authorization: Bearer <节点令牌>`；
 * 没有令牌时带上节点标识头，控制平面据此记录端点所属设备。协议细节不在这里实现：
 * 加载器行指向 DSH 原生的 MCP 客户端插件，连接、握手、工具注册与重连都由它承担。
 * @module @chatdsh/host-connectors/registry-client
 */

import { NODE_HEADERS, type McpSnapshot } from '@chatdsh/core-contracts';

/** 客户端配置。 */
export interface RegistryClientConfig {
  /** 控制平面地址。 */
  readonly gatewayUrl: string;
  /** 本设备标识。 */
  readonly deviceId: string;
  /** 节点令牌；为空时只用节点标识头。 */
  readonly nodeToken: string;
  /** 请求超时，单位毫秒。 */
  readonly requestTimeoutMs: number;
}

/** 注册表客户端。 */
export class McpRegistryClient {
  constructor(private readonly config: RegistryClientConfig) {}

  /** 认证与标识头部。 */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      [NODE_HEADERS.id]: this.config.deviceId,
      ...(this.config.nodeToken === '' ? {} : { authorization: `Bearer ${this.config.nodeToken}` }),
    };
  }

  /** 读一次快照。 */
  async snapshot(): Promise<McpSnapshot> {
    const response = await fetch(`${this.config.gatewayUrl}/chatdsh/gateway/mcp`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`读取 MCP 注册表失败：HTTP ${response.status}`);
    return await response.json() as McpSnapshot;
  }

  /** 覆盖式上报本设备的端点。 */
  async publish(servers: Readonly<Record<string, unknown>>): Promise<McpSnapshot> {
    const response = await fetch(`${this.config.gatewayUrl}/chatdsh/gateway/mcp`, {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ servers }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`上报 MCP 配置失败：HTTP ${response.status}`);
    return await response.json() as McpSnapshot;
  }

  /** 移除本设备的一段端点。 */
  async remove(server: string): Promise<McpSnapshot> {
    const response = await fetch(
      `${this.config.gatewayUrl}/chatdsh/gateway/mcp?server=${encodeURIComponent(server)}`,
      {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      },
    );
    if (!response.ok) throw new Error(`移除 MCP 端点失败：HTTP ${response.status}`);
    return await response.json() as McpSnapshot;
  }
}
