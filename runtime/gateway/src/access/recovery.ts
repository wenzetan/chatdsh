/**
 * 一次性恢复码。
 *
 * 每次生成 10 条独立的 128 位随机码，以十六进制展示，只在生成响应里出现一次；库里保存
 * SHA-256 摘要。消费是带条件的单条更新，同一条码的第二次提交不会再成功，重放无法通过。
 * @module @chatdsh/gateway/access/recovery
 */

import { createHash, randomBytes } from 'node:crypto';
import { ACCESS_SECURITY } from '@chatdsh/core-contracts';
import type { AccessStore } from './store.ts';

/** 单条恢复码的随机载荷长度，单位字节。 */
export const RECOVERY_CODE_BYTES = 16;

/** 恢复码的形状：32 个十六进制字符，对应 128 位。 */
const RECOVERY_CODE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * 生成一批恢复码并替换库里已有的全部记录。
 * @param store - 访问层存储。
 * @param now - 当前时刻，单位毫秒。
 * @returns 恢复码原值，条数固定为 10，只在此处返回一次。
 */
export function generateRecoveryCodes(store: AccessStore, now: number): string[] {
  const codes: string[] = [];
  while (codes.length < ACCESS_SECURITY.recoveryCodeCount) {
    const code = randomBytes(RECOVERY_CODE_BYTES).toString('hex');
    if (!codes.includes(code)) codes.push(code);
  }
  store.replaceRecoveryCodes(codes.map(recoveryCodeDigest), now);
  return codes;
}

/**
 * 计算一条恢复码的摘要。原值先做规范化，大小写与首尾空白不影响判定。
 * @param code - 恢复码原值。
 * @returns 十六进制摘要。
 */
export function recoveryCodeDigest(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}

/**
 * 消费一条恢复码。形状不符或已被消费都返回 `false`。
 * @param store - 访问层存储。
 * @param code - 恢复码原值。
 * @param now - 当前时刻，单位毫秒。
 * @returns 是否消费成功。
 */
export function consumeRecoveryCode(store: AccessStore, code: string, now: number): boolean {
  const normalized = normalizeRecoveryCode(code);
  if (!RECOVERY_CODE_PATTERN.test(normalized)) return false;
  return store.consumeRecoveryCode(recoveryCodeDigest(normalized), now);
}

/**
 * 剩余未消费的恢复码条数。
 * @param store - 访问层存储。
 * @returns 剩余条数。
 */
export function recoveryCodesRemaining(store: AccessStore): number {
  return store.recoveryCodeStats().remaining;
}

/**
 * 删除全部恢复码：用户移除对应因素时调用。
 * @param store - 访问层存储。
 */
export function removeRecoveryCodes(store: AccessStore): void {
  store.deleteRecoveryCodes();
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase();
}
