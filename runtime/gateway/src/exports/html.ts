/**
 * HTML 导出的渲染。
 *
 * 文档是自包含的静态页：只有内联样式，没有脚本、表单、外链资源与内联事件属性；元信息里的
 * 内容安全策略同样禁止脚本与外链。所有用户内容经过 HTML 转义，输出可被标准解析器直接读取。
 * 样式复用打印样式，浏览器打印这份文件时分页与页码同样生效。
 * @module @chatdsh/gateway/exports/html
 */

import type { ExportAttachment, PrintScope } from '@chatdsh/core-contracts';
import { documentFacts, formatTimeWithZone, type TimeDisplayOptions } from './document.ts';
import { attachmentStateLabel, escapeHtml, printStylesheet } from './print.ts';
import type { ExportDocument } from './types.ts';

/** 导出用的打印范围：页码、换行、重复表头都打开，应用部分全部隐藏。 */
export const EXPORT_PRINT_SCOPE: Omit<PrintScope, 'title' | 'scope'> = {
  pageNumbers: true,
  codeWrapping: 'wrap',
  repeatTableHeader: true,
  excluded: ['navigation', 'composer', 'interaction-buttons'],
};

/** 角色标签。 */
function roleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'artifact') return '制品内容';
  return '工具阅读记录';
}

/** 附件清单。 */
function attachmentSection(attachments: readonly ExportAttachment[]): string {
  if (attachments.length === 0) return '';
  const rows = attachments.map((attachment) => [
    '<tr>',
    `<td>${escapeHtml(attachment.filename)}</td>`,
    `<td>${escapeHtml(attachmentStateLabel(attachment.state))}</td>`,
    `<td>${attachment.size === undefined ? '—' : String(attachment.size)}</td>`,
    '</tr>',
  ].join('')).join('\n');
  return [
    '<section aria-labelledby="export-attachments">',
    '<h2 id="export-attachments">附件清单</h2>',
    '<table>',
    '<thead><tr><th scope="col">文件名</th><th scope="col">状态</th><th scope="col">字节</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</section>',
  ].join('\n');
}

/**
 * 渲染 HTML 导出。
 * @param document - 导出文档。
 * @param time - 时间显示方式。
 * @returns 完整 HTML 文档。
 */
export function renderHtml(document: ExportDocument, time: TimeDisplayOptions): string {
  const facts = documentFacts(document, time)
    .map((fact) => `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`)
    .join('');
  const entries: string[] = [];
  let currentTurn: number | undefined;
  for (const entry of document.entries) {
    if (entry.turn !== currentTurn) {
      if (currentTurn !== undefined) entries.push('</section>');
      currentTurn = entry.turn;
      entries.push(`<section class="chdsh-export-turn" aria-labelledby="export-turn-${String(entry.turn)}">`);
      entries.push(`<h2 id="export-turn-${String(entry.turn)}">第 ${String(entry.turn)} 回合</h2>`);
    }
    entries.push([
      '<article class="chdsh-print-msg">',
      '<header>',
      `<span class="role">${escapeHtml(roleLabel(entry.role))}</span>`,
      `<time datetime="${escapeHtml(new Date(entry.time).toISOString())}">${escapeHtml(formatTimeWithZone(entry.time, time))}</time>`,
      '</header>',
      `<pre>${escapeHtml(entry.text)}</pre>`,
      '</article>',
    ].join(''));
  }
  if (currentTurn !== undefined) entries.push('</section>');

  const css = printStylesheet({
    title: document.title,
    scope: document.scope,
    ...EXPORT_PRINT_SCOPE,
  });

  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="ChatDSH">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'; script-src \'none\'">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(document.title)}</title>`,
    '<style>',
    css,
    '</style></head><body>',
    '<header>',
    `<h1>${escapeHtml(document.title)}</h1>`,
    `<dl class="chdsh-print-facts">${facts}</dl>`,
    '<p class="chdsh-print-notice">这是只读导出，内容取自权威会话日志的完整回合；页面没有脚本、输入或交互动作。</p>',
    '</header>',
    '<main>',
    entries.length === 0 ? '<p>这个范围里没有可导出的文本。</p>' : entries.join('\n'),
    '</main>',
    attachmentSection(document.attachments),
    '<footer>导出内容按所选脱敏方式处理；副本水位、事件序号与内部存储路径都不出现在文件里。</footer>',
    '</body></html>',
  ].join('\n');
}
