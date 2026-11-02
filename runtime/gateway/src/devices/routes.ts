/**
 * 设备管理的 HTTP 入口：配对码、配对、分组列表、撤销、链路检查与活动通道。
 *
 * 认证只认请求携带的令牌（`Authorization: Bearer` 或 `x-chatdsh-device-token`）。设备
 * 标识头只用于界面展示当前设备，单独出现时不构成任何凭据。管理接口一律不回显令牌，
 * 响应带 `Cache-Control: no-store`。
 *
 * 三处通道用于验收撤销的即时性：`/devices/stream` 是 SSE 流，`/devices/wait` 是在途
 * HTTP 请求，`/devices/ws` 是 WebSocket 升级。撤销时这三类通道与执行节点的长连接一起
 * 关闭。
 * @module @chatdsh/gateway/devices/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  deviceRevokeRequestSchema,
  pairingRequestSchema,
  type ChatdshTelemetry,
  type DeviceLinkCheck,
  type DeviceList,
  type PairingCode,
} from '@chatdsh/core-contracts';
import type { DevicePrincipal } from './credential.ts';
import { DeviceError, type DeviceLifecycle } from './lifecycle.ts';
import { pairingSourceOf } from './pairing.ts';
import type { DeviceTransportRegistry } from './transports.ts';
import { readLimitedBody } from '../mobile-http.ts';
import { WebSocketHandshake, rejectUpgrade, websocketVersionSupported } from '../websocket.ts';

/** 配对请求体上限。 */
export const DEVICE_PAIR_BODY_LIMIT = 64 * 1024;

/** 撤销请求体上限。 */
export const DEVICE_REVOKE_BODY_LIMIT = 8 * 1024;

/** SSE 心跳间隔。 */
export const DEVICE_STREAM_HEARTBEAT_MS = 1_000;

/** 在途 HTTP 请求的默认等待时长。 */
export const DEVICE_WAIT_TIMEOUT_MS = 30_000;

/** 配对码路径。 */
export const DEVICE_PAIR_PATH = '/chatdsh/gateway/devices/pair';

/** 配对码签发路径。 */
export const DEVICE_PAIRING_PATH = '/chatdsh/gateway/devices/pairing';

/** 设备列表路径。 */
export const DEVICE_LIST_PATH = '/chatdsh/gateway/devices';

/** 撤销路径。 */
export const DEVICE_REVOKE_PATH = '/chatdsh/gateway/devices/revoke';

/** 链路检查路径。 */
export const DEVICE_LINK_CHECK_PATH = '/chatdsh/gateway/devices/link-check';

/** SSE 通道路径。 */
export const DEVICE_STREAM_PATH = '/chatdsh/gateway/devices/stream';

/** 在途 HTTP 请求路径。 */
export const DEVICE_WAIT_PATH = '/chatdsh/gateway/devices/wait';

/** WebSocket 通道路径。 */
export const DEVICE_SOCKET_PATH = '/chatdsh/gateway/devices/ws';

/** 设备入口的构造输入。 */
export interface DeviceHostOptions {
  readonly lifecycle: DeviceLifecycle;
  readonly telemetry: ChatdshTelemetry;
  readonly transports: DeviceTransportRegistry;
  /** 控制平面对外地址，用于解析相对地址与核对配对目标。 */
  readonly controlUrl: string;
  /** SSE 心跳间隔，缺省 {@link DEVICE_STREAM_HEARTBEAT_MS}。 */
  readonly streamHeartbeatMs?: number;
  /** 在途 HTTP 请求的默认等待时长，缺省 {@link DEVICE_WAIT_TIMEOUT_MS}。 */
  readonly waitTimeoutMs?: number;
}

/** 装配好的设备入口。 */
export interface DeviceHost {
  /**
   * 处理一次 HTTP 请求。
   * @returns 属于设备路径时为真。
   */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /**
   * 处理一次 WebSocket 升级。
   * @returns 属于设备通道路径时为真。
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** 关闭本入口登记的全部活动通道。 */
  stop(): void;
}

/** 两个字的 HTTP 状态说明；未列出的按通用描述处理。 */
function statusText(status: number): string {
  if (status === 400) return 'Bad Request';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 405) return 'Method Not Allowed';
  if (status === 409) return 'Conflict';
  if (status === 410) return 'Gone';
  if (status === 413) return 'Payload Too Large';
  if (status === 429) return 'Too Many Requests';
  if (status === 503) return 'Service Unavailable';
  return 'Bad Request';
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

/** 拒绝一次升级，状态说明与状态码一致。 */
function rejectSocketUpgrade(socket: Duplex, status: number, code: string): void {
  if (status === 401 || status === 403 || status === 400) {
    rejectUpgrade(socket, status, code);
    return;
  }
  const body = JSON.stringify({ error: code });
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
    'Content-Type: application/json; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  );
  socket.destroy();
}

/** 把请求路径收敛成不含查询串的部分。 */
function pathOf(request: IncomingMessage): string {
  const raw = request.url ?? '/';
  const cut = raw.indexOf('?');
  return cut < 0 ? raw : raw.slice(0, cut);
}

/** 装配设备管理入口。 */
export function createDeviceHost(options: DeviceHostOptions): DeviceHost {
  const { lifecycle, telemetry, transports } = options;
  const controlUrl = options.controlUrl;
  const heartbeatMs = options.streamHeartbeatMs ?? DEVICE_STREAM_HEARTBEAT_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEVICE_WAIT_TIMEOUT_MS;
  const active = new Set<() => void>();

  const reject = (
    response: ServerResponse,
    status: number,
    code: string,
    action: string,
    errorType: string
  ): void => {
    telemetry.event('chatdsh.gateway.device.rejected', {
      action,
      outcome: 'rejected',
      'error.type': errorType,
      'error.code': code,
    });
    sendJson(response, status, { error: code });
  };

  const rejectAuth = (response: ServerResponse, code: string, action: string): void => {
    reject(response, 401, code, action, code.startsWith('device-token') ? 'auth' : 'request');
  };

  const principalOf = (request: IncomingMessage, response: ServerResponse, action: string): DevicePrincipal | undefined => {
    const auth = lifecycle.authenticate(request);
    if (auth.ok) return auth.principal;
    rejectAuth(response, auth.code, action);
    return undefined;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = pathOf(request);
    if (path !== DEVICE_LIST_PATH && path.startsWith(`${DEVICE_LIST_PATH}/`) === false) return false;
    const url = new URL(request.url ?? '/', controlUrl);
    const single = (name: string): string | undefined => {
      const values = url.searchParams.getAll(name);
      if (values.length > 1) return undefined;
      return values[0];
    };

    if (path === DEVICE_PAIR_PATH) {
      if (request.method !== 'POST') {
        reject(response, 405, 'request-invalid', 'pair', 'request');
        return true;
      }
      const body = await readLimitedBody(request, DEVICE_PAIR_BODY_LIMIT);
      if (body === undefined) {
        telemetry.counter('chatdsh_gateway_device_pairs_total', { description: '节点配对次数' })
          .add(1, { outcome: 'rejected' });
        reject(response, 413, 'payload-too-large', 'pair', 'request');
        return true;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        telemetry.counter('chatdsh_gateway_device_pairs_total', { description: '节点配对次数' })
          .add(1, { outcome: 'rejected' });
        reject(response, 400, 'request-invalid', 'pair', 'request');
        return true;
      }
      const parsed = pairingRequestSchema.safeParse(payload);
      if (!parsed.success) {
        telemetry.counter('chatdsh_gateway_device_pairs_total', { description: '节点配对次数' })
          .add(1, { outcome: 'rejected' });
        reject(response, 400, 'request-invalid', 'pair', 'request');
        return true;
      }
      try {
        const outcome = lifecycle.pair(parsed.data, pairingSourceOf(request));
        sendJson(response, 200, { ...outcome.result, device: outcome.device });
      } catch (error) {
        if (!(error instanceof DeviceError)) throw error;
        if (error.retryAfterMs !== undefined) response.setHeader('Retry-After', Math.ceil(error.retryAfterMs / 1000));
        sendJson(response, error.status, { error: error.code, retryAfterMs: error.retryAfterMs });
      }
      return true;
    }

    if (path === DEVICE_PAIRING_PATH) {
      if (request.method !== 'GET') {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'pairing', outcome: 'rejected' });
        reject(response, 405, 'request-invalid', 'pairing', 'request');
        return true;
      }
      if (principalOf(request, response, 'pairing') === undefined) {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'pairing', outcome: 'rejected' });
        return true;
      }
      const kind = single('kind') === 'qr' ? 'qr' : 'manual';
      const code = lifecycle.issuePairingCode(kind);
      telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
        .add(1, { action: 'pairing', outcome: 'issued' });
      sendJson(response, 200, { ...code, encoded: pairingEncodedOf(code) });
      return true;
    }

    if (path === DEVICE_LIST_PATH) {
      if (request.method !== 'GET') {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'list', outcome: 'rejected' });
        reject(response, 405, 'request-invalid', 'list', 'request');
        return true;
      }
      const principal = principalOf(request, response, 'list');
      if (principal === undefined) {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'list', outcome: 'rejected' });
        return true;
      }
      const list: DeviceList = lifecycle.listDevices(principal);
      sendJson(response, 200, list);
      return true;
    }

    if (path === DEVICE_REVOKE_PATH) {
      if (request.method !== 'POST') {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'revoke', outcome: 'rejected' });
        reject(response, 405, 'request-invalid', 'revoke', 'request');
        return true;
      }
      if (principalOf(request, response, 'revoke') === undefined) {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'revoke', outcome: 'rejected' });
        return true;
      }
      const body = await readLimitedBody(request, DEVICE_REVOKE_BODY_LIMIT);
      if (body === undefined) {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'revoke', outcome: 'rejected' });
        reject(response, 413, 'payload-too-large', 'revoke', 'request');
        return true;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'revoke', outcome: 'rejected' });
        reject(response, 400, 'request-invalid', 'revoke', 'request');
        return true;
      }
      const parsed = deviceRevokeRequestSchema.safeParse(payload);
      if (!parsed.success) {
        telemetry.counter('chatdsh_mobile_devices_total', { description: '设备管理操作' })
          .add(1, { action: 'revoke', outcome: 'rejected' });
        reject(response, 400, 'request-invalid', 'revoke', 'request');
        return true;
      }
      try {
        const outcome = lifecycle.revoke(parsed.data);
        sendJson(response, 200, outcome.result);
      } catch (error) {
        if (!(error instanceof DeviceError)) throw error;
        sendJson(response, error.status, { error: error.code });
      }
      return true;
    }

    if (path === DEVICE_LINK_CHECK_PATH) {
      if (request.method !== 'GET') {
        telemetry.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
          .add(1, { outcome: 'link-rejected' });
        reject(response, 405, 'request-invalid', 'link-check', 'request');
        return true;
      }
      if (principalOf(request, response, 'link-check') === undefined) {
        telemetry.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
          .add(1, { outcome: 'link-rejected' });
        return true;
      }
      const deviceId = single('deviceId');
      if (deviceId === undefined || deviceId === '') {
        telemetry.counter('chatdsh_gateway_device_requests_total', { description: '沿设备连接转发的请求数' })
          .add(1, { outcome: 'link-rejected' });
        reject(response, 400, 'request-invalid', 'link-check', 'request');
        return true;
      }
      try {
        const check: DeviceLinkCheck = await lifecycle.checkLink(deviceId);
        sendJson(response, 200, check);
      } catch (error) {
        if (!(error instanceof DeviceError)) throw error;
        sendJson(response, error.status, { error: error.code });
      }
      return true;
    }

    if (path === DEVICE_STREAM_PATH) {
      if (request.method !== 'GET') {
        reject(response, 405, 'request-invalid', 'stream', 'request');
        return true;
      }
      const principal = principalOf(request, response, 'stream');
      if (principal === undefined) return true;
      openStream(response, principal);
      return true;
    }

    if (path === DEVICE_WAIT_PATH) {
      if (request.method !== 'GET') {
        reject(response, 405, 'request-invalid', 'wait', 'request');
        return true;
      }
      const principal = principalOf(request, response, 'wait');
      if (principal === undefined) return true;
      const requested = Number(single('timeoutMs') ?? waitTimeoutMs);
      const timeout = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 10), 60_000) : waitTimeoutMs;
      openWait(response, principal, timeout);
      return true;
    }

    return false;
  };

  /** 打开一条 SSE 流并登记为设备通道。 */
  const openStream = (response: ServerResponse, principal: DevicePrincipal): void => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 5000\n\n');
    response.write(`event: ready\ndata: ${JSON.stringify({ deviceId: principal.id, kind: principal.kind })}\n\n`);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n');
    }, heartbeatMs);
    heartbeat.unref();
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      release();
      active.delete(finish);
    };
    const shutdown = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      response.destroy();
      active.delete(finish);
    };
    const release = transports.track(principal.id, 'sse', shutdown);
    active.add(finish);
    response.on('close', finish);
    response.on('error', finish);
  };

  /** 打开一条在途 HTTP 请求并登记为设备通道。 */
  const openWait = (response: ServerResponse, principal: DevicePrincipal, timeoutMs: number): void => {
    const timer = setTimeout(() => {
      release();
      active.delete(finish);
      if (!response.writableEnded) {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
      }
    }, timeoutMs);
    timer.unref();
    const finish = (): void => {
      clearTimeout(timer);
      release();
      active.delete(finish);
    };
    const shutdown = (): void => {
      clearTimeout(timer);
      active.delete(finish);
      if (!response.writableEnded) response.destroy();
    };
    const release = transports.track(principal.id, 'http', shutdown);
    active.add(finish);
    response.on('close', finish);
    response.on('error', finish);
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (pathOf(request) !== DEVICE_SOCKET_PATH) return false;
    void head;
    const auth = lifecycle.authenticate(request);
    if (auth.ok === false) {
      telemetry.event('chatdsh.gateway.device.rejected', {
        action: 'socket',
        outcome: 'rejected',
        'error.type': 'auth',
        'error.code': auth.code,
      });
      rejectSocketUpgrade(socket, 401, auth.code);
      return true;
    }
    if (!websocketVersionSupported(request) || typeof request.headers['sec-websocket-key'] !== 'string') {
      telemetry.event('chatdsh.gateway.device.rejected', {
        action: 'socket',
        outcome: 'rejected',
        'error.type': 'protocol',
        'error.code': 'handshake-invalid',
      });
      rejectSocketUpgrade(socket, 400, 'handshake-invalid');
      return true;
    }
    const handshake = WebSocketHandshake.accept(socket, request, []);
    handshake.writeHead();
    handshake.writeText(JSON.stringify({ kind: 'ready', deviceId: auth.principal.id }));
    const release = transports.track(auth.principal.id, 'websocket', () => socket.destroy());
    socket.on('close', release);
    socket.on('error', () => socket.destroy());
    return true;
  };

  return {
    handle,
    handleUpgrade,
    stop(): void {
      for (const finish of [...active]) finish();
      active.clear();
    },
  };
}

/** 生成给二维码或手填使用的编码，内容与控制平面一致。 */
export function pairingEncodedOf(code: PairingCode): string {
  return Buffer.from(JSON.stringify({
    version: 2,
    publicUrl: `${code.controlUrl.replace(/^http/, 'ws')}/ws/mobile`,
    controlUrl: code.controlUrl,
    pairingCode: code.code,
    expiresAt: code.expiresAt,
  }), 'utf8').toString('base64url');
}
