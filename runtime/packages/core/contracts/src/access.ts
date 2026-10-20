/**
 * 可达性提供方。
 *
 * 「客户端怎么到达控制平面」被抽象成一层：对外地址、TLS 材料、请求来源的身份、诊断状态
 * 四件事。首期只实现 Tailscale，其余方案按同一形状补齐。
 * @module @chatdsh/core-contracts/access
 */

/** 从一次请求里解析出的来源身份。 */
export interface AccessIdentity {
  /** 提供方注入的登录标识；没有时为空。 */
  readonly login?: string | undefined;
  /** 显示名。 */
  readonly displayName?: string | undefined;
  /** 提供方名字，用于审计。 */
  readonly source?: string | undefined;
}

/** 请求头的样子，既能是对象也能是 Headers。 */
export type AccessHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

/** 一个可达性提供方。 */
export interface AccessProvider {
  /** 提供方名字。 */
  readonly name: string;
  /** 对外可达地址；由外部终止 TLS 时也填这一项，便于下发给客户端。 */
  readonly publicUrl?: string;
  /** 解析来源身份。 */
  identityOf(headers: AccessHeaders): AccessIdentity;
  /** 诊断状态，键值都是字符串。 */
  status(): Record<string, string>;
}

/** Tailscale 注入的头部名。 */
export const TAILSCALE_HEADERS = {
  login: 'tailscale-user-login',
  name: 'tailscale-user-name',
} as const;

/** 读取一个头部，兼容对象与 Headers 两种形状。 */
function read(headers: AccessHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const value = (headers as Record<string, string | string[] | undefined>)[name]
    ?? (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Tailscale 提供方：身份来自 Serve 注入的头部。
 * @returns 提供方实例。
 */
export function tailscaleProvider(): AccessProvider {
  return {
    name: 'tailscale',
    identityOf(headers: AccessHeaders): AccessIdentity {
      const login = read(headers, TAILSCALE_HEADERS.login);
      const displayName = read(headers, TAILSCALE_HEADERS.name);
      return {
        login,
        displayName,
        source: login === undefined ? undefined : 'tailscale',
      };
    },
    status(): Record<string, string> {
      return { provider: 'tailscale' };
    },
  };
}

/**
 * 手动提供方：用户自备反代，没有来源身份。
 * @returns 提供方实例。
 */
export function manualProvider(): AccessProvider {
  return {
    name: 'manual',
    identityOf(): AccessIdentity {
      return {};
    },
    status(): Record<string, string> {
      return { provider: 'manual' };
    },
  };
}
