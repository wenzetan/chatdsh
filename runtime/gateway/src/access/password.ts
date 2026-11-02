/**
 * 访问密码的哈希与校验。
 *
 * 工作区没有 Argon2id 实现，密码派生使用 Node.js 内置 `scrypt`（OpenSSL 提供，RFC 7914），
 * 参数取 64 MiB 内存档位：N 为 65536、r 为 8、p 为 1，随机盐 16 字节，输出 32 字节。
 * 编码为 `scrypt$N$r$p$salt$hash`，参数随摘要一起保存，日后调整参数不会使既有密码失效。
 * 校验用恒定时间比较；未配置密码时同样执行一次完整派生，避免时序差异泄露凭据配置。
 * @module @chatdsh/gateway/access/password
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** 密码编码的算法标识。 */
export const PASSWORD_ALGORITHM = 'scrypt';

/** 当前使用的派生参数。 */
export const PASSWORD_PARAMETERS = {
  /** 代价参数，取 2 的 16 次方，配合 r=8 占用 64 MiB 内存。 */
  N: 65536,
  /** 块大小。 */
  r: 8,
  /** 并行度。 */
  p: 1,
  /** 盐长度，单位字节。 */
  saltBytes: 16,
  /** 输出长度，单位字节。 */
  keyBytes: 32,
  /** 允许 OpenSSL 使用的内存上限，单位字节；比实际占用留出一倍余量。 */
  maxmem: 128 * 1024 * 1024,
} as const;

/** 密码原值的长度上限，与登录契约的字段上限一致。 */
export const PASSWORD_MAX_LENGTH = 1024;

/**
 * 计算密码摘要。
 * @param password - 密码原值。
 * @returns 版本化编码，可直接入库。
 */
export async function hashAccessPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  const salt = randomBytes(PASSWORD_PARAMETERS.saltBytes);
  const derived = await derive(password, salt, PASSWORD_PARAMETERS);
  return [
    PASSWORD_ALGORITHM,
    PASSWORD_PARAMETERS.N,
    PASSWORD_PARAMETERS.r,
    PASSWORD_PARAMETERS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * 校验密码。
 * @param password - 密码原值。
 * @param encoded - 库里的版本化编码。
 * @returns 是否匹配。
 */
export async function verifyAccessPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) return false;
  const parsed = parsePasswordHash(encoded);
  const derived = await derive(password, parsed.salt, parsed.parameters);
  const expected = parsed.hash;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * 校验一个必然不匹配的摘要，用于未配置密码时保持相同的计算代价。
 * @param password - 密码原值。
 */
export async function burnPasswordTime(password: string): Promise<void> {
  await verifyAccessPassword(password, dummyEncoding());
}

let dummyCache: string | undefined;

/** 一次性生成的固定摘要；盐随机、原值随机，永不匹配任何输入。 */
function dummyEncoding(): string {
  if (dummyCache === undefined) {
    const salt = randomBytes(PASSWORD_PARAMETERS.saltBytes);
    const key = randomBytes(PASSWORD_PARAMETERS.keyBytes);
    dummyCache = [
      PASSWORD_ALGORITHM,
      PASSWORD_PARAMETERS.N,
      PASSWORD_PARAMETERS.r,
      PASSWORD_PARAMETERS.p,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
  }
  return dummyCache;
}

interface ParsedPasswordHash {
  readonly parameters: { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number };
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/** 解析编码。字段缺失、算法不符或参数越界就地抛出。 */
function parsePasswordHash(encoded: string): ParsedPasswordHash {
  const parts = encoded.split('$');
  if (parts.length !== 6) throw new Error('密码摘要编码字段数不正确');
  const [algorithm, rawN, rawR, rawP, rawSalt, rawHash] = parts as [string, string, string, string, string, string];
  if (algorithm !== PASSWORD_ALGORITHM) throw new Error(`密码摘要算法不受支持：${algorithm}`);
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20) throw new Error(`密码摘要代价参数越界：${rawN}`);
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new Error(`密码摘要块大小越界：${rawR}`);
  if (!Number.isInteger(p) || p < 1 || p > 16) throw new Error(`密码摘要并行度越界：${rawP}`);
  const salt = Buffer.from(rawSalt, 'base64url');
  const hash = Buffer.from(rawHash, 'base64url');
  if (salt.length < 8 || hash.length < 16) throw new Error('密码摘要的盐或摘要长度不足');
  return { parameters: { N, r, p, maxmem: PASSWORD_PARAMETERS.maxmem }, salt, hash };
}

function assertPasswordLength(password: string): void {
  if (password.length === 0) throw new Error('密码不能为空');
  if (password.length > PASSWORD_MAX_LENGTH) throw new Error(`密码长度超过 ${PASSWORD_MAX_LENGTH}`);
}

function derive(
  password: string,
  salt: Buffer,
  parameters: { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_PARAMETERS.keyBytes, parameters, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}
