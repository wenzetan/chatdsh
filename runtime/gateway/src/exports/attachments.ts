/**
 * 导出附件的事实解析。
 *
 * 附件的下落按真实文件系统判定：数据根下 `attachments/<标识>/` 存在即可下载并取真实字节；
 * 不存在时再按会话归属设备判定，属于本机就按丢失处理，属于其他设备就按需要源设备处理。
 * 每种结论都带稳定的原因，导出界面逐项显示，不静默跳过丢失的附件。
 * @module @chatdsh/gateway/exports/attachments
 */

import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import { mimeTypeOf } from '../sharing/attachments.ts';
import { ExportError, type AttachmentContext, type AttachmentRef, type AttachmentResolver, type ResolvedAttachment } from './types.ts';

/** 单份附件的字节上限。 */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** 断言路径落在目录之内。 */
function containment(root: string, target: string): string {
  const base = resolve(root);
  const full = resolve(target);
  if (full !== base && !full.startsWith(`${base}${sep}`)) {
    throw new ExportError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-path', '附件路径越出数据目录');
  }
  return full;
}

/** 目录里的第一个常规文件名。 */
async function firstFileNameOf(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && !entry.isSymbolicLink()) return entry.name;
  }
  return undefined;
}

/** 按标记里的文件名或目录内容确定展示文件名。 */
async function filenameOf(ref: AttachmentRef, directory: string): Promise<string> {
  const listed = await firstFileNameOf(directory);
  if (listed !== undefined && (ref.filename === '' || listed === ref.filename)) return listed;
  if (ref.filename !== '') return ref.filename;
  if (listed !== undefined) return listed;
  throw new ExportError(CHATDSH_ERROR_CODES.attachmentMissing, 'attachment-empty', `附件 ${ref.id} 目录里没有文件`);
}

/**
 * 同机部署的附件解析：数据根下的 `attachments/<标识>/<文件名>`。
 * @param options - 数据根。
 * @returns 附件解析函数。
 */
export function createDirectoryAttachmentResolver(options: { readonly dataRoot: string }): AttachmentResolver {
  const dataRoot = resolve(options.dataRoot);
  return async (ref: AttachmentRef, context: AttachmentContext): Promise<ResolvedAttachment> => {
    const directory = containment(dataRoot, join(dataRoot, 'attachments', ref.id));
    const info = await lstat(directory).catch(() => undefined);
    const mimeType = ref.mimeType ?? mimeTypeOf(ref.filename);
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
      const state = context.ownerDeviceId === context.localDeviceId ? 'missing' : 'needs-source-device';
      return {
        id: ref.id,
        filename: ref.filename === '' ? `附件 ${ref.id}` : ref.filename,
        state,
        mimeType,
        ...(ref.size === undefined ? {} : { size: ref.size }),
      };
    }
    const filename = await filenameOf(ref, directory);
    const file = containment(directory, join(directory, filename));
    const fileInfo = await lstat(file);
    if (fileInfo.size > MAX_ATTACHMENT_BYTES) {
      throw new ExportError(CHATDSH_ERROR_CODES.exportTooLarge, 'attachment-too-large', `附件 ${ref.id} 超过单份上限`);
    }
    const bytes = new Uint8Array(await readFile(file));
    return { id: ref.id, filename, state: 'downloadable', mimeType, size: bytes.byteLength, bytes };
  };
}
