/**
 * 遥测的三个 HTTP 端点。
 *
 * 状态端点在开启与关闭两种状态下都可用；自检端点在关闭时返回 409；上报中继在关闭时返回 404。
 * 三个端点都只接受回环来源，并校验 `Origin`，避免被第三方页面当作代理使用。
 * @module @chatdsh/host-telemetry/endpoints
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostWebServerOf, type Context } from '@chatdsh/adapter';

/** 状态端点的路径。 */
export const STATUS_PATH = '/chatdsh/telemetry/status';

/** 自检端点的路径。 */
export const SELF_TEST_PATH = '/chatdsh/telemetry/self-test';

/** 浏览器与移动端上报中继的路径。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 诊断导出的路径。 */
export const DIAGNOSTICS_PATH = '/chatdsh/telemetry/diagnostics';

/** 运行期开关的路径。 */
export const STATE_PATH = '/chatdsh/telemetry/state';

/** 写操作要求的同源标识头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 端点需要从服务取得的能力。 */
export interface EndpointHost {
  /** 当前开关状态。 */
  readonly enabled: boolean;
  /** 关闭原因。 */
  readonly reason: string | undefined;
  /** 状态载荷。 */
  status(): Promise<Record<string, unknown>>;
  /** 执行一次自检，返回探针标识。 */
  selfTest(): Promise<string>;
  /** 诊断导出：脱敏后的最近事件与丢弃汇总。 */
  diagnostics(limit?: number): Promise<Record<string, unknown>>;
  /** 运行期切换开关并返回新的状态载荷。 */
  setEnabled(enabled: boolean): Promise<Record<string, unknown>>;
  /** 转发一份上报载荷。 */
  relay(signal: string, body: string): Promise<{ status: number; detail?: string }>;
}

/** 回环来源判定：Host 与 Origin 都必须是本机地址。 */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage, limit = 1_048_576): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/** 诊断导出的默认条数与上限。 */
const DIAGNOSTICS_DEFAULT_LIMIT = 64;
const DIAGNOSTICS_MAX_LIMIT = 256;

/** 解析诊断导出的条数上限。 */
function parseLimit(rawUrl: string | undefined): number {
  const query = new URL(rawUrl ?? DIAGNOSTICS_PATH, 'http://127.0.0.1').searchParams.get('limit');
  const parsed = query === null ? Number.NaN : Number.parseInt(query, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DIAGNOSTICS_DEFAULT_LIMIT;
  return Math.min(parsed, DIAGNOSTICS_MAX_LIMIT);
}

/**
 * 注册端点。
 * @param ctx - 宿主上下文，提供 `webServer`。
 * @param host - 端点背后要调用的服务能力。
 * @returns 释放函数。
 */
export function registerTelemetryEndpoints(ctx: Context, host: EndpointHost): () => void {
  const disposers: (() => void)[] = [];

  disposers.push(hostWebServerOf(ctx).register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (request, response) => {
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: 'loopback-only' });
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      sendJson(response, 200, await host.status());
    },
  }));

  disposers.push(hostWebServerOf(ctx).register({
    kind: 'exact',
    path: SELF_TEST_PATH,
    handler: async (request, response) => {
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: 'loopback-only' });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      if (!host.enabled) {
        sendJson(response, 409, { error: 'telemetry-disabled', reason: host.reason });
        return;
      }
      sendJson(response, 200, { probeId: await host.selfTest() });
    },
  }));

  disposers.push(hostWebServerOf(ctx).register({
    kind: 'exact',
    path: RELAY_PATH,
    handler: async (request, response) => {
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: 'loopback-only' });
        return;
      }
      if (!host.enabled) {
        sendJson(response, 404, { error: 'telemetry-disabled', reason: host.reason });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const signal = String(request.headers['x-chatdsh-signal'] ?? 'logs');
      const body = await readBody(request);
      const result = await host.relay(signal, body);
      sendJson(response, result.status, result.detail === undefined ? { accepted: result.status === 200 } : { accepted: false, detail: result.detail });
    },
  }));

  disposers.push(hostWebServerOf(ctx).register({
    kind: 'exact',
    path: DIAGNOSTICS_PATH,
    handler: async (request, response) => {
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: 'loopback-only' });
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      if (!host.enabled) {
        sendJson(response, 409, { error: 'telemetry-disabled', reason: host.reason });
        return;
      }
      sendJson(response, 200, await host.diagnostics(parseLimit(request.url)));
    },
  }));

  disposers.push(hostWebServerOf(ctx).register({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (request, response) => {
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: 'loopback-only' });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      if (request.headers[CSRF_HEADER] !== '1') {
        sendJson(response, 403, { error: 'csrf-required' });
        return;
      }
      const payload = JSON.parse(await readBody(request)) as { enabled?: unknown };
      if (typeof payload.enabled !== 'boolean') {
        sendJson(response, 400, { error: 'enabled-required' });
        return;
      }
      sendJson(response, 200, await host.setEnabled(payload.enabled));
    },
  }));

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}