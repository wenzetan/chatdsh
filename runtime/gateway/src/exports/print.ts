/**
 * 打印文档与打印样式。
 *
 * 打印视图去掉应用导航、输入区与交互按钮，保留标题、时间、页码、代码换行、长表头重复与
 * 可理解的链接文本。分页规则按中文排版设置：消息整块不跨页切断，标题不落在页尾，段落
 * 保留孤行与寡行下限，标点按 `line-break: strict` 处理禁则。样式同时给出屏幕版与
 * `@media print` 版，浏览器打印命令与 PDF 渲染共用这一份。
 * @module @chatdsh/gateway/exports/print
 */

import type { ExportAttachment, PrintScope } from '@chatdsh/core-contracts';
import type { PublicPageModel } from '../sharing/types.ts';
import { formatRangeLabel, formatTimeWithZone, type TimeDisplayOptions } from './document.ts';
import type { PrintDocumentModel } from './types.ts';

/** 界面部分与打印时隐藏的类名。 */
export const PRINT_EXCLUSION_CLASSES: Readonly<Record<PrintScope['excluded'][number], string>> = {
  navigation: 'chdsh-app-nav',
  composer: 'chdsh-composer',
  'interaction-buttons': 'chdsh-actions',
};

/** HTML 转义。打印文档里的一切用户内容都要经过它。 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 附件状态的中文说法。 */
export function attachmentStateLabel(state: ExportAttachment['state']): string {
  if (state === 'downloadable') return '可下载';
  if (state === 'missing') return '缺失';
  return '需要源设备';
}

/** 角色标签。 */
function roleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'tool') return '工具阅读记录';
  if (role === 'artifact') return '制品内容';
  return role;
}

/** 打印隐藏规则：只隐藏范围内指定的部分。 */
function exclusionRules(scope: PrintScope): string[] {
  if (scope.excluded.length === 0) return [];
  const classes = scope.excluded.map((item) => `.${PRINT_EXCLUSION_CLASSES[item]}`).join(',');
  return [`${classes}{display:none!important}`];
}

/**
 * 生成打印样式。
 *
 * 屏幕与打印共用同一套排版；分页与纸张规则放在 `@media print` 与 `@page` 里，页码只在
 * 打开页码时输出。代码换行按 `wrap` 与 `scroll` 两种方式给出不同的处理。
 * @param scope - 打印范围。
 * @returns 完整样式文本。
 */
export function printStylesheet(scope: PrintScope): string {
  const codeRules = scope.codeWrapping === 'wrap'
    ? 'pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;line-break:strict}'
    : 'pre{white-space:pre;overflow-x:auto;word-break:normal;line-break:strict}';
  const headerRules = scope.repeatTableHeader
    ? 'thead{display:table-header-group}'
    : 'thead{display:table-row-group}';

  return [
    'html{-webkit-text-size-adjust:100%}',
    'body{font:11pt/1.75 "Noto Sans CJK SC","Noto Serif CJK SC","Source Han Sans SC",system-ui,sans-serif;color:#1f2328;background:#fff;margin:0 auto;max-width:52rem;padding:1.5rem 1rem}',
    'h1{font-size:1.5rem;line-height:1.35;margin:0 0 .5rem}',
    'h2{font-size:1.0625rem;margin:1.5rem 0 .5rem}',
    '.chdsh-print-facts{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0 0 1rem;font-size:.875rem}',
    '.chdsh-print-facts dt{color:#57606a}',
    '.chdsh-print-facts dd{margin:0}',
    '.chdsh-print-notice{border-left:3px solid #d0d7de;padding:.25rem 0 .25rem .75rem;color:#57606a;font-size:.875rem;margin:0 0 1.5rem}',
    '.chdsh-print-entry{color:#57606a;font-size:.875rem;margin:0 0 1rem}',
    '.chdsh-print-msg{border:1px solid #d0d7de;border-radius:6px;padding:.75rem 1rem;margin:0 0 .875rem;break-inside:avoid}',
    '.chdsh-print-msg>header{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;color:#57606a;font-size:.8125rem}',
    '.chdsh-print-msg .role{font-weight:600;color:#1f2328}',
    '.chdsh-print-msg pre{margin:.5rem 0 0;font:inherit}',
    codeRules,
    'table{width:100%;border-collapse:collapse;margin:0 0 1rem}',
    'th,td{border:1px solid #d0d7de;padding:.375rem .5rem;text-align:left;font-size:.875rem;vertical-align:top}',
    'th{background:#f6f8fa}',
    headerRules,
    'tr{break-inside:avoid}',
    'a[href]::after{content:"（" attr(href) "）";word-break:break-all;color:#57606a}',
    'footer{margin-top:1.5rem;color:#57606a;font-size:.8125rem}',
    ...exclusionRules(scope),
    scope.pageNumbers
      ? '@page{size:A4;margin:18mm 16mm;@bottom-center{content:"第 " counter(page) " 页 / 共 " counter(pages) " 页";font-size:9pt;color:#57606a}}'
      : '@page{size:A4;margin:18mm 16mm}',
    '@media print{',
    '  body{max-width:none;margin:0;padding:0;font-size:10.5pt;color:#000}',
    '  h1,h2{break-after:avoid}',
    '  .chdsh-print-msg{break-inside:avoid;border-color:#999}',
    '  .chdsh-print-msg>header{break-after:avoid}',
    '  p,li{orphans:2;widows:2}',
    '  thead{display:table-header-group}',
    '  tr,figure{break-inside:avoid}',
    '  pre,h1,h2,td,th{overflow-wrap:break-word;word-break:normal;line-break:strict;hyphens:none}',
    '  a{color:#000;text-decoration:none}',
    '  .chdsh-print-notice{break-inside:avoid}',
    '  .chdsh-print-entry{display:none}',
    '}',
  ].join('\n');
}

/**
 * 公开快照页的打印文档事实。
 *
 * 页面只有固定内容，打印时保留标题、建立时间、回合范围与逐条消息；交互部分在打印范围里
 * 全部隐去。附件清单沿用逐项状态。
 * @param page - 公开页模型。
 * @returns 打印文档模型。
 */
export function printModelOfSharePage(page: PublicPageModel): PrintDocumentModel {
  return {
    title: page.title,
    at: page.createdAt,
    facts: [
      { label: '建立于', value: new Date(page.createdAt).toISOString() },
      { label: '内容范围', value: `${formatRangeLabel(page.turns)}（完整回合，${String(page.scope.eventCount)} 个事件，${String(page.messages.length)} 条消息）` },
      { label: '附件', value: `${String(page.attachments.length)} 项只读副本` },
    ],
    entries: page.messages.map((message) => ({
      role: message.role,
      time: message.time,
      text: message.text,
      kind: 'message' as const,
    })),
    attachments: page.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      state: 'downloadable' as const,
      size: attachment.size,
    })),
    notice: '这是固定内容的只读快照；页面没有输入、审批或编辑动作。',
    footer: '打印视图只保留标题、时间、正文与附件清单；应用导航、输入区与交互按钮都不出现在纸上。',
  };
}

/** 公开页打印的默认范围。 */
export const PUBLIC_PRINT_SCOPE: Omit<PrintScope, 'title' | 'scope'> = {
  pageNumbers: true,
  codeWrapping: 'wrap',
  repeatTableHeader: true,
  excluded: ['navigation', 'composer', 'interaction-buttons'],
};

/**
 * 渲染公开快照页的打印文档。
 * @param page - 公开页模型。
 * @param time - 时间显示方式。
 * @returns 完整 HTML，含打印样式。
 */
export function renderSharePrintPage(page: PublicPageModel, time: TimeDisplayOptions): string {
  return renderPrintDocument(printModelOfSharePage(page), {
    scope: { title: page.title, scope: page.scope, ...PUBLIC_PRINT_SCOPE },
    time,
  });
}

/** 文档外壳。 */
function shell(options: { readonly title: string; readonly css: string; readonly body: string }): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">',
    `<title>${escapeHtml(options.title)}</title>`,
    '<style>',
    options.css,
    '</style></head><body>',
    options.body,
    '</body></html>',
  ].join('\n');
}

/** 附件清单表格。 */
function attachmentTable(attachments: readonly ExportAttachment[]): string {
  if (attachments.length === 0) return '';
  const rows = attachments.map((attachment) => [
    '<tr>',
    `<td>${escapeHtml(attachment.filename)}</td>`,
    `<td>${escapeHtml(attachmentStateLabel(attachment.state))}</td>`,
    `<td>${attachment.size === undefined ? '—' : String(attachment.size)}</td>`,
    '</tr>',
  ].join('')).join('\n');
  return [
    '<section class="chdsh-print-attachments">',
    '<h2>附件清单</h2>',
    '<table>',
    '<thead><tr><th scope="col">文件名</th><th scope="col">状态</th><th scope="col">字节</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</section>',
  ].join('\n');
}

/**
 * 渲染打印文档。
 * @param model - 文档事实。
 * @param options - 打印范围与时间显示。
 * @returns 完整 HTML，含打印样式。
 */
export function renderPrintDocument(model: PrintDocumentModel, options: { readonly scope: PrintScope; readonly time: TimeDisplayOptions }): string {
  const facts = model.facts.map((fact) => (
    `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`
  )).join('');
  const entries = model.entries.map((entry) => [
    '<article class="chdsh-print-msg">',
    '<header>',
    `<span class="role">${escapeHtml(roleLabel(entry.role))}</span>`,
    `<time datetime="${escapeHtml(new Date(entry.time).toISOString())}">${escapeHtml(formatTimeWithZone(entry.time, options.time))}</time>`,
    '</header>',
    `<pre>${escapeHtml(entry.text)}</pre>`,
    '</article>',
  ].join('')).join('\n');

  const body = [
    '<header class="chdsh-print-head">',
    `<h1>${escapeHtml(model.title)}</h1>`,
    `<dl class="chdsh-print-facts">${facts}</dl>`,
    `<p class="chdsh-print-notice">${escapeHtml(model.notice)}</p>`,
    '<p class="chdsh-print-entry">打印样式已应用，使用浏览器的打印命令输出这一页。</p>',
    '</header>',
    '<main>',
    entries === '' ? '<p>这个范围里没有可显示的文本。</p>' : entries,
    '</main>',
    attachmentTable(model.attachments),
    `<footer>${escapeHtml(model.footer)}</footer>`,
  ].join('\n');

  return shell({ title: model.title, css: printStylesheet(options.scope), body });
}
