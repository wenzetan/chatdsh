/**
 * 中继 PWA 页面的浏览器侧遥测。
 *
 * 只使用 `docs/telemetry.md` 6.3 节登记的名称：`chatdsh.client.boot`、
 * `chatdsh.client.ui.action`、`chatdsh.client.error` 与 `chatdsh_client_errors_total`。
 * 载荷是 OTLP/HTTP JSON，经同源 `POST /chatdsh/telemetry/browser` 交给中继进程导出。
 * 属性只取动作名、结果、模块数量与错误类型码；草稿正文、会话标识与地址不进入遥测。
 * @module @chatdsh/gateway/pwa-telemetry
 */

/** 中继端点。 */
export const BROWSER_RELAY_PATH = '/chatdsh/telemetry/browser';

/** 信号分流请求头。 */
export const BROWSER_RELAY_SIGNAL_HEADER = 'x-chatdsh-signal';

/** 同源上报要求的请求头。 */
export const BROWSER_RELAY_CSRF_HEADER = 'x-chatdsh-csrf';

/** 遥测面。 */
export interface PwaPageTelemetry {
  boot(moduleCount: number, outcome: 'ok' | 'failed'): void;
  action(action: string, outcome: string): void;
  failure(action: string, error: unknown): void;
}

/** 遥测面构造选项。 */
export interface PwaPageTelemetryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly randomHex?: (bytes: number) => string;
  readonly component?: string;
}

/**
 * 建立页面遥测面。
 * @param options - 发送实现、时钟与随机源。
 * @returns 遥测面。
 */
export function createPwaPageTelemetry(options: PwaPageTelemetryOptions = {}): PwaPageTelemetry {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const component = options.component ?? '@chatdsh/gateway/pwa-page';
  const randomHex = options.randomHex ?? ((bytes: number): string => {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  });

  function attribute(key: string, value: string): { key: string; value: { stringValue: string } } {
    return { key, value: { stringValue: value } };
  }

  function resource(): { attributes: unknown[] } {
    return {
      attributes: [
        attribute('service.name', 'chatdsh-browser'),
        attribute('chatdsh.surface', 'browser'),
        attribute('chatdsh.component', component),
      ],
    };
  }

  function post(signal: 'logs' | 'traces' | 'metrics', payload: unknown): void {
    void fetchImpl(BROWSER_RELAY_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BROWSER_RELAY_SIGNAL_HEADER]: signal,
        [BROWSER_RELAY_CSRF_HEADER]: '1',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  }

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

  return {
    boot(moduleCount: number, outcome: 'ok' | 'failed'): void {
      const startedAt = now();
      post('traces', {
        resourceSpans: [{
          resource: resource(),
          scopeSpans: [{
            scope: { name: component },
            spans: [{
              traceId: randomHex(16),
              spanId: randomHex(8),
              name: 'chatdsh.client.boot',
              kind: 3,
              startTimeUnixNano: String(startedAt * 1_000_000),
              endTimeUnixNano: String(now() * 1_000_000),
              status: { code: outcome === 'ok' ? 1 : 2 },
              attributes: [
                attribute('module.count', String(moduleCount)),
                attribute('outcome', outcome),
              ],
            }],
          }],
        }],
      });
    },

    action(action: string, outcome: string): void {
      post('logs', {
        resourceLogs: [{
          resource: resource(),
          scopeLogs: [{
            scope: { name: component },
            logRecords: [{
              timeUnixNano: String(now() * 1_000_000),
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: 'chatdsh.client.ui.action' },
              attributes: [attribute('action', action), attribute('outcome', outcome)],
            }],
          }],
        }],
      });
    },

    failure(action: string, error: unknown): void {
      const failure = failureOf(error);
      const at = now();
      post('logs', {
        resourceLogs: [{
          resource: resource(),
          scopeLogs: [{
            scope: { name: component },
            logRecords: [{
              timeUnixNano: String(at * 1_000_000),
              severityNumber: 17,
              severityText: 'ERROR',
              body: { stringValue: 'chatdsh.client.error' },
              attributes: [
                attribute('action', action),
                attribute('error.type', failure.type),
                attribute('error.code', failure.code),
              ],
            }],
          }],
        }],
      });
      post('metrics', {
        resourceMetrics: [{
          resource: resource(),
          scopeMetrics: [{
            scope: { name: component },
            metrics: [{
              name: 'chatdsh_client_errors_total',
              sum: {
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [{
                  asInt: '1',
                  startTimeUnixNano: String(at * 1_000_000),
                  timeUnixNano: String(at * 1_000_000),
                  attributes: [attribute('error_type', failure.type)],
                }],
              },
            }],
          }],
        }],
      });
    },
  };
}
