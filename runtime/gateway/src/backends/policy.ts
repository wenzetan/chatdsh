/**
 * 聊天与记忆后端的开关规则。
 *
 * 控制平面持有这两个开关。合法组合只有五种：记忆取 `hermes` 依附于 Hermes 承载的聊天
 * 会话，聊天取 `dsh` 时它无从产生，这一组合不在清单里。配置带修订号，写入携带读到的
 * 修订号，落后即拒绝，两台设备同时改写时不会静默覆盖。
 *
 * 校验是纯计算，失败就地抛出；这里不读写文件，也不做网络调用。
 * @module @chatdsh/gateway/backends/policy
 */

/** 聊天后端的标识。 */
export const CHAT_BACKENDS = ['dsh', 'hermes'] as const;

/** 记忆后端的标识。 */
export const MEMORY_BACKENDS = ['none', 'hindsight', 'hermes'] as const;

/** 聊天后端标识。 */
export type ChatBackendId = typeof CHAT_BACKENDS[number];

/** 记忆后端标识。 */
export type MemoryBackendId = typeof MEMORY_BACKENDS[number];

/** 一份运行期后端配置。 */
export interface BackendSelection {
  /** 修订号，每次成功保存加一。 */
  readonly revision: number;
  /** 聊天后端。 */
  readonly chatBackend: ChatBackendId;
  /** 记忆后端。 */
  readonly memoryBackend: MemoryBackendId;
}

/** 一种后端组合。 */
export interface BackendCombination {
  /** 聊天后端。 */
  readonly chatBackend: ChatBackendId;
  /** 记忆后端。 */
  readonly memoryBackend: MemoryBackendId;
}

/** 合法组合清单。 */
export const LEGAL_COMBINATIONS: readonly BackendCombination[] = [
  { chatBackend: 'dsh', memoryBackend: 'none' },
  { chatBackend: 'dsh', memoryBackend: 'hindsight' },
  { chatBackend: 'hermes', memoryBackend: 'none' },
  { chatBackend: 'hermes', memoryBackend: 'hindsight' },
  { chatBackend: 'hermes', memoryBackend: 'hermes' },
];

/** 尚未写入任何配置时的取值：聊天由 DSH 承载，记忆不启用。 */
export const DEFAULT_BACKEND_SELECTION: BackendSelection = Object.freeze({
  revision: 0,
  chatBackend: 'dsh',
  memoryBackend: 'none',
});

/** 配置被拒绝的失败码。 */
export type BackendSettingsErrorCode =
  | 'invalid-revision'
  | 'unknown-chat-backend'
  | 'unknown-memory-backend'
  | 'invalid-combination'
  | 'revision-stale'
  | 'hermes-unconfigured'
  | 'settings-corrupt'
  | 'settings-write-failed';

/** 后端配置被拒绝。 */
export class BackendSettingsError extends Error {
  /** 失败码，写入诊断与遥测。 */
  readonly code: BackendSettingsErrorCode;
  /** 拒绝时该采用的最新修订号。 */
  readonly revision: number | undefined;

  constructor(code: BackendSettingsErrorCode, message: string, revision?: number) {
    super(message);
    this.name = 'BackendSettingsError';
    this.code = code;
    this.revision = revision;
  }
}

/** 标识是否属于聊天后端。 */
export function isChatBackendId(value: unknown): value is ChatBackendId {
  return typeof value === 'string' && (CHAT_BACKENDS as readonly string[]).includes(value);
}

/** 标识是否属于记忆后端。 */
export function isMemoryBackendId(value: unknown): value is MemoryBackendId {
  return typeof value === 'string' && (MEMORY_BACKENDS as readonly string[]).includes(value);
}

/** 一组组合是否合法。 */
export function isLegalCombination(chatBackend: unknown, memoryBackend: unknown): boolean {
  if (!isChatBackendId(chatBackend) || !isMemoryBackendId(memoryBackend)) return false;
  return LEGAL_COMBINATIONS.some(
    (item) => item.chatBackend === chatBackend && item.memoryBackend === memoryBackend,
  );
}

/**
 * 断言一组组合可以保存。
 * @param chatBackend - 聊天后端标识。
 * @param memoryBackend - 记忆后端标识。
 * @throws {BackendSettingsError} 标识未知或组合不在清单里。
 */
export function assertCombination(chatBackend: unknown, memoryBackend: unknown): void {
  if (!isChatBackendId(chatBackend)) {
    throw new BackendSettingsError(
      'unknown-chat-backend',
      `未知的聊天后端 ${JSON.stringify(chatBackend)}；可用取值：${CHAT_BACKENDS.join('、')}`,
    );
  }
  if (!isMemoryBackendId(memoryBackend)) {
    throw new BackendSettingsError(
      'unknown-memory-backend',
      `未知的记忆后端 ${JSON.stringify(memoryBackend)}；可用取值：${MEMORY_BACKENDS.join('、')}`,
    );
  }
  if (!isLegalCombination(chatBackend, memoryBackend)) {
    throw new BackendSettingsError(
      'invalid-combination',
      `聊天后端 ${chatBackend} 与记忆后端 ${memoryBackend} 不能同时选择；记忆取 hermes 只在聊天取 hermes 时成立`,
    );
  }
}

/** 组合的稳定键，用于诊断与去重。 */
export function combinationKey(chatBackend: ChatBackendId, memoryBackend: MemoryBackendId): string {
  return `${chatBackend}+${memoryBackend}`;
}

/**
 * 解析一份从磁盘或请求里读到的配置。
 *
 * 修订号必须是非负整数，两个标识必须在清单里，组合必须合法。形状不符时就地抛出，
 * 不补齐默认值掩盖损坏的文件。
 * @param value - 待解析的取值。
 */
export function parseBackendSelection(value: unknown): BackendSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackendSettingsError('settings-corrupt', '后端配置不是对象');
  }
  const record = value as Record<string, unknown>;
  const revision = record.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new BackendSettingsError('invalid-revision', `修订号必须是非负整数，收到 ${JSON.stringify(revision)}`);
  }
  assertCombination(record.chatBackend, record.memoryBackend);
  return {
    revision,
    chatBackend: record.chatBackend as ChatBackendId,
    memoryBackend: record.memoryBackend as MemoryBackendId,
  };
}

/** 记忆能力是否启用。 */
export function memoryEnabled(memoryBackend: MemoryBackendId): boolean {
  return memoryBackend !== 'none';
}

/** 记忆后端是否依赖 Hermes 承载的聊天。 */
export function requiresHermesChat(memoryBackend: MemoryBackendId): boolean {
  return memoryBackend === 'hermes';
}

/** 聊天后端是否依赖外部或托管的 Hermes。 */
export function requiresHermes(chatBackend: ChatBackendId): boolean {
  return chatBackend === 'hermes';
}

/** 供界面与诊断显示的一行说明。 */
export function describeSelection(selection: BackendSelection): string {
  return `修订 ${selection.revision}：聊天 ${selection.chatBackend}，记忆 ${selection.memoryBackend}`;
}
