/**
 * Markdown 导出的渲染。
 *
 * 正文按条目分节：每个回合一个二级标题，每条内容一个三级标题加一段围栏文本。围栏长度按
 * 正文里最长的反引号串决定，正文里的围栏标记因此不会截断结构。说明事实与附件清单用表格
 * 呈现，表格里的竖线经过转义。
 * @module @chatdsh/gateway/exports/markdown
 */

import type { ExportAttachment } from '@chatdsh/core-contracts';
import { attachmentStateLabel } from './print.ts';
import { documentFacts, formatTimeWithZone, type TimeDisplayOptions } from './document.ts';
import type { ExportDocument } from './types.ts';

/** 转义 Markdown 表格里的竖线与换行。 */
function tableCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
}

/** 正文的围栏块：围栏长度取正文里最长反引号串加一，最少三个。 */
function fenced(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** 角色标签。 */
function roleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'artifact') return '制品内容';
  return '工具阅读记录';
}

/** 附件清单表格。 */
function attachmentTable(attachments: readonly ExportAttachment[]): string[] {
  if (attachments.length === 0) return [];
  return [
    '## 附件清单',
    '',
    '| 文件名 | 状态 | 字节 |',
    '| --- | --- | --- |',
    ...attachments.map((attachment) => (
      `| ${tableCell(attachment.filename)} | ${attachmentStateLabel(attachment.state)} | ${attachment.size === undefined ? '—' : String(attachment.size)} |`
    )),
    '',
  ];
}

/**
 * 渲染 Markdown 导出。
 * @param document - 导出文档。
 * @param time - 时间显示方式。
 * @returns Markdown 文本。
 */
export function renderMarkdown(document: ExportDocument, time: TimeDisplayOptions): string {
  const lines: string[] = [`# ${document.title}`, ''];
  for (const fact of documentFacts(document, time)) {
    lines.push(`- **${fact.label}**：${fact.value}`);
  }
  lines.push('', '> 这是只读导出，内容取自权威会话日志的完整回合。', '');
  lines.push(...attachmentTable(document.attachments));

  let currentTurn: number | undefined;
  for (const entry of document.entries) {
    if (entry.turn !== currentTurn) {
      currentTurn = entry.turn;
      lines.push(`## 第 ${String(entry.turn)} 回合`, '');
    }
    lines.push(`### ${roleLabel(entry.role)} · ${formatTimeWithZone(entry.time, time)}`, '');
    lines.push(fenced(entry.text), '');
  }
  if (document.entries.length === 0) lines.push('这个范围里没有可导出的文本。', '');
  return `${lines.join('\n').trimEnd()}\n`;
}
