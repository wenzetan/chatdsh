/**
 * 访问会话与一次性票据。
 *
 * 会话令牌取 256 位随机值，只在下发时以 base64url 形式写入 HttpOnly Cookie，服务器只保存
 * SHA-256 摘要。有效期 30 天，到期前 7 天内的活动把到期时刻推后到「当前时刻 + 30 天」，续期
 * 只在窗口内写库，避免每个请求都更新行。撤销即时生效，撤销后的令牌一律拒绝。
 *
 * 一次性票据用于两处：密码通过后的第二因素票据，与浏览器 WebSocket 的连接票据。票据本体只在
 * 返回时出现，库里同样是摘要，消费是一次带条件的更新。
 * @module @chatdsh/gateway/access/session
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  ACCESS_SECURITY,
  ACCESS_SESSION_RENEW_WINDOW_SECONDS,
  ACCESS_SESSION_TTL_SECONDS,
  type AccessSession,
} from '@chatdsh/core-contracts';
import type { AccessSessionRow } from './store.ts';

/** 会话绝对有效期，单位毫秒。 */
export const ACCESS_SESSION_TTL_MS = ACCESS_SESSION_TTL_SECONDS * 1000;

/** 到期前允许续期的窗口，单位毫秒。 */
export const ACCESS_SESSION_RENEW_WINDOW_MS = ACCESS_SESSION_RENEW_WINDOW_SECONDS * 1000;

/** 第二因素票据的有效期，单位毫秒。 */
export const SECOND_FACTOR_TICKET_TTL_MS = 5 * 60 * 1000;

/** WebSocket 连接票据的有效期，单位毫秒。 */
export const WEBSOCKET_TICKET_TTL_MS = ACCESS_SECURITY.ticketTtlSeconds * 1000;

/** 活动时刻写库的最小间隔，单位毫秒。 */
export const ACTIVITY_TOUCH_INTERVAL_MS = 60 * 1000;

/** 票据种类。 */
export type AccessTicketKind = 'second-factor' | 'websocket';

/** 命令行客户端携带会话令牌的请求头名。 */
const BEARER_HEADER = 'authorization';

/** 令牌前缀。 */
const BEARER_PREFIX = 'Bearer ';

/** 生成一张新的访问会话令牌，256 位随机。 */
export function newAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 生成一张一次性票据，128 位随机。 */
export function newTicket(): string {
  return randomBytes(16).toString('base64url');
}

/** 会话标识。 */
export function newSessionId(): string {
  return randomUUID();
}

/** 令牌摘要：库里只保存它，令牌本体不落库。 */
export function accessTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 票据摘要。 */
export function accessTicketHash(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/** 会话记录到契约形状的投影。 */
export function accessSessionView(row: AccessSessionRow, options: { readonly currentSessionId?: string }): AccessSession {
  return {
    sessionId: row.sessionId,
    clientName: row.clientName,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    expiresAt: row.expiresAt,
    renewableFrom: row.expiresAt - ACCESS_SESSION_RENEW_WINDOW_MS,
    current: row.sessionId === options.currentSessionId,
    revokedAt: row.revokedAt,
  };
}

/**
 * 续期判定：已过期返回不应继续使用，处在续期窗口内返回应把到期时刻推后。
 * @param row - 会话记录。
 * @param now - 当前时刻，单位毫秒。
 * @returns 过期标记、续期标记与新的到期时刻。
 */
export function renewalOf(row: AccessSessionRow, now: number): { readonly expired: boolean; readonly renew: boolean; readonly expiresAt: number } {
  if (row.expiresAt <= now) return { expired: true, renew: false, expiresAt: row.expiresAt };
  if (now < row.expiresAt - ACCESS_SESSION_RENEW_WINDOW_MS) return { expired: false, renew: false, expiresAt: row.expiresAt };
  return { expired: false, renew: true, expiresAt: now + ACCESS_SESSION_TTL_MS };
}

/**
 * 序列化访问会话 Cookie。
 * @param token - 会话令牌。
 * @param maxAgeSeconds - 有效期秒数。
 * @returns `Set-Cookie` 头的值。
 */
export function serializeAccessCookie(token: string, maxAgeSeconds: number): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('访问会话令牌格式不合法');
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error('Cookie 有效期必须为正整数');
  return [
    `${ACCESS_SECURITY.sessionCookie}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** 清除访问会话 Cookie 的 `Set-Cookie` 头值。 */
export function clearAccessCookie(): string {
  return [`${ACCESS_SECURITY.sessionCookie}=`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0'].join('; ');
}

/**
 * 从请求里取访问会话令牌。Cookie 优先，其次接受 `Authorization: Bearer`，供命令行客户端使用。
 * @param request - 传入请求。
 * @returns 令牌，或 `undefined`。
 */
export function accessTokenOf(request: IncomingMessage): string | undefined {
  const cookie = cookieValue(request.headers.cookie, ACCESS_SECURITY.sessionCookie);
  if (cookie !== undefined) return cookie;
  const header = request.headers[BEARER_HEADER];
  const value = Array.isArray(header) ? header.at(0) : header;
  if (typeof value !== 'string' || !value.startsWith(BEARER_PREFIX)) return undefined;
  const token = value.slice(BEARER_PREFIX.length).trim();
  return token === '' ? undefined : token;
}

/** 请求是否以 Cookie 认证；写入请求需要据此要求 CSRF 令牌。 */
export function isCookieAuthentication(request: IncomingMessage): boolean {
  return cookieValue(request.headers.cookie, ACCESS_SECURITY.sessionCookie) !== undefined;
}

/**
 * 从请求头里取某个 Cookie 的值。
 * @param header - `Cookie` 头原文。
 * @param name - Cookie 名。
 * @returns 值，或 `undefined`。
 */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}
