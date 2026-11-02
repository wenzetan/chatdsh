/**
 * JSONL 导出的渲染。
 *
 * 每行一个独立对象，第一行是文件头，随后逐条事件、逐条附件，最后一行是结尾计数。行内不
 * 出现换行（字符串由 `JSON.stringify` 转义），任何一行都能被标准 JSON 解析器单独读出。
 * 文件头带范围与排除项，不带事件序号与副本水位。
 * @module @chatdsh/gateway/exports/jsonl
 */

import type { ExportDocument } from './types.ts';

/** 一行 JSON。 */
function line(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * 渲染 JSONL 导出。
 * @param document - 导出文档。
 * @returns 以换行分隔的 JSON 对象。
 */
export function renderJsonl(document: ExportDocument): string {
  const lines: string[] = [];
  lines.push(line({
    type: 'export.header',
    version: 1,
    format: 'jsonl',
    title: document.title,
    source: document.source,
    generatedAt: document.generatedAt,
    scope: document.scope,
    turns: document.turns,
    includeToolReads: document.includeToolReads,
    redaction: document.strict ? 'strict' : 'default',
    excluded: document.excluded,
    attachments: document.attachments,
    privateRecord: document.privateRecord,
  }));
  for (const entry of document.entries) {
    lines.push(line({
      type: 'export.event',
      turn: entry.turn,
      role: entry.role,
      kind: entry.kind,
      time: entry.time,
      chars: [...entry.text].length,
      text: entry.text,
    }));
  }
  for (const attachment of document.attachments) {
    lines.push(line({
      type: 'export.attachment',
      id: attachment.id,
      filename: attachment.filename,
      state: attachment.state,
      ...(attachment.size === undefined ? {} : { size: attachment.size }),
    }));
  }
  lines.push(line({
    type: 'export.end',
    events: document.entries.length,
    attachments: document.attachments.length,
    chars: document.scope.charCount,
  }));
  return `${lines.join('\n')}\n`;
}
