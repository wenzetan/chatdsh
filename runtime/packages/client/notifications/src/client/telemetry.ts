/**
 * 通知界面的浏览器侧遥测。
 *
 * 上报走宿主提供的同源中继 `POST /chatdsh/telemetry/browser`，按请求头 `x-chatdsh-signal`
 * 分流到三类出口。只使用 `docs/telemetry.md` 6.5 节登记的名称：一次通知接口调用是一个
 * `chatdsh.client.remote.call` span，一次打开通知是一个 `chatdsh.client.navigate` span，
 * 被拒绝的打开动作写 `chatdsh.client.navigate.rejected` 事件，界面动作写
 * `chatdsh.client.ui.action`，失败写 `chatdsh.client.error` 并计入错误计数。属性只有方法
 * 名、动作名、结果、设备与错误类型；标题、摘要与消息原文都不进入遥测。
 * @module @chatdsh/client-notifications/telemetry
 */

/** 同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继校验的来源请求头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测里使用的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-notifications';

/** 同时在途的上报数量上限，超出后丢弃本次上报。 */
const PENDING_MAX = 64;

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 打开通知的结果枚举。 */
export type NavigationOutcome = 'ok' | 'blocked' | 'failed';

/** 通知界面的遥测面。 */
export interface NotificationTelemetry {
  /**
   * 记录一次通知接口调用。
   * @param method - 接口方法名。
   * @param work - 实际调用。
   * @returns 调用结果。
   */
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 结果枚举。
   */
  action(action: string, outcome: string): void;
  /**
   * 记录一次打开通知。
   * @param attributes - 设备、会话、尝试次数与结果。
   */
  navigate(attributes: {
    readonly deviceId?: string;
    readonly sessionId?: string;
    readonly attempt: number;
    readonly outcome: NavigationOutcome;
    readonly error?: unknown;
  }): void;
  /**
   * 记录一次失败。
   * @param error - 失败对象。
   */
  failure(error: unknown): void;
}

/** 遥测面的构造依赖。 */
export interface NotificationTelemetryOptions {
  /** 发请求的实现；浏览器里是全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
  /** 生成随机十六进制标识的实现。 */
  readonly randomHex?: (bytes: number) => string;
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
 * 建立通知界面的遥测面。
 * @param options - 依赖覆盖。
 * @returns 遥测面。
 */
export function createNotificationTelemetry(options: NotificationTelemetryOptions = {}): NotificationTelemetry {
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
  const span = (name: string, attributes: OtlpAttribute[], startedAt: number, outcome: string): void => {
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

  const failure = (error: unknown): void => {
    const { type, code } = failureAttributesOf(error);
    event('chatdsh.client.error', [attribute('error.type', type), attribute('error.code', code)], 17, 'ERROR');
    count('chatdsh_client_errors_total', [attribute('error_type', type)]);
  };

  return {
    async run<T>(method: string, work: () => Promise<T>): Promise<T> {
      const startedAt = now();
      const attributes = [attribute('rpc.method', method)];
      try {
        const value = await work();
        span('chatdsh.client.remote.call', [...attributes, attribute('outcome', 'ok')], startedAt, 'ok');
        return value;
      } catch (error) {
        span('chatdsh.client.remote.call', [...attributes, attribute('outcome', 'failed')], startedAt, 'failed');
        failure(error);
        throw error;
      }
    },

    action(action: string, outcome: string): void {
      event('chatdsh.client.ui.action', [attribute('action', action), attribute('outcome', outcome)], outcome === 'ok' ? 9 : 13, outcome === 'ok' ? 'INFO' : 'WARN');
    },

    navigate(attributes): void {
      const startedAt = now();
      const failed = attributes.error === undefined ? undefined : failureAttributesOf(attributes.error);
      const spanAttributes = [
        attribute('attempt', String(attributes.attempt)),
        attribute('outcome', attributes.outcome),
        ...(attributes.deviceId === undefined ? [] : [attribute('deviceId', attributes.deviceId)]),
        ...(attributes.sessionId === undefined ? [] : [attribute('session.id', attributes.sessionId)]),
        ...(failed === undefined ? [] : [attribute('error.type', failed.type), attribute('error.code', failed.code)]),
      ];
      span('chatdsh.client.navigate', spanAttributes, startedAt, attributes.outcome === 'ok' ? 'ok' : 'failed');
      if (attributes.outcome !== 'ok' && failed !== undefined) {
        event('chatdsh.client.navigate.rejected', [
          attribute('attempt', String(attributes.attempt)),
          attribute('outcome', attributes.outcome),
          ...(attributes.deviceId === undefined ? [] : [attribute('deviceId', attributes.deviceId)]),
          attribute('error.type', failed.type),
          attribute('error.code', failed.code),
        ], 13, 'WARN');
      }
      count('chatdsh_client_navigations_total', [attribute('outcome', attributes.outcome)]);
    },

    failure,
  };
}
