/**
 * 新窗口深链接：把当前上下文编成地址，并从地址还原上下文。
 *
 * 地址沿用外壳的逻辑路由 `/sessions/:sessionId?device=:deviceId`，选中对象放在片段
 * `#pane=<kind>:<id>`。外壳的路由解析只看路径与 `device` 查询参数，片段对它没有影响，
 * 因此同一个地址既能被外壳当作合法会话地址打开，也能让本模块恢复分屏右栏的目标。
 *
 * 每种非法输入都有固定原因，界面据此提示并阻止打开，不做猜测修补。
 * @module @chatdsh/client-multi-window/deep-link
 */

import { assertIdentifier, isIdentifier } from './identifiers.ts';

/** 右栏可承载的对象种类。 */
export const PANE_KINDS = ['document', 'artifact', 'trace'] as const;

/** 右栏对象种类取值。 */
export type PaneKind = (typeof PANE_KINDS)[number];

/** 右栏选中的对象。 */
export interface PaneSelection {
  /** 对象种类。 */
  readonly kind: PaneKind;
  /** 对象标识。 */
  readonly id: string;
}

/** 一个窗口的上下文：会话、设备与可选的右栏对象。 */
export interface WindowTarget {
  /** 目标会话。 */
  readonly sessionId: string;
  /** 目标执行设备。 */
  readonly deviceId: string;
  /** 右栏选中的对象；单栏时不出现。 */
  readonly pane?: PaneSelection;
}

/** 深链接解析失败的原因。 */
export type DeepLinkFailure =
  | 'address'
  | 'origin'
  | 'path'
  | 'session'
  | 'device'
  | 'query'
  | 'fragment';

/** 深链接解析结论。 */
export type DeepLinkResult =
  | { readonly ok: true; readonly target: WindowTarget }
  | { readonly ok: false; readonly reason: DeepLinkFailure };

/** 右栏对象种类的中文名。 */
const PANE_LABELS: Readonly<Record<PaneKind, string>> = {
  document: '文档',
  artifact: '制品',
  trace: '轨迹',
};

/**
 * 判断取值是否属于登记的对象种类。
 * @param value - 待判定值。
 * @returns 属于登记种类时为真。
 */
export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === 'string' && (PANE_KINDS as readonly string[]).includes(value);
}

/**
 * 取对象种类的中文名。
 * @param kind - 对象种类。
 * @returns 中文名。
 */
export function paneLabel(kind: PaneKind): string {
  return PANE_LABELS[kind];
}

/**
 * 把上下文编成片段。
 * @param pane - 右栏对象。
 * @returns 片段文本，带前导 `#`；没有对象时为空串。
 */
export function paneFragment(pane: PaneSelection | undefined): string {
  if (pane === undefined) return '';
  if (!isPaneKind(pane.kind)) throw new Error(`右栏对象种类不合法：${String(pane.kind)}`);
  assertIdentifier('右栏对象标识', pane.id);
  return `#pane=${pane.kind}:${encodeURIComponent(pane.id)}`;
}

/**
 * 把上下文编成路径。
 * @param target - 窗口上下文。
 * @returns 会话路径、设备查询串与对象片段。
 */
export function deepLinkPath(target: WindowTarget): string {
  const sessionId = assertIdentifier('会话标识', target.sessionId);
  const deviceId = assertIdentifier('设备标识', target.deviceId);
  return `/sessions/${encodeURIComponent(sessionId)}?device=${encodeURIComponent(deviceId)}${paneFragment(target.pane)}`;
}

/**
 * 把上下文编成绝对地址。
 * @param target - 窗口上下文。
 * @param origin - 目标来源，例如 `http://127.0.0.1:3080`。
 * @returns 绝对地址。
 */
export function deepLinkUrl(target: WindowTarget, origin: string): string {
  const parsed = new URL(origin);
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`来源必须是纯来源地址：${origin}`);
  }
  return `${parsed.origin}${deepLinkPath(target)}`;
}

/**
 * 解析一个深链接。
 *
 * 只接受与本模块同源的绝对地址，或者以 `/sessions/` 开头的相对路径。会话与设备各出现一次，
 * 查询串里出现其他参数按非法处理；片段只接受 `pane=<kind>:<id>`。
 * @param input - 地址或路径。
 * @param origin - 当前来源；用于判定绝对地址是否同源，缺省取运行环境的来源。
 * @returns 解析结论。
 */
export function parseDeepLink(input: string, origin?: string): DeepLinkResult {
  let url: URL;
  try {
    url = new URL(input, origin ?? (typeof location === 'undefined' ? 'http://multi-window.invalid' : location.origin));
  } catch {
    return { ok: false, reason: 'address' };
  }
  const base = origin ?? (typeof location === 'undefined' ? 'http://multi-window.invalid' : location.origin);
  if (url.origin !== new URL(base).origin) return { ok: false, reason: 'origin' };
  if (!url.pathname.startsWith('/sessions/')) return { ok: false, reason: 'path' };
  const segments = url.pathname.slice('/sessions/'.length).split('/');
  if (segments.length !== 1) return { ok: false, reason: 'path' };
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(segments[0] ?? '');
  } catch {
    return { ok: false, reason: 'session' };
  }
  if (!isIdentifier(sessionId)) return { ok: false, reason: 'session' };
  let deviceId: string | undefined;
  for (const [name, value] of url.searchParams.entries()) {
    if (name !== 'device') return { ok: false, reason: 'query' };
    if (deviceId !== undefined) return { ok: false, reason: 'query' };
    if (!isIdentifier(value)) return { ok: false, reason: 'device' };
    deviceId = value;
  }
  if (deviceId === undefined) return { ok: false, reason: 'device' };
  if (url.hash === '') return { ok: true, target: { sessionId, deviceId } };
  const match = /^#pane=([a-z]+):(.+)$/u.exec(url.hash);
  if (match === null) return { ok: false, reason: 'fragment' };
  const kind = match[1];
  if (!isPaneKind(kind)) return { ok: false, reason: 'fragment' };
  let id: string;
  try {
    id = decodeURIComponent(match[2] ?? '');
  } catch {
    return { ok: false, reason: 'fragment' };
  }
  if (!isIdentifier(id)) return { ok: false, reason: 'fragment' };
  return { ok: true, target: { sessionId, deviceId, pane: { kind, id } } };
}

/**
 * 判断两个上下文是否指向同一会话、设备与对象。
 * @param left - 第一个上下文。
 * @param right - 第二个上下文。
 * @returns 完全一致时为真。
 */
export function sameWindowTarget(left: WindowTarget, right: WindowTarget): boolean {
  if (left.sessionId !== right.sessionId || left.deviceId !== right.deviceId) return false;
  if (left.pane === undefined || right.pane === undefined) return left.pane === right.pane;
  return left.pane.kind === right.pane.kind && left.pane.id === right.pane.id;
}

/**
 * 判断上下文是否指向同一个会话。
 * @param left - 第一个上下文。
 * @param right - 第二个上下文。
 * @returns 会话与设备一致时为真。
 */
export function sameSessionOf(left: WindowTarget, right: WindowTarget): boolean {
  return left.sessionId === right.sessionId && left.deviceId === right.deviceId;
}
