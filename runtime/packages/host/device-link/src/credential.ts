/**
 * 本机运行时界面凭据的换取与按路径选择。
 *
 * 索引页与 Remote 端点使用同名的两份 cookie，值不同，只能按路径分别补发。
 * @module @chatdsh/host-device-link/credential
 */

/** 运行时界面凭据的 cookie 名前缀。 */
export const CREDENTIAL_COOKIE_PREFIX = 'dsh-auth-';

/** 本机界面凭据：索引页与 Remote 端点要求的两份 cookie。 */
export interface LocalCredential {
  /** 凭据对应的本机地址；地址变了要重新换取。 */
  readonly origin: string;
  /** 页面凭据：`/` 的索引页要求它。 */
  readonly page: string;
  /** API 凭据：`/api/` 的 Remote 调用要求它。 */
  readonly api: string;
}

/**
 * 用一次带启动口令的请求换一份 cookie。
 * @param url - 带口令的本机地址。
 * @returns `名=值` 形式的 cookie。
 */
export async function mintCookie(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '')
    .find((value) => value.startsWith(CREDENTIAL_COOKIE_PREFIX));
  if (cookie === undefined || cookie === '') {
    throw new Error(`device-link: ${new URL(url).pathname} 没有下发界面凭据（HTTP ${response.status}）`);
  }
  return cookie;
}

/**
 * 请求里是否已经带了本机界面凭据。
 *
 * 调用方自带凭据时原样转发，不补发，凭据归属的判断仍然落在接收请求的那台运行时上。
 * @param cookie - 请求的 Cookie 头。
 * @returns 有凭据时为真。
 */
export function hasLocalCredential(cookie: string | undefined): boolean {
  if (cookie === undefined) return false;
  return cookie.split(';').some((part) => part.trim().startsWith(CREDENTIAL_COOKIE_PREFIX));
}

/**
 * 按路径选要补发的凭据。
 * @param credential - 本机凭据。
 * @param path - 转发给本机运行时的路径，可带查询串。
 * @returns 要补发的 cookie；这个路径不需要凭据时为空。
 */
export function credentialFor(credential: LocalCredential, path: string): string | undefined {
  const pathname = path.split('?')[0] ?? '/';
  if (pathname === '/' || pathname === '/index.html') return credential.page;
  if (pathname.startsWith('/api/')) return credential.api;
  return undefined;
}

/** 设备端换取凭据的入口；401 重试时由实现方丢弃缓存后再次调用。 */
export interface CredentialProvider {
  /** 取当前凭据；实现方负责缓存。 */
  get(): Promise<LocalCredential>;
  /** 丢弃缓存并重新换取。 */
  refresh(): Promise<LocalCredential>;
}
