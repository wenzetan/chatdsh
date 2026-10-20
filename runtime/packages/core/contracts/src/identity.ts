/**
 * 控制平面注入的身份头部。
 *
 * 运行时只绑回环，身份由控制平面在反向代理时写入头部，运行时侧不再做跨账号判定，
 * 进程内的授权层恒为 owner。头部名集中在这里，避免两侧各写一份字面量。
 * @module @chatdsh/core-contracts/identity
 */

/** 控制平面注入的身份头部名。 */
export const IDENTITY_HEADERS = {
  /** 账号标识，控制平面生成的 UUID。 */
  accountId: 'x-chatdsh-account-id',
  /** 工作区标识，会话归属判定使用。 */
  workspaceId: 'x-chatdsh-workspace-id',
  /** 设备标识，执行节点与设备订阅使用。 */
  deviceId: 'x-chatdsh-device-id',
  /** 请求标识，用于把一次客户端请求串到运行时与工具。 */
  requestId: 'x-chatdsh-request-id',
  /** 身份来源，取 `gateway` 表示由控制平面注入。 */
  identitySource: 'x-chatdsh-identity-source',
} as const;

/** 注入身份的形态。 */
export type IdentitySource = 'gateway' | 'direct';

/** 运行时侧解析出的身份。 */
export interface ChatdshIdentity {
  /** 账号标识；直接访问运行时（无控制平面）时为 `local`。 */
  readonly accountId: string;
  /** 当前请求的工作区标识，缺省为 `undefined`。 */
  readonly workspaceId?: string | undefined;
  /** 当前请求的设备标识，缺省为 `undefined`。 */
  readonly deviceId?: string | undefined;
  /** 请求标识，缺省为 `undefined`。 */
  readonly requestId?: string | undefined;
  /** 身份来源。 */
  readonly source: IdentitySource;
}

/** 支持两种头部容器：普通键值表，以及带 `get` 方法的请求头部对象。 */
export type IdentityHeaders = Record<string, string | string[] | undefined> | { get(name: string): string | null };

function isGetter(value: IdentityHeaders): value is { get(name: string): string | null } {
  return typeof (value as { get?: unknown }).get === 'function';
}

/** 从请求头部解析身份。缺失账号头部时按本机直连处理。 */
export function resolveIdentity(headers: IdentityHeaders): ChatdshIdentity {
  const read = (name: string): string | undefined => {
    if (isGetter(headers)) return headers.get(name) ?? undefined;
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
  };
  const accountId = read(IDENTITY_HEADERS.accountId);
  return {
    accountId: accountId ?? 'local',
    workspaceId: read(IDENTITY_HEADERS.workspaceId),
    deviceId: read(IDENTITY_HEADERS.deviceId),
    requestId: read(IDENTITY_HEADERS.requestId),
    source: accountId === undefined ? 'direct' : 'gateway',
  };
}
