/**
 * 记忆面板的界面动作遥测。
 *
 * 浏览器侧不持有 OpenObserve 凭据，事件编成 OTLP 日志载荷交给同源中继；中继只转发不解析，
 * 形状与 `@chatdsh/client-telemetry` 生成的一致。事件只带动作名与结果，不带查询文本、
 * 记忆正文或工作区路径。
 * @module @chatdsh/client-memory/telemetry
 */

/** 界面动作名，取值集合固定。 */
export type MemoryAction =
  | 'memory-search'
  | 'memory-entry-edit'
  | 'memory-entry-delete'
  | 'memory-entries-delete'
  | 'memory-export'
  | 'memory-group-create'
  | 'memory-group-rename'
  | 'memory-group-attach'
  | 'memory-group-detach'
  | 'memory-group-remove'
  | 'memory-write-discard'
  | 'memory-reload';

/** 动作结果。 */
export type MemoryOutcome = 'ok' | 'failed' | 'degraded';

/**
 * 记录一次界面动作；发送失败不打断界面。
 * @param action - 动作名。
 * @param outcome - 动作结果。
 */
export function noteAction(action: MemoryAction, outcome: MemoryOutcome): void {
  void fetch('/chatdsh/telemetry/browser', {
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
          scope: { name: '@chatdsh/client-memory' },
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
