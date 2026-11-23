/**
 * 页面路径、中继状态与相对时间判定。
 *
 * 这些函数只读输入值，不访问浏览器全局对象，单元测试可以直接调用。
 * @module @chatdsh/client-remote/state
 */

/** 中继连接状态。 */
export type RelayStatus =
  | { readonly state: 'checking' }
  | { readonly state: 'connected' }
  | { readonly state: 'disconnected'; readonly code: string };

/**
 * 从路径里取出当前执行设备。
 * @param pathname - 文档路径，例如 `/d/<deviceId>/chat`。
 * @returns 设备标识；路径不以 `/d/` 开头时返回 `undefined`。
 */
export function parseDevicePath(pathname: string): string | undefined {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments[0] !== 'd' || segments[1] === undefined) return undefined;
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    return undefined;
  }
}

/**
 * 当前页面所属设备在宿主侧的前缀。
 * @param pathname - 文档路径。
 * @returns `/d/<deviceId>`；不在设备路径下时返回空字符串。
 */
export function deviceHostPrefix(pathname: string): string {
  const deviceId = parseDevicePath(pathname);
  return deviceId === undefined ? '' : `/d/${encodeURIComponent(deviceId)}`;
}

/**
 * 把一次请求失败归入界面状态。
 * @param error - 失败对象。
 * @returns 中继连接状态。
 */
export function classifyRelayFailure(error: unknown): RelayStatus {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly status?: unknown; readonly code?: unknown; readonly name?: unknown };
    if (typeof record.status === 'number') {
      if (record.status === 404) return { state: 'disconnected', code: 'gateway-missing' };
      if (record.status === 401 || record.status === 403) return { state: 'disconnected', code: 'unauthorized' };
      if (record.status === 409) return { state: 'disconnected', code: 'conflict' };
      if (record.status >= 500) return { state: 'disconnected', code: 'server-error' };
      return { state: 'disconnected', code: `http-${record.status}` };
    }
    if (typeof record.code === 'string' && record.code !== '') {
      return { state: 'disconnected', code: record.code };
    }
    if (typeof record.name === 'string' && record.name !== '') {
      return { state: 'disconnected', code: record.name === 'AbortError' ? 'timeout' : 'network' };
    }
  }
  return { state: 'disconnected', code: 'network' };
}

/**
 * 取失败对象的稳定错误码。
 * @param error - 失败对象。
 * @returns 错误码；没有可用字段时返回 `unknown`。
 */
export function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly code?: unknown; readonly name?: unknown };
    if (typeof record.code === 'string' && record.code !== '') return record.code;
    if (typeof record.name === 'string' && record.name !== '') return record.name;
  }
  return 'unknown';
}

/** 相对时间的单位。 */
export interface ActivityTime {
  readonly unit: 'now' | 'minute' | 'hour' | 'day' | 'date';
  readonly value: number;
  readonly at: number;
}

/**
 * 把最近活动时间换算成界面要显示的单位。
 * @param now - 当前时刻的毫秒时间戳。
 * @param time - 最近活动的毫秒时间戳。
 * @returns 单位与数值；超过七天时返回日期单位。
 */
export function activityTime(now: number, time: number): ActivityTime {
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return { unit: 'now', value: 0, at: time };
  if (elapsed < 3_600_000) return { unit: 'minute', value: Math.floor(elapsed / 60_000), at: time };
  if (elapsed < 86_400_000) return { unit: 'hour', value: Math.floor(elapsed / 3_600_000), at: time };
  if (elapsed < 7 * 86_400_000) return { unit: 'day', value: Math.floor(elapsed / 86_400_000), at: time };
  return { unit: 'date', value: time, at: time };
}
