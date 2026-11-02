/**
 * 导出文档的组装与共性文本。
 *
 * 文档把来源、范围、条目、附件与排除项汇成一份可渲染的事实集合；时间显示方式与时区在这里
 * 固定下来，四种格式共用同一份事实。范围一律是完整回合，附件状态逐项保留。
 * @module @chatdsh/gateway/exports/document
 */

import type {
  ContentScope,
  ExportAttachment,
  ExportEstimate,
  ExportScope,
  ExportSource,
} from '@chatdsh/core-contracts';
import type { CollectedContent } from './collect.ts';
import type { RedactionMode } from './redact.ts';
import type { ExportDocument, ResolvedAttachment } from './types.ts';

/** 时间显示选项。 */
export interface TimeDisplayOptions {
  /** 时间显示方式。 */
  readonly timeDisplay: 'local' | 'utc';
  /** 时区名，`utc` 时忽略。 */
  readonly timeZone: string;
}

/**
 * 按所选方式显示一个时刻。
 * @param time - 毫秒时间戳。
 * @param options - 时间显示方式与时区。
 * @returns 可用作文本与文件名的时刻字符串。
 */
export function formatTime(time: number, options: TimeDisplayOptions): string {
  const date = new Date(time);
  if (options.timeDisplay === 'utc') return date.toISOString();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: options.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

/** 时刻字符串附带时区名。 */
export function formatTimeWithZone(time: number, options: TimeDisplayOptions): string {
  if (options.timeDisplay === 'utc') return formatTime(time, options);
  return `${formatTime(time, options)}（${options.timeZone}）`;
}

/**
 * 回合范围的展示文字。
 * @param turns - 覆盖的回合编号。
 * @returns 连续与不连续两种写法。
 */
export function formatRangeLabel(turns: readonly number[]): string {
  const first = turns[0];
  const last = turns[turns.length - 1];
  if (first === undefined || last === undefined) return '回合范围为空';
  const contiguous = turns.every((turn, index) => index === 0 || turn === (turns[index - 1] ?? 0) + 1);
  return contiguous ? `回合 ${String(first)}–${String(last)}` : `回合 ${turns.map((turn) => String(turn)).join('、')}`;
}

/** 时刻的紧凑写法，用在文件名里。 */
function fileStampOf(time: number, options: TimeDisplayOptions): string {
  return formatTime(time, options).replaceAll(/[^0-9]/gu, '').slice(0, 14);
}

/** 导出文件名。 */
export function exportFilenameOf(exportScope: ExportScope, generatedAt: number, options: TimeDisplayOptions): string {
  const stamp = fileStampOf(generatedAt, options);
  const source = exportScope.source.kind === 'session'
    ? `会话-${exportScope.source.sessionId}`
    : `制品-${exportScope.source.artifactId}-v${String(exportScope.source.version)}`;
  const extension = exportScope.format === 'markdown'
    ? 'md'
    : exportScope.format === 'jsonl'
      ? 'jsonl'
      : exportScope.format === 'html'
        ? 'html'
        : 'pdf';
  return `${source}-${stamp}.${extension}`;
}

/** 导出文件的内容类型。 */
export function exportContentTypeOf(format: ExportScope['format']): string {
  if (format === 'markdown') return 'text/markdown; charset=utf-8';
  if (format === 'jsonl') return 'application/jsonl; charset=utf-8';
  if (format === 'html') return 'text/html; charset=utf-8';
  return 'application/pdf';
}

/** 组装文档的输入。 */
export interface DocumentInput {
  readonly exportScope: ExportScope;
  readonly title: string;
  readonly generatedAt: number;
  readonly content: CollectedContent;
  readonly attachments: readonly ResolvedAttachment[];
  readonly time: TimeDisplayOptions;
}

/** 组装导出文档。 */
export function buildDocument(input: DocumentInput): ExportDocument {
  const missing = input.attachments.filter((attachment) => attachment.state !== 'downloadable');
  const scope: ContentScope = {
    ...input.content.scope,
    attachmentsComplete: missing.length === 0,
  };
  const attachments: ExportAttachment[] = input.attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    state: attachment.state,
    ...(attachment.size === undefined ? {} : { size: attachment.size }),
  }));
  const attachmentFiles = input.attachments
    .filter((attachment): attachment is ResolvedAttachment & { bytes: Uint8Array } => attachment.bytes !== undefined)
    .map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
    }));
  return {
    title: input.title,
    source: input.exportScope.source,
    generatedAt: input.generatedAt,
    scope,
    turns: input.content.turns,
    entries: input.content.entries,
    attachments,
    attachmentFiles,
    excluded: input.content.excluded,
    redactions: input.content.redactions,
    timeDisplay: input.time.timeDisplay,
    timeZone: input.time.timeZone,
    includeToolReads: input.exportScope.includeToolReads,
    strict: (input.exportScope.redaction as RedactionMode) === 'strict',
    privateRecord: input.exportScope.format === 'jsonl',
  };
}

/**
 * 预估导出的体积与附件。
 * @param content - 收集结果。
 * @param attachments - 附件解析结论。
 * @returns 预估。
 */
export function estimateOf(
  content: CollectedContent,
  attachments: readonly ResolvedAttachment[],
): ExportEstimate {
  const attachmentBytes = attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0);
  // 中文按 UTF-8 三字节估算，换行与标记留出余量。
  const bytes = content.scope.charCount * 3 + content.entries.length * 8 + attachmentBytes;
  return {
    eventCount: content.scope.eventCount,
    charCount: content.scope.charCount,
    bytes,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      state: attachment.state,
      ...(attachment.size === undefined ? {} : { size: attachment.size }),
    })),
  };
}

/** 一条说明事实。 */
export interface DocumentFact {
  readonly label: string;
  readonly value: string;
}

/** 排除项的中文说法。 */
const EXCLUSION_LABELS: Readonly<Record<string, string>> = {
  credentials: '凭据',
  'memory-recall': '记忆召回',
  'internal-paths': '内部路径',
  'replica-watermark': '副本水位',
  contacts: '联系方式',
  'internal-addresses': '内网地址',
  'tool-records': '工具记录',
};

/** 脱敏类别的中文说法。 */
const REDACTION_LABELS: Readonly<Record<string, string>> = {
  credentials: '凭据',
  'internal-paths': '内部路径',
  contacts: '联系方式',
  'internal-addresses': '内网地址',
};

/** 把类别名翻成中文，未登记的取值原样保留。 */
function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return labels[value] ?? value;
}

/**
 * 导出的说明事实：来源、范围、时间、工具记录、脱敏、排除项与附件计数。
 * @param document - 导出文档。
 * @param time - 时间显示方式。
 * @returns 逐条事实，四种格式共用。
 */
export function documentFacts(document: ExportDocument, time: TimeDisplayOptions): DocumentFact[] {
  const downloadable = document.attachments.filter((attachment) => attachment.state === 'downloadable').length;
  const missing = document.attachments.filter((attachment) => attachment.state === 'missing').length;
  const remote = document.attachments.filter((attachment) => attachment.state === 'needs-source-device').length;
  const facts: DocumentFact[] = [
    { label: '来源', value: sourceLabelOf(document.source) },
    {
      label: '内容范围',
      value: `${formatRangeLabel(document.turns)}（完整回合，${String(document.scope.eventCount)} 个事件，${String(document.scope.charCount)} 字符）`,
    },
    { label: '导出时间', value: formatTimeWithZone(document.generatedAt, time) },
    { label: '工具阅读记录', value: document.includeToolReads ? '包含' : '不包含（工具输出按摘要处理）' },
    {
      label: '脱敏',
      value: `${document.strict ? '严格' : '默认'}（${(document.strict ? ['credentials', 'internal-paths', 'contacts', 'internal-addresses'] : ['credentials', 'internal-paths']).map((item) => labelOf(REDACTION_LABELS, item)).join('、')}）；命中 ${String(document.redactions.paths)} 处路径、${String(document.redactions.credentials)} 处凭据`,
    },
    {
      label: '排除内容',
      value: document.excluded.map((item) => labelOf(EXCLUSION_LABELS, item)).join('、'),
    },
  ];
  if (document.attachments.length > 0) {
    facts.push({
      label: '附件',
      value: `共 ${String(document.attachments.length)} 项：可下载 ${String(downloadable)}，缺失 ${String(missing)}，需要源设备 ${String(remote)}`,
    });
  }
  if (document.privateRecord) {
    facts.push({ label: '记录范围', value: '完整业务记录（含逐条事件文本）' });
  }
  return facts;
}

/** 来源说明文字。 */
export function sourceLabelOf(source: ExportSource): string {
  return source.kind === 'session'
    ? `会话 ${source.sessionId}`
    : `制品 ${source.artifactId} 第 ${String(source.version)} 版`;
}
