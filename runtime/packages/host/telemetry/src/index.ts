/**
 * 宿主平面遥测出口插件。
 *
 * 本包把诊断客户端注册成 `ctx.chatdshTelemetry`，并对外提供状态、自检与浏览器上报中继
 * 三个端点。信号采集、脱敏与导出管道由 `@chatdsh/core-diagnostics` 承担，本包只负责
 * 宿主生命周期与 HTTP 接入。
 * @module @chatdsh/host-telemetry
 */

export { ChatdshTelemetryService, ChatdshTelemetryService as default } from './service.ts';
export { Config } from './schema.ts';
export {
  registerTelemetryEndpoints,
  RELAY_PATH,
  SELF_TEST_PATH,
  STATUS_PATH,
  type EndpointHost,
} from './endpoints.ts';
