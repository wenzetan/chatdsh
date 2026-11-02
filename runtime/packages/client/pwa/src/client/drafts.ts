/**
 * 离线草稿：按客户端与窗口隔离，只保留输入内容与已确认的引用。
 *
 * 键由客户端标识、窗口标识、设备与会话四段组成：换窗口、换设备、换会话互不覆盖，同一窗口
 * 刷新后恢复。保存前把外来内容收敛成白名单字段，令牌、凭据、工具原文、记忆查询内容与未确认
 * 附件字节都被丢弃。离线时点击发送只得到拒绝结果：不写待发队列、不发请求、草稿保留。
 * @module @chatdsh/client-pwa/drafts
 */

import type { PwaTelemetry } from './telemetry.ts';

/** 草稿存储键的前缀。 */
export const DRAFT_KEY_PREFIX = 'chatdsh-pwa.draft.v1';

/** 客户端标识的存储键；同一浏览器内稳定。 */
export const CLIENT_KEY = 'chatdsh-pwa.client.v1';

/** 窗口标识的存储键；同一窗口刷新后稳定，第二个窗口不同。 */
export const WINDOW_KEY = 'chatdsh-pwa.window.v1';

/** 上次窗口标识的存储键；浏览器关闭后据此恢复草稿。 */
export const WINDOW_HINT_KEY = 'chatdsh-pwa.window-hint.v1';

/** 窗口间通道名。 */
export const WINDOW_CHANNEL = 'chatdsh-pwa.windows.v1';

/** 探测同源窗口的等待上限，单位毫秒。 */
export const PEER_TIMEOUT_MS = 200;

/** 引用对象的种类。 */
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
  readonly clientId: string;
  readonly windowId: string;
  readonly deviceId: string;
  readonly sessionId?: string;
}

/** 一条离线草稿。 */
export interface OfflineDraft {
  readonly text: string;
  readonly references: readonly DraftReference[];
  readonly attachments: readonly DraftAttachment[];
  readonly revision: number;
  readonly updatedAt: number;
}

/** 草稿写入失败的原因。 */
export type DraftFailureReason = 'storage-full' | 'storage-unavailable' | 'privacy-mode';

/** 草稿写入结果。 */
export interface DraftWriteResult {
  readonly outcome: 'saved' | 'rejected';
  readonly reason?: DraftFailureReason;
  readonly revision?: number;
}

/** 不允许写进草稿的字段名。 */
export const SENSITIVE_DRAFT_KEYS: readonly string[] = [
  'token',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'memoryQuery',
  'toolResult',
  'toolResults',
  'toolCalls',
  'attachmentBytes',
  'file',
];

/** 草稿文本的长度上限。 */
const TEXT_MAX = 262144;

/** 标识长度上限。 */
const IDENTIFIER_MAX = 200;

/** 离线发送的固定结果。 */
export const OFFLINE_SEND_MESSAGE = '当前处于离线状态，发送被阻止，草稿保存在本机';

/** 网络不可达时的发送失败说明。 */
export const NETWORK_SEND_MESSAGE = '网络不可达，发送失败，草稿保存在本机';

/** 一次发送的结论。 */
export interface SendResult {
  readonly outcome: 'sent' | 'rejected';
  readonly code?: 'offline' | 'network' | 'empty';
  readonly message?: string;
  readonly draftKept: boolean;
  readonly queued: false;
}

/** 判断字符串是否是可用的标识。 */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= IDENTIFIER_MAX;
}

/**
 * 打开窗口间通道。
 * @returns 通道；浏览器不支持时为 `null`。
 */
function openWindowChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(WINDOW_CHANNEL);
}

/**
 * 探测同源页面里是否已有窗口。
 * @param channel - 窗口间通道。
 * @param timeoutMs - 等待上限，单位毫秒。
 * @returns 收到回应时为真。
 */
function windowPeerExists(channel: BroadcastChannel, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    channel.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
     channel.postMessage('hello');
  });
}

/**
 * 注册窗口间通道的应答，供后续窗口探测使用。
 * @param channel - 窗口间通道。
 */
function registerWindowResponder(channel: BroadcastChannel | null): void {
  if (channel === null) return;
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data === 'hello') channel.postMessage('peer');
  };
}

/**
 * 取草稿的存储键。
 * @param identity - 草稿键。
 * @returns 存储键；缺少必要标识时抛出。
 */
export function draftStorageKey(identity: DraftIdentity): string {
  if (!isIdentifier(identity.clientId) || !isIdentifier(identity.windowId) || !isIdentifier(identity.deviceId)) {
    throw new Error('草稿键需要客户端、窗口与设备三个标识');
  }
  const session = identity.sessionId === undefined ? 'new' : identity.sessionId;
  return `${DRAFT_KEY_PREFIX}:${identity.clientId}:${identity.windowId}:${identity.deviceId}:${session}`;
}

/**
 * 把外来内容收敛成允许保存的字段。
 * @param input - 外来内容。
 * @returns 文本、引用与已确认附件。
 */
export function sanitizeDraft(input: unknown): Pick<OfflineDraft, 'text' | 'references' | 'attachments'> {
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
 * @param storage - 本地存储。
 * @param identity - 草稿键。
 * @returns 草稿；没有记录或内容不合法时为 `undefined`。
 */
export function readDraft(storage: Storage, identity: DraftIdentity): OfflineDraft | undefined {
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
  const content = sanitizeDraft(record);
  return { ...content, revision, updatedAt };
}

/**
 * 写一条草稿。
 * @param storage - 本地存储。
 * @param identity - 草稿键。
 * @param input - 要保存的内容。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 写入结果。
 */
export function saveDraft(storage: Storage, identity: DraftIdentity, input: unknown, now: number = Date.now()): DraftWriteResult {
  const content = sanitizeDraft(input);
  const previous = readDraft(storage, identity);
  const revision = (previous?.revision ?? 0) + 1;
  try {
    storage.setItem(
      draftStorageKey(identity),
      JSON.stringify({ ...content, revision, updatedAt: now })
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const reason: DraftFailureReason = name === 'QuotaExceededError'
      ? 'storage-full'
      : name === 'SecurityError'
        ? 'privacy-mode'
        : 'storage-unavailable';
    return { outcome: 'rejected', reason };
  }
  return { outcome: 'saved', revision };
}

/**
 * 清掉一条草稿。
 * @param storage - 本地存储。
 * @param identity - 草稿键。
 */
export function clearDraft(storage: Storage, identity: DraftIdentity): void {
  storage.removeItem(draftStorageKey(identity));
}

/**
 * 取客户端标识。
 * @param storage - 本地存储。
 * @param generate - 生成标识的函数。
 * @returns 客户端标识。
 */
export function clientIdentity(storage: Storage, generate: () => string): string {
  const existing = storage.getItem(CLIENT_KEY);
  if (existing !== null && isIdentifier(existing)) return existing;
  const created = generate();
  storage.setItem(CLIENT_KEY, created);
  return created;
}

/**
 * 取窗口标识。
 *
 * 会话存储里的标识在刷新后保持稳定；第二个窗口用窗口间通道探测同源页面，存在其它窗口时生成
 * 新标识，草稿因此互不覆盖。浏览器关闭后会话存储清空，此时沿用本地存储里记录的上次窗口
 * 标识，草稿在重新打开浏览器后恢复。
 * @param options - 会话存储、本地存储、标识生成函数与通道覆盖。
 * @returns 窗口标识与是否沿用上次窗口。
 */
export async function resolveWindowIdentity(options: {
  readonly session: Storage;
  readonly storage: Storage;
  readonly generate: () => string;
  readonly channel?: BroadcastChannel | null;
  readonly peerTimeoutMs?: number;
}): Promise<{ readonly windowId: string; readonly resumed: boolean }> {
  const channel = options.channel === undefined ? openWindowChannel() : options.channel;
  const existing = options.session.getItem(WINDOW_KEY);
  if (existing !== null && isIdentifier(existing)) {
    options.storage.setItem(WINDOW_HINT_KEY, existing);
    registerWindowResponder(channel);
    return { windowId: existing, resumed: false };
  }
  const hasPeer = channel === null ? false : await windowPeerExists(channel, options.peerTimeoutMs ?? PEER_TIMEOUT_MS);
  const hint = options.storage.getItem(WINDOW_HINT_KEY);
  const resumed = !hasPeer && hint !== null && isIdentifier(hint);
  const windowId = resumed ? hint : options.generate();
  options.session.setItem(WINDOW_KEY, windowId);
  options.storage.setItem(WINDOW_HINT_KEY, windowId);
  registerWindowResponder(channel);
  return { windowId, resumed };
}

/**
 * 判定一次发送。
 *
 * 离线时直接拒绝：不发请求、不排队。在线时向目标地址提交文本，网络或服务端失败同样拒绝并
 * 保留草稿；任何情况下都不自动重发。
 * @param options - 目标地址、在线状态、文本与依赖。
 * @returns 发送结论。
 */
export async function submitDraft(options: {
  readonly endpoint: string;
  readonly text: string;
  readonly online: boolean;
  readonly fetchImpl: typeof fetch;
  readonly telemetry?: PwaTelemetry;
}): Promise<SendResult> {
  if (options.text.trim() === '') {
    return { outcome: 'rejected', code: 'empty', message: '输入区没有内容', draftKept: true, queued: false };
  }
  if (!options.online) {
    options.telemetry?.action('draft-send', 'rejected');
    return { outcome: 'rejected', code: 'offline', message: OFFLINE_SEND_MESSAGE, draftKept: true, queued: false };
  }
  let response: Response;
  try {
    response = await options.fetchImpl(options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: options.text }),
    });
  } catch (error) {
    options.telemetry?.failure('draft-send', error);
    return { outcome: 'rejected', code: 'network', message: NETWORK_SEND_MESSAGE, draftKept: true, queued: false };
  }
  if (!response.ok) {
    options.telemetry?.failure('draft-send', new Error(`服务端拒绝发送：${String(response.status)}`));
    return { outcome: 'rejected', code: 'network', message: '发送失败，草稿保留在本机', draftKept: true, queued: false };
  }
  options.telemetry?.action('draft-send', 'ok');
  return { outcome: 'sent', draftKept: true, queued: false };
}
