/**
 * 控制平面。
 *
 * 常驻的独立服务：持有账号与会话归属，反向代理客户端的 `/api` 请求到对应运行时并注入身份。
 * 运行时不对外监听，进程内的授权层恒为 owner，隔离落在进程边界上。
 * @module @chatdsh/gateway
 */

export { GatewayStore, PushQueue, ReplicaStore, ScheduleStore, ShareStore, readConfig, dataRoot, parseLlmGateway } from './store.ts';
export type {
  AccountRecord,
  DeviceRecord,
  GatewayConfig,
  PushItem,
  ReplicaAppendResult,
  ReplicaEventInput,
  SessionOwnershipRecord,
  ShareInput,
  ShareRecord,
  TaskAction,
  TaskInput,
  TaskRecord,
} from './store.ts';
export { createScheduler } from './scheduler.ts';
export type { Scheduler, SchedulerOptions } from './scheduler.ts';
export { createPushHub } from './push.ts';
export type { DeliveryResult, PushHub } from './push.ts';
export { renderSharePage } from './render.ts';
export type { ShareEvent } from './render.ts';
export { createGatewayServer } from './server.ts';
export { handleLlmRequest, LlmQuotaLedger } from './llm.ts';
export { McpRegistry, McpRegistryError, toServerName } from './mcp-registry.ts';
export type { McpEndpointRecord, McpServerInput, McpSnapshot, McpTransport } from './mcp-registry.ts';
export type { LlmGatewayConfig, LlmQuotaConfig } from './llm.ts';
export type { GatewayServer } from './server.ts';
