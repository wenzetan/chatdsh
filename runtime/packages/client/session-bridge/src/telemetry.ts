/**
 * 导航桥的浏览器侧遥测。
 *
 * 上报走控制平面的同源中继 `POST /chatdsh/telemetry/browser`，载荷是 OTLP/HTTP JSON，端点按
 * 请求头 `x-chatdsh-signal` 分流到日志、链路与指标三个出口。遥测关闭时端点返回 404，这里
 * 只落空本次上报，导航结果不受影响。
 *
 * 三条信号：
 * - `chatdsh.client.navigate`：一次导航动作，覆盖全部尝试与最终结果；
 * - `chatdsh.client.navigate.rejected`：导航被拒绝、确认超时或来源被丢弃；
 * - `chatdsh_client_navigations_total`：导航结果计数。
 * 属性只放设备标识、会话标识、尝试次数、结果与原因分类，不记录消息原文与标题。
 * @module @chatdsh/client-session-bridge/telemetry
 */

import type { NavigationErrorType, NavigationRejectionCode } from './contract.ts';

/** 上报的同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继要求的来源校验头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测规范里的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-session-bridge';

/** 待发送载荷的上限；超出后丢弃最旧的，保证队列不随使用量增长。 */
const PENDING_MAX = 64;

/** 一次导航动作的最终结果。 */
export type NavigationActionOutcome = 'selected' | 'rejected' | 'timeout';

/** 一次失败事件的类别。`ignored` 表示消息被来源或 schema 校验丢弃。 */
export type NavigationFailureOutcome = 'rejected' | 'timeout' | 'ignored';

/** 一条 OTLP 属性的取值。 */
export interface OtlpAttributeValue {
  readonly stringValue?: string;
  readonly intValue?: string;
}

/** 一条 OTLP 属性。 */
export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpAttributeValue;
}

/** 一次导航动作的 span 记录。 */
export interface NavigationSpanRecord {
  /** 目标设备。 */
  readonly deviceId: string;
  /** 目标会话。 */
  readonly sessionId: string;
  /** 实际尝试次数。 */
  readonly attempt: number;
  /** 最终结果。 */
  readonly outcome: NavigationActionOutcome;
  /** 失败分类；成功时缺省。 */
  readonly errorType?: NavigationErrorType;
  /** 失败原因码；成功时缺省。 */
  readonly errorCode?: NavigationRejectionCode;
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 结束时刻的毫秒时间戳。 */
  readonly endedAt: number;
}

/** 一次失败事件的记录。 */
export interface NavigationFailureRecord {
  /** 目标设备；来源不明的消息带空串。 */
  readonly deviceId: string;
  /** 发生时所在的尝试次数。 */
  readonly attempt: number;
  /** 失败类别。 */
  readonly outcome: NavigationFailureOutcome;
  /** 失败分类。 */
  readonly errorType: NavigationErrorType;
  /** 失败原因码。 */
  readonly errorCode: NavigationRejectionCode;
}

/** 导航桥使用的遥测面。 */
export interface NavigationTelemetry {
  /**
   * 记一次导航动作的 span。
   * @param record - 设备、会话、尝试次数、结果与耗时。
   */
  navigateSpan(record: NavigationSpanRecord): void;
  /**
   * 记一次失败事件。
   * @param record - 设备、尝试次数、类别与原因。
   */
  navigationFailed(record: NavigationFailureRecord): void;
  /**
   * 记一次导航结果计数。
   * @param outcome - 最终结果。
   */
  navigationCounted(outcome: NavigationActionOutcome): void;
}

/** 遥测面的依赖。 */
export interface NavigationTelemetryOptions {
  /** 发请求的实现。 */
  readonly fetchImpl: typeof fetch;
  /** 生成随机十六进制标识的实现。 */
  readonly randomHex: (bytes: number) => string;
  /** 当前时刻的毫秒时间戳。 */
  readonly now: () => number;
  /** 上报端点；缺省用 {@link RELAY_PATH}。 */
  readonly relayPath?: string;
}

/**
 * 把一对键值编成字符串属性。
 * @param key - 属性键。
 * @param value - 属性值。
 * @returns OTLP 属性。
 */
function textAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/**
 * 把一对键值编成整数属性。
 * @param key - 属性键。
 * @param value - 属性值。
 * @returns OTLP 属性。
 */
function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

/** 资源属性：服务名、形态与产生信号的包。 */
function resource(): { readonly attributes: readonly OtlpAttribute[] } {
  return {
    attributes: [
      textAttribute('service.name', 'chatdsh-browser'),
      textAttribute('chatdsh.surface', 'browser'),
      textAttribute('chatdsh.component', SCOPE),
    ],
  };
}

/**
 * 建立遥测面。
 * @param options - 依赖。
 * @returns 遥测面。
 */
export function createNavigationTelemetry(options: NavigationTelemetryOptions): NavigationTelemetry {
  const { fetchImpl, randomHex: randomHexOf, now } = options;
  const relayPath = options.relayPath ?? RELAY_PATH;
  let pending = 0;

  /**
   * 把一份载荷交给中继。失败只落空本次上报，不改变导航结果。
   * @param signal - 载荷类型。
   * @param payload - OTLP/HTTP JSON 载荷。
   */
  const post = (signal: 'logs' | 'traces' | 'metrics', payload: unknown): void => {
    if (pending >= PENDING_MAX) return;
    pending += 1;
    void fetchImpl(relayPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-signal': signal, [CSRF_HEADER]: '1' },
      body: JSON.stringify(payload),
      keepalive: true,
    })
      .catch(() => undefined)
      .finally(() => {
        pending -= 1;
      });
  };

  return {
    navigateSpan(record: NavigationSpanRecord): void {
      const attributes: OtlpAttribute[] = [
        textAttribute('deviceId', record.deviceId),
        textAttribute('session.id', record.sessionId),
        intAttribute('attempt', record.attempt),
        textAttribute('outcome', record.outcome),
      ];
      if (record.errorType !== undefined) attributes.push(textAttribute('error.type', record.errorType));
      if (record.errorCode !== undefined) attributes.push(textAttribute('error.code', record.errorCode));
      post('traces', {
        resourceSpans: [
          {
            resource: resource(),
            scopeSpans: [
              {
                scope: { name: SCOPE },
                spans: [
                  {
                    traceId: randomHexOf(16),
                    spanId: randomHexOf(8),
                    name: 'chatdsh.client.navigate',
                    kind: 3,
                    startTimeUnixNano: String(record.startedAt * 1_000_000),
                    endTimeUnixNano: String(record.endedAt * 1_000_000),
                    status: { code: record.outcome === 'selected' ? 1 : 2 },
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      });
    },

    navigationFailed(record: NavigationFailureRecord): void {
      post('logs', {
        resourceLogs: [
          {
            resource: resource(),
            scopeLogs: [
              {
                scope: { name: SCOPE },
                logRecords: [
                  {
                    timeUnixNano: String(now() * 1_000_000),
                    severityNumber: 13,
                    severityText: 'WARN',
                    body: { stringValue: 'chatdsh.client.navigate.rejected' },
                    attributes: [
                      textAttribute('deviceId', record.deviceId),
                      intAttribute('attempt', record.attempt),
                      textAttribute('outcome', record.outcome),
                      textAttribute('error.type', record.errorType),
                      textAttribute('error.code', record.errorCode),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    },

    navigationCounted(outcome: NavigationActionOutcome): void {
      post('metrics', {
        resourceMetrics: [
          {
            resource: resource(),
            scopeMetrics: [
              {
                scope: { name: SCOPE },
                metrics: [
                  {
                    name: 'chatdsh_client_navigations_total',
                    sum: {
                      aggregationTemporality: 1,
                      isMonotonic: true,
                      dataPoints: [
                        {
                          asDouble: 1,
                          timeUnixNano: String(now() * 1_000_000),
                          attributes: [textAttribute('outcome', outcome)],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  };
}

/**
 * 生成随机十六进制标识。
 * @param bytes - 字节数。
 * @returns 十六进制写法。
 */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
