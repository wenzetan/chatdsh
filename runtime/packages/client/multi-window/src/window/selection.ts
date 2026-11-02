/**
 * 每窗口选择与滚动位置。
 *
 * 当前设备、当前会话与滚动位置都记在会话存储里，键里带窗口标识：第二个窗口拿到的是空记录，
 * 从深链接的目标开始，第一窗口的选择与滚动不因第二窗口打开或改选而改变。记录不广播，标签
 * 列表只显示其他窗口的标题与上下文。
 * @module @chatdsh/client-multi-window/selection
 */

import type { WindowTarget } from './deep-link.ts';
import { assertIdentifier, isIdentifier } from './identifiers.ts';

/** 选择记录。 */
export interface WindowSelectionRecord {
  /** 当前上下文。 */
  readonly target: WindowTarget;
  /** 内容区的滚动位置，单位像素。 */
  readonly scrollTop: number;
  /** 最近写入时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 选择记录的存储键前缀。 */
export const SELECTION_KEY_PREFIX = 'chatdsh-multi-window.selection.v1';

/**
 * 取选择记录的存储键。
 * @param windowId - 窗口标识。
 * @returns 存储键；标识不合法时抛出。
 */
export function selectionStorageKey(windowId: string): string {
  return `${SELECTION_KEY_PREFIX}:${assertIdentifier('窗口标识', windowId)}`;
}

/**
 * 读当前窗口的选择记录。
 * @param storage - 会话存储。
 * @param windowId - 窗口标识。
 * @returns 记录；没有记录或内容不可解析时返回 `undefined`。
 */
export function readWindowSelection(storage: Storage | undefined, windowId: string): WindowSelectionRecord | undefined {
  if (storage === undefined) return undefined;
  const raw = storage.getItem(selectionStorageKey(windowId));
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const sessionId = record['sessionId'];
  const deviceId = record['deviceId'];
  const scrollTop = record['scrollTop'];
  const updatedAt = record['updatedAt'];
  if (!isIdentifier(sessionId) || !isIdentifier(deviceId)) return undefined;
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) return undefined;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined;
  const pane = record['pane'];
  if (pane === undefined) return { target: { sessionId, deviceId }, scrollTop, updatedAt };
  if (typeof pane !== 'object' || pane === null) return undefined;
  const rawPane = pane as Record<string, unknown>;
  const kind = rawPane['kind'];
  const id = rawPane['id'];
  if (kind !== 'document' && kind !== 'artifact' && kind !== 'trace') return undefined;
  if (!isIdentifier(id)) return undefined;
  return { target: { sessionId, deviceId, pane: { kind, id } }, scrollTop, updatedAt };
}

/**
 * 写当前窗口的选择记录。
 * @param storage - 会话存储。
 * @param windowId - 窗口标识。
 * @param target - 当前上下文。
 * @param scrollTop - 滚动位置。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 写入成功时为真。
 */
export function writeWindowSelection(
  storage: Storage | undefined,
  windowId: string,
  target: WindowTarget,
  scrollTop: number = 0,
  now: number = Date.now()
): boolean {
  if (storage === undefined) return false;
  const record: Record<string, unknown> = {
    sessionId: target.sessionId,
    deviceId: target.deviceId,
    scrollTop: Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0,
    updatedAt: now,
  };
  if (target.pane !== undefined) record['pane'] = { kind: target.pane.kind, id: target.pane.id };
  try {
    storage.setItem(selectionStorageKey(windowId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * 只更新滚动位置，保留已登记的上下文。
 * @param storage - 会话存储。
 * @param windowId - 窗口标识。
 * @param scrollTop - 滚动位置。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 写入成功时为真；没有记录时不创建。
 */
export function writeScrollAnchor(
  storage: Storage | undefined,
  windowId: string,
  scrollTop: number,
  now: number = Date.now()
): boolean {
  const previous = readWindowSelection(storage, windowId);
  if (previous === undefined) return false;
  return writeWindowSelection(storage, windowId, previous.target, scrollTop, now);
}

/**
 * 清掉当前窗口的选择记录。
 * @param storage - 会话存储。
 * @param windowId - 窗口标识。
 */
export function clearWindowSelection(storage: Storage | undefined, windowId: string): void {
  if (storage === undefined) return;
  storage.removeItem(selectionStorageKey(windowId));
}
