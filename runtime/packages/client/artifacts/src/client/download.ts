/**
 * 制品的下载与外部打开。
 *
 * 内容字节来自读取结果里的 base64，装成 `Blob` 后交给 `URL.createObjectURL`：下载用带
 * `download` 属性的链接，外部打开用带 `target` 的链接，浏览器自己完成保存与跳转，页面不
 * 拦截这次动作。文件名由标题、版本号与内容类型拼成，标题里的路径分隔符会被替换。
 * @module @chatdsh/client-artifacts/download
 */

import { decodeBase64, formatBytes } from './state.ts';
import type { ArtifactReadResult } from './types.ts';

/** 内容类型到文件后缀的映射；表里没有的类型不补后缀。 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/javascript': 'js',
  'text/xml': 'xml',
  'application/xhtml+xml': 'xhtml',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/javascript': 'js',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** 去掉媒体类型的参数并转小写。 */
function baseTypeOf(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLocaleLowerCase();
  return base === undefined || base === '' ? 'application/octet-stream' : base;
}

/**
 * 下载文件名。
 * @param title - 制品标题。
 * @param version - 版本号。
 * @param contentType - 内容类型。
 * @returns 形如 `报告-v2.html` 的文件名。
 */
export function filenameOf(title: string, version: number, contentType: string): string {
  const raw = title.trim() === '' ? 'artifact' : title.trim();
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_');
  const extension = EXTENSIONS[baseTypeOf(contentType)];
  if (extension === undefined) return `${safe}-v${String(version)}`;
  const lower = safe.toLocaleLowerCase();
  const stem = lower.endsWith(`.${extension}`) ? safe.slice(0, safe.length - extension.length - 1) : safe;
  return `${stem}-v${String(version)}.${extension}`;
}

/**
 * 读取结果的字节。
 * @param read - 一次读取的结果。
 * @returns 内容字节。
 */
export function bytesOf(read: ArtifactReadResult): Uint8Array<ArrayBuffer> {
  return decodeBase64(read.base64, '内容');
}

/**
 * 读取结果的 Blob。
 * @param read - 一次读取的结果。
 * @returns 带内容类型的 Blob。
 */
export function blobOf(read: ArtifactReadResult): Blob {
  return new Blob([bytesOf(read)], { type: read.contentType });
}

/**
 * 为一个 Blob 建立对象地址。调用方负责在卸载时撤销它。
 * @param blob - 内容。
 * @returns 对象地址。
 */
export function objectUrlOf(blob: Blob): string {
  return URL.createObjectURL(blob);
}

/**
 * 在一次点击里保存内容：造链接、点一下、稍后撤销对象地址。
 *
 * 撤销延后一秒，让浏览器有机会把字节读走；立即撤销会让部分浏览器中断正在开始的保存。
 * @param blob - 内容。
 * @param filename - 文件名。
 * @param documentFace - 页面文档；省略时取全局 `document`。
 */
export function saveBlob(blob: Blob, filename: string, documentFace: Document = document): void {
  const url = objectUrlOf(blob);
  const anchor = documentFace.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  documentFace.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

/**
 * 一次读取结果的保存说明：文件名与带字节数的结果文字。
 * @param read - 一次读取的结果。
 * @returns 文件名与结果文字。
 */
export function describeSave(read: ArtifactReadResult): { readonly filename: string; readonly note: string } {
  const filename = filenameOf(read.record.title, read.version.version, read.contentType);
  return { filename, note: `已保存 ${filename}（共 ${formatBytes(read.version.size)}）` };
}
