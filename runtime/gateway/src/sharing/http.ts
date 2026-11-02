/**
 * 分享路由：公开页、附件下载与控制平面的分享管理接口。
 *
 * 公共入口的挂载由发行集成处理；这里提供挂载所需的路由函数，测试用真实 HTTP 服务装配它。
 * 公开页响应头禁止脚本与非同源资源，附件下载强制按附件处理并禁止内联渲染。管理接口要求
 * 请求者身份校验，写动作由校验方同时核对来源与 CSRF。
 * @module @chatdsh/gateway/sharing/http
 */

import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { renderPublicPage, renderShareUnavailablePage } from '../render.ts';
import { renderSharePrintPage } from '../exports/print.ts';
import type { TimeDisplayOptions } from '../exports/document.ts';
import { ShareError } from './types.ts';
import type { ShareAuthorize, ShareCreateInput, SharePreviewInput, ShareRange } from './types.ts';
import type { ShareService } from './service.ts';
import { ATTACHMENT_ID_PATTERN, SHARE_TOKEN_PATTERN } from './attachments.ts';

/** 管理接口路径。 */
export const SHARE_LIST_PATH = '/chatdsh/gateway/shares';
export const SHARE_PATH = '/chatdsh/gateway/share';
export const SHARE_PREVIEW_PATH = '/chatdsh/gateway/share/preview';

/** 公开页路径前缀。 */
export const PUBLIC_SHARE_PREFIX = '/s/';

/** 请求体上限。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 一次分享最多登记的附件数。 */
const MAX_ATTACHMENTS = 100;

/** 管理接口的响应头。 */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** 公开页的响应头：没有脚本，没有非同源资源。 */
const PUBLIC_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** 公开页打印视图的时间显示方式：本机时区。 */
const PRINT_TIME: TimeDisplayOptions = {
  timeDisplay: 'local',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

/** 管理接口的请求方法。 */
type OwnerAction = 'read' | 'write';

/** 路由处理函数。 */
export type ShareHttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/** 装配分享路由所需的依赖。 */
export interface ShareHttpOptions {
  readonly service: ShareService;
  readonly authorize: ShareAuthorize;
  readonly telemetry: ChatdshTelemetry;
}

/** 发 JSON 应答。 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(Buffer.byteLength(text, 'utf8')) });
  response.end(text);
}

/** 发 HTML 应答。 */
function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { ...PUBLIC_PAGE_HEADERS, 'Content-Length': String(Buffer.byteLength(html, 'utf8')) });
  response.end(html);
}

/** RFC 5987 文件名编码：只保留 attr-char，其余按 UTF-8 百分号编码。 */
function encodeFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 解码路径段；编码不合法时返回空串，由调用方按未知令牌处理。 */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/** 发附件应答。 */
function sendAttachment(response: ServerResponse, filename: string, mimeType: string, bytes: Uint8Array): void {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, '_').replaceAll('"', '_').replaceAll('\\', '_');
  response.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': String(bytes.byteLength),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeFilename(filename)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'X-Download-Options': 'noopen',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  });
  response.end(bytes);
}

/** 读请求体并解析 JSON。 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number.parseInt(declared, 10) > MAX_BODY_BYTES) {
    throw new ShareError(CHATDSH_ERROR_CODES.payloadTooLarge, 'body-too-large', '请求体超过上限');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new ShareError(CHATDSH_ERROR_CODES.payloadTooLarge, 'body-too-large', '请求体超过上限');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'body-empty', '请求体为空');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'body-json', '请求体无法解析为 JSON');
  }
}

/** 断言对象。 */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'body-shape', `${what}必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** 读会话标识。 */
function readSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'session-id', '缺少会话标识');
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 200 || /\s/u.test(trimmed)) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'session-id', '会话标识不合法');
  }
  return trimmed;
}

/** 读范围。 */
function readRange(value: unknown): ShareRange {
  const record = asRecord(value, '范围');
  const mode = record['mode'];
  if (mode === 'session') return { mode: 'session' };
  if (mode === 'turns') {
    const turns = record['turns'];
    if (!Array.isArray(turns)) {
      throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'turns-shape', '指定回合集合必须是数组');
    }
    return { mode: 'turns', turns: turns.map((turn) => (typeof turn === 'number' ? turn : Number.NaN)) };
  }
  if (mode === 'range') {
    return {
      mode: 'range',
      turnFrom: typeof record['turnFrom'] === 'number' ? record['turnFrom'] : Number.NaN,
      turnTo: typeof record['turnTo'] === 'number' ? record['turnTo'] : Number.NaN,
    };
  }
  if (mode === 'bound') {
    return { mode: 'bound', upToSeq: typeof record['upToSeq'] === 'number' ? record['upToSeq'] : Number.NaN };
  }
  throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'range-mode', '范围方式只接受 session、turns、range 与 bound');
}

/** 读文本选择与附件选择。 */
function readSelection(body: Record<string, unknown>): {
  readonly includeUserText: boolean;
  readonly includeAssistantText: boolean;
  readonly attachmentIds: string[];
} {
  const scope = body['scope'];
  if (scope !== undefined && (typeof scope !== 'object' || scope === null || Array.isArray(scope))) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'scope-shape', '分享范围必须是对象');
  }
  const record = (scope ?? {}) as Record<string, unknown>;
  const includeUserText = record['includeUserText'] === undefined ? true : record['includeUserText'] === true;
  const includeAssistantText = record['includeAssistantText'] === undefined ? true : record['includeAssistantText'] === true;
  if (!includeUserText && !includeAssistantText) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'text-selection', '分享范围至少包含用户消息或助手消息');
  }
  const raw = record['attachmentIds'] ?? body['attachmentIds'] ?? [];
  if (!Array.isArray(raw)) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachments-shape', '附件选择必须是数组');
  }
  if (raw.length > MAX_ATTACHMENTS) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachments-too-many', `一次最多选择 ${String(MAX_ATTACHMENTS)} 个附件`);
  }
  const attachmentIds = raw.map((item) => {
    if (typeof item !== 'string' || !ATTACHMENT_ID_PATTERN.test(item)) {
      throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'attachment-id', '附件标识不合法');
    }
    return item;
  });
  return { includeUserText, includeAssistantText, attachmentIds };
}

/** 范围优先级：显式范围，其次旧接口的上界，再次范围里的回合边界，最后整段会话。 */
function resolveRequestedRange(body: Record<string, unknown>, scope: Record<string, unknown> | undefined): ShareRange {
  const explicit = body['range'];
  if (explicit !== undefined) return readRange(explicit);
  const legacyBound = body['upToSeq'];
  if (typeof legacyBound === 'number') return { mode: 'bound', upToSeq: legacyBound };
  const content = scope?.['scope'];
  if (content !== undefined) {
    const record = asRecord(content, '内容范围');
    const turnFrom = record['turnFrom'];
    const turnTo = record['turnTo'];
    if (typeof turnFrom === 'number' && typeof turnTo === 'number') {
      return { mode: 'range', turnFrom, turnTo };
    }
  }
  return { mode: 'session' };
}

/** 读可选的整数。 */
function readOptionalInteger(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, `${key}-invalid`, `${key} 必须是非负整数`);
  }
  return value;
}

/** 读操作标识与请求摘要。 */
function readOperation(body: Record<string, unknown>): { operationId?: string; requestDigest?: string } {
  const operationId = body['operationId'];
  const requestDigest = body['requestDigest'];
  if (operationId === undefined && requestDigest === undefined) return {};
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(operationId)) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'operation-id', '操作标识不合法');
  }
  if (typeof requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(requestDigest)) {
    throw new ShareError(CHATDSH_ERROR_CODES.requestInvalid, 'request-digest', '请求摘要必须是 64 位小写十六进制');
  }
  return { operationId, requestDigest };
}

/** 解析建立请求。 */
function parseCreate(body: unknown): ShareCreateInput {
  const record = asRecord(body, '建立分享的请求');
  const selection = readSelection(record);
  const scope = record['scope'];
  const operation = readOperation(record);
  const ttlMs = readOptionalInteger(record, 'ttlMs');
  return {
    sessionId: readSessionId(record['sessionId']),
    range: resolveRequestedRange(record, scope as Record<string, unknown> | undefined),
    includeUserText: selection.includeUserText,
    includeAssistantText: selection.includeAssistantText,
    attachmentIds: selection.attachmentIds,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...operation,
  };
}

/** 解析预览请求。 */
function parsePreview(body: unknown): SharePreviewInput {
  const record = asRecord(body, '预览请求');
  const selection = readSelection(record);
  const scope = record['scope'];
  return {
    sessionId: readSessionId(record['sessionId']),
    range: resolveRequestedRange(record, scope as Record<string, unknown> | undefined),
    includeUserText: selection.includeUserText,
    includeAssistantText: selection.includeAssistantText,
    attachmentIds: selection.attachmentIds,
  };
}

/** 失败到状态码。 */
function statusOfError(error: ShareError): number {
  switch (error.code) {
    case CHATDSH_ERROR_CODES.payloadTooLarge:
      return 413;
    case CHATDSH_ERROR_CODES.operationDigestMismatch:
    case CHATDSH_ERROR_CODES.attachmentMissing:
      return 409;
    case CHATDSH_ERROR_CODES.sessionNotFound:
      return 404;
    case CHATDSH_ERROR_CODES.internalError:
      return 500;
    default:
      return 400;
  }
}

/** 处理失败，按错误码给出应答。 */
function fail(response: ServerResponse, error: unknown, telemetry: ChatdshTelemetry, kind: string): void {
  if (error instanceof ShareError) {
    sendJson(response, statusOfError(error), { error: error.code, reason: error.reason });
    return;
  }
  telemetry.event('chatdsh.gateway.share.rejected', {
    'error.type': 'internal',
    'error.code': CHATDSH_ERROR_CODES.internalError,
    outcome: 'failed',
    kind,
  });
  sendJson(response, 500, { error: CHATDSH_ERROR_CODES.internalError });
}

/** 校验请求者。 */
function authorizeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authorize: ShareAuthorize,
  action: OwnerAction,
): boolean {
  if (authorize(request, action) !== undefined) return true;
  sendJson(response, 401, { error: CHATDSH_ERROR_CODES.authRequired });
  return false;
}

/**
 * 构造分享路由处理函数。
 * @param options - 分享服务、身份校验与遥测。
 * @returns 路由处理函数；路径不属于分享时返回 `false`。
 */
export function createShareHttpHandler(options: ShareHttpOptions): ShareHttpHandler {
  const { service, authorize, telemetry } = options;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
    const path = url.pathname;

    if (path === SHARE_LIST_PATH) {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: CHATDSH_ERROR_CODES.requestInvalid, reason: 'method-not-allowed' });
        return true;
      }
      if (!authorizeRequest(request, response, authorize, 'read')) return true;
      try {
        sendJson(response, 200, await service.list());
      } catch (error) {
        fail(response, error, telemetry, 'list');
      }
      return true;
    }

    if (path === SHARE_PREVIEW_PATH) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: CHATDSH_ERROR_CODES.requestInvalid, reason: 'method-not-allowed' });
        return true;
      }
      if (!authorizeRequest(request, response, authorize, 'read')) return true;
      try {
        sendJson(response, 200, await service.preview(parsePreview(await readJsonBody(request))));
      } catch (error) {
        fail(response, error, telemetry, 'preview');
      }
      return true;
    }

    if (path === SHARE_PATH || path.startsWith(`${SHARE_PATH}/`)) {
      const pathToken = path === SHARE_PATH ? undefined : decodeSegment(path.slice(SHARE_PATH.length + 1));
      if (request.method === 'POST' && pathToken === undefined) {
        if (!authorizeRequest(request, response, authorize, 'write')) return true;
        try {
          sendJson(response, 200, await service.create(parseCreate(await readJsonBody(request))));
        } catch (error) {
          fail(response, error, telemetry, 'create');
        }
        return true;
      }
      if (request.method === 'DELETE') {
        if (!authorizeRequest(request, response, authorize, 'write')) return true;
        const token = pathToken ?? url.searchParams.get('token') ?? '';
        try {
          const revoked = await service.revoke(token);
          if (revoked === undefined) {
            sendJson(response, 404, { revoked: false, error: CHATDSH_ERROR_CODES.objectNotFound });
            return true;
          }
          sendJson(response, 200, { revoked: true, shareId: revoked.shareId, revokedAt: revoked.revokedAt, status: revoked.status });
        } catch (error) {
          fail(response, error, telemetry, 'revoke');
        }
        return true;
      }
      sendJson(response, 405, { error: CHATDSH_ERROR_CODES.requestInvalid, reason: 'method-not-allowed' });
      return true;
    }

    if (path.startsWith(PUBLIC_SHARE_PREFIX)) {
      const segments = path.slice(PUBLIC_SHARE_PREFIX.length).split('/');
      const rawToken = segments[0] ?? '';
      const token = decodeSegment(rawToken);
      if (segments.length === 1 && request.method === 'GET') {
        if (!SHARE_TOKEN_PATTERN.test(token)) {
          sendHtml(response, 404, renderShareUnavailablePage(404));
          return true;
        }
        try {
          const access = service.publicAccess(token);
          if (access.state !== 'active') {
            const status = access.state === 'unknown' ? 404 : 410;
            sendHtml(response, status, renderShareUnavailablePage(status));
            return true;
          }
          // `?print=1` 走导出宿主的打印视图：去掉应用导航、输入与交互，按分页规则排版。
          const printView = url.searchParams.get('print') === '1';
          sendHtml(response, 200, printView
            ? renderSharePrintPage(access.page, PRINT_TIME)
            : renderPublicPage(access.page));
        } catch (error) {
          fail(response, error, telemetry, 'render');
        }
        return true;
      }
      if (segments.length === 3 && segments[1] === 'attachments' && request.method === 'GET') {
        const attachmentId = decodeSegment(segments[2] ?? '');
        try {
          const content = await service.attachment(token, attachmentId);
          if (content === undefined) {
            sendHtml(response, 404, renderShareUnavailablePage(404));
            return true;
          }
          sendAttachment(response, content.filename, content.mimeType, content.bytes);
        } catch (error) {
          fail(response, error, telemetry, 'attachment');
        }
        return true;
      }
      sendHtml(response, 404, renderShareUnavailablePage(404));
      return true;
    }

    return false;
  };
}
