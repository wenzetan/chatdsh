/**
 * 分享快照的渲染。
 *
 * 快照是控制平面自己渲染的只读页面：从会话副本读出不超过 `upToSeq` 的事件，服务端拼成
 * HTML 返回，不经过运行时。页面里的全部用户内容都做 HTML 转义。
 * @module @chatdsh/gateway/render
 */

import type { ShareRecord } from './store.ts';

/** 一条待渲染的事件。 */
export interface ShareEvent {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly payload?: unknown;
}

/** HTML 转义。快照里的一切用户内容都要经过它。 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 从事件本体里尽力取出可读文本；取不到时回退成 JSON 摘要。 */
function textOf(payload: unknown): string {
  if (payload === undefined) return '';
  const data = (payload as { data?: unknown }).data;
  const message = (data as { message?: unknown } | undefined)?.message;
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .filter((part) => part !== '');
    if (parts.length > 0) return parts.join('');
  }
  const toolName = (data as { name?: unknown } | undefined)?.name;
  if (typeof toolName === 'string') return toolName;
  const summary = JSON.stringify(data ?? payload);
  return summary.length <= 2000 ? summary : `${summary.slice(0, 2000)}…`;
}

/** 事件类型到展示标签。 */
function labelOf(kind: string): string {
  const labels: Record<string, string> = {
    'user/message': '用户',
    'assistant/message': '助手',
    'system/message': '系统',
    'developer/message': '系统指令',
    'tool/call': '工具调用',
    'tool/result': '工具结果',
    'turn/start': '回合开始',
    'turn/end': '回合结束',
    'step/start': '步骤开始',
    'step/end': '步骤结束',
  };
  return labels[kind] ?? kind;
}

/**
 * 渲染分享页面。
 * @param record - 分享记录。
 * @param events - 快照范围内的事件，按序号升序。
 * @returns 完整 HTML。
 */
export function renderSharePage(record: ShareRecord, events: readonly ShareEvent[]): string {
  const created = new Date(record.createdAt).toISOString();
  const items = events.map((event) => {
    const text = textOf(event.payload);
    const when = new Date(event.time).toISOString();
    return [
      `<article class="event">`,
      `<header><span class="label">${escapeHtml(labelOf(event.kind))}</span>`,
      `<span class="meta">#${event.seq} · ${escapeHtml(when)}</span></header>`,
      text === '' ? '' : `<pre>${escapeHtml(text)}</pre>`,
      `</article>`,
    ].join('');
  }).join('\n');

  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>会话快照 ${escapeHtml(record.sessionId)}</title>`,
    '<style>',
    'body{font:16px/1.6 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1f2328;background:#fff}',
    'h1{font-size:1.25rem;margin:0 0 .25rem}',
    '.meta{color:#6e7781;font-size:.8125rem}',
    '.event{border:1px solid #d0d7de;border-radius:6px;padding:.75rem 1rem;margin:0 0 .75rem}',
    '.event header{display:flex;justify-content:space-between;gap:1rem;align-items:baseline}',
    '.label{font-weight:600}',
    'pre{white-space:pre-wrap;word-break:break-word;margin:.5rem 0 0;font:inherit}',
    'footer{margin-top:2rem;color:#6e7781;font-size:.8125rem}',
    '</style></head><body>',
    `<h1>会话快照</h1>`,
    `<p class="meta">会话 ${escapeHtml(record.sessionId)} · 截至序号 ${record.upToSeq} · 建立于 ${escapeHtml(created)}</p>`,
    events.length === 0 ? '<p>这个范围内没有可展示的事件。</p>' : items,
    '<footer>这是固定内容的只读快照。源会话在此之后的新内容不会出现在这里。</footer>',
    '</body></html>',
  ].join('\n');
}
