/**
 * 手机业务通道的接入层：控制平面对外提供与运行时插件一致的配对接口。
 *
 * 上游 Android 与 iOS 客户端的配对模型是「Base64URL 配对载荷 → 带 dsh-pair 子协议连
 * WebSocket → 收到 paired 帧拿到长期令牌 → 之后用 Authorization: Bearer 重连」。把同一套
 * 接口在控制平面上实现，客户端不需要改任何协议代码：它只要把配对载荷里的地址指向控制
 * 平面即可。控制平面校验通过后再把连接桥接到运行时的插件，插件只看得到一个本机回环连接。
 *
 * 这里直接处理 HTTP 升级与 WebSocket 帧，不引入额外依赖：控制平面只需要在升级后写一帧
 * paired，之后两侧套接字原样对接。
 * @module @chatdsh/gateway/mobile-channel
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import type { GatewayStore } from './store.ts';
import { deviceTokenHash, mobileTokenOf } from './mobile-http.ts';

/** WebSocket 握手用的固定 GUID。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 配对只在使用一次性配对码时发生；之后的连接一律用设备令牌。 */
export interface MobileChannelOptions {
  /** 一次性配对码；未配置时配对子协议一律拒绝。 */
  readonly pairingCode: string | undefined;
  /** 运行时插件监听的基地址，手机连接桥接到这里。 */
  readonly runtimeUrl: string;
  readonly store: GatewayStore;
  readonly telemetry: ChatdshTelemetry;
  /** 账号名，用于把新设备登记到账号下。 */
  readonly accountLogin: string;
}

/** 升级前的处理结果：要么直接把连接桥接到上游，要么就地拒绝。 */
export interface ChannelDecision {
  /** 桥接目标路径；`undefined` 表示已就地处理、不再桥接。 */
  readonly bridgePath?: string;
  /** 写入上游的额外请求头。 */
  readonly headers?: Record<string, string>;
}

class WebSocketHandshake {
  private constructor(
    private readonly socket: Duplex,
    private readonly accept: string,
    private readonly protocol: string | undefined
  ) {}

  /** 完成 101 握手；`protocol` 是选中的子协议。 */
  static accept(socket: Duplex, request: IncomingMessage): WebSocketHandshake {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') throw new Error('缺少 Sec-WebSocket-Key');
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const offered = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const protocol = offered.includes('dsh-mobile-v1') ? 'dsh-mobile-v1' : offered[0];
    return new WebSocketHandshake(socket, accept, protocol);
  }

  /** 写出 101 响应。 */
  writeHead(): void {
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${this.accept}`,
    ];
    if (this.protocol !== undefined) lines.push(`Sec-WebSocket-Protocol: ${this.protocol}`);
    // 立即写出，随后同一套接字上写业务帧时不会被合并进握手响应。
    this.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  }

  /** 写一帧服务端文本消息。服务端帧不掩码。 */
  writeText(payload: string): void {
    this.socket.write(encodeServerTextFrame(payload));
  }
}

/**
 * 编码一帧服务端到客户端的文本消息。
 *
 * 长度按 125、65535、更长的三档分别用 7 位、16 位、64 位表示；服务端帧不加掩码。
 * @param payload - 完整的 UTF-8 文本。
 * @returns 可直接写进套接字的字节。
 */
export function encodeServerTextFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const length = body.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, body]);
}

/** 判断升级请求是否走手机业务通道。 */
export function isMobileChannelPath(path: string): boolean {
  return path === '/ws/mobile';
}

/** 从子协议里取一次性配对码。 */
export function pairingCodeOf(request: IncomingMessage): string | undefined {
  const offered = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((entry) => entry.trim());
  const entry = offered.find((candidate) => candidate.startsWith('dsh-pair.'));
  if (entry === undefined) return undefined;
  const code = entry.slice('dsh-pair.'.length);
  return code === '' ? undefined : code;
}

/** 恒定时间比较两个字符串，避免按字节比较泄露配对码。 */
function sameSecret(given: string, expected: string): boolean {
  const left = Buffer.from(given, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return createHash('sha256').update(left).digest().equals(createHash('sha256').update(right).digest());
}

/** 拒绝一次升级，回一个最小的 HTTP 响应后关闭套接字。 */
export function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const body = JSON.stringify({ error: code });
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request';
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Content-Type: application/json; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  );
  socket.destroy();
}

/**
 * 处理一次手机通道升级。
 *
 * 三条路径：
 * 1. 带一次性配对码：校验配对码，签发设备令牌，回一帧 `paired`，再把连接桥接到插件；
 *    插件随后发出的 `hello` 会原样到达客户端。
 * 2. 带设备令牌：校验令牌与吊销状态，桥接到插件。
 * 3. 两者都没有或校验失败：就地拒绝，请求不进入运行时。
 */
export function handleMobileChannel(
  request: IncomingMessage,
  socket: Duplex,
  options: MobileChannelOptions
): ChannelDecision {
  const pairingCode = pairingCodeOf(request);
  if (pairingCode !== undefined) {
    if (options.pairingCode === undefined) {
      options.telemetry.event('chatdsh.gateway.mobile.rejected', {
        action: 'ws-pair',
        outcome: 'rejected',
        'error.type': 'config',
        'error.code': 'pairing-disabled',
      });
      rejectUpgrade(socket, 404, 'pairing-disabled');
      return {};
    }
    if (!sameSecret(pairingCode, options.pairingCode)) {
      options.telemetry.event('chatdsh.gateway.mobile.rejected', {
        action: 'ws-pair',
        outcome: 'rejected',
        'error.type': 'auth',
        'error.code': 'pairing-code-invalid',
      });
      rejectUpgrade(socket, 401, 'pairing-code-invalid');
      return {};
    }
    const token = randomBytes(32).toString('base64url');
    const account = options.store.ensureAccount(options.accountLogin);
    const record = options.store.registerMobileDevice({
      id: randomUUID(),
      accountId: account.id,
      name: deviceNameOf(request),
      platform: platformOf(request),
      tokenHash: deviceTokenHash(token),
    });
    const handshake = WebSocketHandshake.accept(socket, request);
    handshake.writeHead();
    handshake.writeText(JSON.stringify({
      kind: 'paired',
      token,
      device: { id: record.id, name: record.name },
    }));
    options.telemetry.counter('chatdsh_mobile_upgrades_total', { description: '手机 WebSocket 升级次数' })
      .add(1, { outcome: 'paired' });
    // 配对连接到此为止。客户端拿到令牌后会用 Authorization: Bearer 重新连一条带
    // device-id 的连接，那条连接才承载业务帧；继续在配对连接上桥接只会让插件因为
    // 缺少 X-DSH-Device-ID 而拒绝并关闭全部套接字。
    closeAfterFlush(socket);
    return {};
  }

  const token = mobileTokenOf(request);
  if (token === '') {
    options.telemetry.event('chatdsh.gateway.mobile.upgrade.rejected', {
      'error.type': 'auth',
      'error.code': 'device-token-required',
    });
    options.telemetry.counter('chatdsh_mobile_upgrades_total', { description: '手机 WebSocket 升级次数' })
      .add(1, { outcome: 'rejected' });
    rejectUpgrade(socket, 401, 'device-token-required');
    return {};
  }
  const record = options.store.mobileDeviceByTokenHash(deviceTokenHash(token));
  if (record === undefined) {
    options.telemetry.event('chatdsh.gateway.mobile.upgrade.rejected', {
      'error.type': 'auth',
      'error.code': 'device-token-invalid',
    });
    options.telemetry.counter('chatdsh_mobile_upgrades_total', { description: '手机 WebSocket 升级次数' })
      .add(1, { outcome: 'rejected' });
    rejectUpgrade(socket, 401, 'device-token-invalid');
    return {};
  }
  options.store.touchMobileDevice(record.id);
  options.telemetry.counter('chatdsh_mobile_upgrades_total', { description: '手机 WebSocket 升级次数' })
    .add(1, { outcome: 'accepted' });
  return { bridgePath: '/ws/mobile' };
}

/** 设备名称：客户端可以用 X-DSH-Device-Name 传 Base64 名称。 */
function deviceNameOf(request: IncomingMessage): string {
  const raw = request.headers['x-dsh-device-name'];
  if (typeof raw !== 'string' || raw === '') return 'Android';
  const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
  return decoded === '' ? 'Android' : decoded.slice(0, 80);
}

/** 平台标识：新手机会声明 android，缺省按 android 记。 */
function platformOf(request: IncomingMessage): string {
  const raw = request.headers['x-dsh-platform'];
  if (typeof raw !== 'string' || raw.trim() === '') return 'android';
  return raw.trim().slice(0, 32);
}

/** 写完全部待发字节后正常关闭一个已握手的 WebSocket。 */
function closeAfterFlush(socket: Duplex): void {
  socket.end();
}

/** 桥接两侧套接字；任一方向关闭或出错时一起销毁。 */
export function bridgeSockets(
  socket: Duplex,
  upstreamSocket: Duplex,
  head: Buffer,
  upstreamHead: Buffer
): void {
  if (upstreamHead.length > 0) socket.write(upstreamHead);
  if (head.length > 0) upstreamSocket.write(head);
  upstreamSocket.pipe(socket);
  socket.pipe(upstreamSocket);
  upstreamSocket.on('close', () => socket.destroy());
  socket.on('close', () => upstreamSocket.destroy());
  upstreamSocket.on('error', () => socket.destroy());
  socket.on('error', () => upstreamSocket.destroy());
}

/** 打开到运行时的升级请求。 */
export function openUpstreamUpgrade(
  runtimeUrl: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  onUpgrade: (response: IncomingMessage, upstreamSocket: Duplex, upstreamHead: Buffer) => void,
  onRejected: (response: IncomingMessage) => void,
  onError: (error: Error) => void
): void {
  const target = new URL(runtimeUrl);
  const forward = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = forward({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port === '' ? undefined : target.port,
    path,
    method: 'GET',
    headers: { ...headers, host: target.host },
  });
  upstream.on('upgrade', onUpgrade);
  upstream.on('response', onRejected);
  upstream.on('error', onError);
  upstream.end();
}

/** 生成给手机扫码或手填的配对载荷，编码方式与插件一致。 */
export function pairingPayload(input: {
  publicUrl: string;
  pairingCode: string;
  expiresAt: number;
}): { payload: Record<string, unknown>; encoded: string } {
  const payload = {
    version: 2,
    publicUrl: input.publicUrl,
    pairingCode: input.pairingCode,
    expiresAt: input.expiresAt,
  };
  return { payload, encoded: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') };
}
