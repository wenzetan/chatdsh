/**
 * 设备长连接：执行节点主动连到控制平面，控制平面沿这条连接向设备转发请求。
 *
 * 设备在防火墙后面时没有可拨入的地址，因此由设备拨出。一条连接同时承载多条通道：
 * 控制平面为每条通道分配 `channelId`，设备把通道里的请求发到自己的本地运行时，再按通道
 * 回填响应。在线状态就是这张连接表本身，不另设心跳记录表。
 *
 * 协议有两个版本。版本 1 是最早的单次转发：控制平面发 `request`，设备回 `response`。
 * 版本 2 是按通道多路复用的帧协议：`open`／`accepted`／`data`／`credit`／`end`／
 * `cancel`／`cancelled`／`reset`，每条通道有独立序号与额度，连接有发送缓冲上限，
 * 慢消费者靠扣住额度让上游停止读取。握手帧 `hello` 带 `version`：带版本 2 的连接走通道
 * 帧，不带的连接按版本 1 处理。
 *
 * 心跳对两个版本都用文本帧：控制平面每 `heartbeatMs` 发一帧 `ping`，设备回一帧 `pong`；
 * 超过 `deadAfterMs` 没有收到 `pong` 判定连接已死，立即从在线表移除并断开。
 *
 * 同一台设备的新代次替换旧连接：旧连接上的通道全部以 `device-replaced` 明确失败，不会被
 * 静默丢弃。
 * @module @chatdsh/gateway/device-link
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import type { GatewayStore, NodeDeviceRecord, NodeRole } from './store.ts';
import { deviceTokenHash } from './mobile-http.ts';
import { WebSocketConnection, WebSocketHandshake, rejectUpgrade, websocketVersionSupported } from './websocket.ts';

/** 设备长连接的升级路径。 */
export const DEVICE_LINK_PATH = '/chatdsh/gateway/device-link';

/** 按设备路由的路径形状：`/d/<deviceId>` 与它下面的全部路径。 */
export const DEVICE_PREFIX_PATH = /^\/d\/([^/]+)(\/.*)?$/;

/** 当前实现的通道协议版本。 */
export const PROTOCOL_VERSION = 2;

/** 最早的转发协议版本：一次 `request` 对一次 `response`。 */
export const LEGACY_PROTOCOL_VERSION = 1;

/** 每个连接允许同时打开的通道数上限。 */
export const MAX_CHANNELS_PER_LINK = 128;

/** 每个连接允许积压的发送字节上限。 */
export const LINK_SEND_BUFFER_BYTES = 8 * 1024 * 1024;

/** 每条通道的初始单向额度。 */
export const CHANNEL_INITIAL_CREDIT_BYTES = 256 * 1024;

/** 单个数据帧里载荷的字节上限。 */
export const DATA_PAYLOAD_MAX_BYTES = 32 * 1024;

/** 单个通道协议帧的字节上限。 */
export const FRAME_MAX_BYTES = 64 * 1024;

/** 版本 1 的单帧上限：它的响应体按 Base64 放在一帧里，比通道帧宽。 */
export const LEGACY_FRAME_MAX_BYTES = 12 * 1024 * 1024;

/** 握手允许的时长。 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** 通道从打开到收到响应头的时长上限。 */
export const RESPONSE_HEADER_TIMEOUT_MS = 30_000;

/** 通道上没有数据流动的时长上限。 */
export const STREAM_IDLE_TIMEOUT_MS = 75_000;

/** 取消后等待设备确认的时长上限。 */
export const CANCEL_ACK_TIMEOUT_MS = 2_000;

/** 缓冲读取的响应体上限，与转发请求体的上限一致。 */
export const MAX_BUFFERED_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 单条连接允许累计的协议违规次数，达到上限关闭整条连接。 */
export const PROTOCOL_VIOLATION_LIMIT = 3;

/** 按设备前缀允许升级的 WebSocket 路径白名单。 */
export const DEVICE_UPGRADE_PATHS: readonly string[] = ['/api/remote.mux'];

/** 前缀资源路径的长度上限。 */
export const DEVICE_PATH_MAX_LENGTH = 2048;

/** 完成结果在连接上保留的时长，用于同一 `operationId` 的重复提交。 */
export const OPERATION_CACHE_MS = 5 * 60_000;

/** 每条连接保留的完成结果条数上限。 */
export const OPERATION_CACHE_LIMIT = 256;

/** 通道去重记录保留的事件标识条数上限。 */
export const CHANNEL_DEDUP_LIMIT = 1024;

/** 控制平面默认的心跳间隔。 */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** 控制平面默认的失联判定阈值。 */
export const DEFAULT_DEAD_AFTER_MS = 75_000;

/** 单次转发的默认超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 通道种类：普通 HTTP、事件订阅与 WebSocket 隧道。 */
export type ChannelKind = 'http' | 'events' | 'websocket';

/** 通道状态。任何非终态可以进入 `cancelling` 或 `closed`。 */
export type ChannelState = 'opening' | 'active' | 'half-closed' | 'cancelling' | 'closed';

/** 通道被终止时的稳定枚举。 */
export type ChannelResetCode =
  | 'channel-unknown'
  | 'channel-limit'
  | 'seq-out-of-order'
  | 'seq-duplicate'
  | 'credit-exceeded'
  | 'buffer-exceeded'
  | 'frame-too-large'
  | 'path-invalid'
  | 'header-timeout'
  | 'idle-timeout'
  | 'request-timeout'
  | 'cancel-timeout'
  | 'response-too-large'
  | 'event-invalid'
  | 'consumer-failed'
  | 'cancelled'
  | 'link-closed'
  | 'upgrade-rejected';

/** 前缀资源路径被拒绝的稳定枚举。 */
export type DevicePathRejectionCode =
  | 'device-url-absolute'
  | 'device-path-not-relative'
  | 'device-path-malformed'
  | 'device-path-traversal'
  | 'device-path-too-long';

/** 前缀资源路径的解析结果。 */
export type DeviceResourceResolution =
  | { readonly ok: true; readonly deviceId: string; readonly path: string }
  | { readonly ok: false; readonly code: DevicePathRejectionCode };

/** 一次连接上的固定预算。 */
export interface LinkLimits {
  readonly maxChannels: number;
  readonly sendBufferBytes: number;
  readonly initialCreditBytes: number;
  readonly dataPayloadMaxBytes: number;
  readonly frameMaxBytes: number;
}

/** 一次连接上的超时预算。 */
export interface ChannelTimers {
  readonly handshakeMs: number;
  readonly headerMs: number;
  readonly idleMs: number;
  readonly cancelAckMs: number;
}

/** 版本 1 的设备帧。 */
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

/** 版本 1 的控制帧。 */
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

/** 版本 2 的设备帧。 */
export type DeviceFrameV2 =
  | {
    readonly type: 'hello';
    readonly version: number;
    readonly deviceId: string;
    readonly platform: string;
    readonly role: NodeRole;
    readonly capabilities: readonly string[];
  }
  | { readonly type: 'ping'; readonly generation: number; readonly nonce: string }
  | { readonly type: 'pong'; readonly generation: number; readonly nonce?: string }
  | {
    readonly type: 'accepted';
    readonly channelId: string;
    readonly generation: number;
    readonly status: number;
    readonly headers?: Record<string, string | string[]>;
  }
  | {
    readonly type: 'data';
    readonly channelId: string;
    readonly generation: number;
    readonly seq: number;
    readonly payloadLength: number;
    readonly payload: string;
    /** 事件订阅里的稳定事件标识；HTTP 响应没有这个字段。 */
    readonly eventId?: string;
  }
  | { readonly type: 'end'; readonly channelId: string; readonly generation: number; readonly lastSeq: number }
  | { readonly type: 'credit'; readonly channelId: string; readonly generation: number; readonly bytes: number }
  | { readonly type: 'cancelled'; readonly channelId: string; readonly generation: number; readonly reason: string }
  | { readonly type: 'reset'; readonly channelId: string; readonly generation: number; readonly code: string };

/** 版本 2 的控制帧。 */
export type ControlFrameV2 =
  | {
    readonly type: 'welcome';
    readonly version: number;
    readonly deviceId: string;
    readonly generation: number;
    readonly limits: LinkLimits;
  }
  | {
    readonly type: 'open';
    readonly channelId: string;
    readonly generation: number;
    readonly kind: ChannelKind;
    readonly method: string;
    readonly path: string;
    readonly headers: Record<string, string>;
    readonly operationId: string;
  }
  | {
    readonly type: 'data';
    readonly channelId: string;
    readonly generation: number;
    readonly seq: number;
    readonly payloadLength: number;
    readonly payload: string;
  }
  | { readonly type: 'credit'; readonly channelId: string; readonly generation: number; readonly bytes: number }
  | { readonly type: 'end'; readonly channelId: string; readonly generation: number; readonly lastSeq: number }
  | { readonly type: 'cancel'; readonly channelId: string; readonly generation: number; readonly reason: string }
  | { readonly type: 'reset'; readonly channelId: string; readonly generation: number; readonly code: string }
  | { readonly type: 'ping'; readonly generation: number; readonly nonce: string }
  | { readonly type: 'pong'; readonly generation: number; readonly nonce?: string };

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

/** 打开一条通道的输入。 */
export interface DeviceChannelSpec {
  readonly kind: ChannelKind;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  /** 写操作的幂等标识；同连接上同标识直接返回已保存的结果。 */
  readonly operationId?: string;
  /** 本次通道的响应头超时；缺省取连接预算。 */
  readonly headerTimeoutMs?: number;
}

/** 通道收到的响应头。 */
export interface ChannelAcceptance {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
}

/** 通道结束方式。 */
export interface ChannelClose {
  /** `ended` 为双方正常结束；其余是终止码。 */
  readonly code: 'ended' | 'cancelled' | ChannelResetCode;
}

/** 长连接失败的取值。转发方按 `code` 决定回给客户端的状态码。 */
export type DeviceLinkErrorCode =
  | 'device-offline'
  | 'device-timeout'
  | 'device-replaced'
  | 'device-revoked'
  | 'device-unsupported'
  | 'device-path-invalid'
  | 'device-channel-limit'
  | 'device-channel-reset'
  | 'device-channel-cancelled'
  | 'device-buffer-exceeded'
  | 'device-handshake-failed'
  | 'device-upgrade-rejected';

/** 一次按设备升级的结果；供路由层写 span 与指标。 */
export type DeviceUpgradeOutcome =
  | 'upgraded'
  | 'device-offline'
  | 'path-invalid'
  | 'device-not-found'
  | 'device-revoked'
  | 'handshake-invalid'
  | 'upgrade-rejected';

/** 一次按设备升级的完整结果。 */
export interface DeviceUpgradeResult {
  /** 稳定的结果枚举。 */
  readonly outcome: DeviceUpgradeOutcome;
  /** 回给浏览器的状态码；成功时为 101。 */
  readonly status: number;
  /** 稳定的错误码；成功时为 `upgraded`。 */
  readonly code: string;
  /** 失败类别的稳定枚举。 */
  readonly errorType?: 'auth' | 'request' | 'protocol' | 'link' | 'upgrade';
}

/** 长连接失败。转发方按 `code` 决定回给客户端的状态码。 */
export class DeviceLinkError extends Error {
  constructor(readonly code: DeviceLinkErrorCode, readonly channelCode?: string) {
    super(channelCode === undefined ? code : `${code}:${channelCode}`);
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
  /** 连接预算的部分覆盖。 */
  readonly limits?: Partial<LinkLimits>;
  /** 通道超时预算的部分覆盖。 */
  readonly timers?: Partial<ChannelTimers>;
}

/** 一条等待回填的版本 1 请求。 */
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
  readonly generation: number;
  readonly limits: LinkLimits;
  readonly timers: ChannelTimers;
  readonly ready: Deferred<void>;
  readonly pending: Map<string, PendingRequest>;
  readonly channels: Map<string, DeviceChannel>;
  readonly operations: Map<string, CachedOperation>;
  handshakeTimer: NodeJS.Timeout | undefined;
  protocol: 'pending' | typeof LEGACY_PROTOCOL_VERSION | typeof PROTOCOL_VERSION;
  lastPongAt: number;
  violations: number;
}

/** 一条连接上保存的完成结果。 */
interface CachedOperation {
  readonly response: DeviceResponse;
  readonly at: number;
}

/** 一个可结算的等待点。 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: Error): void;
}

/** 造一个可结算的等待点。无人等待时被拒绝不让进程崩溃；有等待者时照常抛出。 */
function deferred<T>(): Deferred<T> {
  let resolveCallback: (value: T) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolveCallback = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectCallback = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  // 等待点可能没有任何 await 者（握手完成前连接被移除、通道在响应头到达前被终止）。
  // 不吞掉错误，只把「未处理拒绝」从致命变为可查询：调用方仍然拿到同一个拒绝。
  void promise.catch(() => undefined);
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve: (value: T) => resolveCallback(value),
    reject: (error: Error) => rejectCallback(error),
  };
}

/** 定时器统一不拖住进程。 */
function armTimer(ms: number, handler: () => void): NodeJS.Timeout {
  const timer = setTimeout(handler, ms);
  timer.unref();
  return timer;
}

/** 版本 2 的字段是否是非负安全整数。 */
function isSequenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 只保留有取值的传播头，避免把 undefined 写进请求头。 */
function traceHeaders(carrier: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(carrier)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 校验一条转发给设备运行时的目标路径。
 *
 * 只接受以单个 `/` 开始的相对路径：完整 URL、`//`、路径穿越与解码后越界全部拒绝。
 * @param path - 目标路径，可带查询串。
 * @returns 拒绝码；路径合法时为空。
 */
export function validateDeviceTargetPath(path: string): DevicePathRejectionCode | undefined {
  if (!path.startsWith('/')) return 'device-path-not-relative';
  const queryAt = path.indexOf('?');
  const pathOnly = queryAt === -1 ? path : path.slice(0, queryAt);
  if (pathOnly.startsWith('//') || pathOnly.includes('//')) return 'device-path-malformed';
  if (path.includes('\0')) return 'device-path-malformed';
  if (pathOnly.length > DEVICE_PATH_MAX_LENGTH) return 'device-path-too-long';
  let decodedLength = 0;
  for (const segment of pathOnly.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return 'device-path-malformed';
    }
    if (decoded.includes('/') || decoded.includes('\\')) return 'device-path-traversal';
    if (decoded === '.' || decoded === '..') return 'device-path-traversal';
    if (decoded.includes('\0')) return 'device-path-malformed';
    decodedLength += decoded.length + 1;
  }
  if (decodedLength > DEVICE_PATH_MAX_LENGTH) return 'device-path-too-long';
  return undefined;
}

/**
 * 解析一次 `/d/<deviceId>/<rest>` 请求。
 *
 * 设备标识按编码后的一段解析；`rest` 保留原编码与查询串，先按
 * {@link validateDeviceTargetPath} 校验再返回。
 * @param rawUrl - 入站请求的路径与查询串。
 * @returns 解析结果；被拒绝时带稳定枚举。
 */
export function resolveDeviceResourcePath(rawUrl: string): DeviceResourceResolution {
  if (!rawUrl.startsWith('/')) return { ok: false, code: 'device-url-absolute' };
  const queryAt = rawUrl.indexOf('?');
  const rawPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const query = queryAt === -1 ? '' : rawUrl.slice(queryAt);
  const matched = DEVICE_PREFIX_PATH.exec(rawPath);
  if (matched === null) return { ok: false, code: 'device-path-not-relative' };
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(matched[1] ?? '');
  } catch {
    return { ok: false, code: 'device-path-malformed' };
  }
  if (
    deviceId === '' || deviceId === '.' || deviceId === '..'
    || deviceId.includes('/') || deviceId.includes('\\') || deviceId.includes('\0')
  ) {
    return { ok: false, code: 'device-path-malformed' };
  }
  const rest = matched[2] === undefined || matched[2] === '' ? '/' : matched[2];
  const rejection = validateDeviceTargetPath(rest);
  if (rejection !== undefined) return { ok: false, code: rejection };
  return { ok: true, deviceId, path: `${rest}${query}` };
}

/** 从请求取节点令牌。只认 `Authorization: Bearer`，不接受查询串里的令牌。 */
export function nodeTokenOf(request: IncomingMessage): string {
  const header = request.headers[['auth', 'orization'].join('')];
  if (typeof header !== 'string') return '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

/** 逐跳头部：前缀升级时不转发请求方向，也不回填响应方向。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** 前缀升级里不转发的凭据头：运行时凭据由设备插件自己添加。 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie']);

/** 一条发送方向上的额度等待者。 */
interface CreditWaiter {
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * 一条通道。
 *
 * 通道自己管两件事：两个方向各自的序号与额度，以及一条收尾路径。发送方向严格按额度
 * 拆帧，额度不足就等待设备补充；接收方向校验序号连续与额度上限，消费者处理完一段后才
 * 给设备补充额度，慢消费者因此把上游读取停住。
 */
export class DeviceChannel {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly operationId: string;
  /** 所属设备的标识；连接被替换后仍可据此收尾。 */
  readonly linkDeviceId: string;
  state: ChannelState = 'opening';
  status: number | undefined;
  headers: Record<string, string | string[]> | undefined;

  private readonly hub: DeviceLinkHub;
  private readonly link: Link;
  private readonly span: TelemetrySpan;
  private readonly acceptedDeferred = deferred<ChannelAcceptance>();
  private readonly finishedDeferred = deferred<ChannelClose>();
  private sendSeq = 0;
  private sendCredit: number;
  private sendWaiters: CreditWaiter[] = [];
  private recvSeq = 0;
  private recvReceived = 0;
  private recvGranted: number;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private chunkHandler: ((chunk: Buffer, eventId: string | undefined) => void | Promise<void>) | undefined;
  private endHandler: (() => void) | undefined;
  private chunkQueue: Promise<void> = Promise.resolve();
  private readonly seenEvents = new Set<string>();
  private readonly seenOrder: string[] = [];
  private headerTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private cancelTimer: NodeJS.Timeout | undefined;
  private localEnded = false;
  private remoteEnded = false;
  private terminalCode: 'ended' | 'cancelled' | ChannelResetCode | undefined;

  constructor(hub: DeviceLinkHub, link: Link, spec: DeviceChannelSpec) {
    this.hub = hub;
    this.link = link;
    this.channelId = randomUUID();
    this.kind = spec.kind;
    this.operationId = spec.operationId ?? randomUUID();
    this.linkDeviceId = link.record.id;
    this.span = hub.telemetry.startSpan('chatdsh.gateway.device.request', {
      deviceId: link.record.id,
      'http.method': spec.method,
    });
    this.sendCredit = link.limits.initialCreditBytes;
    this.recvGranted = link.limits.initialCreditBytes;
    this.headerTimer = armTimer(spec.headerTimeoutMs ?? link.timers.headerMs, () => {
      this.hub.terminateChannel(this, 'header-timeout');
    });
    this.idleTimer = armTimer(link.timers.idleMs, () => {
      this.hub.terminateChannel(this, 'idle-timeout');
    });
  }

  /** 响应头到达的等待点。 */
  accepted(): Promise<ChannelAcceptance> {
    return this.acceptedDeferred.promise;
  }

  /** 通道结束的等待点。 */
  finished(): Promise<ChannelClose> {
    return this.finishedDeferred.promise;
  }

  /** 设备是否已经发送半关闭。 */
  get deviceEnded(): boolean {
    return this.remoteEnded;
  }

  /** 订阅数据段；处理函数结算之后才给设备补充额度。 */
  onChunk(handler: (chunk: Buffer, eventId: string | undefined) => void | Promise<void>): void {
    this.chunkHandler = handler;
  }

  /** 订阅正常结束。 */
  onEnd(handler: () => void): void {
    this.endHandler = handler;
  }

  /** 已缓冲的响应体；只在没有设置数据段订阅者时累积。 */
  takeBuffered(): Buffer {
    const body = Buffer.concat(this.buffered);
    this.buffered = [];
    this.bufferedBytes = 0;
    return body;
  }

  /**
   * 向设备发送一段字节：按协议帧上限拆分，每段先占用额度。
   * @param payload - 要发送的字节。
   */
  async send(payload: Buffer): Promise<void> {
    let offset = 0;
    while (offset < payload.length) {
      if (this.state === 'closed' || this.state === 'cancelling') {
        throw new DeviceLinkError('device-channel-reset', this.terminalCode ?? 'link-closed');
      }
      const size = Math.min(payload.length - offset, this.link.limits.dataPayloadMaxBytes);
      await this.waitCredit(size);
      const chunk = payload.subarray(offset, offset + size);
      this.hub.writeFrame(this.link, {
        type: 'data',
        channelId: this.channelId,
        generation: this.link.generation,
        seq: this.sendSeq,
        payloadLength: chunk.length,
        payload: chunk.toString('base64'),
      }, this);
      this.sendSeq += 1;
      this.touch();
      offset += size;
    }
  }

  /** 发送半关闭：请求体发送完毕，等待设备的响应尾。 */
  sendEnd(): void {
    if (this.state === 'closed') return;
    this.localEnded = true;
    this.hub.writeFrame(this.link, {
      type: 'end',
      channelId: this.channelId,
      generation: this.link.generation,
      lastSeq: this.sendSeq === 0 ? 0 : this.sendSeq - 1,
    }, this);
    if (this.remoteEnded) this.finish('ended');
    else this.state = 'half-closed';
  }

  /** 取消通道：中断设备侧的真实请求与订阅。 */
  cancel(reason = 'cancelled'): void {
    if (this.state === 'closed' || this.state === 'cancelling') return;
    this.state = 'cancelling';
    this.hub.writeFrame(this.link, {
      type: 'cancel',
      channelId: this.channelId,
      generation: this.link.generation,
      reason,
    }, this);
    this.cancelTimer = armTimer(this.link.timers.cancelAckMs, () => {
      this.hub.terminateChannel(this, 'cancel-timeout');
    });
  }

  /**
   * 接收一条设备数据帧。
   * @param frame - 设备帧。
   */
  receiveData(frame: Extract<DeviceFrameV2, { type: 'data' }>): void {
    const bytes = Buffer.byteLength(frame.payload, 'base64');
    if (frame.payloadLength !== bytes) {
      this.hub.terminateChannel(this, 'credit-exceeded');
      return;
    }
    if (frame.seq < this.recvSeq) {
      this.hub.terminateChannel(this, 'seq-duplicate');
      return;
    }
    if (frame.seq > this.recvSeq) {
      this.hub.terminateChannel(this, 'seq-out-of-order');
      return;
    }
    if (this.recvReceived + bytes > this.recvGranted) {
      this.hub.terminateChannel(this, 'credit-exceeded');
      return;
    }
    this.recvSeq += 1;
    this.recvReceived += bytes;
    this.touch();
    const payload = bytes === 0 ? Buffer.alloc(0) : Buffer.from(frame.payload, 'base64');
    if (this.kind === 'events' && frame.eventId !== undefined && !this.acceptEvent(frame.eventId)) {
      this.grantCredit(bytes);
      return;
    }
    if (this.chunkHandler === undefined) {
      if (this.kind !== 'websocket' && this.bufferedBytes + bytes > MAX_BUFFERED_RESPONSE_BYTES) {
        this.hub.terminateChannel(this, 'response-too-large');
        return;
      }
      this.buffered.push(payload);
      this.bufferedBytes += bytes;
      this.grantCredit(bytes);
      return;
    }
    const handler = this.chunkHandler;
    const eventId = frame.eventId;
    this.chunkQueue = this.chunkQueue.then(async () => {
      await handler(payload, eventId);
      this.grantCredit(bytes);
    }).catch(() => {
      this.hub.terminateChannel(this, 'consumer-failed');
    });
  }

  /** 接收设备的半关闭。 */
  receiveEnd(): void {
    this.remoteEnded = true;
    this.touch();
    this.endHandler?.();
    if (this.localEnded) this.finish('ended');
    else this.state = 'half-closed';
  }

  /** 接收设备补充的额度。 */
  receiveCredit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      this.hub.terminateChannel(this, 'credit-exceeded');
      return;
    }
    this.sendCredit += bytes;
    this.touch();
    this.releaseWaiters();
  }

  /** 接收设备的取消确认。 */
  receiveCancelled(): void {
    this.finish('cancelled');
  }

  /** 接收设备的终止帧。 */
  receiveReset(code: string): void {
    this.finish(resetCodeOf(code));
  }

  /** 连接断开时收尾：设备已经不在了，本地资源必须全部释放。 */
  linkClosed(error: DeviceLinkError): void {
    this.finish(this.terminalCode ?? 'link-closed', error);
  }

  /** 通道收尾：清定时器、结算等待点、从连接表移除。 */
  finish(code: 'ended' | 'cancelled' | ChannelResetCode, error?: DeviceLinkError): void {
    if (this.state === 'closed') return;
    this.terminalCode = code;
    this.state = 'closed';
    this.clearTimers();
    for (const waiter of this.sendWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new DeviceLinkError('device-channel-reset', code));
    }
    this.sendWaiters = [];
    const failure = code === 'ended' || code === 'cancelled'
      ? undefined
      : error ?? new DeviceLinkError('device-channel-reset', code);
    if (failure === undefined) {
      if (!this.acceptedDeferred.settled) {
        this.acceptedDeferred.reject(new DeviceLinkError('device-channel-cancelled', code));
      }
      this.finishedDeferred.resolve({ code });
    } else {
      if (!this.acceptedDeferred.settled) this.acceptedDeferred.reject(failure);
      if (!this.finishedDeferred.settled) this.finishedDeferred.reject(failure);
    }
    this.span.setAttribute('outcome', code);
    if (this.status !== undefined) this.span.setAttribute('http.status_code', this.status);
    if (failure !== undefined) {
      this.span.setAttribute('error.type', 'channel');
      this.span.setAttribute('error.code', failure.code);
    }
    this.span.end();
    this.hub.telemetry.counter('chatdsh_gateway_device_requests_total', {
      description: '控制平面沿设备连接转发的请求数',
    }).add(1, { outcome: code });
    this.link.channels.delete(this.channelId);
  }

  /** 接收设备的响应头。 */
  receiveAccepted(frame: Extract<DeviceFrameV2, { type: 'accepted' }>): void {
    // 请求体可以在响应头之前发完，此时通道已经半关闭，响应头仍然有效。
    if (this.state !== 'opening' && this.state !== 'half-closed') {
      this.hub.terminateChannel(this, 'channel-unknown');
      return;
    }
    this.status = frame.status;
    this.headers = frame.headers ?? {};
    this.state = 'active';
    if (this.headerTimer !== undefined) clearTimeout(this.headerTimer);
    this.headerTimer = undefined;
    this.touch();
    this.acceptedDeferred.resolve({ status: this.status, headers: this.headers });
  }

  /** 事件订阅的按标识去重：重复标识直接丢弃，不计新事件。 */
  private acceptEvent(eventId: string): boolean {
    if (this.seenEvents.has(eventId)) return false;
    this.seenEvents.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > CHANNEL_DEDUP_LIMIT) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seenEvents.delete(oldest);
    }
    return true;
  }

  /** 消费完一段就补充同等额度。 */
  private grantCredit(bytes: number): void {
    if (this.state === 'closed' || bytes === 0) return;
    this.recvGranted += bytes;
    this.hub.writeFrame(this.link, {
      type: 'credit',
      channelId: this.channelId,
      generation: this.link.generation,
      bytes,
    }, this);
  }

  /** 等待发送额度。 */
  private waitCredit(bytes: number): Promise<void> {
    if (this.state === 'closed' || this.state === 'cancelling') {
      return Promise.reject(new DeviceLinkError('device-channel-reset', this.terminalCode ?? 'link-closed'));
    }
    if (this.sendCredit >= bytes) {
      this.sendCredit -= bytes;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = armTimer(this.link.timers.idleMs, () => {
        this.hub.terminateChannel(this, 'idle-timeout');
      });
      this.sendWaiters.push({
        bytes,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
    });
  }

  /** 额度到账后按顺序释放等待者。 */
  private releaseWaiters(): void {
    while (this.sendWaiters.length > 0) {
      const waiter = this.sendWaiters[0];
      if (waiter === undefined) return;
      if (this.sendCredit < waiter.bytes) return;
      this.sendCredit -= waiter.bytes;
      this.sendWaiters.shift();
      waiter.resolve();
    }
  }

  /** 刷新空闲计时。 */
  private touch(): void {
    if (this.state === 'closed') return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = armTimer(this.link.timers.idleMs, () => {
      this.hub.terminateChannel(this, 'idle-timeout');
    });
  }

  private clearTimers(): void {
    if (this.headerTimer !== undefined) clearTimeout(this.headerTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (this.cancelTimer !== undefined) clearTimeout(this.cancelTimer);
    this.headerTimer = undefined;
    this.idleTimer = undefined;
    this.cancelTimer = undefined;
  }
}

/** 设备给的终止码收敛到本地枚举；不认识的按通用终止处理。 */
const KNOWN_RESET_CODES: readonly string[] = [
  'path-invalid', 'upgrade-rejected', 'event-invalid', 'header-timeout', 'idle-timeout',
  'request-timeout', 'cancel-timeout', 'response-too-large', 'buffer-exceeded',
  'credit-exceeded', 'consumer-failed', 'cancelled', 'link-closed',
];

/** 把设备给的终止码收敛到本地枚举。 */
function resetCodeOf(code: string): ChannelResetCode {
  return KNOWN_RESET_CODES.includes(code) ? code as ChannelResetCode : 'channel-unknown';
}

/**
 * 设备长连接的中枢。
 *
 * 在线表按设备标识索引；同一台设备重复连接时旧连接立刻关闭，旧连接上的通道以
 * `device-replaced` 明确失败，新连接接手。每条连接的生命周期写一个 span，断开时写一条
 * 事件，每条通道写一个 span 与一个计数。
 */
export class DeviceLinkHub {
  private readonly store: GatewayStore;
  private readonly telemetryRef: ChatdshTelemetry;
  private readonly heartbeatMs: number;
  private readonly deadAfterMs: number;
  private readonly requestTimeoutMs: number;
  private readonly limits: LinkLimits;
  private readonly timers: ChannelTimers;
  private readonly links = new Map<string, Link>();
  private readonly generations = new Map<string, number>();
  private readonly revoked = new Set<string>();

  constructor(options: DeviceLinkOptions) {
    this.store = options.store;
    this.telemetryRef = options.telemetry;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.deadAfterMs = options.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.limits = {
      maxChannels: options.limits?.maxChannels ?? MAX_CHANNELS_PER_LINK,
      sendBufferBytes: options.limits?.sendBufferBytes ?? LINK_SEND_BUFFER_BYTES,
      initialCreditBytes: options.limits?.initialCreditBytes ?? CHANNEL_INITIAL_CREDIT_BYTES,
      dataPayloadMaxBytes: options.limits?.dataPayloadMaxBytes ?? DATA_PAYLOAD_MAX_BYTES,
      frameMaxBytes: options.limits?.frameMaxBytes ?? FRAME_MAX_BYTES,
    };
    this.timers = {
      handshakeMs: options.timers?.handshakeMs ?? HANDSHAKE_TIMEOUT_MS,
      headerMs: options.timers?.headerMs ?? RESPONSE_HEADER_TIMEOUT_MS,
      idleMs: options.timers?.idleMs ?? STREAM_IDLE_TIMEOUT_MS,
      cancelAckMs: options.timers?.cancelAckMs ?? CANCEL_ACK_TIMEOUT_MS,
    };
  }

  /** 遥测出口；连接与通道共用同一个出口。 */
  get telemetry(): ChatdshTelemetry {
    return this.telemetryRef;
  }

  /** 当前在线的设备标识。 */
  onlineIds(): string[] {
    return [...this.links.keys()];
  }

  /** 设备是否在线。 */
  online(deviceId: string): boolean {
    return this.links.has(deviceId);
  }

  /** 设备是否已被撤销：撤销之后升级一律拒绝。 */
  isRevoked(deviceId: string): boolean {
    return this.revoked.has(deviceId);
  }

  /** 在线连接数。 */
  get size(): number {
    return this.links.size;
  }

  /** 当前代次；设备从未连接过时为空。 */
  generationOf(deviceId: string): number | undefined {
    return this.generations.get(deviceId);
  }

  /** 一条连接上打开的通道数。 */
  channelCount(deviceId: string): number {
    return this.links.get(deviceId)?.channels.size ?? 0;
  }

  /**
   * 撤销一台设备：关闭现有连接、拒绝后续升级。
   *
   * 挂在连接上的通道全部以 `device-revoked` 明确失败。撤销入口由设备管理流程调用。
   * @param deviceId - 设备标识。
   */
  revoke(deviceId: string): void {
    this.revoked.add(deviceId);
    const link = this.links.get(deviceId);
    if (link === undefined) return;
    this.unregister(link, 'revoked');
    link.connection.close(4001, 'revoked');
  }

  /**
   * 处理一次设备长连接的升级。令牌无效或设备不存在时在握手阶段拒绝，连接不建立。
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
    if (this.revoked.has(record.id)) {
      this.reject(socket, 401, 'device-revoked');
      return;
    }
    if (typeof request.headers['sec-websocket-key'] !== 'string' || !websocketVersionSupported(request)) {
      this.reject(socket, 400, 'handshake-invalid');
      return;
    }
    const handshake = WebSocketHandshake.accept(socket, request, []);
    handshake.writeHead();
    this.register(record, new WebSocketConnection(handshake));
  }

  /**
   * 处理一次 `/d/<deviceId>/…` 的 WebSocket 升级。
   *
   * 只放行白名单里的路径；设备离线、未知设备、已撤销设备与被拒绝的路径都在握手阶段
   * 回明确状态，绝不转交宿主机的默认运行时。这条入口由路由层在升级事件里调用。
   * @param request - 升级请求。
   * @param socket - 升级后的套接字。
   * @param head - 升级请求里已经读出的首段字节。
   */
  async handleDeviceUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<DeviceUpgradeResult> {
    const resolved = resolveDeviceResourcePath(request.url ?? '');
    if (!resolved.ok) {
      this.reject(socket, 400, resolved.code, 'upgrade', 'request');
      return { outcome: 'path-invalid', status: 400, code: resolved.code, errorType: 'request' };
    }
    const pathOnly = resolved.path.split('?')[0] ?? '';
    if (!DEVICE_UPGRADE_PATHS.includes(pathOnly)) {
      this.reject(socket, 403, 'path-invalid', 'upgrade', 'request');
      return { outcome: 'path-invalid', status: 403, code: 'path-invalid', errorType: 'request' };
    }
    const record = this.store.nodeById(resolved.deviceId);
    if (record === undefined) {
      this.reject(socket, 404, 'device-not-found', 'upgrade', 'request');
      return { outcome: 'device-not-found', status: 404, code: 'device-not-found', errorType: 'request' };
    }
    if (this.revoked.has(record.id)) {
      this.reject(socket, 401, 'device-revoked', 'upgrade', 'auth');
      return { outcome: 'device-revoked', status: 401, code: 'device-revoked', errorType: 'auth' };
    }
    const link = this.links.get(record.id);
    if (link === undefined) {
      this.reject(socket, 409, 'device-offline', 'upgrade', 'link');
      return { outcome: 'device-offline', status: 409, code: 'device-offline', errorType: 'link' };
    }
    if (!websocketVersionSupported(request) || typeof request.headers['sec-websocket-key'] !== 'string') {
      this.reject(socket, 400, 'handshake-invalid', 'upgrade', 'protocol');
      return { outcome: 'handshake-invalid', status: 400, code: 'handshake-invalid', errorType: 'protocol' };
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      const lowered = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowered) || CREDENTIAL_HEADERS.has(lowered) || lowered === 'host') continue;
      headers[lowered] = Array.isArray(value) ? value.join(', ') : value;
    }
    const carrier = this.telemetry.inject({});
    if (carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
    if (carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;
    let channel: DeviceChannel;
    try {
      channel = this.openChannelOn(link, { kind: 'websocket', method: 'GET', path: resolved.path, headers });
    } catch (error) {
      const code = error instanceof DeviceLinkError ? error.code : 'device-upgrade-rejected';
      this.reject(socket, 502, code, 'upgrade', 'upgrade');
      return { outcome: 'upgrade-rejected', status: 502, code, errorType: 'upgrade' };
    }
    const outcome = await this.bridgeUpgrade(channel, socket, head);
    return outcome === 'upgraded'
      ? { outcome: 'upgraded', status: 101, code: 'upgraded' }
      : { outcome: 'upgrade-rejected', status: 502, code: 'upgrade-rejected', errorType: 'upgrade' };
  }

  /**
   * 沿设备的连接转发一次请求，缓冲完整响应后返回。
   * @param deviceId - 设备标识。
   * @param request - 方法、路径、请求头与请求体。
   * @param timeoutMs - 本次转发的超时；缺省取构造配置。
   * @param operationId - 写操作的幂等标识；缺省按请求生成一个。
   * @returns 设备回填的响应。
   * @throws {@link DeviceLinkError} 设备离线、替换、撤销、超时或协议终止。
   */
  async sendRequest(
    deviceId: string,
    request: DeviceRequest,
    timeoutMs = this.requestTimeoutMs,
    operationId?: string
  ): Promise<DeviceResponse> {
    const link = this.links.get(deviceId);
    if (link === undefined) {
      this.recordRequestOutcome('offline');
      throw new DeviceLinkError('device-offline');
    }
    await this.awaitReady(link);
    const rejection = validateDeviceTargetPath(request.path);
    if (rejection !== undefined) {
      this.telemetry.event('chatdsh.gateway.device.rejected', {
        action: 'channel',
        outcome: 'rejected',
        'error.type': 'request',
        'error.code': rejection,
      });
      this.recordRequestOutcome('path-invalid');
      throw new DeviceLinkError('device-path-invalid');
    }
    if (link.protocol === LEGACY_PROTOCOL_VERSION) {
      return this.sendLegacyRequest(link, request, timeoutMs);
    }
    const cached = this.cachedOperation(link, operationId);
    if (cached !== undefined) {
      this.recordRequestOutcome('duplicate');
      return cached;
    }
    const channel = this.openChannelOn(link, {
      kind: 'http',
      method: request.method,
      path: request.path,
      headers: request.headers ?? {},
      operationId,
    });
    const timer = armTimer(timeoutMs, () => {
      this.telemetry.event('chatdsh.gateway.device.rejected', {
        action: 'channel',
        outcome: 'timeout',
        'error.type': 'timeout',
        'error.code': 'request-timeout',
      });
      this.terminateChannel(channel, 'request-timeout');
    });
    try {
      // 请求体先于响应头发送：读取请求体后才回响应头的处理器不能被顺序卡死。
      if (request.body !== undefined && request.body.length > 0) await channel.send(request.body);
      channel.sendEnd();
      const accepted = await channel.accepted();
      await channel.finished();
      const response: DeviceResponse = {
        status: accepted.status,
        headers: accepted.headers,
        body: channel.takeBuffered(),
      };
      this.rememberOperation(link, channel.operationId, response);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 打开一条流式通道。
   *
   * 调用方在拿到句柄后立刻注册 `onChunk` 与 `onEnd`，再等待 `accepted()`。离线、未知设备、
   * 超出通道上限与非法路径在这里同步抛出，便于调用方立刻回状态码。
   * @param deviceId - 设备标识。
   * @param spec - 通道的种类、方法、路径、请求头与幂等标识。
   * @returns 通道句柄。
   */
  openChannel(deviceId: string, spec: DeviceChannelSpec): DeviceChannel {
    const link = this.links.get(deviceId);
    if (link === undefined) throw new DeviceLinkError('device-offline');
    if (link.protocol !== PROTOCOL_VERSION) throw new DeviceLinkError('device-unsupported');
    const rejection = validateDeviceTargetPath(spec.path);
    if (rejection !== undefined) throw new DeviceLinkError('device-path-invalid');
    return this.openChannelOn(link, spec);
  }

  /** 关闭全部连接；进程退出时调用。 */
  stop(): void {
    for (const link of [...this.links.values()]) {
      this.unregister(link, 'stopped');
      link.connection.destroy();
    }
  }

  /**
   * 写一帧通道协议帧，并执行连接的发送缓冲预算。
   * @param link - 目标连接。
   * @param frame - 控制帧。
   * @param channel - 触发这次写入的通道；超预算时终止这条通道。
   * @param force - 忽略缓冲预算；终止帧与握手帧本身要写出去。
   */
  writeFrame(link: Link, frame: ControlFrameV2, channel: DeviceChannel | undefined, force = false): void {
    if (link.connection.closed) return;
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > link.limits.frameMaxBytes) {
      if (channel !== undefined) this.terminateChannel(channel, 'frame-too-large');
      return;
    }
    if (!force && link.connection.bufferedBytes + bytes > link.limits.sendBufferBytes) {
      if (channel !== undefined) this.terminateChannel(channel, 'buffer-exceeded');
      return;
    }
    link.connection.sendText(text);
  }

  /**
   * 终止一条通道：本地收尾并给设备发终止帧。
   * @param channel - 目标通道。
   * @param code - 终止码。
   */
  terminateChannel(channel: DeviceChannel, code: ChannelResetCode): void {
    if (channel.state === 'closed') return;
    channel.finish(code);
    const link = this.links.get(channel.linkDeviceId);
    if (link !== undefined) {
      this.writeFrame(link, {
        type: 'reset',
        channelId: channel.channelId,
        generation: link.generation,
        code,
      }, undefined, true);
    }
    this.telemetry.event('chatdsh.gateway.device.rejected', {
      action: 'channel',
      outcome: 'reset',
      'error.type': 'channel',
      'error.code': code,
    });
  }

  /** 登记一条连接，同设备的旧连接被替换。 */
  private register(record: NodeDeviceRecord, connection: WebSocketConnection): void {
    const previous = this.links.get(record.id);
    if (previous !== undefined) {
      this.unregister(previous, 'replaced');
      previous.connection.close(4000, 'replaced');
    }
    const generation = (this.generations.get(record.id) ?? 0) + 1;
    this.generations.set(record.id, generation);
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
      generation,
      limits: this.limits,
      timers: this.timers,
      ready: deferred<void>(),
      pending: new Map(),
      channels: new Map(),
      operations: new Map(),
      handshakeTimer: undefined,
      protocol: 'pending',
      lastPongAt: Date.now(),
      violations: 0,
    };
    link.handshakeTimer = armTimer(this.timers.handshakeMs, () => {
      this.violation(link, 'handshake-timeout');
    });
    this.links.set(record.id, link);
    this.store.touchNode(record.id);
    this.telemetry.counter('chatdsh_gateway_device_links_total', { description: '设备长连接生命周期' })
      .add(1, { outcome: 'opened' });
    connection.onText((payload) => this.onText(link, payload));
    connection.onBinary(() => this.violation(link, 'frame-not-text'));
    connection.onClose((info) => {
      this.unregister(link, info.code === 4000 ? 'replaced' : info.code === 4001 ? 'revoked' : 'closed');
    });
  }

  /** 一次心跳：失联则断开，否则发一帧 ping。 */
  private beat(deviceId: string): void {
    const link = this.links.get(deviceId);
    if (link === undefined) return;
    if (Date.now() - link.lastPongAt > this.deadAfterMs) {
      this.unregister(link, 'timeout');
      link.connection.destroy();
      return;
    }
    if (link.protocol === PROTOCOL_VERSION) {
      this.writeFrame(link, { type: 'ping', generation: link.generation, nonce: randomUUID() }, undefined, true);
      return;
    }
    link.connection.sendText(JSON.stringify({ type: 'ping' } satisfies ControlFrame));
  }

  /** 处理一帧设备消息。协议不合法时按违规计数，累计到上限断开连接。 */
  private onText(link: Link, payload: string): void {
    const maxFrame = link.protocol === PROTOCOL_VERSION ? link.limits.frameMaxBytes : LEGACY_FRAME_MAX_BYTES;
    if (Buffer.byteLength(payload, 'utf8') > maxFrame) {
      this.violation(link, 'frame-too-large');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.violation(link, 'frame-invalid');
      return;
    }
    const frame = parsed as DeviceFrame | DeviceFrameV2;
    if (frame.type === 'hello') {
      this.onHello(link, frame);
      return;
    }
    if (frame.type === 'pong') {
      link.lastPongAt = Date.now();
      this.store.touchNode(link.record.id);
      return;
    }
    if (frame.type === 'ping') {
      if (link.protocol !== PROTOCOL_VERSION) {
        this.violation(link, 'frame-unknown');
        return;
      }
      if (frame.generation !== link.generation || typeof frame.nonce !== 'string') {
        this.violation(link, 'frame-invalid');
        return;
      }
      link.lastPongAt = Date.now();
      this.store.touchNode(link.record.id);
      this.writeFrame(link, { type: 'pong', generation: link.generation, nonce: frame.nonce }, undefined, true);
      return;
    }
    if (link.protocol !== PROTOCOL_VERSION) {
      if (frame.type === 'response') {
        this.onLegacyResponse(link, frame);
        return;
      }
      this.violation(link, 'frame-unknown');
      return;
    }
    const candidate = frame as { readonly channelId?: unknown; readonly generation?: unknown };
    if (typeof candidate.channelId !== 'string') {
      this.violation(link, 'frame-unknown');
      return;
    }
    if (candidate.generation !== link.generation) {
      this.violation(link, 'generation-mismatch');
      return;
    }
    const channel = link.channels.get(candidate.channelId);
    if (channel === undefined) {
      this.violation(link, 'channel-unknown');
      return;
    }
    if (frame.type === 'accepted') {
      channel.receiveAccepted(frame);
      return;
    }
    if (frame.type === 'data') {
      if (!isSequenceNumber(frame.seq) || typeof frame.payload !== 'string' || !isSequenceNumber(frame.payloadLength)) {
        this.violation(link, 'frame-invalid');
        return;
      }
      channel.receiveData(frame);
      return;
    }
    if (frame.type === 'credit') {
      if (!isSequenceNumber(frame.bytes)) {
        this.violation(link, 'frame-invalid');
        return;
      }
      channel.receiveCredit(frame.bytes);
      return;
    }
    if (frame.type === 'end') {
      if (!isSequenceNumber(frame.lastSeq)) {
        this.violation(link, 'frame-invalid');
        return;
      }
      channel.receiveEnd();
      return;
    }
    if (frame.type === 'cancelled') {
      channel.receiveCancelled();
      return;
    }
    if (frame.type === 'reset') {
      channel.receiveReset(typeof frame.code === 'string' ? frame.code : 'channel-unknown');
      return;
    }
    this.violation(link, 'frame-unknown');
  }

  /** 处理握手帧：确定协议版本并下发预算。 */
  private onHello(link: Link, frame: Extract<DeviceFrame, { type: 'hello' }> | Extract<DeviceFrameV2, { type: 'hello' }>): void {
    // 令牌已经确定设备；对称字段只在设备自报时校验，避免两边对不上还继续转发。
    if (frame.deviceId !== '' && frame.deviceId !== link.record.id) {
      this.violation(link, 'device-mismatch');
      return;
    }
    const version = (frame as { readonly version?: unknown }).version;
    if (version !== undefined && version !== LEGACY_PROTOCOL_VERSION && version !== PROTOCOL_VERSION) {
      this.violation(link, 'protocol-version-unsupported');
      return;
    }
    link.lastPongAt = Date.now();
    this.store.touchNode(link.record.id);
    if (link.handshakeTimer !== undefined) clearTimeout(link.handshakeTimer);
    link.handshakeTimer = undefined;
    if (version === PROTOCOL_VERSION) {
      link.protocol = PROTOCOL_VERSION;
      this.writeFrame(link, {
        type: 'welcome',
        version: PROTOCOL_VERSION,
        deviceId: link.record.id,
        generation: link.generation,
        limits: link.limits,
      }, undefined, true);
      link.ready.resolve();
      return;
    }
    link.protocol = LEGACY_PROTOCOL_VERSION;
    link.ready.resolve();
  }

  /** 处理版本 1 的响应帧。 */
  private onLegacyResponse(link: Link, frame: Extract<DeviceFrame, { type: 'response' }>): void {
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
    this.recordRequestOutcome('ok');
    pending.resolve({
      status: frame.status,
      headers: frame.headers ?? {},
      body: frame.body === undefined || frame.body === '' ? Buffer.alloc(0) : Buffer.from(frame.body, 'base64'),
    });
  }

  /** 等到握手确定协议版本。 */
  private async awaitReady(link: Link): Promise<void> {
    if (link.ready.settled) return;
    try {
      await link.ready.promise;
    } catch {
      throw new DeviceLinkError('device-handshake-failed');
    }
  }

  /** 版本 1 的一次转发。 */
  private async sendLegacyRequest(link: Link, request: DeviceRequest, timeoutMs: number): Promise<DeviceResponse> {
    const requestId = randomUUID();
    const span = this.telemetry.startSpan('chatdsh.gateway.device.request', { deviceId: link.record.id });
    // 载体是返回值：`inject` 不修改传入对象，调用方必须接住它写出的 `traceparent`。
    const carrier = this.telemetry.inject({});
    const frame: ControlFrame = {
      type: 'request',
      requestId,
      method: request.method,
      path: request.path,
      headers: { ...(request.headers ?? {}), ...traceHeaders(carrier) },
      body: request.body === undefined ? '' : request.body.toString('base64'),
    };
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (link.connection.bufferedBytes + bytes > link.limits.sendBufferBytes) {
      span.setAttribute('outcome', 'buffer-exceeded');
      span.setAttribute('error.type', 'flow-control');
      span.setAttribute('error.code', 'device-buffer-exceeded');
      span.end();
      this.recordRequestOutcome('buffer-exceeded');
      throw new DeviceLinkError('device-buffer-exceeded');
    }
    return new Promise<DeviceResponse>((resolve, reject) => {
      const timer = armTimer(timeoutMs, () => {
        const pending = link.pending.get(requestId);
        if (pending === undefined) return;
        link.pending.delete(requestId);
        span.setAttribute('outcome', 'timeout');
        span.setAttribute('error.type', 'timeout');
        span.setAttribute('error.code', 'device-timeout');
        span.end();
        this.recordRequestOutcome('timeout');
        reject(new DeviceLinkError('device-timeout'));
      });
      link.pending.set(requestId, { resolve, reject, timer, span });
      link.connection.sendText(text);
    });
  }

  /** 打开一条通道并登记到连接上。 */
  private openChannelOn(link: Link, spec: DeviceChannelSpec): DeviceChannel {
    if (link.channels.size >= link.limits.maxChannels) {
      this.telemetry.event('chatdsh.gateway.device.rejected', {
        action: 'channel',
        outcome: 'rejected',
        'error.type': 'flow-control',
        'error.code': 'channel-limit',
      });
      throw new DeviceLinkError('device-channel-limit');
    }
    const channel = new DeviceChannel(this, link, spec);
    link.channels.set(channel.channelId, channel);
    const headers = { ...(spec.headers ?? {}) };
    const carrier = this.telemetry.inject({});
    if (carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
    if (carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;
    this.writeFrame(link, {
      type: 'open',
      channelId: channel.channelId,
      generation: link.generation,
      kind: spec.kind,
      method: spec.method,
      path: spec.path,
      headers,
      operationId: channel.operationId,
    }, channel, true);
    return channel;
  }

  /** 命中同标识的完成结果时直接返回。 */
  private cachedOperation(link: Link, operationId: string | undefined): DeviceResponse | undefined {
    if (operationId === undefined) return undefined;
    const cached = link.operations.get(operationId);
    if (cached === undefined) return undefined;
    if (Date.now() - cached.at > OPERATION_CACHE_MS) {
      link.operations.delete(operationId);
      return undefined;
    }
    return cached.response;
  }

  /** 记住一条完成结果，供同标识的重复提交直接返回。 */
  private rememberOperation(link: Link, operationId: string, response: DeviceResponse): void {
    link.operations.set(operationId, { response, at: Date.now() });
    while (link.operations.size > OPERATION_CACHE_LIMIT) {
      const oldest = link.operations.keys().next();
      if (oldest.done === true) return;
      link.operations.delete(oldest.value);
    }
  }

  /** 把升级后的浏览器套接字接到通道上。 */
  private async bridgeUpgrade(channel: DeviceChannel, socket: Duplex, head: Buffer): Promise<'upgraded' | 'upgrade-rejected'> {
    let accepted: ChannelAcceptance;
    try {
      accepted = await channel.accepted();
    } catch {
      this.reject(socket, 502, 'upgrade-rejected', 'upgrade', 'upgrade');
      return 'upgrade-rejected';
    }
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [key, value] of Object.entries(accepted.headers)) {
      const lowered = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowered)) continue;
      if (Array.isArray(value)) {
        for (const entry of value) lines.push(`${key}: ${entry}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push('Connection: Upgrade', 'Upgrade: websocket');
    socket.write(`${lines.join('\r\n')}\r\n\r\n`, () => undefined);
    // 浏览器侧写入积压时先等 drain 再补额度，慢消费者因此把设备侧的读取停住。
    channel.onChunk((chunk) => new Promise<void>((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      const flushed = socket.write(chunk);
      if (flushed) {
        resolve();
        return;
      }
      const settle = (): void => {
        socket.off('drain', settle);
        socket.off('close', settle);
        resolve();
      };
      socket.once('drain', settle);
      socket.once('close', settle);
    }));
    channel.onEnd(() => socket.end());
    const buffered = channel.takeBuffered();
    if (buffered.length > 0 && !socket.destroyed) socket.write(buffered);
    if (channel.deviceEnded && !socket.destroyed) socket.end();
    channel.finished().then(() => {
      if (!socket.destroyed) socket.destroy();
    }, () => {
      if (!socket.destroyed) socket.destroy();
    });
    socket.on('close', () => channel.cancel('client-closed'));
    socket.on('error', () => channel.cancel('client-error'));
    if (head.length > 0) {
      try {
        await channel.send(head);
      } catch {
        return 'upgraded';
      }
    }
    let pendingBytes = 0;
    socket.on('data', (chunk: Buffer) => {
      pendingBytes += chunk.length;
      if (pendingBytes > this.limits.sendBufferBytes / 2) socket.pause();
      void channel.send(chunk).then(() => {
        pendingBytes -= chunk.length;
        if (pendingBytes <= this.limits.sendBufferBytes / 2 && !socket.destroyed) socket.resume();
      }, () => undefined);
    });
    return 'upgraded';
  }

  /** 协议违规：写一条事件；累计到上限则从在线表移除并断开。 */
  private violation(link: Link, code: string): void {
    link.violations += 1;
    this.telemetry.event('chatdsh.gateway.device.rejected', {
      action: 'frame',
      outcome: 'rejected',
      'error.type': 'protocol',
      'error.code': code,
    });
    if (link.violations < PROTOCOL_VIOLATION_LIMIT) return;
    this.unregister(link, 'error');
    link.connection.close(1008, code);
  }

  /** 从在线表移除一条连接，收尾未回填的请求与全部通道。 */
  private unregister(link: Link, reason: string): void {
    if (this.links.get(link.record.id) !== link) return;
    this.links.delete(link.record.id);
    clearInterval(link.heartbeat);
    if (link.handshakeTimer !== undefined) clearTimeout(link.handshakeTimer);
    link.handshakeTimer = undefined;
    const errorCode: DeviceLinkErrorCode = reason === 'replaced'
      ? 'device-replaced'
      : reason === 'revoked'
        ? 'device-revoked'
        : 'device-offline';
    if (!link.ready.settled) link.ready.reject(new DeviceLinkError(errorCode));
    for (const pending of [...link.pending.values()]) {
      clearTimeout(pending.timer);
      pending.span.setAttribute('outcome', reason);
      pending.span.setAttribute('error.type', 'link');
      pending.span.setAttribute('error.code', errorCode);
      pending.span.end();
      this.recordRequestOutcome(errorCode);
      pending.reject(new DeviceLinkError(errorCode));
    }
    link.pending.clear();
    for (const channel of [...link.channels.values()]) {
      channel.linkClosed(new DeviceLinkError(errorCode));
    }
    link.channels.clear();
    link.operations.clear();
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

  /** 记录一次转发的计数。 */
  private recordRequestOutcome(outcome: string): void {
    this.telemetry.counter('chatdsh_gateway_device_requests_total', { description: '控制平面沿设备连接转发的请求数' })
      .add(1, { outcome });
  }

  /** 握手阶段拒绝一次升级。 */
  private reject(
    socket: Duplex,
    status: number,
    code: string,
    action = 'link',
    errorType: 'auth' | 'request' | 'protocol' | 'link' | 'upgrade' = status === 401 ? 'auth' : 'protocol',
  ): void {
    this.telemetry.event('chatdsh.gateway.device.rejected', {
      action,
      outcome: 'rejected',
      'error.type': errorType,
      'error.code': code,
    });
    this.telemetry.counter('chatdsh_gateway_device_links_total', { description: '设备长连接生命周期' })
      .add(1, { outcome: 'rejected' });
    rejectUpgrade(socket, status, code);
  }
}
