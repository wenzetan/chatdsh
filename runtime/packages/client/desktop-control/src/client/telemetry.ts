/**
 * 桌面控制面板的界面动作遥测。
 *
 * 事件名沿用客户端插件登记的 `chatdsh.client.ui.action`，经同源中继
 * `POST /chatdsh/telemetry/browser` 上报。属性只有动作名与结果：目标应用、窗口标识、坐标、
 * 用途原文都不进遥测。
 * @module @chatdsh/client-desktop-control/telemetry
 */

import type { ActionOutcome, ControlTelemetry } from './types.ts';

/** 浏览器侧遥测中继路径。 */
export const TELEMETRY_PATH = '/chatdsh/telemetry/browser';

/** 本包的 instrumentation scope。 */
export const TELEMETRY_SCOPE = '@chatdsh/client-desktop-control';

/** 界面动作的事件名。 */
export const UI_ACTION_EVENT = 'chatdsh.client.ui.action';

/**
 * 记一次界面动作。发送失败不打断界面。
 * @param action - 动作名。
 * @param outcome - 结果。
 */
export function noteAction(action: string, outcome: ActionOutcome): void {
  void fetch(TELEMETRY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chatdsh-signal': 'logs', 'x-chatdsh-csrf': '1' },
    body: JSON.stringify({
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'chatdsh-browser' } },
            { key: 'chatdsh.surface', value: { stringValue: 'browser' } },
            { key: 'chatdsh.component', value: { stringValue: TELEMETRY_SCOPE } },
          ],
        },
        scopeLogs: [{
          scope: { name: TELEMETRY_SCOPE },
          logRecords: [{
            timeUnixNano: String(Date.now() * 1_000_000),
            severityNumber: outcome === 'ok' ? 9 : 13,
            severityText: outcome === 'ok' ? 'INFO' : 'WARN',
            body: { stringValue: UI_ACTION_EVENT },
            attributes: [
              { key: 'action', value: { stringValue: action } },
              { key: 'outcome', value: { stringValue: outcome } },
            ],
          }],
        }],
      }],
    }),
    keepalive: true,
  }).catch(() => undefined);
}

/** 浏览器侧的遥测面。 */
export const browserTelemetry: ControlTelemetry = { action: noteAction };
