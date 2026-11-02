/**
 * 控制平面侧自带的 WebSocket 握手与帧编解码。
 *
 * 控制平面需要三种连接：手机业务通道的桥接（升级后两侧套接字原样对接）、设备长连接
 * （升级后按 JSON 文本帧收发）与前缀路由下的 WebSocket 隧道（升级后字节原样穿过通道）。
 * 三条路径共用同一套握手与帧处理，因此把它们放在这里，`mobile-channel.ts` 与
 * `device-link.ts` 都从这里取。
 *
 * 帧读写的状态机覆盖控制平面这一侧遇到的全部情况：客户端帧带掩码、服务端帧不带掩码、
 * 文本帧与二进制帧都可分段、可收到协议级的 ping 与 close、控制帧不得分段且载荷不超过
 * 125 字节、整条消息受 `maxMessageBytes` 约束、写缓冲可观察并可在写满时等待 drain。
 * 不做扩展协商，不压缩。
 * @module @chatdsh/gateway/websocket
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** 握手与帧头共用的固定 GUID。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 帧操作码。 */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** 单帧载荷上限。超过按协议错误断开，避免对端用长度字段撑爆内存。 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** 控制帧的载荷上限。协议规定控制帧不能超过 125 字节。 */
export const MAX_CONTROL_PAYLOAD_BYTES = 125;

/** 关闭帧的原因长度上限，单位字节。 */
export const MAX_CLOSE_REASON_BYTES = 123;

/** 协议支持的版本。 */
export const SUPPORTED_WEBSOCKET_VERSION = '13';

/**
 * 升级请求的版本是否受支持。
 *
 * 只接受 RFC 6455 的版本 13；缺少版本头或给出其他版本按协议错误处理。
 * @param request - 升级请求。
 * @returns 受支持时为真。
 */
export function websocketVersionSupported(request: IncomingMessage): boolean {
  const version = request.headers['sec-websocket-version'];
  return typeof version === 'string' && version.trim() === SUPPORTED_WEBSOCKET_VERSION;
}

/** 一个握手完成的连接。 */
export class WebSocketHandshake {
  private constructor(
    private readonly socketRef: Duplex,
    private readonly accept: string,
    private readonly protocol: string | undefined
  ) {}

  /**
   * 完成 101 握手。
   * @param socket - 升级后的套接字。
   * @param request - 升级请求。
   * @param preferred - 优先选用的子协议；缺省偏向手机业务通道的子协议。
   * @returns 握手对象。
   */
  static accept(socket: Duplex, request: IncomingMessage, preferred: readonly string[] = ['dsh-mobile-v1']): WebSocketHandshake {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') throw new Error('缺少 Sec-WebSocket-Key');
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const offered = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const protocol = preferred.find((candidate) => offered.includes(candidate)) ?? offered[0];
    return new WebSocketHandshake(socket, accept, protocol);
  }

  /** 升级后的套接字。 */
  get socket(): Duplex {
    return this.socketRef;
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
    this.socketRef.write(`${lines.join('\r\n')}\r\n\r\n`);
  }

  /** 写一帧服务端文本消息。服务端帧不掩码。 */
  writeText(payload: string): void {
    this.socketRef.write(encodeServerTextFrame(payload));
  }

  /** 写一帧服务端二进制消息。服务端帧不掩码。 */
  writeBinary(payload: Buffer): void {
    this.socketRef.write(encodeServerFrame(OPCODE.binary, payload));
  }

  /** 写一帧任意操作码的服务端消息，供隧道转发原始帧时使用。 */
  writeFrame(opcode: number, payload: Buffer): void {
    this.socketRef.write(encodeServerFrame(opcode, payload));
  }
}

/**
 * 编码一帧服务端到客户端的消息。
 *
 * 长度按 125、65535、更长的三档分别用 7 位、16 位、64 位表示；服务端帧不加掩码。
 * @param opcode - 帧操作码。
 * @param payload - 载荷字节。
 * @returns 可直接写进套接字的字节。
 */
export function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * 编码一帧服务端到客户端的文本消息。
 * @param payload - 完整的 UTF-8 文本。
 * @returns 可直接写进套接字的字节。
 */
export function encodeServerTextFrame(payload: string): Buffer {
  return encodeServerFrame(OPCODE.text, Buffer.from(payload, 'utf8'));
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

/** 一帧解析结果。 */
interface ParsedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** 关闭信息。 */
export interface WebSocketCloseInfo {
  /** 关闭码；对端没有给出时为空。 */
  readonly code?: number;
  /** 关闭原因。 */
  readonly reason?: string;
}

/**
 * 一条已握手的连接：负责读帧、写帧、回应协议级 ping 与 close。
 *
 * 文本帧按 UTF-8 解出交给订阅者，二进制帧原样交给二进制订阅者；分段帧按操作码与继续帧
 * 拼接后再交付，整条消息的字节数受 `maxMessageBytes` 约束。对端关闭、套接字出错与主动
 * 关闭都走同一条收尾路径，订阅者只会收到一次关闭通知。
 */
export class WebSocketConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | undefined;
  private finished = false;
  private readonly textHandlers: ((payload: string) => void)[] = [];
  private readonly binaryHandlers: ((payload: Buffer) => void)[] = [];
  private readonly closeHandlers: ((info: WebSocketCloseInfo) => void)[] = [];
  private readonly maxMessageBytes: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(
    private readonly handshake: WebSocketHandshake,
    options: { readonly maxMessageBytes?: number } = {}
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_PAYLOAD_BYTES;
    const socket = handshake.socket;
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('close', () => this.finish({}));
    socket.on('end', () => this.finish({}));
    socket.on('error', () => this.finish({}));
  }

  /** 是否已经关闭。 */
  get closed(): boolean {
    return this.finished;
  }

  /** 套接字里待写出的字节数，用于判断写缓冲是否已经积压。 */
  get bufferedBytes(): number {
    return this.handshake.socket.writableLength;
  }

  /** 当前是否还可以继续写而不积压。 */
  get writable(): boolean {
    return !this.finished && this.bufferedBytes === 0;
  }

  /** 订阅文本消息。 */
  onText(handler: (payload: string) => void): void {
    this.textHandlers.push(handler);
  }

  /** 订阅二进制消息。 */
  onBinary(handler: (payload: Buffer) => void): void {
    this.binaryHandlers.push(handler);
  }

  /** 订阅关闭通知。 */
  onClose(handler: (info: WebSocketCloseInfo) => void): void {
    this.closeHandlers.push(handler);
  }

  /** 写一帧文本消息。 */
  sendText(payload: string): void {
    if (this.finished) return;
    this.handshake.writeText(payload);
  }

  /** 写一帧二进制消息。 */
  sendBinary(payload: Buffer): void {
    if (this.finished) return;
    this.handshake.writeBinary(payload);
  }

  /**
   * 等待套接字写出积压清空。
   *
   * 写缓冲超过套接字的高水位时调用，慢消费者因此暂停上游读取。
   * @returns 写缓冲清空或连接结束时落定。
   */
  drain(): Promise<void> {
    const socket = this.handshake.socket;
    if (this.finished || socket.writableLength === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        socket.off('drain', settle);
        socket.off('close', settle);
        resolve();
      };
      socket.once('drain', settle);
      socket.once('close', settle);
    });
  }

  /** 主动关闭：写一帧 close 后结束套接字。 */
  close(code = 1000, reason = ''): void {
    if (this.finished) return;
    if (!Number.isInteger(code) || code < 1000 || code > 4999) {
      throw new Error(`WebSocket 关闭码非法：${code}`);
    }
    if (Buffer.byteLength(reason) > MAX_CLOSE_REASON_BYTES) {
      throw new Error(`WebSocket 关闭原因超过 ${MAX_CLOSE_REASON_BYTES} 字节`);
    }
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.handshake.socket.write(encodeServerFrame(OPCODE.close, payload));
    this.finish({ code, reason });
    this.handshake.socket.end();
  }

  /** 立即断开，不发 close 帧。 */
  destroy(): void {
    if (this.finished) return;
    this.finish({});
    this.handshake.socket.destroy();
  }

  private consume(chunk: Buffer): void {
    if (this.finished || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.take();
      if (frame === undefined) return;
      if (frame === null) {
        this.destroy();
        return;
      }
      this.dispatch(frame);
      if (this.finished) return;
    }
  }

  /**
   * 从缓冲区取一帧。
   * @returns 完整帧；数据不足时 `undefined`；协议错误时 `null`。
   */
  private take(): ParsedFrame | null | undefined {
    if (this.buffer.length < 2) return undefined;
    const first = this.buffer[0] as number;
    const second = this.buffer[1] as number;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < offset + 2) return undefined;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return undefined;
      const extended = this.buffer.readBigUInt64BE(offset);
      if (extended > BigInt(MAX_PAYLOAD_BYTES)) return null;
      length = Number(extended);
      offset += 8;
    }
    if (length > MAX_PAYLOAD_BYTES) return null;
    // 控制帧不得分段，载荷也不超过 125 字节：这两条都在解析阶段就按协议错误拒绝。
    if (opcode >= 0x8 && (length > MAX_CONTROL_PAYLOAD_BYTES || !fin)) return null;
    let mask: Buffer | undefined;
    if (masked) {
      if (this.buffer.length < offset + 4) return undefined;
      mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + length) return undefined;
    const raw = this.buffer.subarray(offset, offset + length);
    const payload = mask === undefined ? Buffer.from(raw) : unmask(raw, mask);
    this.buffer = this.buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  private dispatch(frame: ParsedFrame): void {
    if (frame.opcode === OPCODE.close) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
      const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : undefined;
      if (!this.finished) {
        this.handshake.socket.write(encodeServerFrame(OPCODE.close, frame.payload.subarray(0, Math.min(2, frame.payload.length))));
      }
      this.finish({ ...(code === undefined ? {} : { code }), ...(reason === undefined || reason === '' ? {} : { reason }) });
      this.handshake.socket.end();
      return;
    }
    if (frame.opcode === OPCODE.ping) {
      this.handshake.socket.write(encodeServerFrame(OPCODE.pong, frame.payload));
      return;
    }
    if (frame.opcode === OPCODE.pong) return;
    if (frame.opcode === OPCODE.continuation) {
      // 没有起始帧的继续帧、或者起始帧之后又插入新的数据帧，都是协议错误。
      if (this.fragmentOpcode === undefined) {
        this.abort(1002, 'continuation-without-start');
        return;
      }
      this.appendFragment(frame);
      if (frame.fin) this.deliver();
      return;
    }
    if (frame.opcode === OPCODE.text || frame.opcode === OPCODE.binary) {
      if (this.fragmentOpcode !== undefined) {
        this.abort(1002, 'fragment-interleaved');
        return;
      }
      this.fragmentOpcode = frame.opcode;
      this.fragmentBytes = 0;
      this.fragments = [];
      this.appendFragment(frame);
      if (frame.fin) this.deliver();
      return;
    }
    // 未知操作码按协议错误断开，不猜测语义。
    this.abort(1002, 'opcode-unknown');
  }

  /** 追加一段分片；累计字节超过消息上限时按 1009 关闭，避免对端撑爆内存。 */
  private appendFragment(frame: ParsedFrame): void {
    this.fragmentBytes += frame.payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) {
      this.abort(1009, 'message-too-large');
      return;
    }
    this.fragments.push(frame.payload);
  }

  private deliver(): void {
    const payload = Buffer.concat(this.fragments);
    const opcode = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = undefined;
    if (opcode === OPCODE.binary) {
      for (const handler of this.binaryHandlers) handler(payload);
      return;
    }
    let text: string;
    try {
      text = this.decoder.decode(payload);
    } catch {
      this.abort(1007, 'payload-not-utf8');
      return;
    }
    for (const handler of this.textHandlers) handler(text);
  }

  /** 按协议错误关闭连接：写一帧 close 带上码与原因后结束套接字。 */
  private abort(code: number, reason: string): void {
    if (this.finished) return;
    const payload = Buffer.alloc(2 + reason.length);
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.handshake.socket.write(encodeServerFrame(OPCODE.close, payload));
    this.finish({ code, reason });
    this.handshake.socket.end();
  }

  private finish(info: WebSocketCloseInfo): void {
    if (this.finished) return;
    this.finished = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = undefined;
    for (const handler of this.closeHandlers) handler(info);
  }
}

/** 按掩码解出客户端帧的载荷。 */
function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    out[index] = (payload[index] as number) ^ (mask[index % 4] as number);
  }
  return out;
}
