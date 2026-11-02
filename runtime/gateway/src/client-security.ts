import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ClientHttpError } from './client-errors.ts';

/** 只能由认证服务返回，设备标识请求头不参与身份判断。 */
export interface ClientPrincipal {
  readonly clientId: string;
  readonly authentication: 'cookie' | 'bearer';
  readonly expiresAt: number;
  readonly deviceIds: readonly string[] | 'all';
  readonly csrfToken?: string;
}

export interface ClientSecurityOptions {
  readonly origin: string;
  readonly authenticate: (request: IncomingMessage) => ClientPrincipal | undefined | Promise<ClientPrincipal | undefined>;
}

/** 配置地址必须为精确 origin，不接受路径、用户信息和通配来源。 */
export function validateClientOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error('客户端来源配置需要精确 HTTP 或 HTTPS origin');
  }
  return url.origin;
}

/** 在调用任何业务读取之前校验认证、来源和写入令牌。 */
export async function authorizeClientRequest(request: IncomingMessage, options: ClientSecurityOptions): Promise<ClientPrincipal> {
  const origin = validateClientOrigin(options.origin);
  const principal = await options.authenticate(request);
  if (principal === undefined) throw new ClientHttpError(401, 'auth-required');
  if (!Number.isFinite(principal.expiresAt) || principal.expiresAt <= Date.now()) {
    throw new ClientHttpError(401, 'access-session-revoked');
  }
  if (request.headers.host !== new URL(origin).host) throw new ClientHttpError(403, 'origin-rejected');
  const suppliedOrigin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  if ((suppliedOrigin !== undefined && suppliedOrigin !== origin) || fetchSite === 'cross-site' || fetchSite === 'same-site') {
    throw new ClientHttpError(403, 'origin-rejected');
  }
  const writes = !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET');
  if (writes && suppliedOrigin !== origin) throw new ClientHttpError(403, 'origin-rejected');
  if (writes && principal.authentication === 'cookie') {
    const supplied = request.headers['x-chatdsh-csrf'];
    const expected = principal.csrfToken;
    if (typeof supplied !== 'string' || expected === undefined || expected.length < 32 || supplied.length > 512) {
      throw new ClientHttpError(403, 'csrf-rejected');
    }
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ClientHttpError(403, 'csrf-rejected');
  }
  return principal;
}

export function assertClientDevice(principal: ClientPrincipal, deviceId: string): void {
  if (principal.deviceIds !== 'all' && !principal.deviceIds.includes(deviceId)) {
    throw new ClientHttpError(403, 'permission-denied');
  }
}
