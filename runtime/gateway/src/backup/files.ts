/**
 * 备份用到的文件系统操作。
 *
 * 目录按 0700 建立，文件按 0600 写入，JSON 先写同目录临时文件再原子改名；剩余空间取最近一个
 * 已存在祖先的文件系统读数，避免在尚未建立的恢复目录上猜路径。符号链接与特殊文件一律拒绝，
 * 备份与恢复都不跟随链接。
 * @module @chatdsh/gateway/backup/files
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';

/** 目录权限。 */
export const DIRECTORY_MODE = 0o700;

/** 文件权限。 */
export const FILE_MODE = 0o600;

/** 一次目录遍历得到的一个文件。 */
export interface TreeFile {
  /** 相对数据根的路径，统一用斜杠分隔。 */
  readonly relativePath: string;
  /** 绝对路径。 */
  readonly absolutePath: string;
  /** 字节数。 */
  readonly bytes: number;
  /** 修改时刻的毫秒时间戳。 */
  readonly mtimeMs: number;
}

/** 建立目录，权限 0700。 */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
}

/** 删除一个文件。 */
export function removeFile(path: string): void {
  unlinkSync(path);
}

/**
 * 建立一个临时路径，避免与既有文件重名。
 * @param directory - 临时文件所在目录。
 * @param prefix - 文件名前缀。
 * @returns 绝对路径。
 */
export function temporaryPath(directory: string, prefix: string): string {
  return join(directory, `${prefix}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
}

/**
 * 原子写入 JSON 文件。
 * @param path - 目标路径。
 * @param value - 要写入的内容。
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDirectory(dirname(path));
  const temporary = temporaryPath(dirname(path), '.chatdsh-json');
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = openSync(temporary, 'wx', FILE_MODE);
  try {
    const buffer = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

/**
 * 计算一个文件的 SHA-256。
 * @param path - 文件路径。
 * @returns 十六进制摘要与字节数。
 */
export async function digestFile(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * 递归列出目录下的普通文件。
 *
 * 目录本身不存在时返回空清单；符号链接、设备文件与其他特殊文件就地拒绝。
 * @param root - 数据域根目录。
 * @param exclude - 相对该根目录的排除路径。
 * @returns 文件清单，按相对路径升序。
 */
export function listTree(root: string, exclude: readonly string[] = []): readonly TreeFile[] {
  if (!existsSync(root)) return [];
  const info = lstatSync(root);
  if (info.isSymbolicLink()) {
    throw new BackupError(BACKUP_ERROR_CODES.sourceEntryUnsupported, `数据域根目录是符号链接：${root}`);
  }
  if (!info.isDirectory()) {
    throw new BackupError(BACKUP_ERROR_CODES.sourceEntryUnsupported, `数据域根目录不是目录：${root}`);
  }
  const skip = new Set(exclude);
  const files: TreeFile[] = [];
  walk(root, '', skip, files);
  return files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
}

/** 逐层遍历一个目录。 */
function walk(root: string, prefix: string, exclude: ReadonlySet<string>, out: TreeFile[]): void {
  const directory = prefix === '' ? root : join(root, prefix);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (exclude.has(relativePath)) continue;
    const absolutePath = join(root, relativePath);
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink()) {
      throw new BackupError(BACKUP_ERROR_CODES.sourceEntryUnsupported, `数据域里存在符号链接，备份不跟随链接`, {
        path: relativePath,
      });
    }
    if (info.isDirectory()) {
      walk(root, relativePath, exclude, out);
      continue;
    }
    if (!info.isFile()) {
      throw new BackupError(BACKUP_ERROR_CODES.sourceEntryUnsupported, `数据域里存在特殊文件，无法取得稳定内容`, {
        path: relativePath,
      });
    }
    out.push({ relativePath, absolutePath, bytes: info.size, mtimeMs: info.mtimeMs });
  }
}

/**
 * 取路径所在文件系统的剩余字节数。
 * @param path - 目标路径；不存在时取最近一个已存在祖先。
 * @returns 剩余字节数。
 */
export function freeBytesOf(path: string): number {
  const existing = existingAncestor(path);
  const stats = statfsSync(existing);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * 核对剩余空间满足要求。
 * @param path - 目标路径。
 * @param requiredBytes - 需要的字节数。
 * @returns 核对时刻的剩余字节数。
 */
export function assertFreeBytes(path: string, requiredBytes: number): number {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
    throw new Error(`剩余空间要求必须是非负整数，实际 ${String(requiredBytes)}`);
  }
  const freeBytes = freeBytesOf(path);
  if (freeBytes < requiredBytes) {
    throw new BackupError(
      BACKUP_ERROR_CODES.diskSpaceInsufficient,
      `剩余空间不足：剩余 ${freeBytes} 字节，至少需要 ${requiredBytes} 字节`,
      { freeBytes, requiredBytes },
      ['释放磁盘空间或把备份与恢复目录换到更大容量的文件系统后重新执行'],
    );
  }
  return freeBytes;
}

/**
 * 断言目录为空或不存在。
 * @param path - 目录路径。
 * @returns 目录是否存在。
 */
export function directoryEmptyOrAbsent(path: string): boolean {
  if (!existsSync(path)) return true;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new BackupError(BACKUP_ERROR_CODES.restoreTargetExists, `恢复目标已存在且不是目录：${path}`);
  }
  return readdirSync(path).length === 0;
}

/**
 * 断言目标路径位于给定根之下，避免相对路径穿越。
 * @param root - 根目录。
 * @param relativePath - 相对路径。
 * @returns 绝对路径。
 */
export function containedPath(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const relativeToRoot = relative(resolve(root), absolute);
  if (relativeToRoot === '' || relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || relativeToRoot.startsWith(sep)) {
    throw new BackupError(BACKUP_ERROR_CODES.manifestCorrupt, '清单里的对象路径越出恢复根', { path: relativePath });
  }
  return absolute;
}

/** 取最近一个已存在的祖先路径。 */
function existingAncestor(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`没有任何已存在的祖先目录：${path}`);
    current = parent;
  }
  return current;
}
