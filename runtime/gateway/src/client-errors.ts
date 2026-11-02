import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatdshErrorCode } from '@chatdsh/core-contracts';

/** 客户端可处理的错误，响应内容使用固定描述。 */
export class ClientHttpError extends Error {
  constructor(readonly status: number, readonly code: ChatdshErrorCode) {
    super(code);
    this.name = 'ClientHttpError';
  }
}

/** 关联标识由服务端生成，避免把外来文本写入响应头和遥测。 */
export function clientRequestId(_request: IncomingMessage): string {
  return randomUUID();
}

/** 私有读取与错误响应统一禁止浏览器和代理保存。 */
export function setClientResponseHeaders(response: ServerResponse, requestId: string): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('Vary', 'Cookie, Authorization, Origin');
}

export function sendClientJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/** 内部异常不携带数据库错误、凭据或路径返回客户端。 */
export function sendClientError(response: ServerResponse, error: unknown, requestId: string): ClientHttpError {
  const failure = error instanceof ClientHttpError ? error : new ClientHttpError(500, 'internal-error');
  sendClientJson(response, failure.status, { error: { code: failure.code, requestId } });
  return failure;
}
