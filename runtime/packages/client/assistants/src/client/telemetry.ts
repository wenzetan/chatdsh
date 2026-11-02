/**
 * 助手面板的浏览器侧遥测。
 *
 * 上报走运行时的同源中继 `POST /chatdsh/telemetry/browser`，按请求头 `x-chatdsh-signal`
 * 分流到 OTLP/HTTP JSON 的三类出口。只使用 `docs/telemetry.md` 第 6.5 节登记的
 * `chatdsh.client.remote.call`、`chatdsh.client.ui.action`、`chatdsh.client.error` 与
 * `chatdsh_client_errors_total`；属性只有方法名、动作名、结果、错误类型与错误码，
 * 不记录助手名称、说明、指令与工具原文。
 * @module @chatdsh/client-assistants/telemetry
 */

import type { ActionOutcome, AssistantUiAction, PanelTelemetry } from './types.ts';

/** 同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继校验的来源请求头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测里使用的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-assistants';

/** 同时在途的上报数量上限，超出后丢弃本次上报。 */
const PENDING_MAX = 64;

/** 遥测面的构造依赖。 */
export interface PanelTelemetryOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 生成随机十六进制标识的实现。 */
  readonly randomHex?: (bytes: number) => string;
}

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 编一对 OTLP 属性。 */
function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** 资源属性：浏览器侧的服务名、形态与产生信号的包。 */
function resource(): { attributes: OtlpAttribute[] } {
  return {
    attributes: [
      attribute('service.name', 'chatdsh-browser'),
      attribute('chatdsh.surface', 'browser'),
      attribute('chatdsh.component', SCOPE),
    ],
  };
}

/** 生成随机十六进制标识。 */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 从失败对象里取错误类型与错误码。
 * @param error - 失败对象。
 * @returns 两个属性值。
 */
function failureAttributesOf(error: unknown): { type: string; code: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly name?: unknown; readonly code?: unknown };
    const type = typeof record.name === 'string' && record.name !== '' ? record.name : 'Error';
    const code = typeof record.code === 'string' && record.code !== '' ? record.code : 'unknown';
    return { type, code };
  }
  return { type: 'Error', code: 'unknown' };
}

/**
 * 建立面板的遥测面。
 * @param options - 依赖覆盖，便于测试。
 * @returns 遥测面。
 */
export function createPanelTelemetry(options: PanelTelemetryOptions = {}): PanelTelemetry {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const randomHexOf = options.randomHex ?? randomHex;
  let pending = 0;

  /**
   * 把一份 OTLP 载荷交给中继。上报失败只丢弃这一条，不改变业务结果。
   * @param signal - 载荷类别。
   * @param payload - OTLP/HTTP JSON 载荷。
   */
  const post = (signal: 'logs' | 'traces' | 'metrics', payload: unknown): void => {
    if (pending >= PENDING_MAX) return;
    pending += 1;
    void fetchImpl(RELAY_PATH, {
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

  const failure = (error: unknown): void => {
    const { type, code } = failureAttributesOf(error);
    const at = now();
    post('logs', {
      resourceLogs: [{
        resource: resource(),
        scopeLogs: [{
          scope: { name: SCOPE },
          logRecords: [{
            timeUnixNano: String(at * 1_000_000),
            severityNumber: 17,
            severityText: 'ERROR',
            body: { stringValue: 'chatdsh.client.error' },
            attributes: [attribute('error.type', type), attribute('error.code', code)],
          }],
        }],
      }],
    });
    post('metrics', {
      resourceMetrics: [{
        resource: resource(),
        scopeMetrics: [{
          scope: { name: SCOPE },
          metrics: [{
            name: 'chatdsh_client_errors_total',
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: [{
                asInt: '1',
                startTimeUnixNano: String(at * 1_000_000),
                timeUnixNano: String(at * 1_000_000),
                attributes: [attribute('error_type', type)],
              }],
            },
          }],
        }],
      }],
    });
  };

  return {
    async run<T>(method: string, work: () => Promise<T>): Promise<T> {
      const startedAt = now();
      const traceId = randomHexOf(16);
      const spanId = randomHexOf(8);
      const emit = (outcome: string): void => {
        const endedAt = now();
        post('traces', {
          resourceSpans: [{
            resource: resource(),
            scopeSpans: [{
              scope: { name: SCOPE },
              spans: [{
                traceId,
                spanId,
                name: 'chatdsh.client.remote.call',
                kind: 3,
                startTimeUnixNano: String(startedAt * 1_000_000),
                endTimeUnixNano: String(endedAt * 1_000_000),
                status: { code: outcome === 'ok' ? 1 : 2 },
                attributes: [attribute('rpc.method', method), attribute('outcome', outcome)],
              }],
            }],
          }],
        });
      };
      try {
        const value = await work();
        emit('ok');
        return value;
      } catch (error) {
        emit('failed');
        failure(error);
        throw error;
      }
    },

    action(action: AssistantUiAction, outcome: ActionOutcome): void {
      post('logs', {
        resourceLogs: [{
          resource: resource(),
          scopeLogs: [{
            scope: { name: SCOPE },
            logRecords: [{
              timeUnixNano: String(now() * 1_000_000),
              severityNumber: outcome === 'ok' ? 9 : 13,
              severityText: outcome === 'ok' ? 'INFO' : 'WARN',
              body: { stringValue: 'chatdsh.client.ui.action' },
              attributes: [attribute('action', action), attribute('outcome', outcome)],
            }],
          }],
        }],
      });
    },

    failure,
  };
}
