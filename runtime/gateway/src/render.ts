/**
 * 分享快照的只读页面渲染。
 *
 * 页面由控制平面自己渲染：全部内容来自固定的快照记录，服务端拼接 HTML 返回，页面里没有
 * 脚本、输入、审批与编辑动作，也没有事件序号、副本水位与源会话标识。一切用户内容都经过
 * HTML 转义，样式只在本页内联。
 * @module @chatdsh/gateway/render
 */

import type { ShareRecord } from './store.ts';
import type { ContentScope } from '@chatdsh/core-contracts';
import type { PublicPageModel, ReplicaEvent, ShareMessage } from './sharing/types.ts';
import { buildTurnIndex, sessionTitleOf } from './sharing/events.ts';
import { filterTurns } from './sharing/filter.ts';

/** 一条待渲染的事件；保留旧接口的形状。 */
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

/** 时间戳的 ISO 表示。 */
function isoOf(time: number): string {
  return new Date(time).toISOString();
}

/** 角色标签。 */
function roleLabelOf(role: ShareMessage['role']): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  return '工具';
}

/** 回合范围的展示文字。 */
function rangeLabelOf(turns: readonly number[]): string {
  if (turns.length === 0) return '回合范围为空';
  const first = turns[0];
  const last = turns[turns.length - 1];
  if (first === undefined || last === undefined) return '回合范围为空';
  const contiguous = turns.every((turn, index) => index === 0 || turn === (turns[index - 1] ?? 0) + 1);
  return contiguous ? `回合 ${String(first)}–${String(last)}` : `回合 ${turns.map((turn) => String(turn)).join('、')}`;
}

/** 页面样式，只在本页生效。 */
const PAGE_STYLE = [
  'body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1f2328;background:#fff}',
  'h1{font-size:1.375rem;margin:0 0 .5rem;line-height:1.3}',
  'h2{font-size:1rem;margin:2rem 0 .5rem}',
  '.meta{display:flex;flex-wrap:wrap;gap:.25rem 1rem;color:#57606a;font-size:.8125rem;margin:0 0 .75rem}',
  '.notice{border-left:3px solid #d0d7de;padding:.25rem 0 .25rem .75rem;color:#57606a;font-size:.875rem;margin:0 0 1.5rem}',
  '.print-entry{display:flex;gap:1rem;align-items:baseline;font-size:.875rem;margin:0 0 2rem}',
  '.print-entry a{color:#0969da}',
  '.message{border:1px solid #d0d7de;border-radius:6px;padding:.75rem 1rem;margin:0 0 .75rem}',
  '.message header{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;color:#57606a;font-size:.8125rem}',
  '.message .role{font-weight:600;color:#1f2328}',
  '.message pre{white-space:pre-wrap;word-break:break-word;margin:.5rem 0 0;font:inherit}',
  '.attachments ul{list-style:none;padding:0;margin:0}',
  '.attachments li{display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline;padding:.375rem 0;border-bottom:1px solid #eaeef2}',
  '.attachments .size{color:#57606a;font-size:.8125rem}',
  'footer{margin-top:2rem;color:#57606a;font-size:.8125rem}',
  '@media print{body{margin:0;max-width:none}.print-entry{display:none}.message{break-inside:avoid}}',
].join('\n');

/** 页面外壳。 */
function shell(options: { readonly title: string; readonly body: string }): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(options.title)}</title>`,
    '<style>',
    PAGE_STYLE,
    '</style></head><body>',
    options.body,
    '</body></html>',
  ].join('\n');
}

/** 一条消息。 */
function renderMessage(message: ShareMessage): string {
  return [
    '<article class="message">',
    `<header><span class="role">${escapeHtml(roleLabelOf(message.role))}</span>`,
    `<span class="time">${escapeHtml(isoOf(message.time))}</span></header>`,
    `<pre>${escapeHtml(message.text)}</pre>`,
    '</article>',
  ].join('');
}

/** 附件清单。 */
function renderAttachments(model: PublicPageModel): string {
  if (model.attachments.length === 0) return '';
  const items = model.attachments.map((attachment) => [
    '<li>',
    `<a href="/s/${encodeURIComponent(model.token)}/attachments/${encodeURIComponent(attachment.id)}" rel="nofollow">${escapeHtml(attachment.filename)}</a>`,
    `<span class="size">${String(attachment.size)} 字节</span>`,
    '</li>',
  ].join('')).join('\n');
  return [
    '<section class="attachments">',
    '<h2>可分享附件</h2>',
    `<ul>${items}</ul>`,
    '</section>',
  ].join('\n');
}

/**
 * 渲染公开快照页。
 * @param model - 固定内容的页面模型。
 * @returns 完整 HTML。
 */
export function renderPublicPage(model: PublicPageModel): string {
  const printEntry = model.canPrint
    ? '<nav class="print-entry"><a href="?print=1" rel="nofollow">打印视图</a><span>或使用浏览器的打印命令（Ctrl+P）。</span></nav>'
    : '';
  const body = [
    '<header class="page-head">',
    `<h1>${escapeHtml(model.title)}</h1>`,
    '<p class="meta">',
    `<span>建立于 ${escapeHtml(isoOf(model.createdAt))}</span>`,
    `<span>${escapeHtml(rangeLabelOf(model.turns))}</span>`,
    `<span>${String(model.messages.length)} 条消息</span>`,
    '<span>只读快照</span>',
    '</p>',
    '<p class="notice">这是固定内容的只读快照。源会话在此之后的新内容不会出现在这里；页面没有输入、审批、继续或编辑动作。</p>',
    printEntry,
    '</header>',
    '<main>',
    model.messages.length === 0 ? '<p>这个范围里没有可公开的文本。</p>' : model.messages.map(renderMessage).join('\n'),
    '</main>',
    renderAttachments(model),
    '<footer>内容范围：默认只公开用户与助手的可见文本。工具参数与结果原文、记忆内容、思考过程、内部路径与凭据都不进入快照。</footer>',
  ].join('\n');
  return shell({ title: model.title, body });
}

/**
 * 渲染公开访问失败的页面。撤销与过期返回同一个页面，未知令牌同样不给出来源信息。
 * @param status - HTTP 状态码，只取 404 与 410。
 * @returns 完整 HTML。
 */
export function renderShareUnavailablePage(status: 404 | 410): string {
  const title = status === 404 ? '链接不存在' : '链接已失效';
  const text = status === 404
    ? '这条分享链接不存在。'
    : '这条分享已经撤销或过期，链接立即失效。';
  return shell({
    title,
    body: [
      '<header class="page-head">',
      `<h1>${escapeHtml(title)}</h1>`,
      '<p class="notice">页面不提供重建链接的入口，也不说明链接原来指向哪个会话。</p>',
      '</header>',
      '<main>',
      `<p>${escapeHtml(text)}</p>`,
      '</main>',
    ].join('\n'),
  });
}

/**
 * 渲染旧接口的快照页面：内容经过同一套默认过滤，页面不显示事件序号与源会话标识。
 * @param record - 分享记录。
 * @param events - 快照范围内的事件。
 * @returns 完整 HTML。
 */
export function renderSharePage(record: ShareRecord, events: readonly ShareEvent[]): string {
  const replicaEvents: ReplicaEvent[] = events.map((event) => ({
    seq: event.seq,
    kind: event.kind,
    time: event.time,
    bytes: 0,
    payload: event.payload,
  }));
  const index = buildTurnIndex(replicaEvents);
  const filtered = filterTurns(index.turns, { includeUserText: true, includeAssistantText: true });
  const turns = [...new Set(index.turns.map((turn) => turn.turn))].sort((left, right) => left - right);
  const first = turns[0] ?? 1;
  const last = turns[turns.length - 1] ?? first;
  const scope: ContentScope = {
    turnFrom: first,
    turnTo: last,
    eventCount: replicaEvents.length,
    charCount: filtered.charCount,
    compressed: false,
    attachmentsComplete: true,
  };
  const model: PublicPageModel = {
    title: sessionTitleOf(replicaEvents) ?? '会话快照',
    createdAt: record.createdAt,
    scope,
    turns,
    messages: filtered.messages,
    attachments: [],
    readOnly: true,
    canPrint: true,
    interactive: false,
    token: record.token,
  };
  return renderPublicPage(model);
}
