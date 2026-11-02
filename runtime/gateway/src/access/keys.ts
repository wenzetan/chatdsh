/**
 * 访问层的部署密钥与信封加密。
 *
 * 主密钥保存在权限 0600 的独立文件里，用途子密钥由 HKDF-SHA256 派生，不同用途互不共享。
 * TOTP 秘密、通行密钥公钥与一次性令牌一律以 AES-256-GCM 信封保存，随机 12 字节 nonce，
 * 附加认证数据包含记录类型与信封版本，解密失败就地拒绝。
 * @module @chatdsh/gateway/access/keys
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 主密钥长度，单位字节。 */
export const ACCESS_KEY_BYTES = 32;

/** 信封版本，写入记录并参与附加认证数据。 */
export const ACCESS_ENVELOPE_VERSION = 1;

/** 用途子密钥的派生意图。 */
export type AccessKeyPurpose = 'csrf' | 'envelope';

/** 一条加密记录。数值字段使用 base64url 写法，长度短于十六进制。 */
export interface AccessEnvelope {
  /** 信封版本。 */
  readonly version: number;
  /** 12 字节 nonce。 */
  readonly nonce: string;
  /** 密文与认证标签。 */
  readonly ciphertext: string;
}

/**
 * 读取或创建部署主密钥。
 *
 * 已存在的文件必须是普通文件、权限恰为 0600、长度为 32 字节；任何不符就地失败，避免以
 * 放宽的权限继续运行。创建走排他写入，两个进程同时启动时只有一个成功。
 * @param path - 主密钥文件路径。
 * @returns 主密钥内容。
 */
export function loadAccessMasterKey(path: string): Buffer {
  if (existsSync(path)) {
    const info = statSync(path);
    if (!info.isFile()) throw new Error(`访问主密钥必须是普通文件：${path}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`访问主密钥文件权限必须为 0600：${path}`);
    const key = readFileSync(path);
    if (key.length !== ACCESS_KEY_BYTES) throw new Error(`访问主密钥长度必须为 ${ACCESS_KEY_BYTES} 字节：${path}`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(ACCESS_KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return key;
}

/**
 * 从主密钥派生用途子密钥。
 * @param masterKey - 部署主密钥。
 * @param purpose - 用途。
 * @returns 32 字节子密钥。
 */
export function deriveAccessKey(masterKey: Buffer, purpose: AccessKeyPurpose): Buffer {
  if (masterKey.length !== ACCESS_KEY_BYTES) throw new Error(`访问主密钥长度不合法：${masterKey.length}`);
  const derived = hkdfSync('sha256', masterKey, Buffer.alloc(0), `chatdsh/access/${purpose}/v1`, ACCESS_KEY_BYTES);
  return Buffer.from(derived);
}

/**
 * 用 AES-256-GCM 加密一段秘密。
 * @param key - 信封子密钥。
 * @param plaintext - 待加密内容。
 * @param recordType - 记录类型，参与附加认证数据。
 * @returns 加密记录。
 */
export function sealAccessSecret(key: Buffer, plaintext: Buffer, recordType: string): AccessEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(envelopeAad(recordType));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    version: ACCESS_ENVELOPE_VERSION,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

/**
 * 解密一段秘密。认证失败、版本不符或字段缺失都就地抛出，不做降级。
 * @param key - 信封子密钥。
 * @param envelope - 加密记录。
 * @param recordType - 记录类型，必须与加密时一致。
 * @returns 明文内容。
 */
export function openAccessSecret(key: Buffer, envelope: AccessEnvelope, recordType: string): Buffer {
  if (envelope.version !== ACCESS_ENVELOPE_VERSION) throw new Error(`信封版本不受支持：${envelope.version}`);
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  if (nonce.length !== 12) throw new Error('信封 nonce 长度必须为 12 字节');
  const sealed = Buffer.from(envelope.ciphertext, 'base64url');
  if (sealed.length < 17) throw new Error('信封密文长度不足');
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(envelopeAad(recordType));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 解析存库的信封文本。字段形状不符就地抛出。
 * @param text - 数据库里的 JSON 文本。
 * @returns 加密记录。
 */
export function parseAccessEnvelope(text: string): AccessEnvelope {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error('信封记录必须是对象');
  const record = value as Record<string, unknown>;
  const version = record.version;
  const nonce = record.nonce;
  const ciphertext = record.ciphertext;
  if (typeof version !== 'number' || !Number.isInteger(version)) throw new Error('信封版本必须是整数');
  if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('信封 nonce 缺失');
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) throw new Error('信封密文缺失');
  return { version, nonce, ciphertext };
}

/** 附加认证数据：部署、记录类型与信封版本共同绑定，跨记录类型挪用的密文无法解开。 */
function envelopeAad(recordType: string): Buffer {
  return Buffer.from(`chatdsh/access/${recordType}/v${ACCESS_ENVELOPE_VERSION}`, 'utf8');
}
