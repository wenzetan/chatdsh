/**
 * 本地草稿：按客户端、窗口、设备与会话保存。
 *
 * 键是四元组，窗口标识在刷新后保持稳定、第二个窗口使用独立标识，因此换设备、换会话与刷新
 * 都能取回各自的草稿。持久化只保存输入文本、引用标识与已确认附件的元数据；凭据、记忆查询
 * 内容、工具原文与未上传文件字节一律不写入。
 * @module @chatdsh/client-shell/drafts
 */

/** 引用对象的种类。与草稿契约的 `REFERENCE_KINDS` 一致。 */
export const DRAFT_REFERENCE_KINDS = ['file', 'skill', 'subagent', 'session', 'command'] as const;

/** 引用对象种类的取值。 */
export type DraftReferenceKind = (typeof DRAFT_REFERENCE_KINDS)[number];

/** 草稿里的一段引用。 */
export interface DraftReference {
  readonly kind: DraftReferenceKind;
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

/** 草稿附件：只保存已确认的元数据。 */
export interface DraftAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly confirmed: true;
  readonly needsReselect: boolean;
}

/** 草稿键：客户端、窗口、设备与会话。 */
export interface DraftIdentity {
  /** 浏览器侧客户端标识，同一浏览器内稳定。 */
  readonly clientId: string;
  /** 窗口标识；同一窗口刷新后保持稳定，第二个窗口不同。 */
  readonly windowId: string;
  /** 目标执行设备。 */
  readonly deviceId: string;
  /** 目标会话；创建会话时的草稿缺省。 */
  readonly sessionId?: string;
}

/** 一条草稿。 */
export interface DraftRecord {
  readonly key: DraftIdentity;
  readonly text: string;
  readonly references: readonly DraftReference[];
  readonly attachments: readonly DraftAttachment[];
  readonly revision: number;
  readonly updatedAt: number;
}

/** 草稿写入失败的原因。与草稿契约的 `DRAFT_FAILURE_REASONS` 一致。 */
export type DraftFailureReason = 'storage-full' | 'storage-unavailable' | 'privacy-mode' | 'cleared-by-browser';

/** 草稿写入结果。 */
export interface DraftWriteResult {
  readonly outcome: 'saved' | 'rejected';
  readonly reason?: DraftFailureReason;
  readonly revision?: number;
}

/** 离线发送的固定结果：草稿保留，不进入待发队列。 */
export const OFFLINE_SEND_RESULT = {
  outcome: 'rejected',
  code: 'device-offline',
  draftKept: true,
  queued: false,
} as const;

/** 离线点击发送时显示的原因。 */
export const OFFLINE_SEND_MESSAGE = '目标设备离线，发送失败，草稿已保留';

/** 离线发送的结论。 */
export type OfflineSendOutcome =
  | {
      readonly outcome: 'rejected';
      readonly code: 'device-offline';
      readonly draftKept: true;
      readonly queued: false;
      readonly message: string;
    }
  | { readonly outcome: 'empty' };

/**
 * 判定一次离线发送。
 *
 * 目标设备离线时点击发送只得到这一个结果：不写待发队列、不改变执行路由、不创建回合；空输入
 * 只提示没有内容。
 * @param text - 输入区文本。
 * @returns 发送结论。
 */
export function offlineSendOutcome(text: string): OfflineSendOutcome {
  if (text.trim() === '') return { outcome: 'empty' };
  return { ...OFFLINE_SEND_RESULT, message: OFFLINE_SEND_MESSAGE };
}

/** 草稿文本的长度上限，与草稿契约一致。 */
const TEXT_MAX = 262144;

/** 标识长度上限。 */
const IDENTIFIER_MAX = 200;

/** 保存窗口标识的存储键；窗口标识放会话存储，刷新保留、第二窗口独立。 */
const WINDOW_KEY = 'chatdsh-shell.window.v1';

/** 保存客户端标识的存储键；客户端标识放本地存储，同一浏览器内稳定。 */
const CLIENT_KEY = 'chatdsh-shell.client.v1';

/**
 * 判断字符串是否是可用的标识。
 * @param value - 待判定值。
 * @returns 非空且不超长时为真。
 */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= IDENTIFIER_MAX;
}

/**
 * 取草稿的存储键。
 * @param identity - 草稿键。
 * @returns 存储键，包含客户端、窗口、设备与会话四段；没有会话时用 `new` 段。
 */
export function draftStorageKey(identity: DraftIdentity): string {
  if (!isIdentifier(identity.clientId) || !isIdentifier(identity.windowId) || !isIdentifier(identity.deviceId)) {
    throw new Error('草稿键需要客户端、窗口与设备三个标识');
  }
  const session = identity.sessionId === undefined ? 'new' : identity.sessionId;
  return `chatdsh-shell.draft.v1:${identity.clientId}:${identity.windowId}:${identity.deviceId}:${session}`;
}

/**
 * 把外来的草稿内容收敛成允许持久化的字段。
 *
 * 只保留文本、引用与已确认附件三类字段；其他键（凭据、工具原文、记忆查询内容、未确认附件
 * 字节）一律丢弃。引用与附件的形状不合法时丢弃该条，不猜测修补。
 * @param input - 外来内容。
 * @returns 允许持久化的三个字段。
 */
export function normalizeDraft(input: unknown): Pick<DraftRecord, 'text' | 'references' | 'attachments'> {
  if (typeof input !== 'object' || input === null) return { text: '', references: [], attachments: [] };
  const record = input as Record<string, unknown>;
  const rawText = record['text'];
  const text = typeof rawText === 'string' ? rawText.slice(0, TEXT_MAX) : '';
  const references: DraftReference[] = [];
  const rawReferences = record['references'];
  if (Array.isArray(rawReferences)) {
    for (const entry of rawReferences) {
      if (typeof entry !== 'object' || entry === null) continue;
      const reference = entry as Record<string, unknown>;
      const kind = reference['kind'];
      if (typeof kind !== 'string' || !(DRAFT_REFERENCE_KINDS as readonly string[]).includes(kind)) continue;
      if (!isIdentifier(reference['id']) || !isIdentifier(reference['label'])) continue;
      references.push({
        kind: kind as DraftReferenceKind,
        id: reference['id'],
        label: reference['label'],
        available: reference['available'] === true,
      });
    }
  }
  const attachments: DraftAttachment[] = [];
  const rawAttachments = record['attachments'];
  if (Array.isArray(rawAttachments)) {
    for (const entry of rawAttachments) {
      if (typeof entry !== 'object' || entry === null) continue;
      const attachment = entry as Record<string, unknown>;
      if (attachment['confirmed'] !== true) continue;
      if (!isIdentifier(attachment['id'])) continue;
      if (!isIdentifier(attachment['filename']) || !isIdentifier(attachment['mimeType'])) continue;
      const size = attachment['size'];
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) continue;
      attachments.push({
        id: attachment['id'],
        filename: attachment['filename'],
        mimeType: attachment['mimeType'],
        size,
        confirmed: true,
        needsReselect: attachment['needsReselect'] === true,
      });
    }
  }
  return { text, references, attachments };
}

/**
 * 读一条草稿。
 * @param storage - 浏览器存储；不可用时返回 `undefined`。
 * @param identity - 草稿键。
 * @returns 草稿记录；没有草稿或内容不可解析时返回 `undefined`。
 */
export function readDraft(storage: Storage | undefined, identity: DraftIdentity): DraftRecord | undefined {
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
  const revision = record['revision'];
  const updatedAt = record['updatedAt'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return undefined;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined;
  const content = normalizeDraft(record);
  return { key: identity, ...content, revision, updatedAt };
}

/**
 * 写一条草稿。
 *
 * 每次都按当前内容重新计算版本号：同键的并发写入以最后落盘的为准。写入被拒绝时返回具体
 * 原因，界面据此提示，输入内容保留在界面上。
 * @param storage - 浏览器存储；不可用时返回 `storage-unavailable`。
 * @param identity - 草稿键。
 * @param input - 要保存的内容。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 写入结果。
 */
export function writeDraft(
  storage: Storage | undefined,
  identity: DraftIdentity,
  input: unknown,
  now: number = Date.now()
): DraftWriteResult {
  if (storage === undefined) return { outcome: 'rejected', reason: 'storage-unavailable' };
  const content = normalizeDraft(input);
  const previous = readDraft(storage, identity);
  const revision = (previous?.revision ?? 0) + 1;
  const record: DraftRecord = { key: identity, ...content, revision, updatedAt: now };
  try {
    storage.setItem(draftStorageKey(identity), JSON.stringify(record));
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const reason: DraftFailureReason =
      name === 'QuotaExceededError' ? 'storage-full' : name === 'SecurityError' ? 'privacy-mode' : 'storage-unavailable';
    return { outcome: 'rejected', reason };
  }
  return { outcome: 'saved', revision };
}

/**
 * 清掉一条草稿。
 * @param storage - 浏览器存储。
 * @param identity - 草稿键。
 */
export function clearDraft(storage: Storage | undefined, identity: DraftIdentity): void {
  if (storage === undefined) return;
  storage.removeItem(draftStorageKey(identity));
}

/**
 * 判断存储是否可读写。
 *
 * 用一次探测写入判断：隐私模式与浏览器清理都会让写入失败，界面需要据此说明草稿只在本次
 * 会话内有效。
 * @param storage - 浏览器存储。
 * @returns 可读写时为真。
 */
export function draftStorageAvailable(storage: Storage | undefined): boolean {
  if (storage === undefined) return false;
  const probe = 'chatdsh-shell.draft.probe';
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取窗口标识。
 *
 * 窗口标识放在会话存储：同一窗口刷新后保持不变，新窗口得到新标识。会话存储不可用时退回
 * 本次页面生命周期内的随机标识，草稿因此在刷新后不再恢复，界面按「存储不可用」说明。
 * @param storage - 会话存储。
 * @param generate - 生成标识的函数。
 * @returns 窗口标识。
 */
export function windowIdentity(storage: Storage | undefined, generate: () => string): string {
  if (storage === undefined) return generate();
  const existing = storage.getItem(WINDOW_KEY);
  if (existing !== null && isIdentifier(existing)) return existing;
  const created = generate();
  storage.setItem(WINDOW_KEY, created);
  return created;
}

/**
 * 取客户端标识。
 * @param storage - 本地存储。
 * @param generate - 生成标识的函数。
 * @returns 客户端标识。
 */
export function clientIdentity(storage: Storage | undefined, generate: () => string): string {
  if (storage === undefined) return generate();
  const existing = storage.getItem(CLIENT_KEY);
  if (existing !== null && isIdentifier(existing)) return existing;
  const created = generate();
  storage.setItem(CLIENT_KEY, created);
  return created;
}
