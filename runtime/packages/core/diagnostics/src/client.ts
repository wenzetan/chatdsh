/**
 * 框架无关的遥测客户端。
 *
 * 各端（控制平面、运行时之外的主进程、命令行、MCP 服务端）用同一个客户端，差别只在
 * `surface` 与 `component`。宿主平面插件把这个客户端包成 `ctx.chatdshTelemetry`，
 * 独立进程直接持有它。业务代码只调用客户端方法，不构造导出管道。
 * @module @chatdsh/core-diagnostics/client
 */

import { randomUUID } from 'node:crypto';
import {
  SpanStatusCode,
  context,
  createTraceState,
  isSpanContextValid,
  trace,
  type Counter,
  type Gauge,
  type Histogram,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  type ChatdshTelemetry,
  type TelemetryAttributeValue,
  type TelemetryAttributes,
  type TelemetryCarrier,
  type TelemetryCounter,
  type TelemetryGauge,
  type TelemetryHistogram,
  type TelemetryInstrumentOptions,
  type TelemetryLogLevel,
  type TelemetryOffReason,
  type TelemetrySpan,
} from '@chatdsh/core-contracts';
import { readOverrides, resolveSwitch, type TelemetryConfig, type TelemetryOverrides } from './config.ts';
import { createRedactor, type Redactor } from './redact.ts';
import { createPipelines, type Pipelines } from './pipelines.ts';
import { ensureContextManager } from './context-manager.ts';
import { createBoundedRingBuffer } from './ring-buffer.ts';
import { extractTraceContext, parseTraceparent, parseTracestate, writeTraceContext } from './trace-context.ts';

/** 日志级别到 OTel 严重级别的映射。 */
const SEVERITY: Record<TelemetryLogLevel, { number: number; text: string }> = {
  debug: { number: 5, text: 'DEBUG' },
  info: { number: 9, text: 'INFO' },
  warn: { number: 13, text: 'WARN' },
  error: { number: 17, text: 'ERROR' },
};

/** 级别下限，用于按配置过滤。 */
const LEVEL_ORDER: Record<TelemetryLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 空 span 句柄，关闭状态下复用同一个实例。 */
const NOOP_SPAN: TelemetrySpan = {
  setAttribute: () => {},
  setAttributes: () => {},
  recordException: () => {},
  end: () => {},
};

/** 客户端构造输入。 */
export interface TelemetryClientOptions {
  /** 配置；缺省字段由 {@link TelemetryConfig} 的默认值补齐。 */
  readonly config: TelemetryConfig;
  /** 产生信号的包或子系统名。 */
  readonly component: string;
  /** 进程环境变量；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 平台是否支持遥测，缺省为支持。 */
  readonly platformSupported?: boolean;
  /** 实例标识；缺省在构造时生成。 */
  readonly instanceId?: string;
}

/** 自检结果。 */
export interface TelemetrySelfTest {
  readonly probeId: string;
}

/** 自监控诊断事件：只记录元数据，不记录任何原始载荷或消息正文。 */
export interface TelemetryDiagnosticRecord {
  /** 信号类别。 */
  readonly signal: 'logs' | 'traces' | 'metrics';
  /** 丢弃原因；导出失败事件没有该字段。 */
  readonly reason?: string;
  /** 导出状态；丢弃事件没有该字段。 */
  readonly status?: string;
  /** 事件发生时刻的毫秒时间戳。 */
  readonly at: number;
}

/** 自监控事件环形缓冲容量。 */
const DIAGNOSTICS_CAPACITY = 32;

function wrapSpan(span: Span): TelemetrySpan {
  return {
    setAttribute(key: string, value: TelemetryAttributeValue): void {
      if (value !== undefined) span.setAttribute(key, value);
    },
    setAttributes(attributes: TelemetryAttributes): void {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) span.setAttribute(key, value);
      }
    },
    recordException(error: unknown): void {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
    },
    end(): void {
      span.end();
    },
  };
}

/**
 * 遥测客户端。
 *
 * 关闭状态下全部方法退化为空操作：不构造任何 provider、exporter 与 HTTP 代理。
 */
export class TelemetryClient implements ChatdshTelemetry {
  /** 进程实例标识，写入资源属性。 */
  readonly instanceId: string;
  /** 当前开关状态。 */
  readonly enabled: boolean;
  /** 关闭原因；开启时为 `undefined`。 */
  readonly reason: TelemetryOffReason | undefined;

  private readonly settings: TelemetryConfig;
  private readonly overrides: TelemetryOverrides;
  private readonly redactor: Redactor;
  private readonly endpoint: string;
  private readonly pipelines: Pipelines | undefined;
  private readonly tracer: Tracer | undefined;
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly diagnostics = createBoundedRingBuffer<TelemetryDiagnosticRecord>(DIAGNOSTICS_CAPACITY);
  private exportedAt: number | undefined;

  constructor(options: TelemetryClientOptions) {
    const env = options.env ?? process.env;
    this.settings = options.config;
    this.overrides = readOverrides(env);
    this.instanceId = options.instanceId ?? randomUUID();
    const state = resolveSwitch(options.config, env, options.platformSupported ?? true);
    this.enabled = state.enabled;
    this.reason = state.reason;
    this.redactor = createRedactor([], { debug: options.config.debug || this.overrides.debug === true });
    this.endpoint = this.overrides.endpoint ?? options.config.endpoint;

    if (state.enabled) {
      ensureContextManager();
      this.pipelines = createPipelines({
        config: options.config,
        overrides: this.overrides,
        instanceId: this.instanceId,
        component: options.component,
      });
      this.tracer = this.pipelines.tracerProvider.getTracer(options.component, options.config.version);
      this.event('chatdsh.telemetry.enabled', { reason: 'startup' });
    }
  }

  /** 服务名，取自形态。 */
  get serviceName(): string {
    return this.pipelines?.serviceName ?? 'chatdsh-runtime';
  }

  /** 记录一条结构化事件日志。 */
  event(name: string, attributes: TelemetryAttributes = {}, body?: string): void {
    if (this.pipelines === undefined) return;
    const { kept, dropped } = this.redactor.attributes(attributes);
    if (dropped > 0) this.recordDropped('logs', 'unregistered-attribute');
    this.pipelines.loggerProvider.getLogger('@chatdsh/core-diagnostics', this.settings.version).emit({
      severityNumber: SEVERITY.info.number,
      severityText: SEVERITY.info.text,
      body: body === undefined ? name : this.redactor.message(body),
      attributes: kept,
    });
  }

  /** 记录一条诊断日志。 */
  log(level: TelemetryLogLevel, message: string, attributes: TelemetryAttributes = {}): void {
    if (this.pipelines === undefined) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.settings.logLevel as TelemetryLogLevel]) return;
    const { kept, dropped } = this.redactor.attributes(attributes);
    if (dropped > 0) this.recordDropped('logs', 'unregistered-attribute');
    this.pipelines.loggerProvider.getLogger('@chatdsh/core-diagnostics', this.settings.version).emit({
      severityNumber: SEVERITY[level].number,
      severityText: SEVERITY[level].text,
      body: this.redactor.message(message),
      attributes: kept,
    });
  }

  /** 取得计数器句柄。 */
  counter(name: string, options?: TelemetryInstrumentOptions): TelemetryCounter {
    if (this.pipelines === undefined) return { add: () => {} };
    let counter = this.counters.get(name);
    if (counter === undefined) {
      counter = this.meter().createCounter(name, instrumentOptions(options));
      this.counters.set(name, counter);
    }
    const handle = counter;
    return {
      add: (delta: number, attributes: TelemetryAttributes = {}): void => {
        const { kept, dropped } = this.redactor.attributes(attributes);
        if (dropped > 0) this.recordDropped('metrics', 'unregistered-attribute');
        handle.add(delta, kept);
      },
    };
  }

  /** 取得分布句柄。 */
  histogram(name: string, options?: TelemetryInstrumentOptions): TelemetryHistogram {
    if (this.pipelines === undefined) return { record: () => {} };
    let histogram = this.histograms.get(name);
    if (histogram === undefined) {
      histogram = this.meter().createHistogram(name, instrumentOptions(options));
      this.histograms.set(name, histogram);
    }
    const handle = histogram;
    return {
      record: (value: number, attributes: TelemetryAttributes = {}): void => {
        const { kept, dropped } = this.redactor.attributes(attributes);
        if (dropped > 0) this.recordDropped('metrics', 'unregistered-attribute');
        handle.record(value, kept);
      },
    };
  }

  /** 取得当前量句柄。 */
  gauge(name: string, options?: TelemetryInstrumentOptions): TelemetryGauge {
    if (this.pipelines === undefined) return { record: () => {} };
    let gauge = this.gauges.get(name);
    if (gauge === undefined) {
      gauge = this.meter().createGauge(name, instrumentOptions(options));
      this.gauges.set(name, gauge);
    }
    const handle = gauge;
    return {
      record: (value: number, attributes: TelemetryAttributes = {}): void => {
        const { kept, dropped } = this.redactor.attributes(attributes);
        if (dropped > 0) this.recordDropped('metrics', 'unregistered-attribute');
        handle.record(value, kept);
      },
    };
  }

  /** 开始一个 span。 */
  startSpan(name: string, attributes: TelemetryAttributes = {}): TelemetrySpan {
    if (this.tracer === undefined) return NOOP_SPAN;
    const { kept } = this.redactor.attributes(attributes);
    return wrapSpan(this.tracer.startSpan(name, { attributes: kept }));
  }

  /** 异步执行并把结果或错误记入 span，自动结束 span。 */
  async runSpan<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    if (this.tracer === undefined) return fn(NOOP_SPAN);
    const { kept } = this.redactor.attributes(attributes);
    return this.tracer.startActiveSpan(name, { attributes: kept }, async (span) => {
      try {
        const result = await fn(wrapSpan(span));
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** 同步版本。 */
  runSpanSync<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => T): T {
    if (this.tracer === undefined) return fn(NOOP_SPAN);
    const { kept } = this.redactor.attributes(attributes);
    const span = this.tracer.startSpan(name, { attributes: kept });
    return context.with(trace.setSpan(context.active(), span), () => {
      try {
        const result = fn(wrapSpan(span));
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** 把当前活动 span 的链路上下文写进载体，不修改入参。 */
  inject(carrier: TelemetryCarrier): TelemetryCarrier {
    if (this.pipelines === undefined) return carrier;
    const activeSpan = trace.getSpan(context.active());
    if (activeSpan === undefined) return carrier;
    const spanContext = activeSpan.spanContext();
    if (!isSpanContextValid(spanContext)) return carrier;
    return writeTraceContext(carrier, {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags.toString(16).padStart(2, '0'),
      traceState: spanContext.traceState?.serialize(),
    });
  }

  /**
   * 严格解析载体并返回新的载体；非法 traceparent 或 tracestate 返回空对象。
   * 入参不会被修改，合法时保留非链路头字段。
   */
  extract(carrier: TelemetryCarrier): TelemetryCarrier {
    if (this.pipelines === undefined) return {};
    if (carrier.traceparent === undefined) return {};

    const traceparentValid = parseTraceparent(carrier.traceparent) !== undefined;
    const tracestateInvalid = traceparentValid
      && carrier.tracestate !== undefined
      && parseTracestate(carrier.tracestate) === undefined;
    const parsed = this.parseCarrier(carrier);
    if (parsed === undefined) {
      this.event('chatdsh.telemetry.invalid', {
        carrier: tracestateInvalid ? 'tracestate' : 'traceparent',
        reason: 'malformed',
      });
      return {};
    }

    const { traceparent: _ignoredTraceparent, tracestate: _ignoredTracestate, ...rest } = carrier;
    return writeTraceContext(rest, parsed);
  }

  /** 在自建解析出的父上下文里执行；非法载体按空上下文执行。 */
  withContext<T>(carrier: TelemetryCarrier, fn: () => T): T {
    if (this.pipelines === undefined) return fn();
    const parsed = this.parseCarrier(carrier);
    if (parsed === undefined) return context.with(context.active(), fn);

    const traceState = parsed.traceState === undefined ? undefined : createTraceState(parsed.traceState);
    const parent = trace.setSpanContext(context.active(), {
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      traceFlags: Number.parseInt(parsed.traceFlags, 16),
      ...(traceState === undefined ? {} : { traceState }),
    });
    return context.with(parent, fn);
  }

  /** 当前 span 的 trace id；没有活动 span 时返回 `undefined`。 */
  currentTraceId(): string | undefined {
    return trace.getSpan(context.active())?.spanContext().traceId;
  }

  /** 有界刷新，超时后返回，不抛出。 */
  async flush(deadlineMs: number): Promise<void> {
    if (this.pipelines === undefined) return;
    await this.pipelines.flush(deadlineMs);
    this.exportedAt = Date.now();
  }

  /** 释放 exporter 与 HTTP 代理。 */
  async shutdown(): Promise<void> {
    if (this.pipelines === undefined) return;
    await this.pipelines.shutdown();
  }

  /** 运行期从环境变量读到的覆盖项，供端点层转发上报时使用。 */
  runtimeOverrides(): TelemetryOverrides {
    return this.overrides;
  }

  /** 记录一次因缺少凭据而无法转发的中继请求。 */
  noteRelayWithoutCredential(): void {
    this.recordDropped('logs', 'relay-without-credential');
  }

  /** 状态载荷：开关、端点、信号、队列深度与最近导出时刻。 */
  status(): Record<string, unknown> {
    if (this.pipelines === undefined) {
      return { enabled: false, reason: this.reason, endpoint: this.endpoint, recentDiagnostics: [] };
    }
    return {
      enabled: true,
      endpoint: this.endpoint,
      organization: this.overrides.organization ?? this.settings.organization,
      serviceName: this.pipelines.serviceName,
      instanceId: this.instanceId,
      component: '@chatdsh/core-diagnostics',
      version: this.settings.version,
      signals: {
        logs: ['event', 'log'],
        traces: ['startSpan', 'runSpan', 'runSpanSync', 'inject', 'extract', 'withContext'],
        metrics: ['counter', 'histogram', 'gauge'],
      },
      queueDepth: {
        logs: this.pipelines.queueDepth('logs'),
        traces: this.pipelines.queueDepth('traces'),
        metrics: this.pipelines.queueDepth('metrics'),
      },
      lastExportAt: this.pipelines.lastExportAt() ?? this.exportedAt,
      credential: this.overrides.authUser === undefined || this.overrides.authPassword === undefined ? 'missing' : 'configured',
      recentDiagnostics: this.recentDiagnostics(),
    };
  }

  /** 写一条日志、一个 span 与一个计数器，返回探针标识。 */
  async selfTest(): Promise<TelemetrySelfTest> {
    const probeId = randomUUID();
    this.log('info', 'telemetry self test', { 'probe.id': probeId });
    this.counter('chatdsh_telemetry_self_test_total', { description: '遥测自检次数' }).add(1, { 'probe.id': probeId });
    await this.runSpan('chatdsh.telemetry.probe', { 'probe.id': probeId }, async () => {
      await this.flush(this.settings.exportTimeoutMs);
      return undefined;
    });
    return { probeId };
  }

  private meter() {
    if (this.pipelines === undefined) throw new Error('telemetry is disabled');
    return this.pipelines.meterProvider.getMeter('@chatdsh/core-diagnostics', this.settings.version);
  }

  private recordDropped(signal: 'logs' | 'traces' | 'metrics', reason: string): void {
    if (this.pipelines === undefined) return;
    this.pipelines.recordDropped(signal, reason);
    const overwritten = this.diagnostics.push({ signal, reason, at: Date.now() });
    if (overwritten) this.pipelines.recordDropped('logs', 'diagnostics-buffer-overflow');
    this.event('chatdsh.telemetry.dropped', { signal, reason });
  }

  /** 严格解析载体；traceparent 与 tracestate 任一非法都视为无有效上下文。 */
  private parseCarrier(carrier: TelemetryCarrier) {
    if (carrier.traceparent === undefined) return undefined;
    if (parseTraceparent(carrier.traceparent) === undefined) return undefined;
    if (carrier.tracestate !== undefined && parseTracestate(carrier.tracestate) === undefined) return undefined;
    return extractTraceContext(carrier);
  }

  /** 合并管道导出失败与客户端丢弃事件，只返回最新的有界元数据。 */
  private recentDiagnostics(): readonly TelemetryDiagnosticRecord[] {
    if (this.pipelines === undefined) return [];
    const exportFailures: TelemetryDiagnosticRecord[] = this.pipelines.recentExportFailures().map((failure) => ({
      signal: failure.signal,
      status: failure.status,
      at: failure.at,
    }));
    const merged = [...exportFailures, ...this.diagnostics.snapshot()];
    merged.sort((left, right) => left.at - right.at);
    return merged.slice(Math.max(0, merged.length - DIAGNOSTICS_CAPACITY));
  }
}

function instrumentOptions(options: TelemetryInstrumentOptions | undefined) {
  if (options === undefined) return undefined;
  // 值为 undefined 的键不写进对象：严格可选属性下「键存在但值为 undefined」与「键不存在」不等价。
  const result: { description?: string; unit?: string } = {};
  if (options.description !== undefined) result.description = options.description;
  if (options.unit !== undefined) result.unit = options.unit;
  return result;
}

/**
 * 按配置建立一个客户端。
 * @param options - 配置、组件名与可选的运行期覆盖。
 * @returns 客户端实例。
 */
export function createTelemetryClient(options: TelemetryClientOptions): TelemetryClient {
  return new TelemetryClient(options);
}
