/**
 * 宿主平面遥测出口插件。
 *
 * 本包把诊断客户端注册成 `ctx.chatdshTelemetry`，并对外提供状态、自检、诊断导出、
 * 运行期开关与浏览器、桌面、移动端上报中继五个端点。信号采集、脱敏与导出管道由
 * `@chatdsh/core-diagnostics` 承担，控制器负责开关热切换，本包负责宿主生命周期与
 * HTTP 接入。
 * @module @chatdsh/host-telemetry
 */

export { ChatdshTelemetryService, ChatdshTelemetryService as default } from './service.ts';
export { TelemetryController, type RelayResult, type TelemetryControllerOptions } from './controller.ts';
export { Config } from './schema.ts';
export {
  registerTelemetryEndpoints,
  CSRF_HEADER,
  DIAGNOSTICS_PATH,
  RELAY_PATH,
  SELF_TEST_PATH,
  STATE_PATH,
  STATUS_PATH,
  type EndpointHost,
} from './endpoints.ts';
