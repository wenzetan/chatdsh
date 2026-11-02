/**
 * 浏览器与桌面主进程共用的随机标识生成。
 *
 * 只使用 Web Crypto，不依赖 `node:crypto`，因此可以进浏览器产物。
 * @module @chatdsh/core-diagnostics/uuid
 */

/**
 * 生成一个 RFC 4122 版本 4 的标识。
 * @returns 小写十六进制的 8-4-4-4-12 形式标识。
 */
export function randomUUID(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new Error('当前运行环境没有可用的 Web Crypto，无法生成实例标识');
  }
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
