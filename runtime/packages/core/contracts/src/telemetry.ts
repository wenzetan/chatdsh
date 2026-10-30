/**
 * `ctx.chatdshTelemetry` 的服务契约。
 *
 * 业务代码只调用这套方法，不自行构造 OTLP exporter，也不在业务路径上直接 import
 * `@opentelemetry/sdk-*`。关闭状态下全部方法退化为空操作：不构造 SDK 对象，不创建 socket。
 * @module @chatdsh/core-contracts/telemetry
 */

/** 服务名，注册与读取都用它。 */
export const CHATDSH_TELEMETRY_SERVICE = 'chatdshTelemetry';

/** 关闭原因。开启时为 `undefined`。 */
export type TelemetryOffReason = 'env' | 'settings' | 'flag' | 'platform';

/** 诊断日志级别。 */
export type TelemetryLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 属性值。未在登记表里的键在非调试模式下被丢弃并计入丢弃计数。 */
export type TelemetryAttributeValue = string | number | boolean | undefined;

/** 属性表。 */
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

/** 上下文载体，形如 W3C 的 `traceparent` 与 `tracestate` 键值对。 */
export interface TelemetryCarrier {
  traceparent?: string;
  tracestate?: string;
  [key: string]: string | undefined;
}

/** 计数器句柄。 */
export interface TelemetryCounter {
  /** 累加一个增量。 */
  add(delta: number, attributes?: TelemetryAttributes): void;
}

/** 分布句柄，用于耗时与尺寸。 */
export interface TelemetryHistogram {
  /** 记录一个观测值。 */
  record(value: number, attributes?: TelemetryAttributes): void;
}

/** 当前量句柄。 */
export interface TelemetryGauge {
  /** 记录当前值。 */
  record(value: number, attributes?: TelemetryAttributes): void;
}

/** span 句柄。 */
export interface TelemetrySpan {
  /** 设置一个属性。 */
  setAttribute(key: string, value: TelemetryAttributeValue): void;
  /** 批量设置属性。 */
  setAttributes(attributes: TelemetryAttributes): void;
  /** 记录一次异常，写入异常的 `name` 与 `message`（消息经脱敏）。 */
  recordException(error: unknown): void;
  /** 结束 span。重复调用无效。 */
  end(): void;
}

/** 计数器与分布句柄的创建选项。 */
export interface TelemetryInstrumentOptions {
  /** 单位，时间用秒，尺寸用字节。 */
  unit?: string;
  /** 说明文字。 */
  description?: string;
}

/**
 * 遥测出口。
 *
 * 入队不阻塞业务路径，导出失败只在遥测模块内计数。
 */
export interface ChatdshTelemetry {
  /** 当前开关状态。 */
  readonly enabled: boolean;
  /** 关闭原因；开启时为 `undefined`。 */
  readonly reason: TelemetryOffReason | undefined;
  /** 记录一条结构化事件日志。 */
  event(name: string, attributes?: TelemetryAttributes, body?: string): void;
  /** 记录一条诊断日志。 */
  log(level: TelemetryLogLevel, message: string, attributes?: TelemetryAttributes): void;
  /** 取得计数器句柄。 */
  counter(name: string, options?: TelemetryInstrumentOptions): TelemetryCounter;
  /** 取得分布句柄。 */
  histogram(name: string, options?: TelemetryInstrumentOptions): TelemetryHistogram;
  /** 取得当前量句柄。 */
  gauge(name: string, options?: TelemetryInstrumentOptions): TelemetryGauge;
  /** 开始一个 span。 */
  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan;
  /** 异步执行并把结果或错误记入 span，自动结束 span。 */
  runSpan<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => Promise<T>): Promise<T>;
  /** 同步版本。 */
  runSpanSync<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => T): T;
  /** 把当前上下文写进载体。 */
  inject(carrier: TelemetryCarrier): TelemetryCarrier;
  /** 从载体还原父上下文；非法值记一条日志并返回空载体。 */
  extract(carrier: TelemetryCarrier): TelemetryCarrier;
  /** 在还原出的上下文里执行。 */
  withContext<T>(carrier: TelemetryCarrier, fn: () => T): T;
  /** 当前 span 的 trace id；没有活动 span 时返回 `undefined`。 */
  currentTraceId(): string | undefined;
  /** 有界刷新，超时后返回，不抛出。 */
  flush(deadlineMs: number): Promise<void>;
  /** 释放 exporter 与 HTTP 代理，由所属 fiber 的销毁路径调用。 */
  shutdown(): Promise<void>;
}

/** 必带属性键。任何信号都要带上，取值规则见遥测文档第五节。 */
export const TELEMETRY_RESOURCE_ATTRIBUTES = {
  surface: 'chatdsh.surface',
  component: 'chatdsh.component',
  instanceId: 'chatdsh.instance.id',
  version: 'chatdsh.version',
  environment: 'deployment.environment',
} as const;

/** 上下文属性键，按可用性附加。 */
export const TELEMETRY_CONTEXT_ATTRIBUTES = {
  sessionId: 'session.id',
  workspaceId: 'workspace.id',
  turn: 'turn',
  step: 'step',
  toolName: 'tool.name',
  mcpMethod: 'mcp.method',
  provider: 'provider',
  model: 'model',
  requestId: 'request.id',
  errorType: 'error.type',
  errorCode: 'error.code',
  outcome: 'outcome',
} as const;

/** 形态取值，与 `service.name` 的后缀一致。 */
export const TELEMETRY_SURFACES = [
  'gateway',
  'runtime',
  'browser',
  'desktop',
  'mobile',
  'cli',
  'mcp',
] as const;

/** 形态取值。 */
export type TelemetrySurface = (typeof TELEMETRY_SURFACES)[number];

/** 每个形态固定的 `service.name`。 */
export const TELEMETRY_SERVICE_NAMES: Readonly<Record<TelemetrySurface, string>> = {
  gateway: 'chatdsh-gateway',
  runtime: 'chatdsh-runtime',
  browser: 'chatdsh-browser',
  desktop: 'chatdsh-desktop',
  mobile: 'chatdsh-mobile',
  cli: 'chatdsh-cli',
  mcp: 'chatdsh-mcp',
};

/** 遥测面声明，写在包的 `package.json` 的 `chatdsh.telemetry` 里。 */
export interface ChatdshTelemetryManifest {
  /** 事件与 span 名。 */
  events?: readonly string[];
  /** span 名。 */
  spans?: readonly string[];
  /** 指标名。 */
  metrics?: readonly string[];
}

/** 包清单里的 ChatDSH 扩展字段。 */
export interface ChatdshPackageManifest {
  /** 遥测面声明。 */
  telemetry?: ChatdshTelemetryManifest;
  /** 扩展包描述，见架构文档 4.8 节。 */
  extensionApiVersion?: number;
  displayName?: string;
  presets?: readonly string[];
  mcpServers?: readonly { name: string; transport: string; command?: string; url?: string }[];
  panels?: readonly string[];
  permissions?: readonly string[];
}
