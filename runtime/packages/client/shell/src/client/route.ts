/**
 * 逻辑路由：URL 路径与路由对象互相转换。
 *
 * 外壳由控制平面托管在根路径，界面内的导航全部走浏览器历史。本模块只处理路径与查询串，
 * 不接触 `window`，因此前进、后退、刷新与深链接都收敛到同一个路由对象。未知路径解析为
 * `invalid`，由界面显示错误并提供返回列表的动作。
 *
 * 路由形状遵循完整客户端规格第 3.1 节：
 * - `/`：聚合会话与欢迎状态；
 * - `/sessions/:sessionId?device=:deviceId`：目标设备上的会话；
 * - `/sessions/new`：创建向导；
 * - `/sessions/:sessionId/continue`：继续方式与 fork 确认；
 * - `/settings/:section`：设置区段；
 * - `/s/:token`：匿名只读快照；
 * - `/diagnostics`：客户端与选定设备的诊断。
 * @module @chatdsh/client-shell/route
 */

/** 设置区段。与设置契约的 `SETTINGS_SECTIONS` 保持同一组取值。 */
export const SETTINGS_SECTIONS = [
  'general',
  'models',
  'plugins',
  'runtime',
  'assistants',
  'skills',
  'memory',
  'connectors',
  'automation',
  'share',
  'devices',
  'access',
  'notifications',
  'data',
  'diagnostics',
] as const;

/** 设置区段取值。 */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 一个路由对象。 */
export type Route =
  | { readonly kind: 'sessions'; readonly sessionId?: string; readonly deviceId?: string }
  | { readonly kind: 'new-session' }
  | { readonly kind: 'continue'; readonly sessionId: string; readonly deviceId?: string }
  | { readonly kind: 'settings'; readonly section: SettingsSection }
  | { readonly kind: 'share'; readonly token: string }
  | { readonly kind: 'diagnostics' }
  | { readonly kind: 'invalid'; readonly path: string };

/** 会话标识与环境设备标识的长度上限，与契约的标识长度一致。 */
const IDENTIFIER_MAX = 200;

/** 仅用于解析相对路径的基准来源；解析结果里不保留它。 */
const PARSE_BASE = 'http://shell.invalid';

/**
 * 判断一个字符串是不是设置区段。
 * @param value - 待判定的字符串。
 * @returns 属于登记区段时为真。
 */
export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * 取路径里的一个标识段。
 *
 * 段必须能解码、非空且不超长；不满足时返回 `undefined`，由调用方判定为非法路径。
 * @param segment - 路径段原文。
 * @returns 解码后的标识。
 */
function decodeIdentifier(segment: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  if (decoded === '' || decoded.length > IDENTIFIER_MAX) return undefined;
  return decoded;
}

/** 查询串的解析结论：设备取值、或者非法。 */
type DeviceQuery = { readonly ok: true; readonly deviceId?: string } | { readonly ok: false };

/**
 * 解析查询串。
 *
 * 只接受单个 `device` 参数；重复参数、超出登记范围的参数与空取值都按非法路径处理。
 * @param search - 带前导 `?` 的查询串。
 * @returns 解析结论。
 */
function parseDeviceQuery(search: URLSearchParams): DeviceQuery {
  let deviceId: string | undefined;
  for (const [name, value] of search.entries()) {
    if (name !== 'device') return { ok: false };
    if (deviceId !== undefined) return { ok: false };
    if (value === '' || value.length > IDENTIFIER_MAX) return { ok: false };
    deviceId = value;
  }
  return deviceId === undefined ? { ok: true } : { ok: true, deviceId };
}

/**
 * 解析一个路径。
 *
 * 接受绝对 URL 或相对路径；只使用路径与查询串，忽略 fragment。结尾多出的一个斜杠按同一
 * 路径处理。
 * @param input - 路径或绝对 URL。
 * @returns 路由对象；无法识别时返回 `invalid`。
 */
export function parseRoute(input: string): Route {
  const invalid: Route = { kind: 'invalid', path: input };
  let url: URL;
  try {
    url = new URL(input, PARSE_BASE);
  } catch {
    return invalid;
  }
  if (url.origin !== PARSE_BASE) return invalid;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const query = parseDeviceQuery(url.searchParams);
  if (!query.ok) return invalid;
  const deviceId = query.deviceId;

  if (path === '' || path === '/') return deviceId === undefined ? { kind: 'sessions' } : { kind: 'sessions', deviceId };
  if (path === '/sessions/new') return { kind: 'new-session' };
  if (path === '/diagnostics') return { kind: 'diagnostics' };
  if (path.startsWith('/sessions/')) {
    const segments = path.slice('/sessions/'.length).split('/');
    if (segments.length === 1) {
      const sessionId = decodeIdentifier(segments[0] ?? '');
      if (sessionId === undefined) return invalid;
      return deviceId === undefined ? { kind: 'sessions', sessionId } : { kind: 'sessions', sessionId, deviceId };
    }
    if (segments.length === 2 && segments[1] === 'continue') {
      const sessionId = decodeIdentifier(segments[0] ?? '');
      if (sessionId === undefined) return invalid;
      return deviceId === undefined ? { kind: 'continue', sessionId } : { kind: 'continue', sessionId, deviceId };
    }
    return invalid;
  }
  if (path.startsWith('/settings/')) {
    const section = path.slice('/settings/'.length);
    if (section.includes('/') || !isSettingsSection(section)) return invalid;
    if (deviceId !== undefined) return invalid;
    return { kind: 'settings', section };
  }
  if (path.startsWith('/s/')) {
    const token = decodeIdentifier(path.slice('/s/'.length));
    if (token === undefined) return invalid;
    return { kind: 'share', token };
  }
  return invalid;
}

/**
 * 把路由对象转成路径。
 * @param route - 路由对象。
 * @returns 带查询串的路径；`invalid` 原样返回它记录的路径。
 */
export function routePath(route: Route): string {
  switch (route.kind) {
    case 'sessions': {
      if (route.sessionId === undefined) {
        return route.deviceId === undefined ? '/' : `/?${deviceQuery(route.deviceId)}`;
      }
      const base = `/sessions/${encodeURIComponent(route.sessionId)}`;
      return route.deviceId === undefined ? base : `${base}?${deviceQuery(route.deviceId)}`;
    }
    case 'new-session':
      return '/sessions/new';
    case 'continue': {
      const base = `/sessions/${encodeURIComponent(route.sessionId)}/continue`;
      return route.deviceId === undefined ? base : `${base}?${deviceQuery(route.deviceId)}`;
    }
    case 'settings':
      return `/settings/${route.section}`;
    case 'share':
      return `/s/${encodeURIComponent(route.token)}`;
    case 'diagnostics':
      return '/diagnostics';
    case 'invalid':
      return route.path;
  }
}

/**
 * 拼 `device` 查询参数。
 * @param deviceId - 设备标识。
 * @returns 查询串片段。
 */
export function deviceQuery(deviceId: string): string {
  if (deviceId === '' || deviceId.length > IDENTIFIER_MAX) throw new Error(`设备标识不合法：${deviceId}`);
  return `device=${encodeURIComponent(deviceId)}`;
}

/**
 * 构造一条会话的路由。
 * @param sessionId - 会话标识。
 * @param deviceId - 归属设备；未知时省略。
 * @returns 路由对象。
 */
export function sessionRoute(sessionId: string, deviceId?: string): Route {
  return deviceId === undefined ? { kind: 'sessions', sessionId } : { kind: 'sessions', sessionId, deviceId };
}

/**
 * 构造一条继续会话的路由。
 * @param sessionId - 源会话标识。
 * @param deviceId - 源设备；未知时省略。
 * @returns 路由对象。
 */
export function continueRoute(sessionId: string, deviceId?: string): Route {
  return deviceId === undefined ? { kind: 'continue', sessionId } : { kind: 'continue', sessionId, deviceId };
}

/**
 * 判断两个路由是否指向同一对象。
 *
 * 用于「前进、后退、刷新与深链接恢复同一对象」的判定：同一对象的两种写法（带与不带设备
 * 查询串）视为不同对象，因为设备归属是对象标识的一部分。
 * @param left - 一个路由。
 * @param right - 另一个路由。
 * @returns 完全相同时为真。
 */
export function sameRoute(left: Route, right: Route): boolean {
  return routePath(left) === routePath(right);
}
