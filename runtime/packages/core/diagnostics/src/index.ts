/**
 * 可复用的诊断客户端包。
 *
 * 提供与宿主框架无关的遥测客户端、配置判定、脱敏、自建 W3C 链路上下文、
 * 有界环形缓冲与 OTLP 导出管道。宿主插件与独立进程共用这些能力，
 * 业务代码只调用客户端方法，不自行构造导出管道。
 * @module @chatdsh/core-diagnostics
 */

export {
  createTelemetryClient,
  TelemetryClient,
  type TelemetryClientOptions,
  type TelemetryDiagnosticEvent,
  type TelemetryDiagnosticRecord,
  type TelemetryDiagnosticsExport,
  type TelemetrySelfTest,
  type TelemetrySwitchTrigger,
} from './client.ts';
export {
  DEFAULT_ENDPOINT,
  DEFAULT_LOG_STREAM,
  DEFAULT_ORGANIZATION,
  DEFAULT_TRACE_STREAM,
  defaultTelemetryConfig,
  readOverrides,
  resolveSwitch,
  SWITCH_FLUSH_MS,
  type SwitchSources,
  type SwitchState,
  type TelemetryConfig,
  type TelemetryOverrides,
} from './config.ts';
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
  type DroppedCounts,
  type ExportFailure,
  type Pipelines,
  type PipelineOptions,
  type TelemetrySignal,
} from './pipelines.ts';
export {
  extractTraceContext,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  parseTracestate,
  type TraceCarrier,
  type W3CTraceContext,
  writeTraceContext,
} from './trace-context.ts';
export {
  createBoundedRingBuffer,
  type BoundedRingBuffer,
} from './ring-buffer.ts';
