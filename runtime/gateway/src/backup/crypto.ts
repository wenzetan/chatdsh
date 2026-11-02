/**
 * 备份对象的加密与密钥读取。
 *
 * 备份对象一律以 AES-256-GCM 按流加密，随机 12 字节 nonce 写入清单，认证标签附在密文末尾；
 * 附加认证数据绑定备份格式版本、数据域与相对路径，跨对象或跨备份挪用密文都会认证失败。
 * 对象密钥由部署主密钥经 HKDF-SHA256 派生，主密钥本身不进入备份，恢复时由操作者单独提供。
 * 明文摘要与字节数在加密过程中同时计算，解密时逐字节复核。
 * @module @chatdsh/gateway/backup/crypto
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, fsyncSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';

/** 主密钥长度，单位字节。 */
export const BACKUP_KEY_BYTES = 32;

/** 密钥派生的用途标签。 */
const BACKUP_KEY_INFO = 'chatdsh/backup/object/v1';

/** 密钥校验向量的附加认证数据。 */
const KEY_CHECK_AAD = 'chatdsh/backup/keycheck/v1';

/** 认证标签长度。 */
const TAG_BYTES = 16;

/** nonce 长度。 */
const NONCE_BYTES = 12;

/** 一段加密对象。 */
export interface SealedObject {
  /** base64url 写法的 nonce。 */
  readonly nonce: string;
  /** 明文字节数。 */
  readonly bytes: number;
  /** 密文与认证标签的总字节数。 */
  readonly cipherBytes: number;
  /** 明文的 SHA-256 十六进制摘要。 */
  readonly sha256: string;
}

/** 密钥校验向量。 */
export interface KeyCheck {
  /** base64url 写法的 nonce。 */
  readonly nonce: string;
  /** 密文与认证标签。 */
  readonly ciphertext: string;
}

/**
 * 由部署主密钥派生备份对象密钥。
 * @param masterKey - 32 字节部署主密钥。
 * @returns 32 字节对象密钥。
 */
export function deriveBackupKey(masterKey: Buffer): Buffer {
  if (masterKey.length !== BACKUP_KEY_BYTES) {
    throw new BackupError(BACKUP_ERROR_CODES.keyUndecryptable, `部署主密钥长度必须为 ${BACKUP_KEY_BYTES} 字节`, {
      bytes: masterKey.length,
    });
  }
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), BACKUP_KEY_INFO, BACKUP_KEY_BYTES));
}

/**
 * 主密钥的密钥标识，写入清单用于核对密钥是否一致。
 * @param masterKey - 32 字节部署主密钥。
 * @returns 16 位十六进制标识。
 */
export function backupKeyIdOf(masterKey: Buffer): string {
  return createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

/**
 * 读取部署主密钥文件。
 *
 * 文件必须存在、是普通文件、权限恰为 0600、长度为 32 字节；任何不符就地拒绝，缺失时给出
 * 重新配置条件。这里不创建密钥文件，恢复过程不得悄悄生成新密钥。
 * @param path - 主密钥文件路径。
 * @returns 主密钥内容。
 */
export function readBackupKeyFile(path: string): Buffer {
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new BackupError(BACKUP_ERROR_CODES.keyMissing, `备份密钥文件不存在：${path}`, { errno }, [
      '把原部署的主密钥文件放回该路径（32 字节，权限 0600）后重新执行',
      '原主密钥已经丢失时只能以新密钥恢复，并重新配对全部设备、重新确认推送订阅、重新配置一次性密码与恢复码',
    ]);
  }
  if (!info.isFile()) {
    throw new BackupError(BACKUP_ERROR_CODES.keyMissing, `备份密钥不是普通文件：${path}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new BackupError(BACKUP_ERROR_CODES.keyUndecryptable, `备份密钥文件权限必须为 0600：${path}`, {
      mode: info.mode & 0o777,
    }, ['把主密钥文件权限改为 0600 后重新执行']);
  }
  if (info.size !== BACKUP_KEY_BYTES) {
    throw new BackupError(BACKUP_ERROR_CODES.keyUndecryptable, `备份密钥长度必须为 ${BACKUP_KEY_BYTES} 字节：${path}`, {
      bytes: info.size,
    }, ['提供长度恰为 32 字节的主密钥文件后重新执行']);
  }
  const descriptor = openSync(path, 'r');
  try {
    const key = Buffer.alloc(BACKUP_KEY_BYTES);
    const read = readSync(descriptor, key, 0, BACKUP_KEY_BYTES, 0);
    if (read !== BACKUP_KEY_BYTES) {
      throw new BackupError(BACKUP_ERROR_CODES.keyUndecryptable, `备份密钥读取不完整：${path}`, { bytes: read });
    }
    return key;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * 组出备份对象的附加认证数据。
 * @param formatVersion - 备份格式版本。
 * @param domain - 数据域。
 * @param relativePath - 恢复后的相对路径。
 * @returns 附加认证数据。
 */
export function objectAad(formatVersion: number, domain: string, relativePath: string): Buffer {
  return Buffer.from(`chatdsh/backup/object/v${String(formatVersion)}/${domain}/${relativePath}`, 'utf8');
}

/**
 * 加密一个文件到备份目录。
 * @param options - 源路径、目标路径、对象密钥与附加认证数据。
 * @returns 密文长度、明文长度、明文摘要与 nonce。
 */
export function sealObject(options: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly key: Buffer;
  readonly aad: Buffer;
}): Promise<SealedObject> {
  const nonce = randomBytes(NONCE_BYTES);
  const hash = createHash('sha256');
  const cipher = createCipheriv('aes-256-gcm', options.key, nonce);
  cipher.setAAD(options.aad);
  let bytes = 0;
  let cipherBytes = 0;
  const descriptor = openSync(options.targetPath, 'wx', 0o600);
  return (async () => {
    try {
      const source = createReadStream(options.sourcePath, { highWaterMark: 1 << 20 });
      for await (const chunk of source) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        bytes += buffer.length;
        const sealed = cipher.update(buffer);
        cipherBytes += sealed.length;
        writeAll(descriptor, sealed);
      }
      const tail = cipher.final();
      cipherBytes += tail.length;
      writeAll(descriptor, tail);
      const tag = cipher.getAuthTag();
      cipherBytes += tag.length;
      writeAll(descriptor, tag);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return { nonce: nonce.toString('base64url'), bytes, cipherBytes, sha256: hash.digest('hex') };
  })();
}

/**
 * 解开一个备份对象，可选写出到目标路径。
 * @param options - 对象路径、对象密钥、nonce、附加认证数据与目标路径。
 * @returns 明文字节数与明文摘要。
 */
export async function openObject(options: {
  readonly objectPath: string;
  readonly key: Buffer;
  readonly nonce: string;
  readonly aad: Buffer;
  readonly targetPath?: string;
}): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const total = objectSize(options.objectPath);
  if (total < TAG_BYTES) {
    throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, '备份对象的密文长度不足', { bytes: total });
  }
  const nonce = Buffer.from(options.nonce, 'base64url');
  if (nonce.length !== NONCE_BYTES) {
    throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, '备份对象的 nonce 长度不合法', { bytes: nonce.length });
  }
  const tag = readTail(options.objectPath, TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', options.key, nonce);
  decipher.setAAD(options.aad);
  decipher.setAuthTag(tag);
  const hash = createHash('sha256');
  let bytes = 0;
  const payloadBytes = total - TAG_BYTES;
  const target = options.targetPath === undefined ? undefined : openSync(options.targetPath, 'wx', 0o600);
  try {
    if (payloadBytes > 0) {
      const source = createReadStream(options.objectPath, { start: 0, end: payloadBytes - 1, highWaterMark: 1 << 20 });
      for await (const chunk of source) {
        const buffer = chunk as Buffer;
        const plain = decipher.update(buffer);
        hash.update(plain);
        bytes += plain.length;
        if (target !== undefined && plain.length > 0) writeAll(target, plain);
      }
    }
    const tail = decipher.final();
    hash.update(tail);
    bytes += tail.length;
    if (target !== undefined && tail.length > 0) writeAll(target, tail);
    if (target !== undefined) fsyncSync(target);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, '备份对象的密文认证失败，内容已损坏', {
      object: options.objectPath,
    }, ['用同一备份源的上一份完整备份替换该对象后重新校验']);
  } finally {
    if (target !== undefined) closeSync(target);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * 生成密钥校验向量：用对象密钥加密一段随机内容，恢复时用来确认密钥可用。
 * @param key - 对象密钥。
 * @returns 校验向量。
 */
export function sealKeyCheck(key: Buffer): KeyCheck {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(KEY_CHECK_AAD, 'utf8'));
  const sealed = Buffer.concat([cipher.update(randomBytes(32)), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString('base64url'), ciphertext: sealed.toString('base64url') };
}

/**
 * 用对象密钥核对密钥校验向量。
 * @param key - 对象密钥。
 * @param check - 校验向量。
 * @returns 解开时确认可用。
 */
export function openKeyCheck(key: Buffer, check: KeyCheck): void {
  const nonce = Buffer.from(check.nonce, 'base64url');
  const sealed = Buffer.from(check.ciphertext, 'base64url');
  if (nonce.length !== NONCE_BYTES || sealed.length <= TAG_BYTES) {
    throw new BackupError(BACKUP_ERROR_CODES.manifestCorrupt, '清单里的密钥校验向量字段不合法');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(KEY_CHECK_AAD, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES));
    decipher.final();
  } catch {
    throw new BackupError(
      BACKUP_ERROR_CODES.keyUndecryptable,
      '提供的密钥无法解开备份的密钥校验向量，密钥与备份不匹配',
      {},
      [
        '提供生成该备份时的部署主密钥文件（32 字节，权限 0600）后重新执行',
        '主密钥已经丢失时只能以新密钥恢复，并重新配对全部设备、重新确认推送订阅、重新配置一次性密码与恢复码',
      ],
    );
  }
}

/** 取文件字节数；不存在时按对象缺失拒绝。 */
function objectSize(path: string): number {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new BackupError(BACKUP_ERROR_CODES.objectMissing, `备份对象不存在：${path}`, { errno });
  }
  return size;
}

/** 读文件末尾若干字节。 */
function readTail(path: string, length: number): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(descriptor, buffer, 0, length, statSync(path).size - length);
    if (read !== length) {
      throw new BackupError(BACKUP_ERROR_CODES.objectCorrupt, '备份对象的认证标签读取不完整', { bytes: read });
    }
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

/** 把一段缓冲完整写入文件描述符。 */
function writeAll(descriptor: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
  }
}
