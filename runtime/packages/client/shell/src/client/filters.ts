/**
 * 会话列表的筛选与持久化。
 *
 * 筛选包含检索文本、设备范围与分组方式，按客户端标识保存在浏览器存储里：刷新、深链接与
 * 前进后退之后仍然生效。存储只保存这三个枚举与文本，不保存会话内容、设备令牌或游标。
 * @module @chatdsh/client-shell/filters
 */

/** 会话列表的分组方式。 */
export const SESSION_GROUPINGS = ['workspace', 'device'] as const;

/** 会话列表的分组方式取值。 */
export type SessionGrouping = (typeof SESSION_GROUPINGS)[number];

/** 设备范围的「全部设备」取值。 */
export const ALL_DEVICES = 'all';

/** 会话列表筛选。 */
export interface SessionFilters {
  /** 标题检索文本；空字符串表示不过滤。 */
  readonly query: string;
  /** 设备范围：具体设备标识或全部设备。 */
  readonly deviceId: string;
  /** 分组方式。 */
  readonly grouping: SessionGrouping;
}

/** 默认筛选：不过滤、全部设备、按工作区分组。 */
export const DEFAULT_FILTERS: SessionFilters = { query: '', deviceId: ALL_DEVICES, grouping: 'workspace' };

/** 检索文本长度上限，与私有读取入口的 `q` 上限一致。 */
const QUERY_MAX = 200;

/** 标识长度上限，与契约的标识长度一致。 */
const IDENTIFIER_MAX = 200;

/**
 * 判断一个字符串是不是分组方式。
 * @param value - 待判定字符串。
 * @returns 属于登记取值时为真。
 */
export function isSessionGrouping(value: string): value is SessionGrouping {
  return (SESSION_GROUPINGS as readonly string[]).includes(value);
}

/**
 * 把任意外来取值收敛成合法筛选。
 *
 * 每个字段单独判定：检索文本去掉外围空白并截到上限，设备范围只接受非空标识或全部设备，
 * 分组方式只接受登记取值。无法识别的字段回到默认值。
 * @param value - 外来的取值。
 * @returns 合法筛选。
 */
export function normalizeFilters(value: unknown): SessionFilters {
  if (typeof value !== 'object' || value === null) return DEFAULT_FILTERS;
  const record = value as Record<string, unknown>;
  const rawQuery = typeof record['query'] === 'string' ? record['query'] : '';
  const query = rawQuery.trim().slice(0, QUERY_MAX);
  const rawDevice = typeof record['deviceId'] === 'string' ? record['deviceId'] : ALL_DEVICES;
  const deviceId =
    rawDevice === ALL_DEVICES || (rawDevice !== '' && rawDevice.length <= IDENTIFIER_MAX) ? rawDevice : ALL_DEVICES;
  const rawGrouping = typeof record['grouping'] === 'string' ? record['grouping'] : DEFAULT_FILTERS.grouping;
  const grouping = isSessionGrouping(rawGrouping) ? rawGrouping : DEFAULT_FILTERS.grouping;
  return { query, deviceId, grouping };
}

/**
 * 筛选的存储键。
 * @param clientId - 浏览器侧客户端标识。
 * @returns 存储键。
 */
export function filtersStorageKey(clientId: string): string {
  if (clientId === '') throw new Error('客户端标识不能为空');
  return `chatdsh-shell.filters.v1:${clientId}`;
}

/**
 * 读筛选。
 * @param storage - 浏览器存储；不可用时返回默认筛选。
 * @param clientId - 浏览器侧客户端标识。
 * @returns 合法筛选。
 */
export function readFilters(storage: Storage | undefined, clientId: string): SessionFilters {
  if (storage === undefined) return DEFAULT_FILTERS;
  const raw = storage.getItem(filtersStorageKey(clientId));
  if (raw === null) return DEFAULT_FILTERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_FILTERS;
  }
  return normalizeFilters(parsed);
}

/**
 * 写筛选。
 *
 * 存储不可用或写入被拒绝时不打断界面：筛选只在本次会话内生效，用户下一步操作会再次尝试。
 * @param storage - 浏览器存储。
 * @param clientId - 浏览器侧客户端标识。
 * @param filters - 要保存的筛选。
 */
export function writeFilters(storage: Storage | undefined, clientId: string, filters: SessionFilters): void {
  if (storage === undefined) return;
  try {
    storage.setItem(filtersStorageKey(clientId), JSON.stringify(normalizeFilters(filters)));
  } catch {
    // 存储被拒绝（隐私模式、额度不足）只影响下次打开的默认值，不影响当前筛选。
  }
}
