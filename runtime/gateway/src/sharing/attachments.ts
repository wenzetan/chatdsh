/**
 * 附件来源与分享包里的附件副本。
 *
 * 分享包自包含：建立分享时把逐项授权的附件字节复制进分享包目录，访问公开页时只读这份
 * 副本，源会话或源设备之后的变化不影响链接。未授权的附件不复制，公开页里既不出现也
 * 无法按路径猜测下载。
 * @module @chatdsh/gateway/sharing/attachments
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import { ShareError, type ShareAttachmentSource, type SourceAttachment } from './types.ts';

/** 附件标识允许的字符集，与附件宿主的 UUID 形式一致。 */
export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 分享令牌允许的字符集。 */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** 单份附件的字节上限，超过时拒绝建立分享。 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** 文件名长度上限。 */
const MAX_FILENAME_LENGTH = 255;

/** 常见媒体类型；未登记的扩展名按二进制处理。 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** 按扩展名给出媒体类型。 */
export function mimeTypeOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return 'application/octet-stream';
  return MIME_TYPES[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** 内容字节的 sha256。 */
export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 断言路径落在目录之内。 */
function containment(root: string, target: string): string {
  const base = resolve(root);
  const full = resolve(target);
  if (full !== base && !full.startsWith(`${base}${sep}`)) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-path', '附件路径越出数据目录');
  }
  return full;
}

/**
 * 同机部署的附件来源：按附件标识读取产品数据目录里的 `attachments/<id>/<文件名>`。
 * @param options - 附件内容根目录。
 * @returns 附件来源。
 */
export function createDirectoryAttachmentSource(options: { readonly root: string }): ShareAttachmentSource {
  const root = resolve(options.root);
  return {
    async read(attachmentId: string): Promise<SourceAttachment> {
      if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-id', '附件标识不合法');
      }
      const directory = containment(root, join(root, attachmentId));
      const directoryInfo = await lstat(directory).catch(() => undefined);
      if (directoryInfo === undefined || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new ShareError(CHATDSH_ERROR_CODES.attachmentMissing, 'attachment-missing', `附件 ${attachmentId} 不在源设备上`);
      }
      const entries = await readdir(directory, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile());
      if (files.length === 0) {
        throw new ShareError(CHATDSH_ERROR_CODES.attachmentMissing, 'attachment-empty', `附件 ${attachmentId} 没有内容文件`);
      }
      if (files.length > 1) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-ambiguous', `附件 ${attachmentId} 的内容文件不唯一`);
      }
      const entry = files[0];
      if (entry === undefined) {
        throw new ShareError(CHATDSH_ERROR_CODES.attachmentMissing, 'attachment-empty', `附件 ${attachmentId} 没有内容文件`);
      }
      const filename = entry.name;
      if (filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) {
        throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-filename', '附件文件名长度不合法');
      }
      const bytes = await readFile(containment(directory, join(directory, filename)));
      if (bytes.byteLength > MAX_SOURCE_BYTES) {
        throw new ShareError(CHATDSH_ERROR_CODES.payloadTooLarge, 'attachment-too-large', `附件超过 ${String(MAX_SOURCE_BYTES)} 字节`);
      }
      return {
        filename,
        mimeType: mimeTypeOf(filename),
        size: bytes.byteLength,
        digest: digestOf(bytes),
        bytes,
      };
    },
  };
}

/**
 * 把附件字节写进分享包。
 * @param options - 分享包根目录、令牌与附件标识。
 * @returns 分享包内的相对路径。
 */
export async function writeShareAttachment(options: {
  readonly root: string;
  readonly token: string;
  readonly attachmentId: string;
  readonly bytes: Uint8Array;
}): Promise<string> {
  if (!SHARE_TOKEN_PATTERN.test(options.token)) {
    throw new ShareError(CHATDSH_ERROR_CODES.internalError, 'share-token', '分享令牌形式不合法');
  }
  if (!ATTACHMENT_ID_PATTERN.test(options.attachmentId)) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-id', '附件标识不合法');
  }
  const storageKey = `${options.token}/attachments/${options.attachmentId}`;
  const absolute = containment(options.root, join(options.root, storageKey));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, options.bytes, { flag: 'wx' });
  return storageKey;
}

/**
 * 读分享包里的附件副本。
 * @param options - 分享包根目录与相对路径。
 * @returns 内容字节。
 */
export async function readShareAttachment(options: {
  readonly root: string;
  readonly storageKey: string;
}): Promise<Uint8Array> {
  const absolute = containment(options.root, join(options.root, options.storageKey));
  const bytes = await readFile(absolute).catch(() => undefined);
  if (bytes === undefined) {
    throw new ShareError(CHATDSH_ERROR_CODES.attachmentMissing, 'package-missing', '分享包里的附件副本已缺失');
  }
  return bytes;
}

/**
 * 删除一个未完成的分享包。建立失败时清理已经写入的副本。
 * @param options - 分享包根目录与令牌。
 */
export async function removeSharePackage(options: { readonly root: string; readonly token: string }): Promise<void> {
  if (!SHARE_TOKEN_PATTERN.test(options.token)) return;
  const directory = containment(options.root, join(options.root, options.token));
  await rm(directory, { recursive: true, force: true });
}
