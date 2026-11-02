/**
 * 附件的准入规则与上下文表示。
 *
 * 大小与媒体类型的上限写在宿主，客户端从 `limits` 读取同一份数字，超限提示因此显示
 * 真实限制。附件在模型上下文里的表示由 `attachmentMarker` 生成，带稳定标识、文件名、
 * 媒体类型与字节数，模型据此引用同一份附件。
 * @module @chatdsh/host-attachments/rules
 */

import { ATTACHMENT_ERROR_CODES, AttachmentError } from './errors.ts';

/** 单个附件的字节上限：32 MiB。 */
export const ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

/** 单条消息的附件数量上限。 */
export const ATTACHMENT_MAX_PER_MESSAGE = 16;

/** 允许的媒体类型。 */
export const ALLOWED_ATTACHMENT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/** 文件名长度上限，字符数。 */
export const ATTACHMENT_MAX_FILENAME_LENGTH = 180;

/** 允许的媒体类型集合。 */
const ALLOWED = new Set<string>(ALLOWED_ATTACHMENT_TYPES);

/** 拒绝的名字片段：路径分隔符与控制字符由逐字符检查处理。 */
const FORBIDDEN_SEGMENTS = new Set(['.', '..']);

/**
 * 规范化媒体类型：去掉参数、转小写。
 * @param mimeType - 请求里的媒体类型。
 * @returns 规范化后的媒体类型。
 */
export function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * 校验文件名，不合格时就地抛出。
 * @param filename - 原始文件名。
 * @returns 可以写进存储路径的文件名。
 */
export function validFilename(filename: string): string {
  if (filename.trim() === '') throw new AttachmentError(ATTACHMENT_ERROR_CODES.nameInvalid, '附件文件名不能为空');
  if (filename.length > ATTACHMENT_MAX_FILENAME_LENGTH) {
    throw new AttachmentError(
      ATTACHMENT_ERROR_CODES.nameInvalid,
      `附件文件名超过 ${String(ATTACHMENT_MAX_FILENAME_LENGTH)} 个字符`,
    );
  }
  for (const character of filename) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '/' || character === '\\' || code < 0x20 || code === 0x7f) {
      throw new AttachmentError(ATTACHMENT_ERROR_CODES.nameInvalid, `附件文件名含有不允许的字符：${filename}`);
    }
  }
  if (FORBIDDEN_SEGMENTS.has(filename)) {
    throw new AttachmentError(ATTACHMENT_ERROR_CODES.nameInvalid, `附件文件名不能是 ${filename}`);
  }
  return filename;
}

/**
 * 把请求内容解成字节。
 * @param input - 字符串内容、字节内容与解释方式。
 * @returns 内容字节。
 */
export function contentBytes(input: {
  readonly content: string | Uint8Array;
  readonly encoding?: 'utf8' | 'base64';
}): Buffer {
  if (typeof input.content === 'string') {
    return Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8');
  }
  if (!(input.content instanceof Uint8Array)) {
    throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '附件内容必须是字符串或字节数组');
  }
  return Buffer.from(input.content);
}

/**
 * 校验大小，超出上限时就地抛出。
 * @param size - 字节数。
 */
export function assertSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '附件字节数必须是非负整数');
  }
  if (size === 0) throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '空文件不能作为附件');
  if (size > ATTACHMENT_MAX_BYTES) {
    throw new AttachmentError(
      ATTACHMENT_ERROR_CODES.tooLarge,
      `附件 ${String(size)} 字节超过上限 ${String(ATTACHMENT_MAX_BYTES)} 字节`,
    );
  }
}

/**
 * 校验媒体类型，不在允许范围内时就地抛出。
 * @param mimeType - 原始媒体类型。
 * @returns 规范化后的媒体类型。
 */
export function assertType(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === '') {
    throw new AttachmentError(ATTACHMENT_ERROR_CODES.requestInvalid, '附件需要媒体类型');
  }
  if (!ALLOWED.has(normalized)) {
    throw new AttachmentError(
      ATTACHMENT_ERROR_CODES.typeRejected,
      `${normalized} 不在允许的附件类型里：${ALLOWED_ATTACHMENT_TYPES.join('、')}`,
    );
  }
  return normalized;
}

/** 附件在模型上下文里的一项。 */
export interface AttachmentContextEntry {
  /** 附件标识。 */
  readonly attachmentId: string;
  /** 上下文里的标记文本。 */
  readonly marker: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

/**
 * 生成附件在上下文里的标记。
 * @param attachment - 附件的标识、文件名、媒体类型与字节数。
 * @returns 标记文本。
 */
export function attachmentMarker(attachment: {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}): string {
  return `[附件 ${attachment.id} ${attachment.filename} ${attachment.mimeType} ${String(attachment.size)} 字节]`;
}

/**
 * 把附件记录排成上下文表示。
 * @param attachments - 按发送顺序排列的附件。
 * @returns 逐项与整段文本。
 */
export function contextOf(
  attachments: readonly {
    readonly id: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
  }[],
): { readonly entries: AttachmentContextEntry[]; readonly text: string } {
  const entries = attachments.map((attachment) => ({
    attachmentId: attachment.id,
    marker: attachmentMarker(attachment),
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  }));
  return { entries, text: entries.map((entry) => entry.marker).join('\n') };
}

/** 部署上限，供客户端显示真实限制。 */
export interface AttachmentLimits {
  readonly maxBytes: number;
  readonly maxPerMessage: number;
  readonly allowedTypes: readonly string[];
  readonly maxFilenameLength: number;
}

/** 当前部署的附件上限。 */
export function attachmentLimits(): AttachmentLimits {
  return {
    maxBytes: ATTACHMENT_MAX_BYTES,
    maxPerMessage: ATTACHMENT_MAX_PER_MESSAGE,
    allowedTypes: [...ALLOWED_ATTACHMENT_TYPES],
    maxFilenameLength: ATTACHMENT_MAX_FILENAME_LENGTH,
  };
}
