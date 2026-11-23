/**
 * 设备侧版本 2 多路复用通道。
 *
 * 一条长连接上同时承载多条逻辑通道：HTTP 通道把请求体流式写给本机运行时并把响应流式
 * 回填；WebSocket 通道向本机运行时发起真实升级，之后在两个套接字之间原样转发字节。
 * 每个方向各自维护序号与额度，慢消费者通过扣住额度让对端停止读取。
 * @module @chatdsh/host-device-link/v2-channel
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import { credentialFor, hasLocalCredential, type CredentialProvider } from './credential.ts';
import {
  traceCarrierOf,
  validateTargetPath,
  type ControlFrameV2,
  type DeviceFrameV2,
  type LinkLimits,
} from './protocol.ts';

/** 逐跳头部：转发到本机运行时时去掉。 */
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

/** 凭据头：由设备插件按本机凭据重新构造。 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie']);

/** 为 401 重试保留的请求体上限。 */
const RETRY_BODY_LIMIT_BYTES = 1024 * 1024;

/** 一次设备连接上累计的通道统计，供诊断与验收读取。 */
export interface DeviceLinkStats {
  /** 收到的数据帧数。 */
  dataFramesReceived: number;
  /** 发出的数据帧数。 */
  dataFramesSent: number;
  /** 收到的单帧最大载荷字节数。 */
  maxPayloadBytesReceived: number;
  /** 发出的单帧最大载荷字节数。 */
  maxPayloadBytesSent: number;
  /** 发出的额度帧数。 */
  creditFramesSent: number;
  /** 收到的额度帧数。 */
  creditFramesReceived: number;
  /** 打开过的通道数。 */
  channelsOpened: number;
}

/** 会话构造输入。 */
export interface DeviceLinkSessionOptions {
  /** 控制平面为这次连接分配的代次。 */
  readonly generation: number;
  /** welcome 下发的预算。 */
  readonly limits: LinkLimits;
  /** 本机运行时的地址，例如 `http://127.0.0.1:4321`。 */
  readonly localOrigin: string;
  /** 本机界面凭据入口。 */
  readonly credentials: CredentialProvider;
  /** 写一帧到控制平面。 */
  readonly send: (frame: DeviceFrameV2) => void;
  /** 协议违规时断开连接。 */
  readonly close: (code: number, reason: string) => void;
  /** 遥测出口。 */
  readonly telemetry?: ChatdshTelemetry;
  /** 统计对象；由连接持有，跨通道累加。 */
  readonly stats: DeviceLinkStats;
  /** 等待本机响应头的时长上限。 */
  readonly headerTimeoutMs: number;
  /** 通道空闲的时长上限。 */
  readonly idleTimeoutMs: number;
}

/** 一条通道的额度等待者。 */
interface CreditWaiter {
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** 版本 2 会话：解析控制帧、维护通道表、把通道上的工作交给具体实现。 */
export class DeviceLinkSession {
  readonly telemetry: ChatdshTelemetry | undefined;
  readonly credentials: CredentialProvider;
  readonly localOrigin: string;
  readonly limits: LinkLimits;
  readonly stats: DeviceLinkStats;
  readonly headerTimeoutMs: number;
  readonly idleTimeoutMs: number;

  private readonly generation: number;
  private readonly sendFrame: (frame: DeviceFrameV2) => void;
  private readonly closeLink: (code: number, reason: string) => void;
  private readonly channels = new Map<string, DeviceChannel>();
  private disposed = false;

  constructor(options: DeviceLinkSessionOptions) {
    this.generation = options.generation;
    this.limits = options.limits;
    this.localOrigin = options.localOrigin;
    this.credentials = options.credentials;
    this.sendFrame = options.send;
    this.closeLink = options.close;
    this.telemetry = options.telemetry;
    this.stats = options.stats;
    this.headerTimeoutMs = options.headerTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
  }

  /** 当前打开的通道数。 */
  get channelCount(): number {
    return this.channels.size;
  }

  /** 写一帧。 */
  send(frame: DeviceFrameV2): void {
    if (this.disposed) return;
    this.sendFrame(frame);
  }

  /** 处理一帧控制平面消息。 */
  handleFrame(frame: ControlFrameV2): void {
    if (this.disposed) return;
    if (frame.type === 'welcome') {
      this.violation('welcome-duplicate');
      return;
    }
    if (frame.type === 'ping') {
      this.send({ type: 'pong', generation: this.generation, nonce: frame.nonce });
      return;
    }
    if (frame.type === 'pong') return;
    if (frame.type === 'open') {
      this.handleOpen(frame);
      return;
    }
    if (typeof frame.channelId !== 'string') {
      this.violation('frame-invalid');
      return;
    }
    if (frame.generation !== this.generation) {
      this.violation('generation-mismatch');
      return;
    }
    const channel = this.channels.get(frame.channelId);
    if (channel === undefined) {
      if (frame.type === 'data' || frame.type === 'end') {
        this.violation('channel-unknown');
      }
      return;
    }
    if (frame.type === 'data') {
      channel.handleData(frame);
      return;
    }
    if (frame.type === 'credit') {
      channel.handleCredit(frame);
      return;
    }
    if (frame.type === 'end') {
      channel.handleEnd(frame);
      return;
    }
    if (frame.type === 'cancel') {
      channel.handleCancel(frame.reason);
      return;
    }
    if (frame.type === 'reset') {
      channel.handleReset(frame.code);
      return;
    }
    this.violation('frame-unknown');
  }

  /** 处理一帧开通道请求。 */
  handleOpen(frame: Extract<ControlFrameV2, { type: 'open' }>): void {
    if (this.disposed) return;
    if (frame.generation !== this.generation) {
      this.violation('generation-mismatch');
      return;
    }
    if (typeof frame.method !== 'string' || typeof frame.path !== 'string'
      || typeof frame.headers !== 'object' || frame.headers === null) {
      this.violation('frame-invalid');
      return;
    }
    if (this.channels.size >= this.limits.maxChannels) {
      this.sendReset(frame.channelId, frame.generation, 'channel-limit');
      return;
    }
    if (this.channels.has(frame.channelId)) {
      this.sendReset(frame.channelId, frame.generation, 'channel-unknown');
      return;
    }
    const rejection = validateTargetPath(frame.path);
    if (rejection !== undefined) {
      this.sendReset(frame.channelId, frame.generation, 'path-invalid');
      return;
    }
    if (frame.kind === 'events') {
      this.sendReset(frame.channelId, frame.generation, 'event-invalid');
      return;
    }
    if (frame.kind !== 'http' && frame.kind !== 'websocket') {
      this.sendReset(frame.channelId, frame.generation, 'channel-unknown');
      return;
    }
    const carrier = traceCarrierOf(frame.headers);
    const start = (): void => {
      const channel = frame.kind === 'http'
        ? new HttpChannel(this, frame)
        : new WebSocketChannel(this, frame);
      this.channels.set(frame.channelId, channel);
      this.stats.channelsOpened += 1;
      channel.start();
    };
    if (this.telemetry === undefined) {
      start();
      return;
    }
    this.telemetry.withContext(carrier, start);
  }

  /** 通道收尾时从表里移除。 */
  removeChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  /** 连接断开时收尾全部通道。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of [...this.channels.values()]) channel.dispose();
    this.channels.clear();
  }

  /** 协议违规：记一条事件并断开连接。 */
  violation(code: string): void {
    this.telemetry?.event('chatdsh.runtime.device.rejected', {
      outcome: 'rejected',
      'error.type': 'protocol',
      'error.code': code,
    });
    this.closeLink(1008, code);
  }

  /** 给一条尚未登记的通道回终止帧。 */
  private sendReset(channelId: string, generation: number, code: string): void {
    this.send({ type: 'reset', channelId, generation, code });
    this.telemetry?.event('chatdsh.runtime.device.rejected', {
      action: 'channel',
      outcome: 'reset',
      'error.type': 'channel',
      'error.code': code,
    });
  }
}

/** 一条逻辑通道的共同部分：序号、额度、定时器与收尾。 */
abstract class DeviceChannel {
  readonly channelId: string;
  readonly generation: number;
  readonly kind: 'http' | 'websocket';
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly span: TelemetrySpan | undefined;
  readonly session: DeviceLinkSession;

  private sendSeqValue = 0;
  private sendCreditValue: number;
  private recvSeqValue = 0;
  private recvReceivedValue = 0;
  private recvGrantedValue: number;
  private sendWaiters: CreditWaiter[] = [];
  private inboundQueue: Promise<void> = Promise.resolve();
  private outboundQueue: Promise<void> = Promise.resolve();
  private closedValue = false;
  private remoteEndedValue = false;
  private localEndedValue = false;
  private outcomeRecorded = false;
  private acceptedSent = false;
  private statusValue: number | undefined;
  private headerTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(session: DeviceLinkSession, frame: Extract<ControlFrameV2, { type: 'open' }>, kind: 'http' | 'websocket') {
    this.session = session;
    this.channelId = frame.channelId;
    this.generation = frame.generation;
    this.kind = kind;
    this.method = frame.method;
    this.path = frame.path;
    this.headers = frame.headers;
    this.sendCreditValue = session.limits.initialCreditBytes;
    this.recvGrantedValue = session.limits.initialCreditBytes;
    this.span = session.telemetry?.startSpan('chatdsh.runtime.device.forward', {
      method: frame.method,
    });
    this.headerTimer = setTimeout(() => {
      if (!this.closedValue && !this.acceptedSent) {
        this.reset('header-timeout');
      }
    }, session.headerTimeoutMs);
    this.headerTimer.unref();
    this.touch();
  }

  /** 通道是否已收尾。 */
  get closed(): boolean {
    return this.closedValue;
  }

  /** 是否已经回填响应头。 */
  get accepted(): boolean {
    return this.acceptedSent;
  }

  /** 控制平面是否已经发送半关闭。 */
  protected get remoteEnded(): boolean {
    return this.remoteEndedValue;
  }

  /** 启动本地转发。 */
  abstract start(): void;

  /** 消费一段来自控制平面的请求体字节。 */
  protected abstract consume(payload: Buffer): Promise<void>;

  /** 控制平面发送半关闭。 */
  protected abstract onRemoteEnd(): void;

  /** 中断本地请求或套接字。 */
  protected abstract abortLocal(error: Error): void;

  /** 接收一段数据。 */
  handleData(frame: Extract<ControlFrameV2, { type: 'data' }>): void {
    if (this.closedValue) return;
    if (typeof frame.payload !== 'string' || !Number.isSafeInteger(frame.seq) || !Number.isSafeInteger(frame.payloadLength)) {
      this.reset('credit-exceeded');
      return;
    }
    const bytes = Buffer.byteLength(frame.payload, 'base64');
    if (frame.payloadLength !== bytes) {
      this.reset('credit-exceeded');
      return;
    }
    if (frame.seq < this.recvSeqValue) {
      this.reset('seq-duplicate');
      return;
    }
    if (frame.seq > this.recvSeqValue) {
      this.reset('seq-out-of-order');
      return;
    }
    if (this.recvReceivedValue + bytes > this.recvGrantedValue) {
      this.reset('credit-exceeded');
      return;
    }
    this.recvSeqValue += 1;
    this.recvReceivedValue += bytes;
    this.session.stats.dataFramesReceived += 1;
    this.session.stats.maxPayloadBytesReceived = Math.max(this.session.stats.maxPayloadBytesReceived, bytes);
    this.touch();
    const payload = bytes === 0 ? Buffer.alloc(0) : Buffer.from(frame.payload, 'base64');
    this.inboundQueue = this.inboundQueue.then(async () => {
      if (this.closedValue) return;
      await this.consume(payload);
      this.grantCredit(bytes);
    }).catch((error: unknown) => {
      if (this.closedValue) return;
      this.session.telemetry?.log('warn', 'device-link local consumer failed', {
        'error.type': error instanceof Error ? error.name : 'Unknown',
      });
      this.reset('consumer-failed');
    });
  }

  /** 接收控制平面的半关闭。 */
  handleEnd(frame: Extract<ControlFrameV2, { type: 'end' }>): void {
    if (this.closedValue) return;
    const expected = this.recvSeqValue === 0 ? 0 : this.recvSeqValue - 1;
    if (frame.lastSeq !== expected || this.remoteEndedValue) {
      this.reset('seq-out-of-order');
      return;
    }
    this.remoteEndedValue = true;
    this.touch();
    // 半关闭要排在已收到的数据之后：先把请求体写完，再结束本地请求。
    this.inboundQueue = this.inboundQueue.then(async () => {
      if (this.closedValue) return;
      this.onRemoteEnd();
      if (this.localEndedValue) this.finish('ended');
    }).catch((error: unknown) => {
      if (this.closedValue) return;
      this.session.telemetry?.log('warn', 'device-link local end failed', {
        'error.type': error instanceof Error ? error.name : 'Unknown',
      });
      this.reset('consumer-failed');
    });
  }

  /** 接收额度补充。 */
  handleCredit(frame: Extract<ControlFrameV2, { type: 'credit' }>): void {
    if (this.closedValue) return;
    if (!Number.isSafeInteger(frame.bytes) || frame.bytes <= 0) {
      this.reset('credit-exceeded');
      return;
    }
    this.sendCreditValue += frame.bytes;
    this.session.stats.creditFramesReceived += 1;
    this.touch();
    this.releaseWaiters();
  }

  /** 接收取消。 */
  handleCancel(reason: string): void {
    if (this.closedValue) return;
    this.send({ type: 'cancelled', channelId: this.channelId, generation: this.generation, reason });
    this.finish('cancelled');
    this.abortLocal(new Error(reason));
  }

  /** 接收终止。 */
  handleReset(code: string): void {
    if (this.closedValue) return;
    this.finish(code);
    this.abortLocal(new Error(code));
  }

  /** 连接断开时收尾。 */
  dispose(): void {
    if (this.closedValue) return;
    this.finish('link-closed');
    this.abortLocal(new Error('link-closed'));
  }

  /** 回填响应头。 */
  protected sendAccepted(status: number, headers: Record<string, string | string[]>): void {
    if (this.closedValue || this.acceptedSent) return;
    this.acceptedSent = true;
    this.statusValue = status;
    this.span?.setAttribute('http.status_code', status);
    this.clearHeaderTimer();
    this.touch();
    this.send({ type: 'accepted', channelId: this.channelId, generation: this.generation, status, headers });
  }

  /** 发送一段字节；按预算拆帧并等待额度。 */
  protected async sendData(payload: Buffer): Promise<void> {
    if (this.closedValue) throw new Error('device-link: channel closed');
    let offset = 0;
    while (offset < payload.length) {
      const size = Math.min(payload.length - offset, this.session.limits.dataPayloadMaxBytes);
      await this.takeCredit(size);
      if (this.closedValue) throw new Error('device-link: channel closed');
      const chunk = payload.subarray(offset, offset + size);
      this.send({
        type: 'data',
        channelId: this.channelId,
        generation: this.generation,
        seq: this.sendSeqValue,
        payloadLength: chunk.length,
        payload: chunk.toString('base64'),
      });
      this.sendSeqValue += 1;
      this.session.stats.dataFramesSent += 1;
      this.session.stats.maxPayloadBytesSent = Math.max(this.session.stats.maxPayloadBytesSent, chunk.length);
      this.touch();
      offset += size;
    }
  }

  /** 发送半关闭。 */
  protected sendEnd(): void {
    if (this.closedValue || this.localEndedValue) return;
    this.localEndedValue = true;
    this.send({
      type: 'end',
      channelId: this.channelId,
      generation: this.generation,
      lastSeq: this.sendSeqValue === 0 ? 0 : this.sendSeqValue - 1,
    });
    if (this.remoteEndedValue) this.finish('ended');
  }

  /** 设备主动终止一条通道。 */
  protected reset(code: string): void {
    if (this.closedValue) return;
    this.send({ type: 'reset', channelId: this.channelId, generation: this.generation, code });
    this.session.telemetry?.event('chatdsh.runtime.device.rejected', {
      action: 'channel',
      outcome: 'reset',
      'error.type': 'channel',
      'error.code': code,
    });
    this.recordOutcome('failed', 'channel', code);
    this.finish(code);
    this.abortLocal(new Error(code));
  }

  /** 本地转发失败。 */
  protected fail(code: string, error: unknown): void {
    if (this.closedValue) return;
    this.recordOutcome('failed', error instanceof Error ? error.name : 'Error', code);
    this.finish(code);
    this.abortLocal(error instanceof Error ? error : new Error(code));
  }

  /** 记录一次通道结果；同一通道只记一次。 */
  protected recordOutcome(outcome: 'upgraded' | 'forwarded' | 'cancelled' | 'failed', errorType?: string, errorCode?: string): void {
    if (this.outcomeRecorded) return;
    this.outcomeRecorded = true;
    this.span?.setAttribute('outcome', outcome);
    if (errorType !== undefined) this.span?.setAttribute('error.type', errorType);
    if (errorCode !== undefined) this.span?.setAttribute('error.code', errorCode);
    this.session.telemetry?.counter('chatdsh_runtime_device_forwards_total', {
      description: '设备侧转发到本地运行时的请求数',
    }).add(1, { outcome });
    if (outcome === 'failed' && errorType !== undefined && errorCode !== undefined) {
      this.session.telemetry?.event('chatdsh.runtime.device.forward.failed', {
        outcome: 'failed',
        'error.type': errorType,
        'error.code': errorCode,
      });
    }
  }

  /** 收尾：清定时器、结算等待点、结束 span、从连接表移除。 */
  protected finish(code: string): void {
    if (this.closedValue) return;
    this.closedValue = true;
    this.clearHeaderTimer();
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const waiter of this.sendWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`device-link: channel closed (${code})`));
    }
    this.sendWaiters = [];
    if (!this.outcomeRecorded) {
      if (code === 'cancelled') this.recordOutcome('cancelled');
      else if (code === 'ended') this.recordOutcome(this.kind === 'websocket' ? 'upgraded' : 'forwarded');
      else this.recordOutcome('failed', 'channel', code);
    }
    if (this.statusValue !== undefined) this.span?.setAttribute('http.status_code', this.statusValue);
    this.span?.end();
    this.session.removeChannel(this.channelId);
  }

  /** 发一帧。 */
  protected send(frame: DeviceFrameV2): void {
    this.session.send(frame);
  }

  /** 把一段写操作排进有序队列；失败时收尾通道。 */
  protected enqueueOutbound(task: () => Promise<void>): void {
    this.outboundQueue = this.outboundQueue.then(task).catch((error: unknown) => {
      if (this.closedValue) return;
      this.fail('consumer-failed', error);
    });
  }

  /** 刷新空闲计时。 */
  protected touch(): void {
    if (this.closedValue) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.closedValue) this.reset('idle-timeout');
    }, this.session.idleTimeoutMs);
    this.idleTimer.unref();
  }

  /** 补充接收额度。 */
  private grantCredit(bytes: number): void {
    if (this.closedValue || bytes === 0) return;
    this.recvGrantedValue += bytes;
    this.send({ type: 'credit', channelId: this.channelId, generation: this.generation, bytes });
    this.session.stats.creditFramesSent += 1;
    this.touch();
  }

  /** 等待发送额度。 */
  private takeCredit(bytes: number): Promise<void> {
    if (this.closedValue) return Promise.reject(new Error('device-link: channel closed'));
    if (this.sendCreditValue >= bytes) {
      this.sendCreditValue -= bytes;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('device-link: credit timeout'));
        if (!this.closedValue) this.reset('idle-timeout');
      }, this.session.idleTimeoutMs);
      timer.unref();
      this.sendWaiters.push({ bytes, resolve, reject, timer });
    });
  }

  /** 额度到账后按顺序释放等待者。 */
  private releaseWaiters(): void {
    while (this.sendWaiters.length > 0) {
      const waiter = this.sendWaiters[0];
      if (waiter === undefined) return;
      if (this.sendCreditValue < waiter.bytes) return;
      this.sendCreditValue -= waiter.bytes;
      this.sendWaiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private clearHeaderTimer(): void {
    if (this.headerTimer !== undefined) clearTimeout(this.headerTimer);
    this.headerTimer = undefined;
  }
}

/** HTTP 通道：把请求体流给本机运行时，把响应流回控制平面。 */
class HttpChannel extends DeviceChannel {
  private request: ClientRequest | undefined;
  private response: IncomingMessage | undefined;
  private injectedCredential: string | undefined;
  private retried = false;
  private bodyBuffer: Buffer[] = [];
  private bodyBytes = 0;
  private bodyTooLarge = false;
  private resolveRequest: ((request: ClientRequest | undefined) => void) | undefined;
  private readonly requestReady = new Promise<ClientRequest | undefined>((resolve) => {
    this.resolveRequest = resolve;
  });

  constructor(session: DeviceLinkSession, frame: Extract<ControlFrameV2, { type: 'open' }>) {
    super(session, frame, 'http');
  }

  start(): void {
    void this.startRequest().catch((error: unknown) => this.fail('local-unreachable', error));
  }

  protected async consume(payload: Buffer): Promise<void> {
    if (payload.length > 0) {
      if (!this.bodyTooLarge) {
        this.bodyBytes += payload.length;
        if (this.bodyBytes > RETRY_BODY_LIMIT_BYTES) {
          this.bodyTooLarge = true;
          this.bodyBuffer = [];
        } else {
          this.bodyBuffer.push(payload);
        }
      }
    }
    const request = this.request ?? await this.requestReady;
    if (request === undefined || request.destroyed || request.writableEnded) return;
    if (payload.length === 0) return;
    if (!request.write(payload)) await waitForDrain(request);
  }

  protected onRemoteEnd(): void {
    const request = this.request;
    if (request !== undefined && !request.destroyed && !request.writableEnded) request.end();
  }

  protected abortLocal(error: Error): void {
    this.resolveRequest?.(undefined);
    this.resolveRequest = undefined;
    this.request?.destroy(error);
    this.response?.destroy(error);
  }

  private async startRequest(body?: Buffer): Promise<void> {
    const url = new URL(this.path, this.session.localOrigin);
    const headers = await this.buildHeaders(url);
    if (this.closed) return;
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(url, { method: this.method, headers, agent: false });
    this.request = request;
    this.resolveRequest?.(request);
    this.resolveRequest = undefined;
    request.on('response', (response) => {
      if (this.request !== request) {
        response.resume();
        return;
      }
      this.onResponse(response);
    });
    request.on('error', (error) => {
      if (this.request !== request) return;
      if (!this.closed) this.fail('local-unreachable', error);
    });
    if (body !== undefined) {
      request.end(body);
      return;
    }
    if (this.remoteEnded) request.end();
  }

  private async buildHeaders(url: URL): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.headers)) {
      const lowered = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowered) || lowered === 'cookie') continue;
      if (lowered === 'host' || lowered === 'content-length') continue;
      if (lowered === 'accept-encoding') continue;
      headers[lowered] = value;
    }
    headers.host = url.host;
    headers.origin = this.session.localOrigin;
    let cookie = this.headers.cookie;
    if (!hasLocalCredential(cookie)) {
      try {
        const credential = await this.session.credentials.get();
        const injected = credentialFor(credential, this.path);
        if (injected !== undefined) {
          cookie = cookie === undefined ? injected : `${cookie}; ${injected}`;
          this.injectedCredential = injected;
        }
      } catch (error) {
        this.session.telemetry?.event('chatdsh.runtime.device.forward.failed', {
          outcome: 'failed',
          'error.type': error instanceof Error ? error.name : 'Unknown',
          'error.code': 'credential-unavailable',
        });
      }
    }
    if (cookie !== undefined) headers.cookie = cookie;
    return headers;
  }

  private onResponse(response: IncomingMessage): void {
    if (this.closed) {
      response.resume();
      return;
    }
    const status = response.statusCode ?? 502;
    if (status === 401 && this.injectedCredential !== undefined && !this.retried && !this.bodyTooLarge && this.remoteEnded) {
      this.retried = true;
      response.resume();
      void this.retryWithFreshCredential().catch((error: unknown) => this.fail('credential-unavailable', error));
      return;
    }
    this.deliver(response, status);
  }

  private async retryWithFreshCredential(): Promise<void> {
    await this.session.credentials.refresh();
    if (this.closed) return;
    const body = this.bodyBuffer.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.bodyBuffer);
    const previous = this.request;
    this.request = undefined;
    previous?.destroy();
    await this.startRequest(body);
  }

  private deliver(response: IncomingMessage, status: number): void {
    this.response = response;
    this.sendAccepted(status, responseHeadersOf(response));
    response.on('data', (chunk: Buffer) => {
      response.pause();
      this.enqueueOutbound(async () => {
        await this.sendData(chunk);
        response.resume();
      });
    });
    response.on('end', () => {
      this.enqueueOutbound(async () => {
        this.sendEnd();
        this.recordOutcome('forwarded');
      });
    });
    response.on('error', (error) => {
      if (!this.closed) this.fail('local-unreachable', error);
    });
    response.on('aborted', () => {
      if (!this.closed) this.fail('local-unreachable', new Error('response aborted'));
    });
  }
}

/** WebSocket 通道：向本机运行时发起真实升级，之后原样转发套接字字节。 */
class WebSocketChannel extends DeviceChannel {
  private request: ClientRequest | undefined;
  private socket: Socket | undefined;
  private injectedCredential: string | undefined;
  private retried = false;

  constructor(session: DeviceLinkSession, frame: Extract<ControlFrameV2, { type: 'open' }>) {
    super(session, frame, 'websocket');
  }

  start(): void {
    void this.startUpgrade().catch((error: unknown) => this.fail('local-unreachable', error));
  }

  protected async consume(payload: Buffer): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return;
    if (payload.length === 0) return;
    if (!socket.write(payload)) await waitForDrain(socket);
  }

  protected onRemoteEnd(): void {
    const socket = this.socket;
    if (socket !== undefined && !socket.destroyed) socket.end();
  }

  protected abortLocal(error: Error): void {
    this.socket?.destroy(error);
    this.request?.destroy(error);
  }

  private async startUpgrade(): Promise<void> {
    const url = new URL(this.path, this.session.localOrigin);
    const key = this.headers['sec-websocket-key'];
    if (key === undefined || key === '') {
      this.reset('upgrade-rejected');
      return;
    }
    const headers = await this.buildHeaders(url);
    if (this.closed) return;
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(url, { method: 'GET', headers, agent: false });
    this.request = request;
    request.on('upgrade', (response, socket, head) => {
      if (this.request !== request) {
        socket.destroy();
        return;
      }
      this.onUpgrade(response, socket, head);
    });
    request.on('response', (response) => {
      if (this.request !== request) {
        response.resume();
        return;
      }
      this.onRejected(response);
    });
    request.on('error', (error) => {
      if (this.request !== request) return;
      if (!this.closed) this.fail('local-unreachable', error);
    });
    request.end();
  }

  private async buildHeaders(url: URL): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.headers)) {
      const lowered = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowered) || CREDENTIAL_HEADERS.has(lowered)) continue;
      if (lowered === 'host' || lowered === 'content-length') continue;
      if (lowered === 'accept-encoding') continue;
      if (lowered === 'sec-websocket-extensions') continue;
      headers[lowered] = value;
    }
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers.host = url.host;
    headers.origin = this.session.localOrigin;
    if (headers['sec-websocket-version'] === undefined) headers['sec-websocket-version'] = '13';
    let cookie = this.headers.cookie;
    if (!hasLocalCredential(cookie)) {
      try {
        const credential = await this.session.credentials.get();
        const injected = credentialFor(credential, this.path);
        if (injected !== undefined) {
          cookie = cookie === undefined ? injected : `${cookie}; ${injected}`;
          this.injectedCredential = injected;
        }
      } catch (error) {
        this.session.telemetry?.event('chatdsh.runtime.device.forward.failed', {
          outcome: 'failed',
          'error.type': error instanceof Error ? error.name : 'Unknown',
          'error.code': 'credential-unavailable',
        });
      }
    }
    if (cookie !== undefined) headers.cookie = cookie;
    return headers;
  }

  private onUpgrade(response: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const accept = response.headers['sec-websocket-accept'];
    if (response.statusCode !== 101 || typeof accept !== 'string' || accept === '') {
      socket.destroy();
      this.reset('upgrade-rejected');
      return;
    }
    this.socket = socket;
    this.sendAccepted(101, responseHeadersOf(response));
    this.recordOutcome('upgraded');
    socket.on('data', (chunk: Buffer) => {
      socket.pause();
      this.enqueueOutbound(async () => {
        await this.sendData(chunk);
        socket.resume();
      });
    });
    socket.on('end', () => {
      this.enqueueOutbound(async () => {
        this.sendEnd();
      });
    });
    socket.on('close', () => {
      if (this.closed) return;
      if (!this.accepted) {
        this.reset('upgrade-rejected');
        return;
      }
      this.enqueueOutbound(async () => {
        this.sendEnd();
      });
    });
    socket.on('error', (error) => {
      if (!this.closed) this.fail('local-unreachable', error);
    });
    if (this.remoteEnded) socket.end();
    if (head.length > 0) {
      this.enqueueOutbound(async () => {
        await this.sendData(head);
      });
    }
  }

  private onRejected(response: IncomingMessage): void {
    if (this.closed) {
      response.resume();
      return;
    }
    const status = response.statusCode ?? 502;
    if (status === 401 && this.injectedCredential !== undefined && !this.retried) {
      this.retried = true;
      response.resume();
      void this.retryUpgrade().catch((error: unknown) => this.fail('credential-unavailable', error));
      return;
    }
    response.resume();
    this.reset('upgrade-rejected');
  }

  private async retryUpgrade(): Promise<void> {
    await this.session.credentials.refresh();
    if (this.closed) return;
    const previous = this.request;
    this.request = undefined;
    previous?.destroy();
    await this.startUpgrade();
  }
}

/** 把响应头整理成通道帧可承载的形状，`set-cookie` 保持多条独立。 */
function responseHeadersOf(response: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value : value;
  }
  const cookies = response.headersDistinct['set-cookie'];
  if (cookies !== undefined && cookies.length > 0) headers['set-cookie'] = cookies;
  return headers;
}

/** 等可写端清空；对端关闭时直接落定。 */
function waitForDrain(stream: ClientRequest | Socket): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      stream.off('drain', settle);
      stream.off('close', settle);
      resolve();
    };
    stream.once('drain', settle);
    stream.once('close', settle);
  });
}
