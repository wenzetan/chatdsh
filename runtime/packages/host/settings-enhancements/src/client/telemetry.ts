/**
 * 设置增强包的浏览器侧遥测。
 *
 * 上报走同源中继 `POST /chatdsh/telemetry/browser`，按请求头 `x-chatdsh-signal` 分流到
 * OTLP/HTTP JSON 的三类出口。只使用已经登记的 `chatdsh.client.remote.call`、
 * `chatdsh.client.ui.action`、`chatdsh.client.error` 与 `chatdsh_client_errors_total`；
 * 属性只有方法名、动作名、结果、错误类型与错误码，不记录设置取值与路径。
 * @module @chatdsh/host-settings-enhancements/telemetry
 */

/** 同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继校验的来源请求头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测里使用的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-settings-enhancements';

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 编一对属性。 */
function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** 资源属性：浏览器形态、服务名与包名。 */
function resource(): { attributes: OtlpAttribute[] } {
  return {
    attributes: [
      attribute('service.name', 'chatdsh-browser'),
      attribute('chatdsh.surface', 'browser'),
      attribute('chatdsh.component', SCOPE),
    ],
  };
}

/** 浏览器侧遥测面。 */
export interface PanelTelemetry {
  /**
   * 记录一次数据调用：成功与失败各发一个 span，失败另发一条错误事件。
   * @param method - 端点名。
   * @param work - 调用本体。
   * @returns 调用结果。
   */
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 结果。
   */
  action(action: string, outcome: 'ok' | 'failed'): void;
}

/** 遥测面的构造依赖。 */
export interface PanelTelemetryOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
}

/** 从失败对象取错误类型与错误码。 */
function failureOf(error: unknown): { type: string; code: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly name?: unknown; readonly code?: unknown };
    return {
      type: typeof record.name === 'string' && record.name !== '' ? record.name : 'Error',
      code: typeof record.code === 'string' && record.code !== '' ? record.code : 'unknown',
    };
  }
  return { type: 'Error', code: 'unknown' };
}

/**
 * 建立遥测面。
 * @param options - 依赖覆盖。
 * @returns 遥测面。
 */
export function createPanelTelemetry(options: PanelTelemetryOptions = {}): PanelTelemetry {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const post = (signal: 'logs' | 'traces' | 'metrics', payload: unknown): void => {
    void fetchImpl(RELAY_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-chatdsh-signal': signal, [CSRF_HEADER]: '1' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  };
  const at = (): string => String(Date.now() * 1_000_000);
  return {
    async run<T>(method: string, work: () => Promise<T>): Promise<T> {
      const startedAt = at();
      try {
        const value = await work();
        post('traces', spanPayload('chatdsh.client.remote.call', method, 'ok', startedAt));
        return value;
      } catch (error) {
        post('traces', spanPayload('chatdsh.client.remote.call', method, 'failed', startedAt));
        const { type, code } = failureOf(error);
        post('logs', {
          resourceLogs: [{
            resource: resource(),
            scopeLogs: [{
              scope: { name: SCOPE },
              logRecords: [{
                timeUnixNano: at(),
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
                  dataPoints: [{ asInt: '1', startTimeUnixNano: at(), timeUnixNano: at(), attributes: [attribute('error_type', type)] }],
                },
              }],
            }],
          }],
        });
        throw error;
      }
    },

    action(action: string, outcome: 'ok' | 'failed'): void {
      post('logs', {
        resourceLogs: [{
          resource: resource(),
          scopeLogs: [{
            scope: { name: SCOPE },
            logRecords: [{
              timeUnixNano: at(),
              severityNumber: outcome === 'ok' ? 9 : 13,
              severityText: outcome === 'ok' ? 'INFO' : 'WARN',
              body: { stringValue: 'chatdsh.client.ui.action' },
              attributes: [attribute('action', action), attribute('outcome', outcome)],
            }],
          }],
        }],
      });
    },
  };
}

/** 一个调用 span 的载荷。 */
function spanPayload(name: string, method: string, outcome: string, startedAt: string): unknown {
  return {
    resourceSpans: [{
      resource: resource(),
      scopeSpans: [{
        scope: { name: SCOPE },
        spans: [{
          traceId: randomHex(16),
          spanId: randomHex(8),
          name,
          kind: 3,
          startTimeUnixNano: startedAt,
          endTimeUnixNano: String(Date.now() * 1_000_000),
          status: { code: outcome === 'ok' ? 1 : 2 },
          attributes: [attribute('rpc.method', method), attribute('outcome', outcome)],
        }],
      }],
    }],
  };
}

/** 生成随机十六进制标识。 */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
