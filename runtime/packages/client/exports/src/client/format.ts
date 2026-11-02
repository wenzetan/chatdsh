/**
 * 格式能力与体积文案。
 *
 * 格式能力来自当前来源：会话可以导出四种格式，原始 JSONL 只在具备私有导出权限时提供；
 * 制品只提供 Markdown、HTML 与 PDF。体积、条数与时间都给出可直接读的中文文案，界面不
 * 把这些数字当成原始数字展示。
 * @module @chatdsh/client-exports/format
 */

import type { ExportFormat, ExportJobView, ExportSource } from './types.ts';

/** 格式的中文名。 */
export const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  markdown: 'Markdown',
  jsonl: '原始 JSONL',
  html: 'HTML',
  pdf: 'PDF',
};

/** 需要私有导出权限的格式。 */
export const PRIVATE_FORMATS: readonly ExportFormat[] = ['jsonl'];

/** 格式的说明文字。 */
export const FORMAT_HINTS: Readonly<Record<ExportFormat, string>> = {
  markdown: '带标题、范围说明与逐条正文的纯文本，适合再编辑。',
  jsonl: '每行一个 JSON 对象，含完整业务记录，只在具备私有导出权限时提供。',
  html: '自包含静态页，没有脚本；浏览器直接打开即可阅读与打印。',
  pdf: '按打印样式分页输出，中文可选择与复制。',
};

/**
 * 当前来源与权限下可选的格式。
 * @param source - 导出源。
 * @param privateExport - 是否具备私有导出权限。
 * @returns 可选格式，按展示顺序。
 */
export function formatsFor(source: ExportSource, privateExport: boolean): ExportFormat[] {
  if (source.kind === 'artifact') return ['markdown', 'html', 'pdf'];
  return privateExport ? ['markdown', 'jsonl', 'html', 'pdf'] : ['markdown', 'html', 'pdf'];
}

/**
 * 判定一种格式在当前来源与权限下是否可选。
 * @param format - 格式。
 * @param source - 导出源。
 * @param privateExport - 是否具备私有导出权限。
 * @returns 可选时为真。
 */
export function isFormatAvailable(format: ExportFormat, source: ExportSource, privateExport: boolean): boolean {
  return formatsFor(source, privateExport).includes(format);
}

/** 字节数文案。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('字节数需要非负有限数值');
  if (bytes < 1024) return `${String(Math.round(bytes))} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 条数与字数文案。 */
export function formatVolume(eventCount: number, charCount: number): string {
  return `${String(eventCount)} 个事件，${String(charCount)} 字符`;
}

/** 预估文案。 */
export function formatEstimate(estimate: { readonly eventCount: number; readonly charCount: number; readonly bytes: number }): string {
  return `预计 ${formatBytes(estimate.bytes)}（${formatVolume(estimate.eventCount, estimate.charCount)}）`;
}

/** 下载文件名的建议写法：来源加格式与时间。 */
export function suggestedFilename(source: ExportSource, format: ExportFormat, stamp: string): string {
  const head = source.kind === 'session' ? `会话-${source.sessionId}` : `制品-${source.artifactId}-v${String(source.version)}`;
  const extension = format === 'markdown' ? 'md' : format === 'jsonl' ? 'jsonl' : format === 'html' ? 'html' : 'pdf';
  return `${head}-${stamp}.${extension}`;
}

/** 下载失效的剩余时间文案。 */
export function describeExpiry(job: ExportJobView, now: number): string {
  if (job.expiresAt === undefined) return '下载在有效期内可用。';
  const remaining = job.expiresAt - now;
  if (remaining <= 0) return '下载地址已失效，请重新生成。';
  const minutes = Math.ceil(remaining / 60_000);
  return minutes < 60
    ? `下载地址在 ${String(minutes)} 分钟内有效。`
    : `下载地址在 ${String(Math.ceil(minutes / 60))} 小时内有效。`;
}
