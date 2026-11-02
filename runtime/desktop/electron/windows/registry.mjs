/**
 * 桌面第二窗口的登记与摆放。
 *
 * 每个窗口登记一条记录：标识、种类、深链接路由、会话与设备、右栏对象、打开时刻与边界。
 * 第二窗口在主窗口右下方向逐级偏移摆放，边界按显示器可用区域夹取；登记可以整体存盘，下次
 * 启动按存盘记录恢复。路由形状与浏览器侧深链接一致：`/sessions/<会话>?device=<设备>`，
 * 可带 `#pane=<种类>:<标识>`。
 * @module chatdsh-desktop-shell/windows/registry
 */

import { MIN_HEIGHT, MIN_WIDTH } from '../window-state.mjs';

/** 登记格式版本。 */
export const WINDOW_SESSION_VERSION = 1;

/** 窗口种类。 */
export const WINDOW_KINDS = Object.freeze(['main', 'secondary']);

/** 同时允许打开的窗口数量上限。 */
export const MAX_DESKTOP_WINDOWS = 6;

/** 第二窗口相对主窗口的偏移，单位像素。 */
export const CASCADE_OFFSET = 28;

/** 路由长度上限。 */
const ROUTE_MAX = 2048;

/** 标识长度上限。 */
const IDENTIFIER_MAX = 200;

/** 会话路由的形状。 */
const ROUTE_PATTERN = /^\/sessions\/([^/?#]+)\?device=([^&#]+)(?:#pane=(document|artifact|trace):(.+))?$/u;

/** 一次路由校验失败。 */
export class WindowRouteError extends Error {
  /**
   * @param {string} code - 失败原因。
   * @param {string} detail - 补充说明。
   */
  constructor(code, detail) {
    super(`窗口路由不合法：${code}${detail === undefined ? '' : `（${detail}）`}`);
    this.name = 'WindowRouteError';
    this.code = code;
  }
}

/**
 * 判断取值是否是可用的标识。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 非空且不超长时为真。
 */
function isIdentifier(value) {
  return typeof value === 'string' && value !== '' && value.length <= IDENTIFIER_MAX;
}

/**
 * 解析一条窗口路由。
 * @param {unknown} route - 待解析的路由。
 * @returns {{ sessionId: string, deviceId: string, pane?: { kind: string, id: string } }} 解析结果。
 */
export function parseWindowRoute(route) {
  if (typeof route !== 'string' || route === '' || route.length > ROUTE_MAX) {
    throw new WindowRouteError('route-type', '路由必须是 1 到 2048 个字符的字符串');
  }
  const match = ROUTE_PATTERN.exec(route);
  if (match === null) throw new WindowRouteError('route-shape', route.slice(0, 120));
  let sessionId;
  let deviceId;
  let paneId;
  try {
    sessionId = decodeURIComponent(match[1] ?? '');
    deviceId = decodeURIComponent(match[2] ?? '');
    paneId = match[4] === undefined ? undefined : decodeURIComponent(match[4]);
  } catch {
    throw new WindowRouteError('route-encoding', '路由包含无法解码的片段');
  }
  if (!isIdentifier(sessionId)) throw new WindowRouteError('session', sessionId);
  if (!isIdentifier(deviceId)) throw new WindowRouteError('device', deviceId);
  if (paneId !== undefined && !isIdentifier(paneId)) throw new WindowRouteError('pane', paneId);
  if (paneId === undefined) return { sessionId, deviceId };
  return { sessionId, deviceId, pane: { kind: String(match[3]), id: paneId } };
}

/**
 * 断言一条路由可用。
 * @param {unknown} route - 待断言的路由。
 * @returns {string} 原路由。
 */
export function assertWindowRoute(route) {
  parseWindowRoute(route);
  return route;
}

/**
 * 判断取值是否是可用的窗口标识。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 可用时为真。
 */
export function isWindowId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,120}$/u.test(value);
}

/**
 * 判断取值是否是可用的窗口种类。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 属于登记种类时为真。
 */
export function isWindowKind(value) {
  return typeof value === 'string' && WINDOW_KINDS.includes(value);
}

/**
 * 建立一条窗口登记。
 * @param {{ id: string, kind: string, route: string, openedAt?: number, bounds?: { x?: number, y?: number, width: number, height: number } }} input - 登记输入。
 * @returns {object} 收敛后的登记。
 */
export function createWindowDescriptor(input) {
  if (!isWindowId(input.id)) throw new Error(`窗口标识不合法：${String(input.id)}`);
  if (!isWindowKind(input.kind)) throw new Error(`窗口种类不合法：${String(input.kind)}`);
  const parsed = parseWindowRoute(input.route);
  if (input.openedAt !== undefined && (!Number.isInteger(input.openedAt) || input.openedAt < 0)) {
    throw new Error(`打开时刻不合法：${String(input.openedAt)}`);
  }
  const bounds = input.bounds === undefined ? undefined : normalizeBounds(input.bounds);
  const descriptor = {
    id: input.id,
    kind: input.kind,
    route: input.route,
    sessionId: parsed.sessionId,
    deviceId: parsed.deviceId,
    openedAt: input.openedAt ?? Date.now(),
  };
  if (parsed.pane !== undefined) descriptor.pane = { kind: parsed.pane.kind, id: parsed.pane.id };
  if (bounds !== undefined) descriptor.bounds = bounds;
  return descriptor;
}

/**
 * 收敛一组边界。
 * @param {{ x?: number, y?: number, width: unknown, height: unknown }} bounds - 原始边界。
 * @returns {{ x?: number, y?: number, width: number, height: number }} 收敛后的边界。
 */
export function normalizeBounds(bounds) {
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(bounds[key]) || bounds[key] <= 0) {
      throw new Error(`窗口边界 ${key} 必须是正整数`);
    }
  }
  for (const key of ['x', 'y']) {
    if (bounds[key] !== undefined && !Number.isInteger(bounds[key])) {
      throw new Error(`窗口边界 ${key} 必须是整数`);
    }
  }
  const normalized = { width: bounds.width, height: bounds.height };
  if (bounds.x !== undefined) normalized.x = bounds.x;
  if (bounds.y !== undefined) normalized.y = bounds.y;
  return normalized;
}

/**
 * 取窗口标题。
 * @param {object} descriptor - 窗口登记。
 * @returns {string} 标题。
 */
export function windowTitleOf(descriptor) {
  const session = descriptor.sessionId.length > 12 ? `${descriptor.sessionId.slice(0, 12)}…` : descriptor.sessionId;
  return descriptor.kind === 'main' ? `ChatDSH · ${session}` : `ChatDSH 第二窗口 · ${session}`;
}

/**
 * 把一个数值夹到区间内。
 * @param {number} value - 原值。
 * @param {number} low - 下限。
 * @param {number} high - 上限。
 * @returns {number} 夹取后的值。
 */
function clamp(value, low, high) {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

/**
 * 计算第二窗口的摆放位置：从主窗口右下方向逐级偏移，并夹在显示器可用区域内。
 * @param {{ x?: number, y?: number, width: number, height: number }} base - 主窗口边界。
 * @param {number} index - 第二窗口的序号，从 0 开始。
 * @param {{ x: number, y: number, width: number, height: number }} workArea - 显示器可用区域。
 * @returns {{ x: number, y: number, width: number, height: number, adjustment: string }} 边界与调整说明。
 */
export function cascadedBounds(base, index, workArea) {
  if (!Number.isInteger(index) || index < 0) throw new Error(`窗口序号不合法：${String(index)}`);
  const baseX = base.x ?? workArea.x;
  const baseY = base.y ?? workArea.y;
  const fillsArea = base.width >= workArea.width * 0.9 && base.height >= workArea.height * 0.9;
  if (fillsArea) {
    const width = Math.max(MIN_WIDTH, Math.round(workArea.width * 0.8));
    const height = Math.max(MIN_HEIGHT, Math.round(workArea.height * 0.8));
    const offset = CASCADE_OFFSET * (index + 1);
    const x = clamp(workArea.x + offset, workArea.x, workArea.x + Math.max(workArea.width - width, 0));
    const y = clamp(workArea.y + offset, workArea.y, workArea.y + Math.max(workArea.height - height, 0));
    return { x, y, width, height, adjustment: 'resized' };
  }
  const width = Math.min(Math.max(base.width, MIN_WIDTH), workArea.width);
  const height = Math.min(Math.max(base.height, MIN_HEIGHT), workArea.height);
  const offset = CASCADE_OFFSET * (index + 1);
  let x = baseX + offset;
  let y = baseY + offset;
  let adjustment = 'none';
  if (x + width > workArea.x + workArea.width || y + height > workArea.y + workArea.height) {
    x = baseX - offset;
    y = baseY - offset;
    adjustment = 'reversed';
  }
  const clampedX = clamp(x, workArea.x, workArea.x + Math.max(workArea.width - width, 0));
  const clampedY = clamp(y, workArea.y, workArea.y + Math.max(workArea.height - height, 0));
  if (clampedX !== x || clampedY !== y) adjustment = adjustment === 'none' ? 'clamped' : `${adjustment}+clamped`;
  return { x: clampedX, y: clampedY, width, height, adjustment };
}

/**
 * 窗口登记表。
 */
export class WindowRegistry {
  /** @type {Map<string, object>} */
  #windows = new Map();

  /** @type {() => number} */
  #now;

  /**
   * @param {{ now?: () => number }} [options] - 时钟。
   */
  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** 登记窗口数量。 */
  get count() {
    return this.#windows.size;
  }

  /**
   * 登记一个窗口。
   * @param {object} descriptor - 窗口登记。
   * @returns {object} 登记后的记录。
   */
  add(descriptor) {
    if (this.#windows.has(descriptor.id)) throw new Error(`窗口标识重复：${descriptor.id}`);
    const record = { ...descriptor, openedAt: descriptor.openedAt ?? this.#now() };
    this.#windows.set(record.id, record);
    return record;
  }

  /**
   * 摘下窗口。
   * @param {string} id - 窗口标识。
   * @returns {boolean} 摘到记录时为真。
   */
  remove(id) {
    return this.#windows.delete(id);
  }

  /**
   * 取一个窗口登记。
   * @param {string} id - 窗口标识。
   * @returns {object | undefined} 登记。
   */
  get(id) {
    return this.#windows.get(id);
  }

  /**
   * 全部登记，按打开时刻排列。
   * @returns {object[]} 登记列表。
   */
  list() {
    return [...this.#windows.values()].sort((left, right) => left.openedAt - right.openedAt);
  }

  /** 主窗口登记。 */
  get primary() {
    return this.list().find((descriptor) => descriptor.kind === 'main');
  }

  /**
   * 下一个第二窗口的序号。
   * @returns {number} 序号。
   */
  nextIndex() {
    return this.list().filter((descriptor) => descriptor.kind === 'secondary').length;
  }

  /**
   * 判断还能否再开一个窗口。
   * @returns {boolean} 未到上限时为真。
   */
  canOpenMore() {
    return this.#windows.size < MAX_DESKTOP_WINDOWS;
  }

  /**
   * 标签列表。
   * @returns {Array<{ id: string, title: string, kind: string, route: string }>} 标签。
   */
  tabs() {
    return this.list().map((descriptor) => ({
      id: descriptor.id,
      title: windowTitleOf(descriptor),
      kind: descriptor.kind,
      route: descriptor.route,
    }));
  }

  /**
   * 存盘用的快照。
   * @returns {{ version: number, windows: object[] }} 快照。
   */
  snapshot() {
    return {
      version: WINDOW_SESSION_VERSION,
      windows: this.list().map((descriptor) => ({
        id: descriptor.id,
        kind: descriptor.kind,
        route: descriptor.route,
        openedAt: descriptor.openedAt,
        ...(descriptor.bounds === undefined ? {} : { bounds: descriptor.bounds }),
      })),
    };
  }

  /**
   * 按快照恢复登记。
   * @param {{ version: number, windows: object[] }} snapshot - 快照。
   * @returns {object[]} 恢复的登记。
   */
  restore(snapshot) {
    const parsed = parseWindowSession(JSON.stringify(snapshot));
    const restored = [];
    for (const descriptor of parsed.windows) restored.push(this.add(descriptor));
    return restored;
  }
}

/**
 * 解析存盘的窗口会话。
 * @param {string} text - 文件正文。
 * @returns {{ version: number, windows: object[] }} 快照；内容不合法时抛出。
 */
export function parseWindowSession(text) {
  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('窗口会话必须是对象');
  if (raw.version !== WINDOW_SESSION_VERSION) throw new Error(`窗口会话版本不认识：${String(raw.version)}`);
  if (!Array.isArray(raw.windows)) throw new Error('窗口会话缺少窗口列表');
  const windows = [];
  for (const entry of raw.windows) {
    if (entry === null || typeof entry !== 'object') throw new Error('窗口会话的窗口项必须是对象');
    windows.push(createWindowDescriptor({
      id: entry.id,
      kind: entry.kind,
      route: entry.route,
      ...(entry.openedAt === undefined ? {} : { openedAt: entry.openedAt }),
      ...(entry.bounds === undefined ? {} : { bounds: entry.bounds }),
    }));
  }
  return { version: WINDOW_SESSION_VERSION, windows };
}

/**
 * 序列化窗口会话。
 * @param {{ version: number, windows: object[] }} snapshot - 快照。
 * @returns {string} 文件正文。
 */
export function serializeWindowSession(snapshot) {
  return `${JSON.stringify({ version: WINDOW_SESSION_VERSION, windows: snapshot.windows }, null, 2)}\n`;
}
