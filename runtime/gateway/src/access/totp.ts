/**
 * TOTP 绑定与校验。
 *
 * 工作区没有 TOTP 库（`otplib` 及其分发包都不在 `node_modules` 与 `.dsh-deps` 里），因此本模块
 * 不自行实现 HMAC 截断：秘密生成、`otpauth://` 地址与时间片匹配统一由 `TotpLibrary` 端口提供，
 * 由 WP39 在接入成熟库时实现。本模块负责其余全部安全判定：秘密以 AES-256-GCM 信封保存、只允许
 * 前后各一个时间窗口、同一时间片只能被接受一次、绑定确认之前不接受校验。
 * @module @chatdsh/gateway/access/totp
 */

import { ChatdshError, type TotpEnrollment } from '@chatdsh/core-contracts';
import { openAccessSecret, parseAccessEnvelope, sealAccessSecret, type AccessEnvelope } from './keys.ts';
import type { AccessStore } from './store.ts';

/** TOTP 时间片长度，单位秒。 */
export const TOTP_PERIOD_SECONDS = 30;

/** 允许的时间窗口数量：前后各一个。 */
export const TOTP_WINDOW = 1;

/**
 * 成熟 TOTP 库的端口。实现必须来自经过维护的库，例如 `otplib` 的 authenticator。
 *
 * `match` 返回命中的时间片序号（`floor(毫秒 / 30000)`），未命中返回 `undefined`。
 */
export interface TotpLibrary {
  /** 生成 base32 写法的秘密。 */
  generateSecret(): string;
  /** 生成 `otpauth://totp/...` 地址。 */
  keyUri(input: { readonly issuer: string; readonly label: string; readonly secret: string }): string;
  /** 在给定时刻按窗口匹配验证码，返回命中的时间片序号。 */
  match(input: {
    readonly secret: string;
    readonly code: string;
    readonly at: number;
    readonly window: number;
    readonly periodSeconds: number;
  }): number | undefined;
}

/** 库里保存的 TOTP 记录。 */
interface TotpCredential {
  readonly version: number;
  readonly confirmed: boolean;
  readonly createdAt: number;
  readonly secret: AccessEnvelope;
}

/** 绑定所用的展示信息。 */
export interface TotpEnrollmentOptions {
  /** 发行方名称，写入 `otpauth://` 地址。 */
  readonly issuer: string;
  /** 展示标签，通常是部署名称。 */
  readonly label: string;
}

/**
 * 开始绑定：生成秘密、加密保存，并返回只展示一次的绑定信息。
 * @param store - 访问层存储。
 * @param key - 信封子密钥。
 * @param library - TOTP 库端口。
 * @param options - 发行方与标签。
 * @param now - 当前时刻，单位毫秒。
 * @returns 契约里的绑定信息，`confirmed` 为 `false`。
 */
export function beginTotpEnrollment(
  store: AccessStore,
  key: Buffer,
  library: TotpLibrary,
  options: TotpEnrollmentOptions,
  now: number
): TotpEnrollment {
  const secret = library.generateSecret();
  const otpauthUri = library.keyUri({ issuer: options.issuer, label: options.label, secret });
  const record: TotpCredential = {
    version: 1,
    confirmed: false,
    createdAt: now,
    secret: sealAccessSecret(key, Buffer.from(secret, 'utf8'), 'totp'),
  };
  store.writeCredential('totp', JSON.stringify(record), now);
  return { otpauthUri, secret, confirmed: false };
}

/**
 * 用首个验证码确认绑定。确认成功前，TOTP 不能用于登录。
 * @param store - 访问层存储。
 * @param key - 信封子密钥。
 * @param library - TOTP 库端口。
 * @param code - 六位验证码。
 * @param now - 当前时刻，单位毫秒。
 */
export function confirmTotpEnrollment(store: AccessStore, key: Buffer, library: TotpLibrary, code: string, now: number): void {
  const record = readTotpCredential(store, key);
  const step = matchTotpStep(library, record.secretText, code, now);
  assertTotpStepWindow(currentTotpStep(now), step);
  if (!store.consumeTotpStep(step, now)) throw new ChatdshError('totp-invalid', '该时间片已被使用');
  store.pruneTotpSteps(currentTotpStep(now) - TOTP_WINDOW - 1);
  const confirmed: TotpCredential = {
    version: record.record.version,
    confirmed: true,
    createdAt: record.record.createdAt,
    secret: record.record.secret,
  };
  store.writeCredential('totp', JSON.stringify(confirmed), now);
}

/**
 * 校验一次 TOTP 登录或再认证。时间片重复、窗口越界、未确认绑定都按 `totp-invalid` 拒绝。
 * @param store - 访问层存储。
 * @param key - 信封子密钥。
 * @param library - TOTP 库端口。
 * @param code - 六位验证码。
 * @param now - 当前时刻，单位毫秒。
 */
export function verifyTotpCode(store: AccessStore, key: Buffer, library: TotpLibrary, code: string, now: number): void {
  const record = readTotpCredential(store, key);
  if (!record.record.confirmed) throw new ChatdshError('totp-invalid', 'TOTP 尚未完成绑定确认');
  const step = matchTotpStep(library, record.secretText, code, now);
  assertTotpStepWindow(currentTotpStep(now), step);
  if (!store.consumeTotpStep(step, now)) throw new ChatdshError('totp-invalid', '该时间片已被使用');
  store.pruneTotpSteps(currentTotpStep(now) - TOTP_WINDOW - 1);
}

/**
 * 是否已经完成 TOTP 绑定。
 * @param store - 访问层存储。
 * @returns 已确认为 `true`。
 */
export function totpEnrolled(store: AccessStore): boolean {
  const credential = store.credential('totp');
  if (credential === undefined) return false;
  const record = parseTotpCredential(credential.digest);
  return record.confirmed;
}

/** 移除 TOTP 绑定与已消费的时间片。 */
export function removeTotp(store: AccessStore): void {
  store.deleteCredential('totp');
  store.pruneTotpSteps(Number.MAX_SAFE_INTEGER);
}

/**
 * 当前时刻所在的时间片序号。
 * @param at - 时刻，单位毫秒。
 * @returns 时间片序号。
 */
export function currentTotpStep(at: number): number {
  return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * 校验命中的时间片没有越出允许窗口。
 * @param currentStep - 当前时间片。
 * @param matchedStep - 库返回的命中时间片。
 */
export function assertTotpStepWindow(currentStep: number, matchedStep: number): void {
  if (matchedStep < currentStep - TOTP_WINDOW || matchedStep > currentStep + TOTP_WINDOW) {
    throw new ChatdshError('totp-invalid', '验证码时间片超出允许窗口');
  }
}

function matchTotpStep(library: TotpLibrary, secret: string, code: string, now: number): number {
  if (!/^\d{6}$/.test(code)) throw new ChatdshError('totp-invalid', '验证码形状不正确');
  const matched = library.match({ secret, code, at: now, window: TOTP_WINDOW, periodSeconds: TOTP_PERIOD_SECONDS });
  if (matched === undefined) throw new ChatdshError('totp-invalid', '验证码不匹配');
  return matched;
}

function readTotpCredential(store: AccessStore, key: Buffer): { readonly record: TotpCredential; readonly secretText: string } {
  const credential = store.credential('totp');
  if (credential === undefined) throw new ChatdshError('totp-invalid', '没有已绑定的 TOTP');
  const record = parseTotpCredential(credential.digest);
  const secretText = openAccessSecret(key, record.secret, 'totp').toString('utf8');
  return { record, secretText };
}

/** 解析库里的记录。字段形状不符就地抛出，解密失败由调用方按拒绝处理。 */
function parseTotpCredential(text: string): TotpCredential {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error('TOTP 记录必须是对象');
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error(`TOTP 记录版本不受支持：${String(record.version)}`);
  if (typeof record.confirmed !== 'boolean') throw new Error('TOTP 记录的确认标记缺失');
  if (typeof record.createdAt !== 'number' || !Number.isInteger(record.createdAt)) throw new Error('TOTP 记录的建立时刻缺失');
  if (typeof record.secret !== 'object' || record.secret === null) throw new Error('TOTP 记录的秘密信封缺失');
  const secret = parseAccessEnvelope(JSON.stringify(record.secret));
  return { version: 1, confirmed: record.confirmed, createdAt: record.createdAt, secret };
}
