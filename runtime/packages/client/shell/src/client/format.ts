/**
 * 界面上重复用到的时间与数量写法。
 * @module @chatdsh/client-shell/format
 */

/**
 * 时间的短写法：当天只写时分，同年写月日，更早写年月日。
 * @param time - 毫秒时间戳。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 短写法。
 */
export function timeText(time: number, now: number = Date.now()): string {
  const at = new Date(time);
  const current = new Date(now);
  const two = (value: number): string => String(value).padStart(2, '0');
  if (at.toDateString() === current.toDateString()) return `${two(at.getHours())}:${two(at.getMinutes())}`;
  if (at.getFullYear() === current.getFullYear()) return `${String(at.getMonth() + 1)}-${two(at.getDate())}`;
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/**
 * 把计数写成两位以上的紧凑形式。
 * @param value - 计数。
 * @returns 超过 99 时写成 `99+`。
 */
export function countText(value: number): string {
  return value > 99 ? '99+' : String(value);
}

/**
 * 未读的读屏说明。
 * @param unread - 未读条数。
 * @returns 说明；没有未读时为空字符串。
 */
export function unreadText(unread: number): string {
  return unread > 0 ? `${countText(unread)} 条未读` : '';
}
