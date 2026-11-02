/**
 * 同源中继载荷的 OTLP/HTTP JSON 编码。
 *
 * 浏览器与桌面主进程不持有 OpenObserve 凭据，也不加载导出 SDK：记录在本模块编成与
 * OTLP/HTTP JSON 一致的形状，交给同源中继原样转发。编码只处理已登记并脱敏过的元数据。
 * @module @chatdsh/core-diagnostics/relay-payload
 */

/** 载荷里的资源信息。 */
export interface RelayResource {
  /** `service.name`。 */
  readonly serviceName: string;
  /** 形态。 */
  readonly surface: string;
  /** 产生记录的包名。 */
  readonly component: string;
  /** 进程实例标识。 */
  readonly instanceId?: string;
  /** 产品版本。 */
  readonly version?: string;
  /** 部署环境。 */
  readonly environment?: string;
}

/** 一个属性值。 */
export type RelayAttributeValue = string | number | boolean;

/** 一条属性。 */
export type RelayAttribute = readonly [string, RelayAttributeValue];

/** 一条日志记录。 */
export interface RelayLogRecord {
  /** 记录时刻的毫秒时间戳。 */
  readonly at: number;
  /** OTel 严重级别数值。 */
  readonly severityNumber: number;
  /** OTel 严重级别文本。 */
  readonly severityText: string;
  /** 记录正文，通常是事件名或脱敏后的诊断消息。 */
  readonly body: string;
  /** 属性。 */
  readonly attributes: readonly RelayAttribute[];
  /** 所属 trace。 */
  readonly traceId?: string;
  /** 所属 span。 */
  readonly spanId?: string;
}

/** 一条 span 记录。 */
export interface RelaySpanRecord {
  /** trace-id。 */
  readonly traceId: string;
  /** span-id。 */
  readonly spanId: string;
  /** 父 span-id。 */
  readonly parentSpanId?: string;
  /** span 名。 */
  readonly name: string;
  /** 开始时刻的毫秒时间戳。 */
  readonly startAt: number;
  /** 结束时刻的毫秒时间戳。 */
  readonly endAt: number;
  /** 结果。 */
  readonly status: 'ok' | 'error';
  /** 属性。 */
  readonly attributes: readonly RelayAttribute[];
}

/** 指标的类型。 */
export type RelayMetricKind = 'sum' | 'histogram' | 'gauge';

/** 一个指标点。 */
export interface RelayMetricPoint {
  /** 属性。 */
  readonly attributes: readonly RelayAttribute[];
  /** 计数型或当前量的取值。 */
  readonly value?: number;
  /** 分布的观测条数。 */
  readonly count?: number;
  /** 分布的观测值之和。 */
  readonly sum?: number;
}

/** 一个指标。 */
export interface RelayMetricRecord {
  /** 指标名。 */
  readonly name: string;
  /** 单位。 */
  readonly unit?: string;
  /** 类型。 */
  readonly kind: RelayMetricKind;
  /** 指标点。 */
  readonly points: readonly RelayMetricPoint[];
  /** 起始时刻的毫秒时间戳。 */
  readonly startAt: number;
}

/** 编码一个属性值。 */
function encodeValue(value: RelayAttributeValue): Record<string, unknown> {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: value };
}

/** 编码属性列表。 */
function encodeAttributes(attributes: readonly RelayAttribute[]): Record<string, unknown>[] {
  return attributes.map(([key, value]) => ({ key, value: encodeValue(value) }));
}

/** 编码资源。 */
function encodeResource(resource: RelayResource): Record<string, unknown> {
  const attributes: RelayAttribute[] = [
    ['service.name', resource.serviceName],
    ['chatdsh.surface', resource.surface],
    ['chatdsh.component', resource.component],
  ];
  if (resource.instanceId !== undefined) attributes.push(['chatdsh.instance.id', resource.instanceId]);
  if (resource.version !== undefined) attributes.push(['chatdsh.version', resource.version]);
  if (resource.environment !== undefined) attributes.push(['deployment.environment', resource.environment]);
  return { attributes: encodeAttributes(attributes) };
}

/** 毫秒时间戳转 OTLP 的纳秒字符串。 */
export function toUnixNano(at: number): string {
  return String(Math.trunc(at * 1_000_000));
}

/**
 * 编码日志载荷。
 * @param resource - 资源。
 * @param records - 日志记录。
 * @returns OTLP/HTTP JSON 载荷。
 */
export function logsPayload(resource: RelayResource, records: readonly RelayLogRecord[]): unknown {
  return {
    resourceLogs: [{
      resource: encodeResource(resource),
      scopeLogs: [{
        scope: { name: resource.component },
        logRecords: records.map((record) => ({
          timeUnixNano: toUnixNano(record.at),
          severityNumber: record.severityNumber,
          severityText: record.severityText,
          body: { stringValue: record.body },
          attributes: encodeAttributes(record.attributes),
          ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
          ...(record.spanId === undefined ? {} : { spanId: record.spanId }),
        })),
      }],
    }],
  };
}

/**
 * 编码追踪载荷。
 * @param resource - 资源。
 * @param spans - span 记录。
 * @returns OTLP/HTTP JSON 载荷。
 */
export function tracesPayload(resource: RelayResource, spans: readonly RelaySpanRecord[]): unknown {
  return {
    resourceSpans: [{
      resource: encodeResource(resource),
      scopeSpans: [{
        scope: { name: resource.component },
        spans: spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
          name: span.name,
          kind: 1,
          startTimeUnixNano: toUnixNano(span.startAt),
          endTimeUnixNano: toUnixNano(span.endAt),
          status: { code: span.status === 'ok' ? 1 : 2 },
          attributes: encodeAttributes(span.attributes),
        })),
      }],
    }],
  };
}

/** 编码一个指标点的时间字段。 */
function encodeTime(metric: RelayMetricRecord, point: RelayMetricPoint): Record<string, unknown> {
  return {
    attributes: encodeAttributes(point.attributes),
    startTimeUnixNano: toUnixNano(metric.startAt),
    timeUnixNano: toUnixNano(Date.now()),
  };
}

/**
 * 编码指标载荷。
 * @param resource - 资源。
 * @param metrics - 指标记录。
 * @returns OTLP/HTTP JSON 载荷。
 */
export function metricsPayload(resource: RelayResource, metrics: readonly RelayMetricRecord[]): unknown {
  return {
    resourceMetrics: [{
      resource: encodeResource(resource),
      scopeMetrics: [{
        scope: { name: resource.component },
        metrics: metrics.map((metric) => {
          if (metric.kind === 'gauge') {
            return {
              name: metric.name,
              ...(metric.unit === undefined ? {} : { unit: metric.unit }),
              gauge: { dataPoints: metric.points.map((item) => ({ ...encodeTime(metric, item), asDouble: item.value ?? 0 })) },
            };
          }
          if (metric.kind === 'histogram') {
            return {
              name: metric.name,
              ...(metric.unit === undefined ? {} : { unit: metric.unit }),
              histogram: {
                aggregationTemporality: 2,
                dataPoints: metric.points.map((item) => ({
                  ...encodeTime(metric, item),
                  count: String(item.count ?? 0),
                  sum: item.sum ?? 0,
                  bucketCounts: [String(item.count ?? 0)],
                  explicitBounds: [],
                })),
              },
            };
          }
          return {
            name: metric.name,
            ...(metric.unit === undefined ? {} : { unit: metric.unit }),
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: metric.points.map((item) => ({ ...encodeTime(metric, item), asDouble: item.value ?? 0 })),
            },
          };
        }),
      }],
    }],
  };
}
