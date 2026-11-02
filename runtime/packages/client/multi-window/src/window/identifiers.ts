/**
 * 窗口标识与存储键。
 *
 * 客户端标识放在本地存储，同一浏览器内稳定；窗口标识放在会话存储，同一窗口刷新后保持
 * 不变，第二个窗口得到新标识。草稿键、布局键与标签顺序都按这两个标识区分，因此换窗口、
 * 换设备、换会话互不覆盖。
 * @module @chatdsh/client-multi-window/identifiers
 */

/** 标识长度上限，与会话契约的标识长度一致。 */
export const IDENTIFIER_MAX = 200;

/** 客户端标识的存储键。 */
export const CLIENT_KEY = 'chatdsh-multi-window.client.v1';

/** 窗口标识的存储键；放会话存储，第二窗口因此得到不同标识。 */
export const WINDOW_KEY = 'chatdsh-multi-window.window.v1';

/** 窗口间广播通道名。 */
export const WINDOW_CHANNEL = 'chatdsh-multi-window.windows.v1';

/** 草稿存储键前缀。 */
export const DRAFT_KEY_PREFIX = 'chatdsh-multi-window.draft.v1';

/** 分屏比例存储键前缀。 */
export const SPLIT_KEY_PREFIX = 'chatdsh-multi-window.split.v1';

/**
 * 判断取值是否是可用的标识。
 * @param value - 待判定值。
 * @returns 非空且不超长时为真。
 */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= IDENTIFIER_MAX;
}

/**
 * 断言标识合法。
 * @param name - 标识名称，用于失败说明。
 * @param value - 待判定值。
 * @returns 原取值。
 */
export function assertIdentifier(name: string, value: unknown): string {
  if (!isIdentifier(value)) throw new Error(`${name}不合法：需要 1 到 ${IDENTIFIER_MAX} 个字符`);
  return value;
}

/**
 * 安全地取一个存储面。
 * @param getter - 取存储的函数；隐私模式下访问本身就会抛出。
 * @returns 存储；不可用时返回 `undefined`。
 */
export function safeStorage(getter: () => Storage): Storage | undefined {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

/**
 * 取一个稳定的客户端标识。
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

/**
 * 取窗口标识。
 *
 * 会话存储在同一窗口的多次导航之间保留，在浏览器标签之间隔离，因此第二个窗口必然得到新的
 * 标识。会话存储不可用时退回本次页面生命周期内的随机标识，界面据此说明草稿只在本次停留
 * 期间有效。
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
 * 生成一个随机标识。
 * @returns 十六进制随机标识。
 */
export function randomIdentifier(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
