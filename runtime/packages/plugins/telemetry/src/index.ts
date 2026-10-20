/**
 * 遥测出口插件。
 *
 * 注册 `ctx.chatdshTelemetry`、状态端点、自检端点与浏览器上报中继，并负责开关判定、
 * 脱敏、采样、批量与自监控。业务包只调用服务方法，不自行构造导出管道。
 * @module @chatdsh/plugin-telemetry
 */

export { ChatdshTelemetryService, ChatdshTelemetryService as default } from './service.ts';
export {
  createTelemetryClient,
  TelemetryClient,
  type TelemetryClientOptions,
  type TelemetrySelfTest,
} from './client.ts';
export {
  DEFAULT_ENDPOINT,
  DEFAULT_LOG_STREAM,
  DEFAULT_ORGANIZATION,
  DEFAULT_TRACE_STREAM,
  defaultTelemetryConfig,
  readOverrides,
  resolveSwitch,
  type SwitchState,
  type TelemetryConfig,
  type TelemetryOverrides,
} from './config.ts';
export { Config } from './schema.ts';
export {
  createRedactor,
  DECLARED_ATTRIBUTE_KEYS,
  MESSAGE_LIMIT,
  redactMessage,
  type RedactOutcome,
  type Redactor,
  type RedactorRule,
} from './redact.ts';
export {
  createPipelines,
  type Pipelines,
  type PipelineOptions,
  type TelemetrySignal,
} from './pipelines.ts';
export {
  registerTelemetryEndpoints,
  RELAY_PATH,
  SELF_TEST_PATH,
  STATUS_PATH,
  type EndpointHost,
} from './endpoints.ts';
