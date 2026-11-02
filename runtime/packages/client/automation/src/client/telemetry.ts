/**
 * 自动化面板的界面动作遥测。
 *
 * 浏览器侧不持有导出端点凭据，事件编成 OTLP 日志载荷交给同源中继；中继只转发不解析。
 * 事件只带动作名与结果，不带自动化标识、提示词、签名密钥的环境变量值、地址或投递载荷。
 * @module @chatdsh/client-automation/telemetry
 */

import type { ActionOutcome, AutomationUiAction, PanelTelemetry } from './types.ts';

/** 浏览器侧遥测中继路径。 */
export const TELEMETRY_PATH = '/chatdsh/telemetry/browser';

/**
 * 记录一次界面动作；发送失败不打断界面。
 * @param action - 动作名。
 * @param outcome - 动作结果。
 */
export function noteAction(action: AutomationUiAction, outcome: ActionOutcome): void {
  void fetch(TELEMETRY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-signal': 'logs', 'x-chatdsh-csrf': '1' },
    body: JSON.stringify({
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'chatdsh-browser' } },
            { key: 'chatdsh.surface', value: { stringValue: 'browser' } },
          ],
        },
        scopeLogs: [{
          scope: { name: '@chatdsh/client-automation' },
          logRecords: [{
            timeUnixNano: String(Date.now() * 1_000_000),
            severityNumber: outcome === 'failed' ? 13 : 9,
            severityText: outcome === 'failed' ? 'WARN' : 'INFO',
            body: { stringValue: 'chatdsh.client.ui.action' },
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
export const browserTelemetry: PanelTelemetry = { action: noteAction };
