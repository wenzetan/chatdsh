/**
 * 移动端遥测中转。
 *
 * 移动端不持有 OpenObserve 凭据，经控制平面端点上报。本模块负责三件事：按记录形状与
 * 属性白名单校验批量载荷、拦截禁止进入遥测的原文与敏感值、把保留下来的记录投递给
 * 控制平面自己的遥测客户端，由同一个 exporter 出网。
 *
 * 批量与体积上限与浏览器中继同构：单批 64 条、单批 256 KB、单条 16 KB。设备维度
 * 每分钟最多 60 批，超出按限流拒绝。投递队列有固定容量，队列满时拒绝新批次并计数，
 * 不阻塞入站请求。
 * @module @chatdsh/gateway/mobile-telemetry
 */

import type { ChatdshTelemetry, TelemetryAttributes, TelemetryAttributeValue } from '@chatdsh/core-contracts';

/** 单批最多记录条数。 */
export const MOBILE_TELEMETRY_BATCH_LIMIT = 64;

/** 单批最大字节数。 */
export const MOBILE_TELEMETRY_PAYLOAD_LIMIT = 256 * 1024;

/** 单条记录最大字节数。 */
export const MOBILE_TELEMETRY_RECORD_LIMIT = 16 * 1024;

/** 单条属性字符串的最大长度。 */
export const MOBILE_TELEMETRY_VALUE_LIMIT = 200;

/** 投递队列容量。 */
export const MOBILE_TELEMETRY_QUEUE_LIMIT = 2048;

/** 限流窗口。 */
export const MOBILE_TELEMETRY_RATE_WINDOW_MS = 60_000;

/** 一个限流窗口内允许的批次数。 */
export const MOBILE_TELEMETRY_RATE_BATCHES = 60;

/** 记录类别。 */
export type MobileTelemetrySignal = 'event' | 'span' | 'metric';

/** 指标记录的聚合方式。 */
export type MobileTelemetryMetricKind = 'histogram' | 'gauge';

/** 移动端已登记的信号名，按记录类别分组；未登记的记录直接拒绝。 */
export const MOBILE_SIGNAL_NAMES = {
  event: ['chatdsh.mobile.queue.replay', 'chatdsh.mobile.keystore'],
  span: ['chatdsh.mobile.startup', 'chatdsh.mobile.connect', 'chatdsh.mobile.push.deliver'],
  metric: ['chatdsh_mobile_connect_seconds', 'chatdsh_mobile_offline_queue_depth'],
} as const;

/** 已登记指标的聚合方式。 */
const MOBILE_METRIC_KINDS: Readonly<Record<string, MobileTelemetryMetricKind>> = {
  chatdsh_mobile_connect_seconds: 'histogram',
  chatdsh_mobile_offline_queue_depth: 'gauge',
};

/** 属性键白名单：取 docs/telemetry.md 第五节与 6.7 节登记过的键。 */
export const MOBILE_ATTRIBUTE_KEYS: readonly string[] = [
  'chatdsh.surface',
  'chatdsh.component',
  'chatdsh.instance.id',
  'chatdsh.version',
  'deployment.environment',
  'session.id',
  'workspace.id',
  'account.id',
  'turn',
  'step',
  'tool.name',
  'mcp.method',
  'provider',
  'model',
  'request.id',
  'error.type',
  'error.code',
  'outcome',
  'device.kind',
  'attempt',
  'kind',
  'count',
  'action',
];

const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(MOBILE_ATTRIBUTE_KEYS);

/** 已登记信号名的集合，按记录类别分开。 */
const REGISTERED_NAMES: Readonly<Record<MobileTelemetrySignal, ReadonlySet<string>>> = {
  event: new Set(MOBILE_SIGNAL_NAMES.event),
  span: new Set(MOBILE_SIGNAL_NAMES.span),
  metric: new Set(MOBILE_SIGNAL_NAMES.metric),
};

/** 明确禁止的属性键：提示词、消息正文、工具参数与结果、文件内容、凭据与请求体。 */
const FORBIDDEN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'system.prompt',
  'message',
  'message.body',
  'model.output',
  'output',
  'arguments',
  'tool.arguments',
  'tool.result',
  'tool.output',
  'result',
  'file',
  'file.content',
  'file.path',
  'content',
  'body',
  'request.body',
  'response.body',
  'payload',
  'credential',
  'credentials',
  'secret',
  'token',
  'device.token',
  'cookie',
  'authorization',
  'password',
  'email',
  'phone',
  'real.name',
  'name',
  'host',
  'hostname',
  'server.address',
  'internal.address',
  'ip',
  'url',
  'origin',
  'path',
]);

/** 禁止键的形状：前缀命中同样拒绝，避免用 `prompt.text` 之类的别名绕开。 */
const FORBIDDEN_KEY_PATTERN = /^(?:prompt|message|tool\.(?:arguments|result|output)|file\.(?:content|path)|credential|request\.body|response\.body|email|phone|real\.name|host|hostname|server\.address|internal\.address)/i;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_PATTERN = /(?:\+?\d[\d\s-]{8,}\d)/;
const CREDENTIAL_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;
const PRIVATE_ADDRESS_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/;
const INTERNAL_HOST_PATTERN = /\b[a-z0-9-]+\.(?:local|internal|lan)\b/i;

function failure(status: number, errorType: string, errorCode: string): MobileTelemetryFailure {
  return { ok: false, status, errorType, errorCode };
}

/** 判断一个字符串是否带有禁止进入遥测的内容。 */
function forbiddenValue(value: string): string | undefined {
  if (EMAIL_PATTERN.test(value)) return 'email';
  if (PHONE_PATTERN.test(value)) return 'phone';
  if (CREDENTIAL_PATTERN.test(value)) return 'credential';
  if (PRIVATE_ADDRESS_PATTERN.test(value)) return 'internal-address';
  if (INTERNAL_HOST_PATTERN.test(value)) return 'hostname';
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAttributes(value: unknown): { ok: true; attributes: TelemetryAttributes; dropped: number } | MobileTelemetryFailure {
  if (value === undefined) return { ok: true, attributes: {}, dropped: 0 };
  if (!isPlainObject(value)) return failure(400, 'payload', 'invalid-attributes');
  const attributes: Record<string, TelemetryAttributeValue> = {};
  let dropped = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (FORBIDDEN_ATTRIBUTE_KEYS.has(key) || FORBIDDEN_KEY_PATTERN.test(key)) {
      return failure(422, 'content', 'forbidden-attribute');
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      return failure(422, 'content', 'forbidden-value');
    }
    if (typeof raw === 'string') {
      if (raw.length > MOBILE_TELEMETRY_VALUE_LIMIT) return failure(422, 'content', 'value-too-long');
      const hit = forbiddenValue(raw);
      if (hit !== undefined) return failure(422, 'content', hit);
    }
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) {
      dropped += 1;
      continue;
    }
    attributes[key] = raw;
  }
  return { ok: true, attributes, dropped };
}

/** 校验一条记录。 */
export function normalizeMobileTelemetryRecord(value: unknown): { ok: true; record: MobileTelemetryRecord; dropped: number } | MobileTelemetryFailure {
  if (!isPlainObject(value)) return failure(400, 'payload', 'invalid-record');
  if (Buffer.byteLength(JSON.stringify(value)) > MOBILE_TELEMETRY_RECORD_LIMIT) return failure(413, 'batch', 'record-too-large');
  const signal = value.signal;
  if (signal !== 'event' && signal !== 'span' && signal !== 'metric') return failure(400, 'payload', 'invalid-signal');
  const name = value.name;
  if (typeof name !== 'string' || !REGISTERED_NAMES[signal].has(name)) {
    return failure(400, 'payload', 'invalid-name');
  }
  if (value.time !== undefined && (typeof value.time !== 'number' || !Number.isFinite(value.time))) {
    return failure(400, 'payload', 'invalid-time');
  }
  if (value.durationMs !== undefined && (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0)) {
    return failure(400, 'payload', 'invalid-duration');
  }
  if (signal === 'metric' && (typeof value.value !== 'number' || !Number.isFinite(value.value))) {
    return failure(400, 'payload', 'invalid-metric-value');
  }
  if (value.value !== undefined && (typeof value.value !== 'number' || !Number.isFinite(value.value))) {
    return failure(400, 'payload', 'invalid-value');
  }
  const normalized = normalizeAttributes(value.attributes);
  if (normalized.ok === false) return normalized;
  return {
    ok: true,
    dropped: normalized.dropped,
    record: {
      signal,
      name,
      time: typeof value.time === 'number' ? value.time : undefined,
      value: typeof value.value === 'number' ? value.value : undefined,
      durationMs: typeof value.durationMs === 'number' ? value.durationMs : undefined,
      attributes: normalized.attributes,
    },
  };
}

/** 记录条目的形状与接收结果。 */
export interface MobileTelemetryRecord {
  readonly signal: MobileTelemetrySignal;
  readonly name: string;
  readonly time?: number;
  readonly value?: number;
  readonly durationMs?: number;
  readonly attributes: TelemetryAttributes;
}

/** 失败结果。 */
export interface MobileTelemetryFailure {
  readonly ok: false;
  readonly status: number;
  readonly errorType: string;
  readonly errorCode: string;
}

/** 接收结果。 */
export interface MobileTelemetryAccepted {
  readonly ok: true;
  readonly accepted: Record<MobileTelemetrySignal, number>;
  readonly dropped: Record<MobileTelemetrySignal, number>;
}

/** 一批记录的校验与接收结果。 */
export type MobileTelemetryResult = MobileTelemetryAccepted | MobileTelemetryFailure;

/**
 * 有界投递队列。
 *
 * 入站请求只做校验与入队，投递在微任务里完成，控制平面事件循环不被单批记录拖住。
 */
export class MobileTelemetryRelay {
  private readonly pending: { readonly deviceId: string; readonly record: MobileTelemetryRecord }[] = [];
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private scheduled = false;

  constructor(private readonly telemetry: ChatdshTelemetry) {}

  /** 当前排队等待投递的记录数。 */
  get queueDepth(): number {
    return this.pending.length;
  }

  /** 校验一批记录并入队。 */
  ingest(deviceId: string, rawRecords: readonly unknown[]): MobileTelemetryResult {
    if (!this.allow(deviceId)) return failure(429, 'rate-limit', 'too-many-batches');
    const accepted: Record<MobileTelemetrySignal, number> = { event: 0, span: 0, metric: 0 };
    const dropped: Record<MobileTelemetrySignal, number> = { event: 0, span: 0, metric: 0 };
    const normalized: MobileTelemetryRecord[] = [];
    for (const raw of rawRecords) {
      const result = normalizeMobileTelemetryRecord(raw);
      if (result.ok === false) return result;
      accepted[result.record.signal] += 1;
      dropped[result.record.signal] += result.dropped;
      normalized.push(result.record);
    }
    if (this.pending.length + normalized.length > MOBILE_TELEMETRY_QUEUE_LIMIT) {
      return failure(503, 'queue', 'queue-full');
    }
    const droppedTotal = dropped.event + dropped.span + dropped.metric;
    if (droppedTotal > 0) {
      const droppedCounter = this.telemetry.counter('chatdsh_telemetry_dropped_total', { description: '未登记属性键的丢弃数' });
      if (dropped.event > 0) droppedCounter.add(dropped.event, { signal: 'logs', reason: 'unregistered-attribute' });
      if (dropped.span > 0) droppedCounter.add(dropped.span, { signal: 'traces', reason: 'unregistered-attribute' });
      if (dropped.metric > 0) droppedCounter.add(dropped.metric, { signal: 'metrics', reason: 'unregistered-attribute' });
    }
    for (const record of normalized) this.pending.push({ deviceId, record });
    this.schedule();
    return { ok: true, accepted, dropped };
  }

  private allow(deviceId: string): boolean {
    const now = Date.now();
    const current = this.windows.get(deviceId);
    if (current === undefined || now - current.startedAt >= MOBILE_TELEMETRY_RATE_WINDOW_MS) {
      this.windows.set(deviceId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= MOBILE_TELEMETRY_RATE_BATCHES) return false;
    current.count += 1;
    return true;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const batch = this.pending.splice(0, this.pending.length);
      for (const item of batch) this.forward(item.record);
    });
  }

  private forward(record: MobileTelemetryRecord): void {
    // 形态与设备类别由控制平面补写，移动端传上来的同键取值被覆盖。
    const attributes: TelemetryAttributes = {
      ...record.attributes,
      'chatdsh.surface': 'mobile',
      'device.kind': 'mobile',
    };
    if (record.signal === 'event') {
      this.telemetry.event(record.name, attributes);
      return;
    }
    if (record.signal === 'span') {
      const span = this.telemetry.startSpan(record.name, attributes);
      if (record.durationMs !== undefined) span.setAttribute('duration', record.durationMs);
      span.end();
      return;
    }
    const value = record.value ?? 0;
    const kind = MOBILE_METRIC_KINDS[record.name] ?? 'gauge';
    if (kind === 'histogram') {
      this.telemetry.histogram(record.name, { unit: record.name.endsWith('_bytes') ? 'By' : 's', description: '移动端上报的分布' })
        .record(value, attributes);
      return;
    }
    this.telemetry.gauge(record.name, { description: '移动端上报的当前量' }).record(value, attributes);
  }
}
