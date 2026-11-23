/**
 * 浏览器遥测的同源中转端点。
 *
 * 页面把 OTLP/HTTP JSON 发到 `POST /chatdsh/telemetry/browser`，由中继进程用本机凭据转发
 * 到 OpenObserve。端点要求同源与自定义请求头，关闭遥测时返回 404，失败分支写事件与计数。
 * @module @chatdsh/gateway/browser-telemetry
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { readLimitedBody } from './mobile-http.ts';

/** 浏览器上报中继路径。 */
export const BROWSER_TELEMETRY_PATH = '/chatdsh/telemetry/browser';

/** 同源写操作要求的请求头。 */
export const BROWSER_TELEMETRY_CSRF_HEADER = 'x-chatdsh-csrf';

/** 单批载荷上限，与浏览器客户端的限制一致。 */
const BODY_LIMIT = 256 * 1024;

/** 转发能力；关闭时仍保留状态供端点判定。 */
export interface BrowserTelemetryRelay {
  readonly enabled: boolean;
  readonly reason: string | undefined;
  relay(signal: string, body: string): Promise<{ status: number; detail?: string }>;
}

/** 端点上下文。 */
export interface BrowserTelemetryContext {
  readonly telemetry: ChatdshTelemetry;
  readonly relay?: BrowserTelemetryRelay;
  readonly origin: string;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function loopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function sameOrigin(origin: string, expected: string): boolean {
  if (origin === expected) return true;
  try {
    const actual = new URL(origin);
    const target = new URL(expected);
    if (actual.protocol !== target.protocol || actual.port !== target.port) return false;
    return loopbackHost(actual.hostname) && loopbackHost(target.hostname);
  } catch {
    return false;
  }
}

/**
 * 处理一次浏览器遥测上报。
 * @param context - 遥测面、转发能力与公共来源。
 * @param request - 入站请求。
 * @param response - 响应。
 * @returns 路径匹配时为真。
 */
export async function handleBrowserTelemetryRequest(
  context: BrowserTelemetryContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = (request.url ?? '/').split('?')[0] ?? '/';
  if (path !== BROWSER_TELEMETRY_PATH) return false;
  if (!context.telemetry.enabled) {
    sendJson(response, 404, { error: 'telemetry-disabled', reason: context.telemetry.reason });
    return true;
  }
  const relay = context.relay;
  if (relay === undefined) {
    sendJson(response, 503, { error: 'relay-unavailable' });
    return true;
  }

  await context.telemetry.runSpan('chatdsh.gateway.browser.telemetry', {
    action: 'ingest',
    outcome: 'pending',
    count: 0,
  }, async (span) => {
    const counter = context.telemetry.counter('chatdsh_gateway_browser_telemetry_batches_total', {
      description: '浏览器遥测批次接收结果',
    });
    const reject = (status: number, errorType: string, errorCode: string): void => {
      span.setAttribute('outcome', 'rejected');
      span.setAttribute('error.type', errorType);
      span.setAttribute('error.code', errorCode);
      context.telemetry.event('chatdsh.gateway.browser.telemetry.rejected', {
        action: 'ingest',
        outcome: 'rejected',
        'error.type': errorType,
        'error.code': errorCode,
      });
      counter.add(1, { outcome: 'rejected', 'error.code': errorCode });
      sendJson(response, status, { error: errorCode });
    };

    if (request.method !== 'POST') {
      reject(405, 'request', 'method-not-allowed');
      return;
    }
    if (request.headers[BROWSER_TELEMETRY_CSRF_HEADER] !== '1') {
      reject(403, 'request', 'csrf-required');
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && !sameOrigin(origin, context.origin)) {
      reject(403, 'request', 'origin-rejected');
      return;
    }
    const body = await readLimitedBody(request, BODY_LIMIT);
    if (body === undefined) {
      reject(413, 'batch', 'payload-too-large');
      return;
    }
    if (body.trim() === '') {
      reject(400, 'payload', 'empty-payload');
      return;
    }
    const signal = typeof request.headers['x-chatdsh-signal'] === 'string'
      ? request.headers['x-chatdsh-signal']
      : 'logs';
    const result = await relay.relay(signal, body);
    if (result.status !== 200) {
      const errorCode = result.detail ?? 'relay-failed';
      span.setAttribute('outcome', 'failed');
      span.setAttribute('error.type', 'relay');
      span.setAttribute('error.code', errorCode);
      context.telemetry.event('chatdsh.gateway.browser.telemetry.rejected', {
        action: 'ingest',
        outcome: 'failed',
        'error.type': 'relay',
        'error.code': errorCode,
      });
      counter.add(1, { outcome: 'failed', 'error.code': errorCode });
      sendJson(response, result.status, { accepted: false, error: 'relay-failed', detail: errorCode });
      return;
    }
    span.setAttribute('outcome', 'accepted');
    span.setAttribute('count', 1);
    counter.add(1, { outcome: 'accepted' });
    sendJson(response, 200, { accepted: true });
  });
  return true;
}
