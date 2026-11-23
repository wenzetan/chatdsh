/**
 * 中继地址的本地保存。
 *
 * 自定义协议或隐私模式下浏览器可能拒绝访问本地存储；此时地址只保留在本次页面
 * 生命周期内，界面仍可正常读取中继。
 * @module @chatdsh/client-remote/storage
 */

/** 保存中继地址的键。 */
export const CONTROL_URL_KEY = 'chatdsh-remote:control-url';

/** 取本地存储；不可用时返回 `undefined`。 */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * 读取保存的中继地址。
 * @returns 保存的值；没有保存或存储不可用时为空字符串。
 */
export function readControlUrl(): string {
  const local = storage();
  if (local === undefined) return '';
  return local.getItem(CONTROL_URL_KEY) ?? '';
}

/**
 * 保存中继地址。
 * @param value - 归一化后的地址；空字符串表示清除。
 */
export function writeControlUrl(value: string): void {
  const local = storage();
  if (local === undefined) return;
  if (value === '') local.removeItem(CONTROL_URL_KEY);
  else local.setItem(CONTROL_URL_KEY, value);
}
