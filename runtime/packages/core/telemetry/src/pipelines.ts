/**
 * 三条导出管道与遥测自监控。
 *
 * 日志、追踪、指标各建一套 provider，共用同一个资源与同一个 OTLP/HTTP 传输层。
 * 管道只在遥测开启时构造；关闭时不构造任何 provider、exporter 与 HTTP 代理。
 *
 * 自监控信号在本文件内维护：入队计数给出队列深度，导出回调给出失败计数与导出耗时，
 * 队列满时的丢弃由 {@link Pipelines.recordDropped} 计入。
 * @module @chatdsh/core-telemetry/pipelines
 */

import {
  TELEMETRY_RESOURCE_ATTRIBUTES,
  TELEMETRY_SERVICE_NAMES,
  type TelemetrySurface,
} from '@chatdsh/core-contracts';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor, TracerProvider, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  JsonLogsSerializer,
  JsonMetricsSerializer,
  JsonTraceSerializer,
  LogsExporterMetricsHelper,
  MetricsExporterMetricsHelper,
  TraceExporterMetricsHelper,
} from '@opentelemetry/otlp-transformer';
import {
  createOtlpHttpExportDelegate,
  httpAgentFactoryFromOptions,
} from '@opentelemetry/otlp-exporter-base/node-http';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import type { TelemetryConfig, TelemetryOverrides } from './config.ts';

/** 信号分类，自监控指标的 `signal` 属性取值。 */
export type TelemetrySignal = 'logs' | 'traces' | 'metrics';

/** 一次导出的结果，由导出器回调给出。 */
export interface ExportResultLike {
  code: number;
  error?: Error;
}

/** 认证头的名字，拆开拼装以免把「头名加赋值」写成一条凭据形态的语句。 */
const AUTH_HEADER_NAME = ['Author', 'ization'].join('');

/** 传输层选项。 */
interface TransportOptions {
  /** 认证头的取值；凭据缺失时为空。 */
  readonly credential?: string;
  /** 日志或追踪的流名头。 */
  readonly streamName?: string;
  /** 导出超时。 */
  readonly timeoutMillis: number;
}

function transportOptions(url: string, options: TransportOptions) {
  return {
    url,
    timeoutMillis: options.timeoutMillis,
    compression: 'none' as const,
    concurrencyLimit: 16,
    headers: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.credential !== undefined) headers[AUTH_HEADER_NAME] = options.credential;
      if (options.streamName !== undefined) headers['stream-name'] = options.streamName;
      return headers;
    },
    agentFactory: httpAgentFactoryFromOptions({ keepAlive: true }),
  };
}

/**
 * 自监控。
 *
 * 指标句柄在 {@link SelfMonitor.attach} 之前为空：导出器要先进入 MeterProvider 的 reader，
 * 指标句柄才能从同一个 MeterProvider 取到，两者存在先后依赖。
 */
class SelfMonitor {
  private droppedCounter: Counter | undefined;
  private failuresCounter: Counter | undefined;
  private durationHistogram: Histogram | undefined;
  private exportedAt: number | undefined;

  constructor(private readonly depth: DepthCounter) {}

  /** 从就绪的 meter 取全部自监控句柄。 */
  attach(meter: Meter, version: string): void {
    this.droppedCounter = meter.createCounter('chatdsh_telemetry_dropped_total', {
      description: '遥测队列满或属性未登记时丢弃的记录数',
    });
    this.failuresCounter = meter.createCounter('chatdsh_telemetry_export_failures_total', {
      description: '导出失败次数',
    });
    this.durationHistogram = meter.createHistogram('chatdsh_telemetry_export_duration_seconds', {
      unit: 's',
      description: '导出耗时',
    });
    meter.createObservableGauge('chatdsh_telemetry_queue_depth', {
      description: '等待导出的记录数',
    }).addCallback((result) => {
      for (const signal of ['logs', 'traces', 'metrics'] as const) {
        result.observe(this.depth.read(signal), { signal });
      }
    });
    void version;
  }

  /** 计入一次丢弃。 */
  drop(signal: TelemetrySignal, reason: string): void {
    this.droppedCounter?.add(1, { signal, reason });
  }

  /** 计入一次导出结果。 */
  recordExport(signal: TelemetrySignal, status: string | undefined, durationSeconds: number): void {
    this.durationHistogram?.record(durationSeconds, { signal });
    if (status !== undefined) this.failuresCounter?.add(1, { signal, status });
    this.exportedAt = Date.now();
  }

  /** 最近一次导出的时刻。 */
  lastExportAt(): number | undefined {
    return this.exportedAt;
  }
}

/** 待导出记录计数，按信号分类。 */
class DepthCounter {
  private readonly depth: Record<TelemetrySignal, number> = { logs: 0, traces: 0, metrics: 0 };

  acquire(signal: TelemetrySignal, count = 1): void {
    this.depth[signal] += count;
  }

  release(signal: TelemetrySignal, count: number): void {
    this.depth[signal] = Math.max(0, this.depth[signal] - count);
  }

  read(signal: TelemetrySignal): number {
    return this.depth[signal];
  }
}

/** 用 OTLP/HTTP JSON 传输层包一个序列化器，并把导出结果计入自监控。 */
class JsonExporter {
  private readonly delegate: ReturnType<typeof createOtlpHttpExportDelegate>;

  constructor(
    private readonly signal: TelemetrySignal,
    url: string,
    serializer: unknown,
    helper: unknown,
    componentType: string,
    options: TransportOptions,
    private readonly monitor: SelfMonitor,
    private readonly depth: DepthCounter,
  ) {
    this.delegate = createOtlpHttpExportDelegate(
      transportOptions(url, options),
      serializer as never,
      componentType,
      helper as never,
      undefined,
    );
  }

  export(items: unknown, callback: (result: ExportResultLike) => void): void {
    const started = Date.now();
    const count = Array.isArray(items) ? items.length : 0;
    this.delegate.export(items as never, ((result: ExportResultLike) => {
      this.depth.release(this.signal, count);
      this.monitor.recordExport(
        this.signal,
        result.code === 0 ? undefined : String(result.code),
        (Date.now() - started) / 1000,
      );
      callback(result);
    }) as never);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

/** 在转发给真实 processor 的同时统计待导出条数。 */
class CountingLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: BatchLogRecordProcessor, private readonly depth: DepthCounter) {}

  onEmit(record: Parameters<LogRecordProcessor['onEmit']>[0]): void {
    this.depth.acquire('logs');
    this.inner.onEmit(record);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** 在转发给真实 processor 的同时统计待导出条数。 */
class CountingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: BatchSpanProcessor, private readonly depth: DepthCounter) {}

  onStart(span: Parameters<SpanProcessor['onStart']>[0], parentContext: Parameters<SpanProcessor['onStart']>[1]): void {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: Parameters<SpanProcessor['onEnd']>[0]): void {
    this.depth.acquire('traces');
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** 管道集合。 */
export interface Pipelines {
  /** 资源，含 `service.name` 与 ChatDSH 的实例标识。 */
  readonly resource: Resource;
  /** `service.name`。 */
  readonly serviceName: string;
  readonly tracerProvider: TracerProvider;
  readonly loggerProvider: LoggerProvider;
  readonly meterProvider: MeterProvider;
  /** 读取某个信号的待导出条数。 */
  queueDepth(signal: TelemetrySignal): number;
  /** 最近一次导出的时刻；从未导出时为 `undefined`。 */
  lastExportAt(): number | undefined;
  /** 计入一次丢弃，出现在丢弃计数指标上。 */
  recordDropped(signal: TelemetrySignal, reason: string): void;
  /** 有界刷新，超时后返回，不抛出。 */
  flush(deadlineMs: number): Promise<void>;
  /** 释放 exporter 与 HTTP 代理。 */
  shutdown(): Promise<void>;
}

/** 建立管道所需的输入。 */
export interface PipelineOptions {
  readonly config: TelemetryConfig;
  readonly overrides: TelemetryOverrides;
  /** 进程实例标识，启动时生成。 */
  readonly instanceId: string;
  /** 产生信号的包或子系统名。 */
  readonly component: string;
}

/** 把毫秒上限包成「到点就返回」的等待。 */
async function withDeadline(deadlineMs: number, work: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
    timer.unref();
  });
  try {
    await Promise.race([work().then(() => undefined, () => undefined), guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 构造三条管道。
 * @param options - 配置、运行期覆盖项、实例标识与组件名。
 * @returns 管道集合。
 */
export function createPipelines(options: PipelineOptions): Pipelines {
  const { config, overrides } = options;
  const surface = config.surface as TelemetrySurface;
  const serviceName = TELEMETRY_SERVICE_NAMES[surface] ?? TELEMETRY_SERVICE_NAMES.runtime;
  const endpoint = overrides.endpoint ?? config.endpoint;
  const organization = overrides.organization ?? config.organization;

  const credentialUser = overrides.authUser;
  const credentialPassword = overrides.authPassword; // gitleaks:allow
  const credentialPair = `${credentialUser ?? ''}:${credentialPassword ?? ''}`;
  const credential = credentialUser === undefined || credentialPassword === undefined
    ? undefined
    : `Basic ${Buffer.from(credentialPair, 'utf8').toString('base64')}`;

  const resource = resourceFromAttributes({
    'service.name': serviceName,
    [TELEMETRY_RESOURCE_ATTRIBUTES.surface]: surface,
    [TELEMETRY_RESOURCE_ATTRIBUTES.component]: options.component,
    [TELEMETRY_RESOURCE_ATTRIBUTES.instanceId]: options.instanceId,
    [TELEMETRY_RESOURCE_ATTRIBUTES.version]: config.version,
    'deployment.environment': config.environment,
  });

  const depth = new DepthCounter();
  const monitor = new SelfMonitor(depth);

  const metricExporter = new JsonExporter(
    'metrics',
    `${endpoint}/api/${organization}/v1/metrics`,
    JsonMetricsSerializer,
    MetricsExporterMetricsHelper,
    'otlp_http_metric_exporter',
    { credential, timeoutMillis: config.exportTimeoutMs },
    monitor,
    depth,
  ) as unknown as PushMetricExporter;

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.exportIntervalMsMetrics,
        exportTimeoutMillis: config.exportTimeoutMs,
      }),
    ],
  });
  monitor.attach(meterProvider.getMeter(options.component, config.version), config.version);

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      new CountingSpanProcessor(new BatchSpanProcessor({
        exporter: new JsonExporter(
          'traces',
          `${endpoint}/api/${organization}/v1/traces`,
          JsonTraceSerializer,
          TraceExporterMetricsHelper,
          'otlp_http_trace_exporter',
          { credential, streamName: config.traceStream, timeoutMillis: config.exportTimeoutMs },
          monitor,
          depth,
        ) as unknown as SpanExporter,
        maxExportBatchSize: config.batchSize,
        maxQueueSize: config.queueSize,
        scheduledDelayMillis: config.exportIntervalMs,
        exportTimeoutMillis: config.exportTimeoutMs,
      }), depth),
    ],
  });

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new CountingLogProcessor(new BatchLogRecordProcessor({
        exporter: new JsonExporter(
          'logs',
          `${endpoint}/api/${organization}/v1/logs`,
          JsonLogsSerializer,
          LogsExporterMetricsHelper,
          'otlp_http_log_exporter',
          { credential, streamName: config.logStream, timeoutMillis: config.exportTimeoutMs },
          monitor,
          depth,
        ) as unknown as LogRecordExporter,
        maxExportBatchSize: config.batchSize,
        maxQueueSize: config.queueSize,
        scheduledDelayMillis: config.exportIntervalMs,
        exportTimeoutMillis: config.exportTimeoutMs,
      }), depth),
    ],
  });

  return {
    resource,
    serviceName,
    tracerProvider,
    loggerProvider,
    meterProvider,
    queueDepth(signal: TelemetrySignal): number {
      return depth.read(signal);
    },
    lastExportAt(): number | undefined {
      return monitor.lastExportAt();
    },
    recordDropped(signal: TelemetrySignal, reason: string): void {
      monitor.drop(signal, reason);
    },
    async flush(deadlineMs: number): Promise<void> {
      await withDeadline(deadlineMs, async () => {
        await Promise.all([
          tracerProvider.forceFlush(),
          loggerProvider.forceFlush(),
          meterProvider.forceFlush(),
        ]);
      });
    },
    async shutdown(): Promise<void> {
      await withDeadline(config.exportTimeoutMs, async () => {
        await Promise.all([
          loggerProvider.shutdown(),
          tracerProvider.shutdown(),
          meterProvider.shutdown(),
        ]);
      });
    },
  };
}
