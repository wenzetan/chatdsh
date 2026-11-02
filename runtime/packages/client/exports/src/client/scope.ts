/**
 * 导出范围的构造与校验。
 *
 * 范围按完整回合表达：起止回合都是正整数，结束不小于起始；请求摘要由范围内容按固定字段顺序
 * 序列化之后取 SHA-256，同一操作标识配同一摘要才是同一次操作。格式与权限在这里就判定，界面
 * 因此不会把不可选的格式提交出去。
 * @module @chatdsh/client-exports/scope
 */

import { formatsFor, isFormatAvailable } from './format.ts';
import type {
  AttachmentPolicy,
  ContentScope,
  ExportFormat,
  ExportScopeView,
  ExportSelection,
  ExportSource,
} from './types.ts';
import { ATTACHMENT_POLICIES, EXPORT_FORMATS } from './types.ts';

/** 范围构造时的失败。 */
export class ExportSelectionError extends Error {
  /**
   * @param reason - 具体条件的稳定取值。
   * @param message - 面向使用者的说明。
   */
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'ExportSelectionError';
  }
}

/** 界面输入的原始字段。 */
export interface SelectionInput {
  readonly source: ExportSource;
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly format: ExportFormat;
  readonly includeToolReads: boolean;
  readonly attachmentPolicy: AttachmentPolicy;
  readonly timeDisplay: 'local' | 'utc';
  readonly redaction: 'default' | 'strict';
  readonly privateExport: boolean;
}

/** 校验回合编号。 */
function positiveTurn(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ExportSelectionError('turn-invalid', `${what}必须是正整数`);
  }
  return value;
}

/**
 * 构造并校验一次导出选择。
 * @param input - 界面输入。
 * @returns 校验过的选择。
 */
export function selectionOf(input: SelectionInput): ExportSelection {
  const turnFrom = positiveTurn(input.turnFrom, '起始回合');
  const turnTo = positiveTurn(input.turnTo, '结束回合');
  if (turnTo < turnFrom) {
    throw new ExportSelectionError('range-order', '结束回合必须不小于起始回合');
  }
  if (!(EXPORT_FORMATS as readonly string[]).includes(input.format)) {
    throw new ExportSelectionError('format-unknown', '导出格式不在登记范围内');
  }
  if (!(ATTACHMENT_POLICIES as readonly string[]).includes(input.attachmentPolicy)) {
    throw new ExportSelectionError('attachment-policy', '附件处理方式不在登记范围内');
  }
  if (!isFormatAvailable(input.format, input.source, input.privateExport)) {
    throw new ExportSelectionError(
      input.format === 'jsonl' ? 'private-export-required' : 'format-unsupported',
      input.format === 'jsonl'
        ? '原始 JSONL 导出需要私有导出权限'
        : '当前来源不支持这个格式',
    );
  }
  return {
    source: input.source,
    turnFrom,
    turnTo,
    format: input.format,
    includeToolReads: input.includeToolReads,
    attachmentPolicy: input.attachmentPolicy,
    timeDisplay: input.timeDisplay,
    redaction: input.redaction,
    privateExport: input.privateExport,
  };
}

/**
 * 把选择与预估拼成提交给控制平面的范围。
 *
 * 事件条数与字符数取自预估，附件完整性取逐项结论；控制平面会用自己的权威读数重算一遍，
 * 提交值只用于界面展示与请求摘要。
 * @param selection - 校验过的选择。
 * @param estimate - 预估。
 * @returns 导出的内容范围。
 */
export function scopeOf(
  selection: ExportSelection,
  estimate: { readonly eventCount: number; readonly charCount: number; readonly attachments: readonly { readonly state: string }[] },
): ExportScopeView {
  const contentScope: ContentScope = {
    turnFrom: selection.turnFrom,
    turnTo: selection.turnTo,
    eventCount: estimate.eventCount,
    charCount: estimate.charCount,
    compressed: !selection.includeToolReads,
    attachmentsComplete: estimate.attachments.every((attachment) => attachment.state === 'downloadable'),
  };
  return {
    source: selection.source,
    scope: contentScope,
    format: selection.format,
    includeToolReads: selection.includeToolReads,
    attachmentPolicy: selection.attachmentPolicy,
    timeDisplay: selection.timeDisplay,
    redaction: selection.redaction,
    privateExport: selection.privateExport,
  };
}

/** 固定的字段顺序，保证同一范围总是同一个摘要。 */
function canonical(scope: ExportScopeView): string {
  const source = scope.source;
  return [
    source.kind === 'session' ? `session:${source.sessionId}` : `artifact:${source.artifactId}@${String(source.version)}`,
    `${String(scope.scope.turnFrom)}-${String(scope.scope.turnTo)}`,
    scope.format,
    scope.includeToolReads ? 'tools' : 'no-tools',
    scope.attachmentPolicy,
    scope.timeDisplay,
    scope.redaction,
    scope.privateExport ? 'private' : 'reading',
  ].join('|');
}

/**
 * 计算请求摘要。
 * @param scope - 导出的内容范围。
 * @returns 64 位小写十六进制摘要。
 */
export async function requestDigestOf(scope: ExportScopeView): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(scope));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成一个操作标识。
 * @returns 32 位小写十六进制标识。
 */
export function newOperationId(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '');
}

/** 可选格式的展示清单。 */
export interface FormatChoice {
  readonly format: ExportFormat;
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * 列出当前来源的格式选择。
 * @param source - 导出源。
 * @param privateExport - 是否具备私有导出权限。
 * @returns 每个格式的可用性与不可用原因。
 */
export function formatChoices(source: ExportSource, privateExport: boolean): FormatChoice[] {
  const available = new Set(formatsFor(source, privateExport));
  return EXPORT_FORMATS.map((format) => (
    available.has(format)
      ? { format, available: true }
      : {
        format,
        available: false,
        reason: format === 'jsonl' ? '需要私有导出权限' : '当前来源不支持这个格式',
      }
  ));
}
