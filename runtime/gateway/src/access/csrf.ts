/**
 * 写入请求的 CSRF 与精确来源校验。
 *
 * 访问会话令牌放在 HttpOnly Cookie 里，浏览器脚本读不到；跨站页面虽然能带上 Cookie，却拿不到
 * CSRF 令牌。CSRF 令牌由部署的 CSRF 子密钥对会话令牌摘要做 HMAC-SHA256 派生，逐会话唯一、
 * 不需要额外存库，重新下发时再次派生即可得到同一个值。
 *
 * 来源校验要求 Host、Origin 与 `Sec-Fetch-Site` 三者同时成立：任何一项不符合就拒绝，写入请求
 * 必须携带 Origin。该校验供访问路由自用，业务路由由 `client-security.ts` 的
 * `authorizeClientRequest` 执行同一组规则。
 * @module @chatdsh/gateway/access/csrf
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ChatdshError } from '@chatdsh/core-contracts';
import { ACCESS_SECURITY } from '@chatdsh/core-contracts';

/** 读取方法之外的方法一律按写入处理。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 派生一个会话的 CSRF 令牌。
 * @param key - CSRF 子密钥。
 * @param sessionTokenHash - 会话令牌摘要的十六进制写法。
 * @returns base64url 写法的令牌。
 */
export function issueCsrfToken(key: Buffer, sessionTokenHash: string): string {
  return createHmac('sha256', key).update(`csrf/v1:${sessionTokenHash}`, 'utf8').digest('base64url');
}

/**
 * 恒定时间比较客户端提交的 CSRF 令牌。
 * @param supplied - 请求头里的令牌。
 * @param expected - 服务端派生出的令牌。
 * @returns 是否匹配。
 */
export function verifyCsrfToken(supplied: string | undefined, expected: string | undefined): boolean {
  if (typeof supplied !== 'string' || expected === undefined) return false;
  if (supplied.length > 512 || expected.length < 32) return false;
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 校验请求来源与固定 origin 完全一致。任何不符都抛出 `origin-rejected`。
 * @param request - 传入请求。
 * @param origin - 部署固定的精确 origin。
 */
export function assertExactOrigin(request: IncomingMessage, origin: string): void {
  const expectedHost = new URL(origin).host;
  if (request.headers.host !== expectedHost) throw new ChatdshError('origin-rejected', '请求 Host 与部署来源不符');
  const supplied = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (supplied !== undefined && supplied !== origin) throw new ChatdshError('origin-rejected', '请求 Origin 与部署来源不符');
  if (site === 'cross-site' || site === 'same-site') throw new ChatdshError('origin-rejected', '子资源来源与部署来源不符');
  if (!SAFE_METHODS.has(request.method ?? 'GET') && supplied !== origin) {
    throw new ChatdshError('origin-rejected', '写入请求必须携带精确来源');
  }
}

/**
 * 校验写入请求的 CSRF 令牌，只对 Cookie 认证的请求生效。
 * @param request - 传入请求。
 * @param expected - 服务端派生出的令牌。
 */
export function assertCsrfToken(request: IncomingMessage, expected: string): void {
  if (SAFE_METHODS.has(request.method ?? 'GET')) return;
  const supplied = request.headers[ACCESS_SECURITY.csrfHeader];
  const value = Array.isArray(supplied) ? supplied.at(0) : supplied;
  if (!verifyCsrfToken(value, expected)) throw new ChatdshError('csrf-rejected', '写入请求的 CSRF 令牌不匹配');
}
