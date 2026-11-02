/**
 * 控制平面。
 *
 * 常驻的独立服务：持有设备与会话归属，反向代理客户端的 `/api` 请求到对应运行时。
 * 运行时不对外监听，进程内的授权层恒为 owner，隔离落在进程边界上。
 * @module @chatdsh/gateway
 */

export { GatewayStore, PushQueue, ReplicaStore, SettingsStore, ShareStore, SETTINGS_NAMESPACES, readConfig, dataRoot, parseLlmGateway, migrateAccountColumns } from './store.ts';
export type {
  DeviceRecord,
  MobileDeviceRecord,
  NodeDeviceRecord,
  NodeRole,
  GatewayConfig,
  PushItem,
  ReplicaAppendResult,
  ReplicaEventInput,
  SessionOwnershipRecord,
  ShareInput,
  ShareRecord,
} from './store.ts';
export { createRuntimeSupervisor, parseRuntimeLaunchConfig, RuntimeSupervisor, findFreePort } from './runtime.ts';
export type { RuntimeLaunchConfig, RuntimeTarget, RuntimeSupervisorOptions } from './runtime.ts';
export { createPushHub } from './push.ts';
export type { DeliveryResult, PushHub } from './push.ts';
export { DeviceLinkError, DeviceLinkHub, DEVICE_LINK_PATH } from './device-link.ts';
export type {
  ControlFrame,
  DeviceFrame,
  DeviceLinkErrorCode,
  DeviceLinkOptions,
  DeviceRequest,
  DeviceResponse,
} from './device-link.ts';
export { renderSharePage } from './render.ts';
export type { ShareEvent } from './render.ts';
export { aggregateSessions } from './sessions.ts';
export type { DeviceSessions, SessionSummary, SessionsSnapshot } from './sessions.ts';
export { BUNDLES_ENDPOINT, DEVICE_PLUGINS_TIMEOUT_MS, DevicePluginsError, PLUGINS_ENDPOINT, fetchDevicePlugins } from './device-plugins.ts';
export type { DevicePluginsErrorCode, DevicePluginsSnapshot } from './device-plugins.ts';
export { SHELL_SCRIPT_PATH, readShellScript, renderShellPage, shellBuilt } from './shell.ts';
export { createGatewayServer } from './server.ts';
export { handleLlmRequest, LlmQuotaLedger } from './llm.ts';
export { McpRegistry, McpRegistryError, toServerName } from './mcp-registry.ts';
export type { McpEndpointRecord, McpServerInput, McpSnapshot, McpTransport } from './mcp-registry.ts';
export type { LlmGatewayConfig, LlmQuotaConfig } from './llm.ts';
export type { GatewayServer } from './server.ts';

// 领域模块入口：按命名空间导出，避免与上面的存储与传输类型重名。
export * as postgres from './postgres/index.ts';
export * as maintenance from './maintenance/index.ts';
export * as backup from './backup/index.ts';
export * as replicaContinuity from './replica-continuity/index.ts';
export * as exports from './exports/index.ts';
export * as resourceLimits from './resource-limits/index.ts';
export * as backends from './backends/index.ts';
export * as deploy from './deploy/index.ts';
