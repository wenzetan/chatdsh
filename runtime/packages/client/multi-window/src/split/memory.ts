/**
 * 分屏比例记忆。
 *
 * 比例按客户端、窗口与设备保存：同一个窗口在同一台设备上恢复上次的拆分位置，换设备或换
 * 窗口各自独立。只保存一个 0 到 1 之间的比例，容器宽度变化时按当前宽度重新夹取，因此窗口
 * 变窄或显示器变化不会留下无法操作的布局。
 * @module @chatdsh/client-multi-window/split-memory
 */

import { assertIdentifier, SPLIT_KEY_PREFIX } from '../window/identifiers.ts';
import { clampRatio, DEFAULT_SPLIT_RATIO } from './geometry.ts';

/** 比例键：客户端、窗口与设备。 */
export interface SplitIdentity {
  /** 浏览器侧客户端标识。 */
  readonly clientId: string;
  /** 窗口标识。 */
  readonly windowId: string;
  /** 目标执行设备。 */
  readonly deviceId: string;
}

/**
 * 取比例存储键。
 * @param identity - 比例键。
 * @returns 存储键；缺少必要标识时抛出。
 */
export function splitStorageKey(identity: SplitIdentity): string {
  const clientId = assertIdentifier('客户端标识', identity.clientId);
  const windowId = assertIdentifier('窗口标识', identity.windowId);
  const deviceId = assertIdentifier('设备标识', identity.deviceId);
  return `${SPLIT_KEY_PREFIX}:${clientId}:${windowId}:${deviceId}`;
}

/**
 * 读保存的比例。
 * @param storage - 本地存储。
 * @param identity - 比例键。
 * @param width - 当前容器宽度，用于夹取；缺省按未经夹取的保存值返回。
 * @returns 比例；没有记录或记录不合法时返回默认比例。
 */
export function readSplitRatio(storage: Storage | undefined, identity: SplitIdentity, width?: number): number {
  if (storage === undefined) return DEFAULT_SPLIT_RATIO;
  const raw = storage.getItem(splitStorageKey(identity));
  if (raw === null) return DEFAULT_SPLIT_RATIO;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return DEFAULT_SPLIT_RATIO;
  return width === undefined ? parsed : clampRatio(parsed, width);
}

/**
 * 保存比例。
 * @param storage - 本地存储。
 * @param identity - 比例键。
 * @param ratio - 比例。
 * @returns 写入成功时为真；存储不可用时为假，界面不因此报错。
 */
export function writeSplitRatio(storage: Storage | undefined, identity: SplitIdentity, ratio: number): boolean {
  if (storage === undefined) return false;
  const value = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : DEFAULT_SPLIT_RATIO;
  try {
    storage.setItem(splitStorageKey(identity), value.toFixed(4));
    return true;
  } catch {
    return false;
  }
}

/**
 * 删掉保存的比例。
 * @param storage - 本地存储。
 * @param identity - 比例键。
 */
export function clearSplitRatio(storage: Storage | undefined, identity: SplitIdentity): void {
  if (storage === undefined) return;
  storage.removeItem(splitStorageKey(identity));
}
