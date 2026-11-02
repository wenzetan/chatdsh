/**
 * 每窗口草稿：键里带窗口标识，两个窗口的输入互不覆盖。
 *
 * 键由客户端、窗口、设备与会话四段组成，与会话契约的草稿键形状一致。第二个窗口的窗口标识
 * 不同，因此同一个会话在两个窗口里各有一份草稿；同一窗口刷新后仍能取回。保存前只保留文本、
 * 版本与时间，凭据、引用原文与附件字节都不写入。
 * @module @chatdsh/client-multi-window/drafts
 */

import { assertIdentifier, DRAFT_KEY_PREFIX, isIdentifier } from './identifiers.ts';

/** 草稿键：客户端、窗口、设备与会话。 */
export interface WindowDraftIdentity {
  /** 浏览器侧客户端标识。 */
  readonly clientId: string;
  /** 窗口标识。 */
  readonly windowId: string;
  /** 目标执行设备。 */
  readonly deviceId: string;
  /** 目标会话；创建会话时缺省。 */
  readonly sessionId?: string;
}

/** 一条窗口草稿。 */
export interface WindowDraft {
  /** 输入文本。 */
  readonly text: string;
  /** 版本号，每次写入递增。 */
  readonly revision: number;
  /** 最近写入时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 草稿写入失败的原因。 */
export type DraftFailureReason = 'storage-unavailable' | 'storage-full' | 'privacy-mode';

/** 草稿写入结果。 */
export type DraftWriteResult =
  | { readonly outcome: 'saved'; readonly revision: number }
  | { readonly outcome: 'rejected'; readonly reason: DraftFailureReason };

/** 草稿文本的长度上限。 */
const TEXT_MAX = 262144;

/**
 * 取草稿的存储键。
 * @param identity - 草稿键。
 * @returns 存储键；缺少必要标识时抛出。
 */
export function draftStorageKey(identity: WindowDraftIdentity): string {
  const clientId = assertIdentifier('客户端标识', identity.clientId);
  const windowId = assertIdentifier('窗口标识', identity.windowId);
  const deviceId = assertIdentifier('设备标识', identity.deviceId);
  const session = identity.sessionId === undefined ? 'new' : assertIdentifier('会话标识', identity.sessionId);
  return `${DRAFT_KEY_PREFIX}:${clientId}:${windowId}:${deviceId}:${session}`;
}

/**
 * 判断本地存储是否可读写。
 * @param storage - 本地存储。
 * @returns 可读写时为真。
 */
export function draftStorageAvailable(storage: Storage | undefined): boolean {
  if (storage === undefined) return false;
  const probe = `${DRAFT_KEY_PREFIX}.probe`;
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读一条窗口草稿。
 * @param storage - 本地存储；不可用时返回 `undefined`。
 * @param identity - 草稿键。
 * @returns 草稿；没有记录或内容不可解析时返回 `undefined`。
 */
export function readWindowDraft(storage: Storage | undefined, identity: WindowDraftIdentity): WindowDraft | undefined {
  if (storage === undefined) return undefined;
  const raw = storage.getItem(draftStorageKey(identity));
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const text = record['text'];
  const revision = record['revision'];
  const updatedAt = record['updatedAt'];
  if (typeof text !== 'string' || text.length > TEXT_MAX) return undefined;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return undefined;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined;
  return { text, revision, updatedAt };
}

/**
 * 写一条窗口草稿。
 * @param storage - 本地存储。
 * @param identity - 草稿键。
 * @param text - 输入文本；超出上限时截断。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 写入结果。
 */
export function writeWindowDraft(
  storage: Storage | undefined,
  identity: WindowDraftIdentity,
  text: string,
  now: number = Date.now()
): DraftWriteResult {
  if (storage === undefined) return { outcome: 'rejected', reason: 'storage-unavailable' };
  const previous = readWindowDraft(storage, identity);
  const revision = (previous?.revision ?? 0) + 1;
  const record: WindowDraft = { text: text.slice(0, TEXT_MAX), revision, updatedAt: now };
  try {
    storage.setItem(draftStorageKey(identity), JSON.stringify(record));
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const reason: DraftFailureReason = name === 'QuotaExceededError'
      ? 'storage-full'
      : name === 'SecurityError' ? 'privacy-mode' : 'storage-unavailable';
    return { outcome: 'rejected', reason };
  }
  return { outcome: 'saved', revision };
}

/**
 * 清掉一条窗口草稿。
 * @param storage - 本地存储。
 * @param identity - 草稿键。
 */
export function clearWindowDraft(storage: Storage | undefined, identity: WindowDraftIdentity): void {
  if (storage === undefined) return;
  storage.removeItem(draftStorageKey(identity));
}

/**
 * 列出某个窗口在某台设备上的草稿键。
 *
 * 只用于界面显示「本窗口有哪些会话还有草稿」，不读取其他窗口的键。
 * @param storage - 本地存储。
 * @param clientId - 客户端标识。
 * @param windowId - 窗口标识。
 * @returns 匹配的存储键。
 */
export function draftKeysOf(storage: Storage | undefined, clientId: string, windowId: string): string[] {
  if (storage === undefined) return [];
  if (!isIdentifier(clientId) || !isIdentifier(windowId)) return [];
  const prefix = `${DRAFT_KEY_PREFIX}:${clientId}:${windowId}:`;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys.sort();
}
