/**
 * 本机同源中继代理。
 *
 * 浏览器直开本机运行时并配置远程中继时，中继没有 CORS 响应头，页面无法直接取数。
 * 本模块在宿主同源 WebServer 上注册四个固定端点，把经过校验的请求转发到用户指定的
 * 中继地址。目标地址只允许精确的 HTTP 或 HTTPS 来源，请求只带链路上下文，目标响应
 * 只回传 JSON 正文类型与链路上下文。
 * @module @chatdsh/host-device-link/relay-proxy
 */

import { BlockList, isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { hostWebServerOf } from '@chatdsh/adapter';
import type { ChatdshTelemetry, TelemetryCarrier, TelemetrySpan } from '@chatdsh/core-contracts';

/** 设备列表代理端点。 */
export const RELAY_DEVICES_PATH = '/chatdsh/device/relay/devices';

/** 会话列表代理端点。 */
export const RELAY_SESSIONS_PATH = '/chatdsh/device/relay/sessions';

/** 只读副本代理端点。 */
export const RELAY_REPLICA_PATH = '/chatdsh/device/relay/replica';

/** 节点配对代理端点。 */
export const RELAY_PAIR_PATH = '/chatdsh/device/relay/pair';

/** 请求目标中继地址的请求头。 */
export const CONTROL_URL_HEADER = 'x-chatdsh-control-url';

/** 写操作要求的同源标识头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 配对请求体上限，单位字节。 */
export const PAIR_BODY_LIMIT = 64 * 1024;

/** 默认转发超时，单位毫秒。 */
export const DEFAULT_TIMEOUT_MS = 8000;

/** 注册参数。 */
export interface RelayProxyOptions {
  /** 本机宿主 HTTP 服务。 */
  readonly webServer: ReturnType<typeof hostWebServerOf>;
  /** 回退的中继地址读取函数；请求头缺省时使用。 */
  readonly fallbackControlUrl: () => string;
  /** 遥测读取函数；每次转发开始时读取当前生效的实例。 */
  readonly telemetry: () => ChatdshTelemetry | undefined;
  /** 转发超时，单位毫秒。 */
  readonly timeoutMs?: number;
}

/** 转发结果。 */
type ForwardOutcome = 'success' | 'rejected' | 'unreachable' | 'timeout';

/** 代理请求校验失败。 */
export class RelayProxyError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'RelayProxyError';
  }
}

/** 配对请求体超过上限。 */
class BodyTooLargeError extends Error {
  constructor() {
    super('payload-too-large');
    this.name = 'BodyTooLargeError';
  }
}

const LOOPBACK = new BlockList();
LOOPBACK.addAddress('127.0.0.1', 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('::ffff:127.0.0.1', 128, 'ipv6');

/**
 * 判断来源地址是否为本机回环地址。
 * @param address - 套接字来源地址。
 * @returns 属于 127.0.0.1、::1 或它们的 IPv4 映射写法时为真。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const withoutBrackets = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const withoutZone = withoutBrackets.includes('%') ? withoutBrackets.slice(0, withoutBrackets.indexOf('%')) : withoutBrackets;
  const family = isIP(withoutZone);
  if (family === 4) return LOOPBACK.check(withoutZone, 'ipv4');
  if (family === 6) return LOOPBACK.check(withoutZone, 'ipv6');
  return false;
}

/**
 * 校验并归一化目标中继地址。
 *
 * 规则与客户端 `normalizeControlUrl` 一致：只接受 HTTP 与 HTTPS，拒绝内嵌凭据、
 * 查询串与片段，去掉末尾斜杠。
 * @param raw - 请求头或配置里的地址。
 * @returns 归一化后的地址。
 * @throws {RelayProxyError} 地址为空或非法。
 */
export function normalizeRelayControlUrl(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new RelayProxyError(400, 'control-url-required');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayProxyError(400, 'control-url-invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RelayProxyError(400, 'control-url-invalid');
  }
  const schemeEnd = url.href.indexOf('://');
  const authorityEnd = url.href.indexOf('/', schemeEnd + 3);
  const authority = url.href.slice(schemeEnd + 3, authorityEnd < 0 ? undefined : authorityEnd);
  if (authority.includes('@')) throw new RelayProxyError(400, 'control-url-invalid');
  if (url.search !== '') throw new RelayProxyError(400, 'control-url-invalid');
  if (url.hash !== '') throw new RelayProxyError(400, 'control-url-invalid');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** 读取单值请求头。 */
function headerOf(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** 读取有上限的请求体。 */
async function readLimitedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = headerOf(request, 'content-length');
  if (declared !== '') {
    const size = Number(declared);
    if (Number.isFinite(size) && size > limit) {
      request.resume();
      throw new BodyTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      request.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 判断是否是超时中止。 */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

/** 一次转发的遥测记录器。 */
interface ForwardRecorder {
  /** 记录结果；同一请求只记录一次。 */
  finish(outcome: ForwardOutcome, status: number, errorType?: string, errorCode?: string): void;
}

/** 生成一次转发的记录器。 */
function recorderOf(telemetry: ChatdshTelemetry | undefined, span: TelemetrySpan | undefined): ForwardRecorder {
  let recorded = false;
  return {
    finish(outcome, status, errorType, errorCode) {
      if (recorded) return;
      recorded = true;
      span?.setAttribute('outcome', outcome);
      span?.setAttribute('http.status_code', status);
      if (errorType !== undefined) span?.setAttribute('error.type', errorType);
      if (errorCode !== undefined) span?.setAttribute('error.code', errorCode);
      telemetry?.counter('chatdsh_runtime_device_forwards_total', {
        description: '设备侧转发到本地运行时的请求数',
      }).add(1, { outcome });
      if (errorType !== undefined && errorCode !== undefined) {
        telemetry?.event('chatdsh.runtime.device.forward.failed', {
          outcome: 'failed',
          'error.type': errorType,
          'error.code': errorCode,
        });
      }
    },
  };
}

/** 写校验失败的响应并记录结果。 */
function rejectOf(
  recorder: ForwardRecorder,
  response: ServerResponse,
  status: number,
  errorType: string,
  errorCode: string,
): void {
  recorder.finish('rejected', status, errorType, errorCode);
  sendJson(response, status, { error: errorCode });
}

/** 解析本次请求的目标中继地址。 */
function targetOf(request: IncomingMessage, fallbackControlUrl: () => string): string {
  const header = headerOf(request, CONTROL_URL_HEADER);
  const raw = header.trim() !== '' ? header : fallbackControlUrl();
  return normalizeRelayControlUrl(raw);
}

/** 把上游响应写回浏览器。 */
function writeUpstream(response: ServerResponse, upstream: Response, body: string): void {
  const headers: Record<string, string> = {
    'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
  };
  const traceparent = upstream.headers.get('traceparent');
  if (traceparent !== null) headers.traceparent = traceparent;
  const tracestate = upstream.headers.get('tracestate');
  if (tracestate !== null) headers.tracestate = tracestate;
  response.writeHead(upstream.status, headers);
  response.end(body);
}

/** 转发一次白名单请求。 */
async function forward(
  response: ServerResponse,
  target: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  recorder: ForwardRecorder,
  telemetry: ChatdshTelemetry | undefined,
  inherited: TelemetryCarrier,
  timeoutMs: number,
): Promise<void> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method === 'POST') headers['content-type'] = 'application/json';
  if (inherited.traceparent !== undefined) {
    headers.traceparent = inherited.traceparent;
    if (inherited.tracestate !== undefined) headers.tracestate = inherited.tracestate;
  } else {
    const carrier: TelemetryCarrier = telemetry?.inject({}) ?? {};
    if (carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
    if (carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;
  }
  let upstream: Response;
  let text: string;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await upstream.text();
  } catch (error) {
    if (isTimeout(error)) {
      recorder.finish('timeout', 504, 'timeout', 'relay-timeout');
      sendJson(response, 504, { error: 'relay-timeout' });
      return;
    }
    recorder.finish('unreachable', 502, 'network', 'relay-unreachable');
    sendJson(response, 502, { error: 'relay-unreachable' });
    return;
  }
  recorder.finish('success', upstream.status);
  writeUpstream(response, upstream, text);
}

/**
 * 注册四个白名单代理端点。
 * @param options - 本机服务、回退地址、遥测读取与超时。
 * @returns 释放全部端点的函数。
 */
export function registerRelayProxy(options: RelayProxyOptions): () => void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const handle = (
    request: IncomingMessage,
    response: ServerResponse,
    spec: {
      readonly method: 'GET' | 'POST';
      readonly requireCsrf: boolean;
      readonly replica: boolean;
      readonly path: string;
      readonly pair: boolean;
    },
  ): Promise<void> => {
    const telemetry = options.telemetry();
    const method = request.method ?? 'GET';
    const execute = async (span: TelemetrySpan | undefined, inherited: TelemetryCarrier): Promise<void> => {
      const recorder = recorderOf(telemetry, span);
      try {
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
          rejectOf(recorder, response, 403, 'security', 'loopback-only');
          return;
        }
        if (method !== spec.method) {
          rejectOf(recorder, response, 405, 'request', 'method-not-allowed');
          return;
        }
        if (spec.requireCsrf && headerOf(request, CSRF_HEADER) !== '1') {
          rejectOf(recorder, response, 403, 'security', 'csrf-required');
          return;
        }
        const target = targetOf(request, options.fallbackControlUrl);
        let suffix = spec.path;
        if (spec.replica) {
          const url = new URL(request.url ?? spec.path, 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId') ?? '';
          if (sessionId.trim() === '') {
            rejectOf(recorder, response, 400, 'request', 'session-id-required');
            return;
          }
          suffix = `${spec.path}?sessionId=${encodeURIComponent(sessionId)}`;
        }
        let body: string | undefined;
        if (spec.pair) {
          try {
            body = (await readLimitedBody(request, PAIR_BODY_LIMIT)).toString('utf8');
          } catch (error) {
            if (error instanceof BodyTooLargeError) {
              rejectOf(recorder, response, 413, 'request', 'payload-too-large');
              return;
            }
            throw error;
          }
        }
        await forward(response, `${target}${suffix}`, spec.method, body, recorder, telemetry, inherited, timeoutMs);
      } catch (error) {
        if (error instanceof RelayProxyError) {
          rejectOf(recorder, response, error.status, 'request', error.code);
          return;
        }
        throw error;
      }
    };

    if (telemetry === undefined) return execute(undefined, {});
    const parent: TelemetryCarrier = {};
    const traceparent = headerOf(request, 'traceparent');
    if (traceparent !== '') parent.traceparent = traceparent;
    const tracestate = headerOf(request, 'tracestate');
    if (tracestate !== '') parent.tracestate = tracestate;
    const extracted = telemetry.extract(parent);
    return telemetry.withContext(extracted, () => telemetry.runSpan(
      'chatdsh.runtime.device.forward',
      { method },
      (span) => execute(span, extracted),
    ));
  };

  const releases = [
    options.webServer.register({
      kind: 'exact',
      path: RELAY_DEVICES_PATH,
      handler: (request, response) => handle(request, response, {
        method: 'GET',
        requireCsrf: false,
        replica: false,
        path: '/chatdsh/gateway/devices',
        pair: false,
      }),
    }),
    options.webServer.register({
      kind: 'exact',
      path: RELAY_SESSIONS_PATH,
      handler: (request, response) => handle(request, response, {
        method: 'GET',
        requireCsrf: false,
        replica: false,
        path: '/chatdsh/gateway/sessions',
        pair: false,
      }),
    }),
    options.webServer.register({
      kind: 'exact',
      path: RELAY_REPLICA_PATH,
      handler: (request, response) => handle(request, response, {
        method: 'GET',
        requireCsrf: false,
        replica: true,
        path: '/chatdsh/gateway/replica',
        pair: false,
      }),
    }),
    options.webServer.register({
      kind: 'exact',
      path: RELAY_PAIR_PATH,
      handler: (request, response) => handle(request, response, {
        method: 'POST',
        requireCsrf: true,
        replica: false,
        path: '/chatdsh/gateway/devices/pair',
        pair: true,
      }),
    }),
  ];
  return () => {
    for (const release of releases.reverse()) release();
  };
}
