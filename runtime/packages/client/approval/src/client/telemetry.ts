/**
 * 审批界面的浏览器侧遥测。
 *
 * 客户端插件把关键界面动作写成 `chatdsh.client.ui.action` 事件，经同源中继
 * `POST /chatdsh/telemetry/browser` 上报；决定的计数由宿主侧承担，这里只记动作与结果，避免
 * 两处口径打架。属性只放动作名与结果枚举：工具参数、命令文本、计划正文与自由输入都不进入
 * 遥测。
 * @module @chatdsh/client-approval/telemetry
 */

/** 中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继要求的来源校验头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测规范里的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-approval';

/** 关键界面动作的事件名。 */
export const UI_ACTION_EVENT = 'chatdsh.client.ui.action';

/** 待发送载荷的上限。 */
const PENDING_MAX = 16;

/** 一条属性的取值。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 关键界面动作的遥测面。 */
export interface UiActionTelemetry {
  /**
   * 记一次界面动作。
   * @param action - 动作名。
   * @param outcome - 结果枚举。
   */
  action(action: string, outcome: string): void;
}

/** 遥测面的依赖。 */
export interface UiActionTelemetryOptions {
  /** 发请求的实现。 */
  readonly fetchImpl: typeof fetch;
  /** 当前时刻的毫秒时间戳。 */
  readonly now: () => number;
  /** 上报端点。 */
  readonly relayPath?: string;
}

/**
 * 建立界面动作的遥测面。
 * @param options - 依赖。
 * @returns 遥测面。
 */
export function createUiActionTelemetry(options: UiActionTelemetryOptions): UiActionTelemetry {
  const relayPath = options.relayPath ?? RELAY_PATH;
  let pending = 0;
  return {
    action(action: string, outcome: string): void {
      if (pending >= PENDING_MAX) return;
      pending += 1;
      const attributes: OtlpAttribute[] = [
        { key: 'action', value: { stringValue: action } },
        { key: 'outcome', value: { stringValue: outcome } },
      ];
      const payload = {
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { stringValue: 'chatdsh-browser' } },
                { key: 'chatdsh.surface', value: { stringValue: 'browser' } },
                { key: 'chatdsh.component', value: { stringValue: SCOPE } },
              ],
            },
            scopeLogs: [
              {
                scope: { name: SCOPE },
                logRecords: [
                  {
                    timeUnixNano: String(options.now() * 1_000_000),
                    severityNumber: 9,
                    severityText: 'INFO',
                    body: { stringValue: UI_ACTION_EVENT },
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      };
      void options.fetchImpl(relayPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chatdsh-signal': 'logs', [CSRF_HEADER]: '1' },
        body: JSON.stringify(payload),
        keepalive: true,
      })
        .catch(() => undefined)
        .finally(() => {
          pending -= 1;
        });
    },
  };
}
