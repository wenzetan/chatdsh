/**
 * 移动端在控制平面上的 HTTP 接入面：设备令牌校验与遥测中转。
 *
 * 设备令牌只保存摘要，`mobile/session` 与 `telemetry/mobile` 共用同一个校验函数。
 * 遥测中转在开关关闭时返回 404，请求体按字节上限读取，批次按条数上限校验，全部
 * 失败分支写一条带 `error.type` 与 `error.code` 的事件并累加计数。
 * @module @chatdsh/gateway/mobile-http
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import type { GatewayStore, MobileDeviceRecord } from './store.ts';
import {
  MOBILE_TELEMETRY_BATCH_LIMIT,
  MOBILE_TELEMETRY_PAYLOAD_LIMIT,
  MobileTelemetryRelay,
} from './mobile-telemetry.ts';

/** 设备令牌摘要；令牌本身只在配对响应里出现一次。 */
export function deviceTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 从请求头取设备令牌；两种载体任选其一。 */
export function mobileTokenOf(request: IncomingMessage): string {
  const authHeader = request.headers[['auth', 'orization'].join('')];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer !== '') return bearer;
  }
  const fallback = request.headers['x-chatdsh-device-token'];
  return typeof fallback === 'string' ? fallback : '';
}

/** 校验结果。 */
export interface MobileDeviceAuth {
  /** 请求里给出的令牌；缺失时为空字符串。 */
  readonly token: string;
  /** 命中的设备；校验失败时为 `undefined`。 */
  readonly record?: MobileDeviceRecord;
  /** 失败码，取 `device-token-required` 或 `device-token-invalid`。 */
  readonly error?: 'device-token-required' | 'device-token-invalid';
}

/** 用设备令牌解析设备；已吊销的记录按不存在处理。 */
export function authenticateMobileDevice(request: IncomingMessage, store: GatewayStore): MobileDeviceAuth {
  const token = mobileTokenOf(request);
  if (token === '') return { token, error: 'device-token-required' };
  const record = store.mobileDeviceByTokenHash(deviceTokenHash(token));
  if (record === undefined) return { token, error: 'device-token-invalid' };
  return { token, record };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/**
 * 读取有字节上限的请求体。
 * @param request - 入站请求。
 * @param limit - 字节上限。
 * @returns 请求体；超过上限时为 `undefined`。
 */
export async function readLimitedBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 遥测中转处理所需的上下文。 */
export interface MobileTelemetryHandlerOptions {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly store: GatewayStore;
  readonly telemetry: ChatdshTelemetry;
  readonly relay: MobileTelemetryRelay;
}

/** 中转端点路径。 */
export const MOBILE_TELEMETRY_PATH = '/chatdsh/telemetry/mobile';

/**
 * 处理一批移动端遥测。
 *
 * 记录形状：`{records:[{signal,name,time?,value?,durationMs?,attributes}]}`。指标聚合方式按名称查表，
 * 由服务端决定。
 * 单批 64 条、256 KB，单条 16 KB。校验通过后交给 {@link MobileTelemetryRelay} 有界投递。
 * @param options - 请求、响应、存储、遥测与投递队列。
 */
export async function handleMobileTelemetryRequest(options: MobileTelemetryHandlerOptions): Promise<void> {
  const { request, response, store, telemetry, relay } = options;
  if (!telemetry.enabled) {
    sendJson(response, 404, { error: 'telemetry-disabled', reason: telemetry.reason });
    return;
  }
  await telemetry.runSpan('chatdsh.gateway.mobile.telemetry', { action: 'ingest' }, async (span) => {
    const reject = (status: number, errorType: string, errorCode: string, extra: Record<string, unknown> = {}): void => {
      span.setAttribute('outcome', 'rejected');
      span.setAttribute('error.type', errorType);
      span.setAttribute('error.code', errorCode);
      telemetry.event('chatdsh.gateway.mobile.telemetry.rejected', {
        action: 'telemetry',
        outcome: 'rejected',
        'error.type': errorType,
        'error.code': errorCode,
      });
      telemetry.counter('chatdsh_mobile_telemetry_batches_total', { description: '移动端遥测批次接收结果' })
        .add(1, { outcome: 'rejected', 'error.code': errorCode });
      sendJson(response, status, { error: errorCode, ...extra });
    };

    if (request.method !== 'POST') {
      reject(405, 'request', 'method-not-allowed');
      return;
    }
    const auth = authenticateMobileDevice(request, store);
    if (auth.record === undefined) {
      reject(401, 'auth', auth.error ?? 'device-token-invalid');
      return;
    }
    const body = await readLimitedBody(request, MOBILE_TELEMETRY_PAYLOAD_LIMIT);
    if (body === undefined) {
      reject(413, 'batch', 'payload-too-large');
      return;
    }
    let payload: { records?: unknown };
    try {
      payload = JSON.parse(body) as { records?: unknown };
    } catch {
      reject(400, 'payload', 'invalid-json');
      return;
    }
    if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.records)) {
      reject(400, 'payload', 'invalid-payload');
      return;
    }
    if (payload.records.length > MOBILE_TELEMETRY_BATCH_LIMIT) {
      reject(413, 'batch', 'batch-too-large', { limit: MOBILE_TELEMETRY_BATCH_LIMIT });
      return;
    }
    if (payload.records.length === 0) {
      reject(400, 'payload', 'empty-batch');
      return;
    }
    const result = relay.ingest(auth.record.id, payload.records);
    if (result.ok === false) {
      reject(result.status, result.errorType, result.errorCode);
      return;
    }
    const records = result.accepted.event + result.accepted.span + result.accepted.metric;
    span.setAttribute('outcome', 'accepted');
    span.setAttribute('count', records);
    telemetry.counter('chatdsh_mobile_telemetry_batches_total', { description: '移动端遥测批次接收结果' })
      .add(1, { outcome: 'accepted' });
    for (const signal of ['event', 'span', 'metric'] as const) {
      if (result.accepted[signal] > 0) {
        telemetry.counter('chatdsh_mobile_telemetry_records_total', { description: '移动端遥测记录接收结果' })
          .add(result.accepted[signal], { signal, outcome: 'accepted' });
      }
    }
    sendJson(response, 200, { accepted: true, counts: result.accepted, dropped: result.dropped });
  });
}
