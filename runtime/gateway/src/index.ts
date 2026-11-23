/**
 * 轻量中继服务端入口。
 *
 * 负责设备配对与出站长连接隧道、按设备请求转发、会话只读副本、白名单设置同步、
 * 审批提醒推送与移动端 PWA 静态入口。
 * @module @chatdsh/gateway
 */

export {
  GatewayStore,
  PushQueue,
  ReceiptStore,
  ReplicaStore,
  SettingsStore,
  SETTINGS_NAMESPACES,
  readConfig,
  dataRoot,
} from './store.ts';
export type {
  DeviceRecord,
  MobileDeviceRecord,
  NodeDeviceRecord,
  NodeRole,
  GatewayAccessMode,
  GatewayConfig,
  PushItem,
  ReceiptRecord,
  ReplicaAppendResult,
  ReplicaEventInput,
  SessionOwnershipRecord,
  SettingInput,
  SettingRecord,
  SettingsNamespace,
} from './store.ts';
export { createPushHub } from './push.ts';
export type { DeliveryResult, PushHub } from './push.ts';
export { DeviceLinkError, DeviceLinkHub, DEVICE_LINK_PATH } from './device-link.ts';
export type {
  ControlFrame,
  DeviceFrame,
  DeviceUpgradeOutcome,
  DeviceUpgradeResult,
  DeviceLinkErrorCode,
  DeviceLinkOptions,
  DeviceRequest,
  DeviceResponse,
} from './device-link.ts';
export { aggregateSessions } from './sessions.ts';
export type { DeviceSessions, SessionSummary, SessionsSnapshot } from './sessions.ts';
export { BUNDLES_ENDPOINT, DEVICE_PLUGINS_TIMEOUT_MS, DevicePluginsError, PLUGINS_ENDPOINT, fetchDevicePlugins } from './device-plugins.ts';
export type { DevicePluginsErrorCode, DevicePluginsSnapshot } from './device-plugins.ts';
export { createGatewayServer } from './server.ts';
export type { GatewayServer } from './server.ts';
export * as replicaContinuity from './replica-continuity/index.ts';
