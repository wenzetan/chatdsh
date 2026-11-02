/**
 * 窗口与分屏动作的浏览器侧遥测。
 *
 * 上报走宿主提供的同源中继 `POST /chatdsh/telemetry/browser`，载荷是 OTLP/HTTP JSON，端点
 * 按请求头 `x-chatdsh-signal` 分流。只使用 `docs/telemetry.md` 第六节登记过的名称：
 * - span `chatdsh.client.navigate`：打开窗口时按深链接请求目标会话；
 * - span `chatdsh.client.command.run`：一次窗口或分屏命令；
 * - 事件 `chatdsh.client.ui.action`：打开窗口、拖动分隔条、键盘调整、重置与坦白入口；
 * - 事件 `chatdsh.client.error` 与计数 `chatdsh_client_errors_total`：失败与失败计数；
 * - 计数 `chatdsh_client_command_runs_total` 与 `chatdsh_client_navigations_total`：动作结果。
 *
 * 属性只取登记过的键：动作名、结果、命令标识、设备与会话标识、错误类型与错误码。窗口标题、
 * 草稿正文、对象正文与地址查询串都不进入遥测。
 * @module @chatdsh/client-multi-window/telemetry
 */

import type { WindowTarget } from './window/deep-link.ts';

/** 同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继校验的来源请求头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测里的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-multi-window';

/** 同时在途的上报数量上限，超出后丢弃本次上报。 */
const PENDING_MAX = 64;

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed' | 'rejected' | 'conflict';

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 遥测面的构造依赖。 */
export interface WindowTelemetryOptions {
  /** 发请求的实现；浏览器里是同源的 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
}

/** 窗口与分屏使用的遥测面。 */
export interface WindowTelemetry {
  /**
   * 记一次按深链接打开目标窗口的导航。
   * @param target - 目标上下文。
   * @param outcome - 结果。
   * @param attempt - 第几次尝试。
   * @param error - 失败对象。
   */
  navigation(target: WindowTarget, outcome: ActionOutcome, attempt: number, error?: unknown): void;
  /**
   * 记一次窗口或分屏命令。
   * @param commandId - 命令标识，取固定枚举。
   * @param outcome - 结果。
   * @param error - 失败对象。
   */
  command(commandId: string, outcome: ActionOutcome, error?: unknown): void;
  /**
   * 记一次关键界面动作。
   * @param action - 动作名，取固定枚举。
   * @param outcome - 结果。
   */
  action(action: string, outcome: ActionOutcome): void;
  /**
   * 记一次失败。
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
 * 建立窗口与分屏的遥测面。
 * @param options - 依赖覆盖。
 * @returns 遥测面。
 */
export function createWindowTelemetry(options: WindowTelemetryOptions = {}): WindowTelemetry {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  let pending = 0;

  /**
   * 把一份 OTLP 载荷交给中继。失败只落空本次上报，不改变业务结果。
   * @param signal - 载荷类型。
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

  /** 写一个 span。 */
  const span = (name: string, attributes: OtlpAttribute[], startedAt: number, outcome: ActionOutcome): void => {
    const endedAt = now();
    post('traces', {
      resourceSpans: [{
        resource: resource(),
        scopeSpans: [{
          scope: { name: SCOPE },
          spans: [{
            traceId: randomHex(16),
            spanId: randomHex(8),
            name,
            kind: 1,
            startTimeUnixNano: String(startedAt * 1_000_000),
            endTimeUnixNano: String(endedAt * 1_000_000),
            attributes: [...attributes, attribute('outcome', outcome)],
            status: { code: outcome === 'ok' ? 1 : 2 },
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
    navigation(target: WindowTarget, outcome: ActionOutcome, attempt: number, error?: unknown): void {
      const attributes = [
        attribute('deviceId', target.deviceId),
        attribute('session.id', target.sessionId),
        attribute('attempt', String(attempt)),
      ];
      if (error !== undefined) {
        const failure = failureAttributesOf(error);
        attributes.push(attribute('error.type', failure.type), attribute('error.code', failure.code));
      }
      span('chatdsh.client.navigate', attributes, now(), outcome);
      count('chatdsh_client_navigations_total', [attribute('outcome', outcome)]);
    },

    command(commandId: string, outcome: ActionOutcome, error?: unknown): void {
      const attributes = [attribute('command.id', commandId)];
      if (error !== undefined) {
        const failure = failureAttributesOf(error);
        attributes.push(attribute('error.type', failure.type), attribute('error.code', failure.code));
      }
      span('chatdsh.client.command.run', attributes, now(), outcome);
      count('chatdsh_client_command_runs_total', [attribute('outcome', outcome)]);
    },

    action(action: string, outcome: ActionOutcome): void {
      const ok = outcome === 'ok';
      event('chatdsh.client.ui.action', [attribute('action', action), attribute('outcome', outcome)], ok ? 9 : 13, ok ? 'INFO' : 'WARN');
    },

    failure(action: string, error: unknown): void {
      const failure = failureAttributesOf(error);
      event('chatdsh.client.ui.action', [attribute('action', action), attribute('outcome', 'failed')], 13, 'WARN');
      event('chatdsh.client.error', [attribute('error.type', failure.type), attribute('error.code', failure.code)], 17, 'ERROR');
      count('chatdsh_client_errors_total', [attribute('error_type', failure.type)]);
    },
  };
}

/**
 * 生成随机十六进制标识。
 * @param bytes - 字节数。
 * @returns 十六进制文本。
 */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
