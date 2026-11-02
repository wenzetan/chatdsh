import { formatScore, formatTimestamp, MemoryFailure, type MemoryRecallHit } from './face.ts';
/**
 * 记忆检索结果的导出。
 *
 * 导出在页面内存里分块生成，按块让出事件循环，避免大结果集阻塞界面。内容只包含命中条目
 * 与读取时刻，不包含查询文本；格式与范围由界面选择。
 * @module @chatdsh/client-memory/export
 */

/** 导出格式。 */
export type ExportFormat = 'json' | 'markdown' | 'text';

/** 导出范围。 */
export type ExportScope = 'page' | 'query' | 'selected';

/** 格式对应的扩展名与媒体类型。 */
const FORMAT_META: Record<ExportFormat, { readonly extension: string; readonly mimeType: string }> = {
  json: { extension: 'json', mimeType: 'application/json' },
  markdown: { extension: 'md', mimeType: 'text/markdown' },
  text: { extension: 'txt', mimeType: 'text/plain' },
};

/** 一次导出的结果。 */
export interface ExportPayload {
  /** 建议的文件名。 */
  readonly fileName: string;
  /** 媒体类型。 */
  readonly mimeType: string;
  /** 文件内容。 */
  readonly text: string;
  /** 导出的条数。 */
  readonly count: number;
  /** 内容字节数。 */
  readonly bytes: number;
}

/** 导出输入。 */
export interface BuildExportInput {
  /** 已经按范围选出的命中条目。 */
  readonly hits: readonly MemoryRecallHit[];
  /** 导出格式。 */
  readonly format: ExportFormat;
  /** 范围的说明文字。 */
  readonly scopeLabel: string;
  /** 最近一次读取的时刻。 */
  readonly readAt: number;
}

/**
 * 让出一轮事件循环，保持界面可响应。
 * @returns 一轮宏任务之后继续。
 */
async function yieldToPage(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 取一条命中的来源文字。
 * @param hit - 命中条目。
 * @returns 来源标识或说明。
 */
function sourceOf(hit: MemoryRecallHit): string {
  return hit.source ?? '未提供';
}

/**
 * 生成 JSON 导出文本。
 * @param input - 导出输入。
 * @returns 导出文本。
 */
function jsonText(input: BuildExportInput): string {
  return JSON.stringify({
    format: 'chatdsh-memory-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    readAt: input.readAt,
    scope: input.scopeLabel,
    count: input.hits.length,
    entries: input.hits.map((hit) => ({
      bank: hit.bank,
      source: hit.source,
      score: hit.score,
      at: hit.at,
      text: hit.text,
    })),
  }, null, 2);
}

/**
 * 生成 Markdown 导出文本，按条目分块。
 * @param input - 导出输入。
 * @returns 导出文本。
 */
async function markdownText(input: BuildExportInput): Promise<string> {
  const parts: string[] = [
    '# 记忆导出',
    '',
    `- 导出时刻：${formatTimestamp(Date.now())}`,
    `- 读取时刻：${formatTimestamp(input.readAt)}`,
    `- 范围：${input.scopeLabel}`,
    `- 条数：${String(input.hits.length)}`,
    '',
  ];
  for (const [index, hit] of input.hits.entries()) {
    parts.push(
      `## 条目 ${String(index + 1)}`,
      '',
      `- bank：${hit.bank}`,
      `- 来源：${sourceOf(hit)}`,
      `- 相关性：${formatScore(hit.score)}`,
      `- 时间：${hit.at === undefined ? '未提供' : formatTimestamp(hit.at)}`,
      '',
      hit.text,
      '',
    );
    if ((index + 1) % 4 === 0) await yieldToPage();
  }
  return parts.join('\n');
}

/**
 * 生成纯文本导出。
 * @param input - 导出输入。
 * @returns 导出文本。
 */
async function plainText(input: BuildExportInput): Promise<string> {
  const parts: string[] = [
    `记忆导出（${input.scopeLabel}）`,
    `导出时刻：${formatTimestamp(Date.now())}`,
    `读取时刻：${formatTimestamp(input.readAt)}`,
    `条数：${String(input.hits.length)}`,
    '',
  ];
  for (const [index, hit] of input.hits.entries()) {
    parts.push(
      `---- 条目 ${String(index + 1)} ----`,
      `bank：${hit.bank}`,
      `来源：${sourceOf(hit)}`,
      `相关性：${formatScore(hit.score)}`,
      `时间：${hit.at === undefined ? '未提供' : formatTimestamp(hit.at)}`,
      hit.text,
      '',
    );
    if ((index + 1) % 4 === 0) await yieldToPage();
  }
  return parts.join('\n');
}

/**
 * 按范围与格式生成导出内容。
 * @param input - 导出输入。
 * @returns 文件内容与建议文件名。
 * @throws 没有可导出的条目时明确失败。
 */
export async function buildExport(input: BuildExportInput): Promise<ExportPayload> {
  if (input.hits.length === 0) throw new MemoryFailure('没有可导出的结果');
  const meta = FORMAT_META[input.format];
  const text = input.format === 'json'
    ? jsonText(input)
    : input.format === 'markdown'
      ? await markdownText(input)
      : await plainText(input);
  return {
    fileName: `chatdsh-memory-${String(Date.now())}.${meta.extension}`,
    mimeType: meta.mimeType,
    text,
    count: input.hits.length,
    bytes: new TextEncoder().encode(text).byteLength,
  };
}
