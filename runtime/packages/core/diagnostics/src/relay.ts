/**
 * 经同源中继上报的遥测客户端。
 *
 * 浏览器与桌面主进程不持有 OpenObserve 凭据、也不加载导出 SDK：客户端把信号编成
 * OTLP/HTTP JSON，按批投递到运行时的同源端点，由运行时用自己的 exporter 出网。
 * 方法与 `@chatdsh/core-diagnostics/client` 完全同名，各端共用同一套调用面。
 *
 * 关闭状态下全部方法退化为空操作：不建队列、不起定时器、不发请求，也不生成或注入
 * `traceparent`。关闭与开启可以在进程内切换，切换不影响业务控制流。
 * @module @chatdsh/core-diagnostics/relay
 */

import type {
  ChatdshTelemetry,
  TelemetryAttributes,
  TelemetryAttributeValue,
  TelemetryCarrier,
  TelemetryCounter,
  TelemetryGauge,
  TelemetryHistogram,
  TelemetryInstrumentOptions,
  TelemetryLogLevel,
  TelemetryOffReason,
  TelemetrySpan,
} from '@chatdsh/core-contracts';
import { randomUUID } from './uuid.ts';
import { createBoundedRingBuffer } from './ring-buffer.ts';
import type { TelemetryDiagnosticEvent, TelemetryDiagnosticsExport } from './client.ts';
import type { DroppedCounts } from './pipelines.ts';
import { createRedactor, type Redactor } from './redact.ts';
import { extractTraceContext, generateSpanId, generateTraceId, parseTraceparent, parseTracestate, writeTraceContext } from './trace-context.ts';
import {
  logsPayload,
  metricsPayload,
  tracesPayload,
  type RelayAttribute,
  type RelayLogRecord,
  type RelayMetricKind,
  type RelayMetricPoint,
  type RelayMetricRecord,
  type RelayResource,
  type RelaySpanRecord,
} from './relay-payload.ts';

/** 中继端点路径。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 信号分流请求头。 */
export const RELAY_SIGNAL_HEADER = 'x-chatdsh-signal';

/** 同源上报要求的请求头；跨站表单无法携带自定义头，因此它同时起到 CSRF 防护作用。 */
export const RELAY_CSRF_HEADER = 'x-chatdsh-csrf';

/** 单批最多条数，与中继端点的限制一致。 */
export const RELAY_BATCH_LIMIT = 64;

/** 单批最大字节数。 */
export const RELAY_PAYLOAD_LIMIT = 256 * 1024;

/** 待发送帧上限，超出按队列满丢弃并计数。 */
export const RELAY_QUEUE_LIMIT = 32;

/** 默认上报间隔。 */
export const RELAY_FLUSH_INTERVAL_MS = 5000;

/** 最近事件的环形缓冲容量。 */
const RECENT_CAPACITY = 64;

/** 日志级别到 OTel 严重级别的映射。 */
const SEVERITY: Record<TelemetryLogLevel, { number: number; text: string }> = {
  debug: { number: 5, text: 'DEBUG' },
  info: { number: 9, text: 'INFO' },
  warn: { number: 13, text: 'WARN' },
  error: { number: 17, text: 'ERROR' },
};

/** 级别下限。 */
const LEVEL_ORDER: Record<TelemetryLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 空 span 句柄。 */
const NOOP_SPAN: TelemetrySpan = {
  setAttribute: () => {},
  setAttributes: () => {},
  recordException: () => {},
  end: () => {},
};

/** 一个活动链路上下文。 */
interface ActiveContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
  readonly traceState?: string;
}

/** 客户端构造输入。 */
export interface RelayTelemetryOptions {
  /** 产生信号的包名。 */
  readonly component: string;
  /** 形态，取 `browser` 或 `desktop`。 */
  readonly surface: string;
  /** 产品版本。 */
  readonly version?: string;
  /** 部署环境。 */
  readonly environment?: string;
  /** 进程实例标识；缺省在构造时生成。 */
  readonly instanceId?: string;
  /** 中继端点路径。 */
  readonly url?: string;
  /** 初始开关状态，缺省开启。 */
  readonly enabled?: boolean;
  /** 初始关闭原因。 */
  readonly reason?: TelemetryOffReason;
  /** 日志级别下限，缺省 `info`。 */
  readonly logLevel?: TelemetryLogLevel;
  /** 上报间隔。 */
  readonly flushIntervalMs?: number;
  /** 调试模式：保留未登记属性的值，供本地排查。 */
  readonly debug?: boolean;
  /** 单批最大字节数。 */
  readonly payloadLimit?: number;
  /** 待发送帧上限。 */
  readonly queueLimit?: number;
  /** 最近事件容量。 */
  readonly recentEventCapacity?: number;
  /** 投递实现；缺省用全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
}

/** 一帧待发送的载荷。 */
interface Frame {
  readonly signal: 'logs' | 'traces' | 'metrics';
  readonly body: string;
}

/** 一个指标的累计状态。 */
interface MetricState {
  readonly name: string;
  readonly unit?: string;
  readonly kind: RelayMetricKind;
  readonly points: Map<string, { attributes: RelayAttribute[]; value: number; count: number; sum: number }>;
}

/** 一个尚未结束的 span。 */
interface PendingSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startAt: number;
  readonly attributes: RelayAttribute[];
  status: 'ok' | 'error';
  ended: boolean;
  endAt?: number;
}

/** 把属性表转成中继载荷使用的键值对列表。 */
function toAttributes(attributes: TelemetryAttributes): RelayAttribute[] {
  const out: RelayAttribute[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    out.push([key, value as TelemetryAttributeValue as string | number | boolean]);
  }
  return out;
}

/**
 * 经同源中继上报的遥测客户端。
 */
export class RelayTelemetryClient implements ChatdshTelemetry {
  /** 进程实例标识。 */
  readonly instanceId: string;

  private readonly settings: RelayTelemetryOptions;
  private readonly resource: RelayResource;
  private readonly redactor: Redactor;
  private readonly url: string;
  private readonly payloadLimit: number;
  private readonly queueLimit: number;
  private readonly recent: ReturnType<typeof createBoundedRingBuffer<TelemetryDiagnosticEvent>>;
  private readonly frames: Frame[] = [];
  private readonly metrics = new Map<string, MetricState>();
  private readonly droppedBySignal: Record<'logs' | 'traces' | 'metrics', number> = { logs: 0, traces: 0, metrics: 0 };
  private readonly droppedByReason: Record<string, number> = {};
  private readonly stack: ActiveContext[] = [];
  private readonly startedAt = Date.now();
  private active: boolean;
  private offReason: TelemetryOffReason | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private failedExports = 0;

  constructor(options: RelayTelemetryOptions) {
    this.settings = options;
    this.instanceId = options.instanceId ?? randomUUID();
    this.url = options.url ?? RELAY_PATH;
    this.payloadLimit = options.payloadLimit ?? RELAY_PAYLOAD_LIMIT;
    this.queueLimit = options.queueLimit ?? RELAY_QUEUE_LIMIT;
    this.active = options.enabled ?? true;
    this.offReason = this.active ? undefined : options.reason ?? 'settings';
    this.redactor = createRedactor([], { debug: options.debug === true });
    this.resource = {
      serviceName: `chatdsh-${options.surface}`,
      surface: options.surface,
      component: options.component,
      instanceId: this.instanceId,
      version: options.version,
      environment: options.environment,
    };
    this.recent = createBoundedRingBuffer<TelemetryDiagnosticEvent>(options.recentEventCapacity ?? RECENT_CAPACITY);
    if (this.active) this.startTimer();
  }

  /** 当前开关状态。 */
  get enabled(): boolean {
    return this.active;
  }

  /** 关闭原因；开启时为 `undefined`。 */
  get reason(): TelemetryOffReason | undefined {
    return this.offReason;
  }

  /**
   * 在进程内切换开关。
   *
   * 关闭时先停新记录，再把在途帧发完并停掉定时器；开启时重新开始计时。
   * @param enabled - 目标状态。
   * @param reason - 关闭原因，关闭时必填。
   */
  setEnabled(enabled: boolean, reason?: TelemetryOffReason): void {
    if (enabled === this.active) {
      this.offReason = enabled ? undefined : reason ?? this.offReason ?? 'settings';
      return;
    }
    if (enabled) {
      this.active = true;
      this.offReason = undefined;
      this.startTimer();
      return;
    }
    this.active = false;
    this.offReason = reason ?? 'settings';
    this.stopTimer();
    this.frames.length = 0;
    this.stack.length = 0;
  }

  /** 记录一条结构化事件日志。 */
  event(name: string, attributes: TelemetryAttributes = {}, body?: string): void {
    if (!this.active) return;
    const { kept, dropped } = this.redactor.attributes(attributes);
    if (dropped > 0) this.recordDropped('logs', 'unregistered-attribute');
    const current = this.stack.at(-1);
    this.postLog({
      at: Date.now(),
      severityNumber: SEVERITY.info.number,
      severityText: SEVERITY.info.text,
      body: body === undefined ? name : this.redactor.message(body),
      attributes: toAttributes(kept),
      traceId: current?.traceId,
      spanId: current?.spanId,
    });
    this.recordRecent({ at: Date.now(), signal: 'logs', kind: 'event', name, attributes: kept });
  }

  /** 记录一条诊断日志。 */
  log(level: TelemetryLogLevel, message: string, attributes: TelemetryAttributes = {}): void {
    if (!this.active) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.settings.logLevel ?? 'info']) return;
    const { kept, dropped } = this.redactor.attributes(attributes);
    if (dropped > 0) this.recordDropped('logs', 'unregistered-attribute');
    const redacted = this.redactor.message(message);
    const current = this.stack.at(-1);
    this.postLog({
      at: Date.now(),
      severityNumber: SEVERITY[level].number,
      severityText: SEVERITY[level].text,
      body: redacted,
      attributes: toAttributes(kept),
      traceId: current?.traceId,
      spanId: current?.spanId,
    });
    this.recordRecent({ at: Date.now(), signal: 'logs', kind: 'log', name: 'log', level, message: redacted, attributes: kept });
  }

  /** 取得计数器句柄。 */
  counter(name: string, options?: TelemetryInstrumentOptions): TelemetryCounter {
    if (!this.active) return { add: () => {} };
    return {
      add: (delta: number, attributes: TelemetryAttributes = {}): void => {
        if (!this.active) return;
        const { kept, dropped } = this.redactor.attributes(attributes);
        if (dropped > 0) this.recordDropped('metrics', 'unregistered-attribute');
        this.accumulate({ name, unit: options?.unit, kind: 'sum' }, kept, delta, 1);
      },
    };
  }

  /** 取得分布句柄。 */
  histogram(name: string, options?: TelemetryInstrumentOptions): TelemetryHistogram {
    if (!this.active) return { record: () => {} };
    return {
      record: (value: number, attributes: TelemetryAttributes = {}): void => {
        if (!this.active) return;
        const { kept, dropped } = this.redactor.attributes(attributes);
        if (dropped > 0) this.recordDropped('metrics', 'unregistered-attribute');
        this.accumulate({ name, unit: options?.unit, kind: 'histogram' }, kept, value, 1);
      },
    };
  }

  /** 取得当前量句柄。 */
  gauge(name: string, options?: TelemetryInstrumentOptions): TelemetryGauge {
    if (!this.active) return { record: () => {} };
    return {
      record: (value: number, attributes: TelemetryAttributes = {}): void => {
        if (!this.active) return;
        const { kept, dropped } = this.redactor.attributes(attributes);
        if (dropped > 0) this.recordDropped('metrics', 'unregistered-attribute');
        this.accumulate({ name, unit: options?.unit, kind: 'gauge' }, kept, value, 1);
      },
    };
  }

  /** 开始一个 span。 */
  startSpan(name: string, attributes: TelemetryAttributes = {}): TelemetrySpan {
    if (!this.active) return NOOP_SPAN;
    const { kept } = this.filterSpanAttributes(attributes);
    const span = this.beginSpan(name, kept);
    return this.spanHandle(span, kept);
  }

  /** 异步执行并把结果或错误记入 span，自动结束 span。 */
  async runSpan<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    if (!this.active) return fn(NOOP_SPAN);
    const { kept } = this.filterSpanAttributes(attributes);
    const span = this.beginSpan(name, kept);
    this.stack.push({ traceId: span.traceId, spanId: span.spanId, traceFlags: '01' });
    try {
      const result = await fn(this.spanHandle(span, kept));
      span.status = 'ok';
      return result;
    } catch (error) {
      span.status = 'error';
      throw error;
    } finally {
      this.stack.pop();
      this.finishSpan(span);
    }
  }

  /** 同步版本。 */
  runSpanSync<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => T): T {
    if (!this.active) return fn(NOOP_SPAN);
    const { kept } = this.filterSpanAttributes(attributes);
    const span = this.beginSpan(name, kept);
    this.stack.push({ traceId: span.traceId, spanId: span.spanId, traceFlags: '01' });
    try {
      const result = fn(this.spanHandle(span, kept));
      span.status = 'ok';
      return result;
    } catch (error) {
      span.status = 'error';
      throw error;
    } finally {
      this.stack.pop();
      this.finishSpan(span);
    }
  }

  /** 把当前活动上下文的链路标识写进载体，不修改入参。 */
  inject(carrier: TelemetryCarrier): TelemetryCarrier {
    if (!this.active) return carrier;
    const current = this.stack.at(-1);
    if (current === undefined) return carrier;
    return writeTraceContext(carrier, {
      traceId: current.traceId,
      spanId: current.spanId,
      traceFlags: current.traceFlags,
      traceState: current.traceState,
    });
  }

  /** 严格解析载体并返回规范化后的载体；非法值返回空对象。 */
  extract(carrier: TelemetryCarrier): TelemetryCarrier {
    if (!this.active) return {};
    const parsed = this.parseCarrier(carrier);
    if (parsed === undefined) {
      const tracestateInvalid = carrier.traceparent !== undefined
        && parseTraceparent(carrier.traceparent) !== undefined
        && carrier.tracestate !== undefined
        && parseTracestate(carrier.tracestate) === undefined;
      this.event('chatdsh.telemetry.invalid', {
        carrier: tracestateInvalid ? 'tracestate' : 'traceparent',
        reason: 'malformed',
      });
      return {};
    }
    const { traceparent: _traceparent, tracestate: _tracestate, ...rest } = carrier;
    return writeTraceContext(rest, parsed);
  }

  /** 在载体还原出的上下文里执行。 */
  withContext<T>(carrier: TelemetryCarrier, fn: () => T): T {
    if (!this.active) return fn();
    const parsed = this.parseCarrier(carrier);
    if (parsed === undefined) return fn();
    this.stack.push(parsed);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }

  /** 当前 span 的 trace id；没有活动 span 时返回 `undefined`。 */
  currentTraceId(): string | undefined {
    return this.stack.at(-1)?.traceId;
  }

  /** 有界刷新：把在途帧发完，超时后返回，不抛出。 */
  async flush(deadlineMs: number): Promise<void> {
    this.collectMetrics();
    const pending = this.frames.splice(0, this.frames.length);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    try {
      await Promise.race([Promise.all(pending.map((frame) => this.deliver(frame))), guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 停止上报：清空在途帧、停掉定时器。 */
  async shutdown(): Promise<void> {
    this.stopTimer();
    this.frames.length = 0;
    this.stack.length = 0;
    this.active = false;
  }

  /** 诊断导出：脱敏后的最近事件与丢弃汇总。 */
  diagnostics(limit: number = this.recent.capacity): TelemetryDiagnosticsExport {
    const events = this.recent.snapshot();
    const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : events.length;
    const bounded = events.slice(Math.max(0, events.length - cap));
    return {
      at: Date.now(),
      enabled: this.active,
      reason: this.offReason,
      count: bounded.length,
      events: bounded,
      dropped: this.droppedCounts(),
    };
  }

  private startTimer(): void {
    if (this.timer !== undefined) return;
    const interval = this.settings.flushIntervalMs ?? RELAY_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.flush(interval);
    }, interval);
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 新建一个 span；没有父上下文时新开一条 trace。 */
  private beginSpan(name: string, attributes: TelemetryAttributes): PendingSpan {
    const parent = this.stack.at(-1);
    const spanId = generateSpanId();
    if (parent !== undefined) {
      return {
        traceId: parent.traceId,
        spanId,
        parentSpanId: parent.spanId,
        name,
        startAt: Date.now(),
        attributes: toAttributes(attributes),
        status: 'ok',
        ended: false,
      };
    }
    return {
      traceId: generateTraceId(),
      spanId,
      name,
      startAt: Date.now(),
      attributes: toAttributes(attributes),
      status: 'ok',
      ended: false,
    };
  }

  /** 把一个 span 包成带属性过滤与结束记录的句柄。 */
  private spanHandle(span: PendingSpan, initial: TelemetryAttributes): TelemetrySpan {
    const attributes: Record<string, TelemetryAttributeValue> = { ...initial };
    const finish = (): void => this.finishSpan(span);
    const write = (key: string, value: TelemetryAttributeValue): void => {
      if (value === undefined) return;
      const outcome = this.redactor.attributes({ [key]: value });
      if (outcome.dropped > 0) this.recordDropped('traces', 'unregistered-attribute');
      const next = outcome.kept[key];
      if (next === undefined) return;
      attributes[key] = next;
      const existing = span.attributes.findIndex(([candidate]) => candidate === key);
      if (existing >= 0) span.attributes[existing] = [key, next as string | number | boolean];
      else span.attributes.push([key, next as string | number | boolean]);
    };
    return {
      setAttribute: write,
      setAttributes(all: TelemetryAttributes): void {
        for (const [key, value] of Object.entries(all)) write(key, value);
      },
      recordException(error: unknown): void {
        const value = error instanceof Error ? error : new Error(String(error));
        span.status = 'error';
        write('error.type', value.name);
      },
      end(): void {
        if (span.ended) return;
        span.ended = true;
        span.endAt = Date.now();
        finish();
      },
    };
  }

  /** 结束一个 span 并把它排进待发送队列。 */
  private finishSpan(span: PendingSpan): void {
    if (!this.active) return;
    const endAt = span.endAt ?? Date.now();
    const record: RelaySpanRecord = {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
      name: span.name,
      startAt: span.startAt,
      endAt,
      status: span.status,
      attributes: span.attributes,
    };
    this.recordRecent({
      at: endAt,
      signal: 'traces',
      kind: 'span',
      name: span.name,
      attributes: Object.fromEntries(span.attributes) as TelemetryAttributes,
    });
    this.pushFrame('traces', tracesPayload(this.resource, [record]));
  }

  private filterSpanAttributes(attributes: TelemetryAttributes): { kept: TelemetryAttributes } {
    const outcome = this.redactor.attributes(attributes);
    if (outcome.dropped > 0) this.recordDropped('traces', 'unregistered-attribute');
    return { kept: outcome.kept };
  }

  private parseCarrier(carrier: TelemetryCarrier): ActiveContext | undefined {
    if (carrier.traceparent === undefined) return undefined;
    const parsed = extractTraceContext(carrier);
    if (parsed === undefined) return undefined;
    return {
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      traceFlags: parsed.traceFlags,
      traceState: parsed.traceState,
    };
  }

  private recordRecent(event: TelemetryDiagnosticEvent): void {
    this.recent.push(event);
  }

  /** 记录一条日志并排进待发送队列。 */
  private postLog(record: RelayLogRecord): void {
    this.pushFrame('logs', logsPayload(this.resource, [record]));
  }

  /** 把一帧载荷排进队列；超出单批体积或队列上限时丢弃并计数。 */
  private pushFrame(signal: Frame['signal'], payload: unknown): void {
    if (!this.active) return;
    const body = JSON.stringify(payload);
    if (body.length > this.payloadLimit) {
      this.recordDropped(signal, 'payload-too-large');
      return;
    }
    if (this.frames.length >= this.queueLimit) {
      this.recordDropped(signal, 'queue-full');
      return;
    }
    this.frames.push({ signal, body });
  }

  private recordDropped(signal: 'logs' | 'traces' | 'metrics', reason: string): void {
    this.droppedBySignal[signal] += 1;
    this.droppedByReason[reason] = (this.droppedByReason[reason] ?? 0) + 1;
    this.accumulate({ name: 'chatdsh_telemetry_dropped_total', kind: 'sum' }, { signal, reason }, 1, 1);
  }

  /** 累计一个指标点。 */
  private accumulate(
    spec: { name: string; unit?: string; kind: RelayMetricKind },
    attributes: TelemetryAttributes,
    value: number,
    count: number,
  ): void {
    if (!this.active) return;
    let state = this.metrics.get(spec.name);
    if (state === undefined) {
      state = {
        name: spec.name,
        ...(spec.unit === undefined ? {} : { unit: spec.unit }),
        kind: spec.kind,
        points: new Map(),
      };
      this.metrics.set(spec.name, state);
    }
    const list = toAttributes(attributes);
    const key = JSON.stringify(list);
    const point = state.points.get(key) ?? { attributes: list, value: 0, count: 0, sum: 0 };
    if (state.kind === 'gauge') point.value = value;
    else if (state.kind === 'histogram') {
      point.count += count;
      point.sum += value;
      point.value = point.count;
    } else point.value += value;
    state.points.set(key, point);
  }

  /** 把累计的指标编成一帧待发送载荷。 */
  private collectMetrics(): void {
    if (!this.active || this.metrics.size === 0) return;
    const records: RelayMetricRecord[] = [];
    for (const state of this.metrics.values()) {
      const points: RelayMetricPoint[] = [];
      for (const point of state.points.values()) {
        if (state.kind === 'histogram') points.push({ attributes: point.attributes, count: point.count, sum: point.sum });
        else points.push({ attributes: point.attributes, value: point.value });
      }
      records.push({
        name: state.name,
        ...(state.unit === undefined ? {} : { unit: state.unit }),
        kind: state.kind,
        points,
        startAt: this.startedAt,
      });
    }
    this.pushFrame('metrics', metricsPayload(this.resource, records));
  }

  /** 投递一帧；失败只在遥测模块内计数。 */
  private async deliver(frame: Frame): Promise<void> {
    const implementation = this.settings.fetchImpl ?? globalThis.fetch;
    if (implementation === undefined) {
      this.failedExports += 1;
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [RELAY_CSRF_HEADER]: '1',
      [RELAY_SIGNAL_HEADER]: frame.signal,
    };
    try {
      const response = await implementation(this.url, { method: 'POST', headers, body: frame.body, keepalive: true });
      if (!response.ok) this.failedExports += 1;
    } catch {
      this.failedExports += 1;
    }
  }

  /** 状态快照：开关、关闭原因、队列深度、丢弃与导出失败。 */
  status(): Record<string, unknown> {
    const queueDepth: Record<'logs' | 'traces' | 'metrics', number> = { logs: 0, traces: 0, metrics: 0 };
    for (const frame of this.frames) queueDepth[frame.signal] += 1;
    return {
      enabled: this.active,
      reason: this.offReason,
      surface: this.resource.surface,
      serviceName: this.resource.serviceName,
      component: this.resource.component,
      instanceId: this.instanceId,
      endpoint: this.url,
      queueDepth,
      dropped: this.droppedCounts(),
      failedExports: this.failedExports,
    };
  }

  private droppedCounts(): DroppedCounts {
    const byReason: Record<string, number> = { ...this.droppedByReason };
    const total = Object.values(byReason).reduce((sum, value) => sum + value, 0);
    return { total, bySignal: { ...this.droppedBySignal }, byReason };
  }
}
