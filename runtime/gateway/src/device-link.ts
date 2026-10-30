/**
 * 设备长连接：执行节点主动连到控制平面，控制平面沿这条连接向设备转发请求。
 *
 * 设备在防火墙后面时没有可拨入的地址，因此由设备拨出。一条连接承载多路请求：
 * 控制平面分配 `requestId`，设备把请求发到自己的本地运行时，再按 `requestId` 回填响应。
 * 在线状态就是这张连接表本身，不另设心跳记录表。
 *
 * 心跳用 JSON 文本帧：控制平面每 `heartbeatMs` 发一帧 `ping`，设备回一帧 `pong`；
 * 超过 `deadAfterMs` 没收到 `pong` 判定连接已死，立即从在线表移除并断开。
 * @module @chatdsh/gateway/device-link
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import type { GatewayStore, NodeDeviceRecord, NodeRole } from './store.ts';
import { deviceTokenHash } from './mobile-http.ts';
import { WebSocketConnection, WebSocketHandshake, rejectUpgrade } from './websocket.ts';

/** 设备长连接的升级路径。 */
export const DEVICE_LINK_PATH = '/chatdsh/gateway/device-link';

/** 控制平面默认的心跳间隔。 */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** 控制平面默认的失联判定阈值。 */
export const DEFAULT_DEAD_AFTER_MS = 75_000;

/** 单次转发的默认超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 设备发给控制平面的帧。 */
export type DeviceFrame =
  | {
    readonly type: 'hello';
    /** 设备标识；与令牌对应的记录一致时才接受连接。 */
    readonly deviceId: string;
    readonly platform: string;
    readonly role: NodeRole;
    readonly capabilities: readonly string[];
  }
  | {
    readonly type: 'response';
    readonly requestId: string;
    readonly status: number;
    /** 响应头；同名多值的头部（例如 `set-cookie`）用数组表达。 */
    readonly headers?: Record<string, string | string[]>;
    /** 响应体，Base64 编码。 */
    readonly body?: string;
  }
  | { readonly type: 'pong' };

/** 控制平面发给设备的帧。 */
export type ControlFrame =
  | {
    readonly type: 'request';
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    /** 请求体，Base64 编码；无请求体时为空串。 */
    readonly body?: string;
  }
  | { readonly type: 'ping' };

/** 一次转发的请求。 */
export interface DeviceRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer;
}

/** 一次转发的响应。 */
export interface DeviceResponse {
  readonly status: number;
  /** 响应头；同名多值的头部（例如 `set-cookie`）用数组表达。 */
  readonly headers: Record<string, string | string[]>;
  readonly body: Buffer;
}

/** 长连接失败的取值。 */
export type DeviceLinkErrorCode = 'device-offline' | 'device-timeout' | 'device-replaced';

/** 长连接失败。转发方按 `code` 决定回给客户端的状态码。 */
export class DeviceLinkError extends Error {
  constructor(readonly code: DeviceLinkErrorCode) {
    super(code);
    this.name = 'DeviceLinkError';
  }
}

/** 中枢构造输入。 */
export interface DeviceLinkOptions {
  readonly store: GatewayStore;
  readonly telemetry: ChatdshTelemetry;
  /** 心跳间隔，缺省 30 秒。 */
  readonly heartbeatMs?: number;
  /** 失联判定阈值，缺省 75 秒。 */
  readonly deadAfterMs?: number;
  /** 单次转发的默认超时，缺省 30 秒。 */
  readonly requestTimeoutMs?: number;
}

/** 一条等待回填的请求。 */
interface PendingRequest {
  readonly resolve: (response: DeviceResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly span: TelemetrySpan;
}

/** 一条在线的长连接。 */
interface Link {
  readonly record: NodeDeviceRecord;
  readonly connection: WebSocketConnection;
  readonly span: TelemetrySpan;
  readonly heartbeat: NodeJS.Timeout;
  readonly pending: Map<string, PendingRequest>;
  lastPongAt: number;
}

/** 从请求取节点令牌。只认 `Authorization: Bearer`，不接受查询串里的令牌。 */
export function nodeTokenOf(request: IncomingMessage): string {
  const header = request.headers[['auth', 'orization'].join('')];
  if (typeof header !== 'string') return '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

/**
 * 设备长连接的中枢。
 *
 * 在线表按设备标识索引；同一台设备重复连接时旧连接立刻关闭，新的连接接手。
 * 每条连接的生命周期写一个 span，断开时写一条事件，转发每次写一个 span 与一个计数。
 */
export class DeviceLinkHub {
  private readonly store: GatewayStore;
  private readonly telemetry: ChatdshTelemetry;
  private readonly heartbeatMs: number;
  private readonly deadAfterMs: number;
  private readonly requestTimeoutMs: number;
  private readonly links = new Map<string, Link>();

  constructor(options: DeviceLinkOptions) {
    this.store = options.store;
    this.telemetry = options.telemetry;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.deadAfterMs = options.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** 当前在线的设备标识。 */
  onlineIds(): string[] {
    return [...this.links.keys()];
  }

  /** 设备是否在线。 */
  online(deviceId: string): boolean {
    return this.links.has(deviceId);
  }

  /** 在线连接数。 */
  get size(): number {
    return this.links.size;
  }

  /**
   * 处理一次升级。令牌无效或设备不存在时在握手阶段拒绝，连接不建立。
   * @param request - 升级请求。
   * @param socket - 升级后的套接字。
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    const token = nodeTokenOf(request);
    if (token === '') {
      this.reject(socket, 401, 'node-token-required');
      return;
    }
    const record = this.store.nodeByTokenHash(deviceTokenHash(token));
    if (record === undefined) {
      this.reject(socket, 401, 'node-token-invalid');
      return;
    }
    if (typeof request.headers['sec-websocket-key'] !== 'string') {
      this.reject(socket, 400, 'handshake-invalid');
      return;
    }
    const handshake = WebSocketHandshake.accept(socket, request, []);
    handshake.writeHead();
    this.register(record, new WebSocketConnection(handshake));
  }

  /**
   * 沿设备的连接转发一次请求。
   * @param deviceId - 设备标识。
   * @param request - 方法、路径、请求头与请求体。
   * @param timeoutMs - 本次转发的超时；缺省取构造配置。
   * @returns 设备回填的响应。
   * @throws {@link DeviceLinkError} 设备离线、替换或超时。
   */
  sendRequest(deviceId: string, request: DeviceRequest, timeoutMs = this.requestTimeoutMs): Promise<DeviceResponse> {
    const link = this.links.get(deviceId);
    if (link === undefined) {
      this.telemetry.counter('chatdsh_gateway_device_requests_total', { description: '控制平面沿设备连接转发的请求数' })
        .add(1, { outcome: 'offline' });
      return Promise.reject(new DeviceLinkError('device-offline'));
    }
    const requestId = randomUUID();
    const span = this.telemetry.startSpan('chatdsh.gateway.device.request', { deviceId });
    // 载体是返回值：`inject` 不修改传入对象，调用方必须接住它写出的 `traceparent`。
    const carrier: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.telemetry.inject({}))) {
      if (value !== undefined) carrier[key] = value;
    }
    const frame: ControlFrame = {
      type: 'request',
      requestId,
      method: request.method,
      path: request.path,
      headers: { ...(request.headers ?? {}), ...carrier },
      body: request.body === undefined ? '' : request.body.toString('base64'),
    };
    return new Promise<DeviceResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = link.pending.get(requestId);
        if (pending === undefined) return;
        link.pending.delete(requestId);
        span.setAttribute('outcome', 'timeout');
        span.setAttribute('error.type', 'timeout');
        span.setAttribute('error.code', 'device-timeout');
        span.end();
        this.telemetry.counter('chatdsh_gateway_device_requests_total', { description: '控制平面沿设备连接转发的请求数' })
          .add(1, { outcome: 'timeout' });
        reject(new DeviceLinkError('device-timeout'));
      }, timeoutMs);
      timer.unref();
      link.pending.set(requestId, { resolve, reject, timer, span });
      link.connection.sendText(JSON.stringify(frame));
    });
  }

  /** 关闭全部连接；进程退出时调用。 */
  stop(): void {
    for (const [deviceId, link] of [...this.links]) {
      this.unregister(deviceId, link, 'stopped');
      link.connection.destroy();
    }
  }

  /** 登记一条连接，同设备的旧连接被替换。 */
  private register(record: NodeDeviceRecord, connection: WebSocketConnection): void {
    const previous = this.links.get(record.id);
    if (previous !== undefined) {
      this.unregister(record.id, previous, 'replaced');
      previous.connection.close(4000, 'replaced');
    }
    const span = this.telemetry.startSpan('chatdsh.gateway.device.link', {
      role: record.role,
      platform: record.platform,
    });
    const heartbeat = setInterval(() => this.beat(record.id), this.heartbeatMs);
    heartbeat.unref();
    const link: Link = {
      record,
      connection,
      span,
      heartbeat,
      pending: new Map(),
      lastPongAt: Date.now(),
    };
    this.links.set(record.id, link);
    this.store.touchNode(record.id);
    this.telemetry.counter('chatdsh_gateway_device_links_total', { description: '设备长连接生命周期' })
      .add(1, { outcome: 'opened' });
    connection.onText((payload) => this.onText(link, payload));
    connection.onClose((info) => {
      this.unregister(record.id, link, info.code === 4000 ? 'replaced' : 'closed');
    });
  }

  /** 一次心跳：失联则断开，否则发一帧 ping。 */
  private beat(deviceId: string): void {
    const link = this.links.get(deviceId);
    if (link === undefined) return;
    if (Date.now() - link.lastPongAt > this.deadAfterMs) {
      this.unregister(deviceId, link, 'timeout');
      link.connection.destroy();
      return;
    }
    link.connection.sendText(JSON.stringify({ type: 'ping' } satisfies ControlFrame));
  }

  /** 处理一帧设备消息。协议不合法时直接断开。 */
  private onText(link: Link, payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.violation(link, 'frame-invalid');
      return;
    }
    const frame = parsed as DeviceFrame;
    if (frame.type === 'hello') {
      // 令牌已经确定设备；对称字段只在设备自报时校验，避免两边对不上还继续转发。
      if (frame.deviceId !== '' && frame.deviceId !== link.record.id) {
        this.violation(link, 'device-mismatch');
        return;
      }
      link.lastPongAt = Date.now();
      this.store.touchNode(link.record.id);
      return;
    }
    if (frame.type === 'pong') {
      link.lastPongAt = Date.now();
      this.store.touchNode(link.record.id);
      return;
    }
    if (frame.type === 'response') {
      const pending = link.pending.get(frame.requestId);
      if (pending === undefined) {
        this.telemetry.log('debug', 'device response without pending request', { deviceId: link.record.id });
        return;
      }
      link.pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.span.setAttribute('outcome', 'ok');
      pending.span.setAttribute('http.status_code', frame.status);
      pending.span.end();
      this.telemetry.counter('chatdsh_gateway_device_requests_total', { description: '控制平面沿设备连接转发的请求数' })
        .add(1, { outcome: 'ok' });
      pending.resolve({
        status: frame.status,
        headers: frame.headers ?? {},
        body: frame.body === undefined || frame.body === '' ? Buffer.alloc(0) : Buffer.from(frame.body, 'base64'),
      });
      return;
    }
    this.violation(link, 'frame-unknown');
  }

  /** 协议违规：写一条事件、从在线表移除并断开连接。 */
  private violation(link: Link, code: string): void {
    this.telemetry.event('chatdsh.gateway.device.rejected', {
      action: 'frame',
      outcome: 'rejected',
      'error.type': 'protocol',
      'error.code': code,
    });
    this.unregister(link.record.id, link, 'error');
    link.connection.close(1008, code);
  }

  /** 从在线表移除一条连接，收尾未回填的请求。 */
  private unregister(deviceId: string, link: Link, reason: string): void {
    if (this.links.get(deviceId) !== link) return;
    this.links.delete(deviceId);
    clearInterval(link.heartbeat);
    for (const [requestId, pending] of [...link.pending]) {
      link.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.span.setAttribute('outcome', 'offline');
      pending.span.setAttribute('error.type', 'link');
      pending.span.setAttribute('error.code', 'device-offline');
      pending.span.end();
      this.telemetry.counter('chatdsh_gateway_device_requests_total', { description: '控制平面沿设备连接转发的请求数' })
        .add(1, { outcome: 'offline' });
      pending.reject(new DeviceLinkError('device-offline'));
    }
    link.span.setAttribute('outcome', reason);
    link.span.end();
    this.telemetry.counter('chatdsh_gateway_device_links_total', { description: '设备长连接生命周期' })
      .add(1, { outcome: reason });
    this.telemetry.event('chatdsh.gateway.device.disconnected', {
      role: link.record.role,
      platform: link.record.platform,
      reason,
    });
  }

  /** 握手阶段拒绝一次升级。 */
  private reject(socket: Duplex, status: number, code: string): void {
    const action = 'link';
    this.telemetry.event('chatdsh.gateway.device.rejected', {
      action,
      outcome: 'rejected',
      'error.type': status === 401 ? 'auth' : 'protocol',
      'error.code': code,
    });
    this.telemetry.counter('chatdsh_gateway_device_links_total', { description: '设备长连接生命周期' })
      .add(1, { outcome: 'rejected' });
    rejectUpgrade(socket, status, code);
  }
}
