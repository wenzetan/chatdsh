/**
 * PWA 界面的浏览器侧遥测。
 *
 * 上报走宿主提供的同源中继 `POST /chatdsh/telemetry/browser`，载荷是 OTLP/HTTP JSON，端点按
 * 请求头 `x-chatdsh-signal` 分流。只使用 `docs/telemetry.md` 6.5 节登记的名称：
 * - span `chatdsh.client.boot`：从界面挂载到可交互；
 * - span `chatdsh.client.module.load`：单个模块装填；
 * - 事件 `chatdsh.client.ui.action`：安装、更新、权限、草稿、布局等关键界面动作；
 * - 事件 `chatdsh.client.error` 与指标 `chatdsh_client_errors_total`：失败与失败计数。
 * 属性只取登记过的键：动作名、结果、模块标识、模块数量与错误类型码。草稿正文、配对码、
 * 设备令牌、地址与查询串都不进入遥测。
 * @module @chatdsh/client-pwa/telemetry
 */

/** 同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继校验的来源请求头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测里使用的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-pwa';

/** 同时在途的上报数量上限，超出后丢弃本次上报。 */
const PENDING_MAX = 64;

/** 界面动作的结果枚举。 */
export type ActionOutcome = 'ok' | 'failed' | 'rejected' | 'unavailable' | 'prompt' | 'waiting';

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 遥测面的构造依赖。 */
export interface PwaTelemetryOptions {
  /** 发请求的实现；浏览器里是同源的 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 生成随机十六进制标识的实现。 */
  readonly randomHex?: (bytes: number) => string;
}

/** PWA 使用的遥测面。 */
export interface PwaTelemetry {
  /**
   * 记录一次界面挂载完成。
   * @param moduleCount - 本次挂载启用的模块数量。
   * @param outcome - 结果。
   */
  boot(moduleCount: number, outcome: 'ok' | 'failed'): void;
  /**
   * 记录一次模块装填。
   * @param moduleId - 模块标识，取固定枚举。
   * @param outcome - 结果。
   */
  moduleLoad(moduleId: string, outcome: 'ok' | 'failed'): void;
  /**
   * 记录一次界面动作。
   * @param action - 动作名，取固定枚举。
   * @param outcome - 结果。
   */
  action(action: string, outcome: ActionOutcome): void;
  /**
   * 记录一次失败。
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

/**
 * 从失败对象里取错误类型与错误码。
 * @param error - 失败对象。
 * @returns 两个属性值。
 */
export function failureAttributesOf(error: unknown): { type: string; code: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly name?: unknown; readonly code?: unknown };
    const type = typeof record.name === 'string' && record.name !== '' ? record.name : 'Error';
    const code = typeof record.code === 'string' && record.code !== '' ? record.code : 'unknown';
    return { type, code };
  }
  return { type: 'Error', code: 'unknown' };
}

/**
 * 建立 PWA 的遥测面。
 * @param options - 依赖覆盖。
 * @returns 遥测面。
 */
export function createPwaTelemetry(options: PwaTelemetryOptions = {}): PwaTelemetry {
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

  /** 写一个 span 载荷。 */
  const span = (name: string, attributes: OtlpAttribute[], startedAt: number, outcome: 'ok' | 'failed'): void => {
    post('traces', {
      resourceSpans: [{
        resource: resource(),
        scopeSpans: [{
          scope: { name: SCOPE },
          spans: [{
            traceId: randomHexOf(16),
            spanId: randomHexOf(8),
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
    boot(moduleCount: number, outcome: 'ok' | 'failed'): void {
      span('chatdsh.client.boot', [attribute('module.count', String(moduleCount)), attribute('outcome', outcome)], now(), outcome);
    },

    moduleLoad(moduleId: string, outcome: 'ok' | 'failed'): void {
      span('chatdsh.client.module.load', [attribute('module.id', moduleId), attribute('outcome', outcome)], now(), outcome);
    },

    action(action: string, outcome: ActionOutcome): void {
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
