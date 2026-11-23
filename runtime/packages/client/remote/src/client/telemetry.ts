/**
 * 远程设备界面的浏览器侧遥测。
 *
 * 上报走当前页面所在宿主提供的 `POST /chatdsh/telemetry/browser`，页面在
 * `/d/<deviceId>/` 下时带设备前缀转发到该宿主；载荷是 OTLP/HTTP JSON，
 * 端点按请求头 `x-chatdsh-signal` 分流。只使用 `docs/telemetry.md` 6.3 节登记的名称：
 * span `chatdsh.client.remote.call`、事件 `chatdsh.client.ui.action` 与
 * `chatdsh.client.error`、指标 `chatdsh_client_errors_total`。
 * 属性只取登记过的键：请求方法名、动作名、结果、错误类型与错误码。配对码、节点令牌、
 * 会话正文与中继地址都不进入遥测。
 * @module @chatdsh/client-remote/telemetry
 */

import { deviceHostPrefix } from './state.ts';

/** 同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继校验的来源请求头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测里使用的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-remote';

/** 同时在途的上报数量上限，超出后丢弃本次上报。 */
const PENDING_MAX = 64;

/** 界面动作的结果枚举。 */
export type RemoteActionOutcome = 'ok' | 'failed' | 'rejected' | 'unavailable' | 'waiting';

/** 一次调用携带的 W3C 链路上下文。 */
export interface TelemetryCarrier {
  readonly traceparent: string;
}

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 遥测面的构造依赖。 */
export interface RemoteTelemetryOptions {
  /** 发请求的实现；浏览器里是同源的 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 生成随机十六进制标识的实现。 */
  readonly randomHex?: (bytes: number) => string;
  /** 上报端点；缺省按当前页面是否在设备前缀下拼出地址。 */
  readonly relayPath?: () => string;
}

/** 远程设备界面使用的遥测面。 */
export interface RemoteTelemetry {
  /**
   * 在一个 span 里执行一次请求。
   * @param method - 固定请求名，例如 `devices.list`。
   * @param body - 请求主体；收到的载体要写进跨组件请求头。
   * @returns 请求结果。
   */
  call<T>(method: string, body: (carrier: TelemetryCarrier) => Promise<T>): Promise<T>;
  /**
   * 记录一次界面动作。
   * @param action - 动作名，取固定枚举。
   * @param outcome - 结果。
   */
  action(action: string, outcome: RemoteActionOutcome): void;
  /**
   * 记录一次失败：一条动作事件、一条错误事件与一次错误计数。
   * @param action - 失败所属的动作名。
   * @param error - 失败对象。
   */
  failure(action: string, error: unknown): void;
}

/** 编一对 OTLP 属性。 */
function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** 资源属性：浏览器侧服务名、形态与产生信号的包。 */
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
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 当前页面所在宿主的遥测上报端点。 */
function defaultRelayPath(): string {
  if (typeof location === 'undefined') return RELAY_PATH;
  return `${deviceHostPrefix(location.pathname)}${RELAY_PATH}`;
}

/**
 * 从失败对象里取错误类型与错误码。
 * @param error - 失败对象。
 * @returns 两个属性值。
 */
export function failureAttributesOf(error: unknown): { type: string; code: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly name?: unknown; readonly code?: unknown };
    const type = typeof record.name === 'string' && record.name !== '' ? record.name : 'Error';
    const code = typeof record.code === 'string' && record.code !== ''
      ? record.code
      : type === 'AbortError' ? 'timeout' : type === 'TypeError' ? 'network' : 'unknown';
    return { type, code };
  }
  return { type: 'Error', code: 'unknown' };
}

/**
 * 建立远程设备界面的遥测面。
 * @param options - 依赖覆盖。
 * @returns 遥测面。
 */
export function createRemoteTelemetry(options: RemoteTelemetryOptions = {}): RemoteTelemetry {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const randomHexOf = options.randomHex ?? randomHex;
  const relayPath = options.relayPath ?? defaultRelayPath;
  let pending = 0;

  /**
   * 把一份 OTLP 载荷交给中继。上报失败只丢弃这一条，不改变业务结果。
   * @param signal - 载荷类别。
   * @param payload - OTLP/HTTP JSON 载荷。
   */
  const post = (signal: 'logs' | 'traces' | 'metrics', payload: unknown): void => {
    if (pending >= PENDING_MAX) return;
    pending += 1;
    void fetchImpl(relayPath(), {
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

  /** 写一个 span 载荷。 */
  const span = (
    name: string,
    attributes: OtlpAttribute[],
    startedAt: number,
    outcome: 'ok' | 'failed',
    traceId: string,
    spanId: string,
  ): void => {
    post('traces', {
      resourceSpans: [{
        resource: resource(),
        scopeSpans: [{
          scope: { name: SCOPE },
          spans: [{
            traceId,
            spanId,
            name,
            kind: 3,
            startTimeUnixNano: String(startedAt * 1_000_000),
            endTimeUnixNano: String(now() * 1_000_000),
            status: { code: outcome === 'ok' ? 1 : 2 },
            attributes,
          }],
        }],
      }],
    });
  };

  /** 写一条事件。 */
  const event = (name: string, attributes: OtlpAttribute[], severityNumber: number, severityText: string): void => {
    post('logs', {
      resourceLogs: [{
        resource: resource(),
        scopeLogs: [{
          scope: { name: SCOPE },
          logRecords: [{
            timeUnixNano: String(now() * 1_000_000),
            severityNumber,
            severityText,
            body: { stringValue: name },
            attributes,
          }],
        }],
      }],
    });
  };

  /** 写一个单调计数。 */
  const count = (name: string, attributes: OtlpAttribute[]): void => {
    const at = now();
    post('metrics', {
      resourceMetrics: [{
        resource: resource(),
        scopeMetrics: [{
          scope: { name: SCOPE },
          metrics: [{
            name,
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: [{
                asInt: '1',
                startTimeUnixNano: String(at * 1_000_000),
                timeUnixNano: String(at * 1_000_000),
                attributes,
              }],
            },
          }],
        }],
      }],
    });
  };

  return {
    async call<T>(method: string, body: (carrier: TelemetryCarrier) => Promise<T>): Promise<T> {
      const startedAt = now();
      const traceId = randomHexOf(16);
      const spanId = randomHexOf(8);
      const carrier: TelemetryCarrier = { traceparent: `00-${traceId}-${spanId}-01` };
      try {
        const value = await body(carrier);
        span('chatdsh.client.remote.call', [attribute('rpc.method', method), attribute('outcome', 'ok')], startedAt, 'ok', traceId, spanId);
        return value;
      } catch (error) {
        span('chatdsh.client.remote.call', [attribute('rpc.method', method), attribute('outcome', 'failed')], startedAt, 'failed', traceId, spanId);
        const { type, code } = failureAttributesOf(error);
        event('chatdsh.client.error', [attribute('error.type', type), attribute('error.code', code)], 17, 'ERROR');
        count('chatdsh_client_errors_total', [attribute('error_type', type)]);
        throw error;
      }
    },

    action(action: string, outcome: RemoteActionOutcome): void {
      const ok = outcome === 'ok';
      event('chatdsh.client.ui.action', [attribute('action', action), attribute('outcome', outcome)], ok ? 9 : 13, ok ? 'INFO' : 'WARN');
    },

    failure(action: string, error: unknown): void {
      const { type, code } = failureAttributesOf(error);
      event('chatdsh.client.ui.action', [attribute('action', action), attribute('outcome', 'failed')], 13, 'WARN');
      event('chatdsh.client.error', [attribute('error.type', type), attribute('error.code', code)], 17, 'ERROR');
      count('chatdsh_client_errors_total', [attribute('error_type', type)]);
    },
  };
}
