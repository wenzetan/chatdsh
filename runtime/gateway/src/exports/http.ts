/**
 * 导出路由：预估、建立、列举、单个任务、取消与下载。
 *
 * 公共入口的挂载由发行集成处理；这里给出挂载所需的路由函数，测试用真实 HTTP 服务装配它。
 * 读动作与写动作分别要求身份校验，写动作由校验方同时核对来源与 CSRF。下载响应强制按附件
 * 处理并给出 UTF-8 文件名与内容类型；建立与取消返回任务视图，视图里没有事件序号、副本
 * 水位与内部存储键。
 * @module @chatdsh/gateway/exports/http
 */

import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExportScope } from '@chatdsh/core-contracts';
import { CHATDSH_ERROR_CODES, exportCreateRequestSchema, exportScopeSchema } from '@chatdsh/core-contracts';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { EXPORT_REJECTED_EVENT } from './telemetry.ts';
import { ExportError } from './types.ts';
import type { ExportActor, ExportAuthorize } from './types.ts';
import type { ExportService } from './service.ts';

/** 导出接口路径。 */
export const EXPORT_LIST_PATH = '/chatdsh/gateway/exports';
export const EXPORT_ESTIMATE_PATH = '/chatdsh/gateway/export/estimate';

/** 请求体上限。 */
const MAX_BODY_BYTES = 256 * 1024;

/** 路由处理函数。 */
export type ExportHttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/** 装配导出路由所需的依赖。 */
export interface ExportHttpOptions {
  readonly service: ExportService;
  readonly authorize: ExportAuthorize;
  /** 遥测出口；缺省时失败事件不写。 */
  readonly telemetry?: ChatdshTelemetry;
}

/** JSON 应答头。 */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** 发 JSON 应答。 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(Buffer.byteLength(text, 'utf8')) });
  response.end(text);
}

/** RFC 5987 文件名编码。 */
function encodeFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 发下载应答。 */
function sendDownload(response: ServerResponse, filename: string, contentType: string, bytes: Uint8Array): void {
  const ascii = filename.replaceAll(/[^\x20-\x7e]/gu, '_').replaceAll('"', '_').replaceAll('\\', '_');
  response.writeHead(200, {
    'Content-Type': contentType,
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

/** 读请求体。 */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number.parseInt(declared, 10) > MAX_BODY_BYTES) {
    throw new ExportError(CHATDSH_ERROR_CODES.payloadTooLarge, 'body-too-large', '请求体超过上限');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new ExportError(CHATDSH_ERROR_CODES.payloadTooLarge, 'body-too-large', '请求体超过上限');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw new ExportError(CHATDSH_ERROR_CODES.requestInvalid, 'body-empty', '请求体为空');
  }
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

/** 解析一个导出的内容范围。 */
function scopeOf(body: unknown): ExportScope {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
  if (record === undefined) {
    throw new ExportError(CHATDSH_ERROR_CODES.requestInvalid, 'body-shape', '请求体必须是对象');
  }
  const candidate = record['scope'] ?? record;
  const result = exportScopeSchema.safeParse(candidate);
  if (!result.success) {
    throw new ExportError(
      CHATDSH_ERROR_CODES.requestInvalid,
      'scope-invalid',
      result.error.issues[0]?.message ?? '导出的内容范围不合法',
    );
  }
  return result.data;
}

/** 解析建立导出的请求。 */
function createRequestOf(body: unknown): { operationId: string; requestDigest: string; scope: ExportScope } {
  const result = exportCreateRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ExportError(
      CHATDSH_ERROR_CODES.requestInvalid,
      'request-invalid',
      result.error.issues[0]?.message ?? '导出请求不合法',
    );
  }
  return result.data;
}

/** 失败到状态码。 */
function statusOfError(error: ExportError): number {
  switch (error.code) {
    case CHATDSH_ERROR_CODES.requestInvalid:
      return 400;
    case CHATDSH_ERROR_CODES.permissionDenied:
      return 403;
    case CHATDSH_ERROR_CODES.objectNotFound:
    case CHATDSH_ERROR_CODES.sessionNotFound:
      return 404;
    case CHATDSH_ERROR_CODES.operationDigestMismatch:
    case CHATDSH_ERROR_CODES.alreadyHandled:
    case CHATDSH_ERROR_CODES.writeUnconfirmed:
      return 409;
    case CHATDSH_ERROR_CODES.exportExpired:
      return 410;
    case CHATDSH_ERROR_CODES.payloadTooLarge:
    case CHATDSH_ERROR_CODES.exportTooLarge:
      return 413;
    case CHATDSH_ERROR_CODES.exportFormatUnsupported:
      return 422;
    case CHATDSH_ERROR_CODES.internalError:
      return 500;
    default:
      return 400;
  }
}

/** 处理失败。 */
function fail(response: ServerResponse, error: unknown, telemetry: ChatdshTelemetry | undefined, kind: string): void {
  if (error instanceof ExportError) {
    sendJson(response, statusOfError(error), { error: error.code, reason: error.reason });
    return;
  }
  telemetry?.event(EXPORT_REJECTED_EVENT, {
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
  authorize: ExportAuthorize,
  action: 'read' | 'write',
): ExportActor | undefined {
  const actor = authorize(request, action);
  if (actor !== undefined) return actor;
  sendJson(response, 401, { error: CHATDSH_ERROR_CODES.authRequired });
  return undefined;
}

/** 把一段路径拆成段。 */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * 构造导出路由处理函数。
 * @param options - 导出服务、身份校验与遥测。
 * @returns 路由处理函数；路径不属于导出时返回 `false`。
 */
export function createExportHttpHandler(options: ExportHttpOptions): ExportHttpHandler {
  const { service, authorize, telemetry } = options;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'gateway'}`);
    const path = url.pathname;

    if (path === EXPORT_ESTIMATE_PATH) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: CHATDSH_ERROR_CODES.requestInvalid, reason: 'method-not-allowed' });
        return true;
      }
      const actor = authorizeRequest(request, response, authorize, 'read');
      if (actor === undefined) return true;
      try {
        sendJson(response, 200, await service.estimate(scopeOf(await readBody(request)), actor));
      } catch (error) {
        fail(response, error, telemetry, 'estimate');
      }
      return true;
    }

    if (path === EXPORT_LIST_PATH) {
      if (request.method === 'GET') {
        if (authorizeRequest(request, response, authorize, 'read') === undefined) return true;
        try {
          sendJson(response, 200, { jobs: await service.list() });
        } catch (error) {
          fail(response, error, telemetry, 'list');
        }
        return true;
      }
      if (request.method === 'POST') {
        const actor = authorizeRequest(request, response, authorize, 'write');
        if (actor === undefined) return true;
        try {
          sendJson(response, 200, await service.create(createRequestOf(await readBody(request)), actor));
        } catch (error) {
          fail(response, error, telemetry, 'create');
        }
        return true;
      }
      sendJson(response, 405, { error: CHATDSH_ERROR_CODES.requestInvalid, reason: 'method-not-allowed' });
      return true;
    }

    if (path.startsWith(`${EXPORT_LIST_PATH}/`)) {
      const segments = segmentsOf(path.slice(EXPORT_LIST_PATH.length));
      const jobId = segments[0] ?? '';
      if (jobId === '') {
        sendJson(response, 404, { error: CHATDSH_ERROR_CODES.objectNotFound });
        return true;
      }
      if (segments.length === 2 && segments[1] === 'download' && request.method === 'GET') {
        if (authorizeRequest(request, response, authorize, 'read') === undefined) return true;
        try {
          const download = await service.download(jobId);
          sendDownload(response, download.filename, download.contentType, download.bytes);
        } catch (error) {
          fail(response, error, telemetry, 'download');
        }
        return true;
      }
      if (segments.length === 2 && segments[1] === 'cancel' && request.method === 'POST') {
        if (authorizeRequest(request, response, authorize, 'write') === undefined) return true;
        try {
          sendJson(response, 200, await service.cancel(jobId));
        } catch (error) {
          fail(response, error, telemetry, 'cancel');
        }
        return true;
      }
      if (segments.length === 1 && request.method === 'GET') {
        if (authorizeRequest(request, response, authorize, 'read') === undefined) return true;
        try {
          const job = await service.job(jobId);
          if (job === undefined) {
            sendJson(response, 404, { error: CHATDSH_ERROR_CODES.objectNotFound });
            return true;
          }
          sendJson(response, 200, job);
        } catch (error) {
          fail(response, error, telemetry, 'job');
        }
        return true;
      }
      sendJson(response, 405, { error: CHATDSH_ERROR_CODES.requestInvalid, reason: 'method-not-allowed' });
      return true;
    }

    return false;
  };
}
