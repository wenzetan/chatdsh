/**
 * 设备长连接的设备侧客户端。
 *
 * 负责拨出连接、发送版本 2 的 hello、校验 welcome、维持双向心跳与断线重连；
 * 通道内的 HTTP 与 WebSocket 转发交给 {@link DeviceLinkSession}。
 * @module @chatdsh/host-device-link/client
 */

import { randomUUID } from 'node:crypto';
import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import type { CredentialProvider } from './credential.ts';
import {
  DEFAULT_DEAD_AFTER_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEADER_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type ControlFrameV2,
  type DeviceFrameV2,
  type LinkLimits,
  type NodeRole,
} from './protocol.ts';
import { DeviceLinkSession, type DeviceLinkStats } from './v2-channel.ts';

/** 控制平面侧的长连接升级路径。 */
export const DEVICE_LINK_PATH = '/chatdsh/gateway/device-link';

/** 重连的起始间隔。 */
export const RECONNECT_BASE_MS = 1000;

/** 客户端构造输入。 */
export interface DeviceLinkClientOptions {
  /** 控制平面地址，例如 `http://127.0.0.1:3170`。 */
  readonly controlUrl: string;
  /** 节点令牌。 */
  readonly token: string;
  /** 设备标识。 */
  readonly deviceId: string;
  /** 平台标识。 */
  readonly platform: string;
  /** 平台角色。 */
  readonly role: NodeRole;
  /** 声明的能力。 */
  readonly capabilities: readonly string[];
  /** 本机运行时的地址。 */
  readonly localOrigin: string;
  /** 本机界面凭据入口。 */
  readonly credentials: CredentialProvider;
  /** 遥测出口；传函数时在每次记录前读取当前实例。 */
  readonly telemetry?: ChatdshTelemetry | (() => ChatdshTelemetry | undefined);
  /** 重连退避的上限，单位毫秒。 */
  readonly reconnectMaxMs?: number;
  /** 心跳间隔，单位毫秒。 */
  readonly heartbeatMs?: number;
  /** 失联判定阈值，单位毫秒。 */
  readonly deadAfterMs?: number;
  /** 等待 welcome 的时长上限，单位毫秒。 */
  readonly handshakeTimeoutMs?: number;
  /** 等待本地响应头的时长上限，单位毫秒。 */
  readonly headerTimeoutMs?: number;
  /** 通道空闲的时长上限，单位毫秒。 */
  readonly idleTimeoutMs?: number;
}

/** welcome 的内容。 */
export interface DeviceLinkWelcome {
  readonly version: number;
  readonly deviceId: string;
  readonly generation: number;
  readonly limits: LinkLimits;
}

/** 客户端累计统计。 */
export interface DeviceLinkClientStats extends DeviceLinkStats {
  /** 发出的心跳数。 */
  pingsSent: number;
  /** 发出的 pong 数。 */
  pongsSent: number;
  /** 收到的心跳数。 */
  pingsReceived: number;
  /** 收到的 pong 数。 */
  pongsReceived: number;
}

/** 等待 welcome 的调用方。 */
interface WelcomeWaiter {
  readonly resolve: (welcome: DeviceLinkWelcome) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** 判断一个值是否是非负安全整数。 */
function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 校验 welcome 下发的预算。 */
function isLimits(value: unknown): value is LinkLimits {
  if (typeof value !== 'object' || value === null) return false;
  const limits = value as Partial<LinkLimits>;
  return isSequence(limits.maxChannels) && limits.maxChannels > 0
    && isSequence(limits.sendBufferBytes) && limits.sendBufferBytes > 0
    && isSequence(limits.initialCreditBytes) && limits.initialCreditBytes > 0
    && isSequence(limits.dataPayloadMaxBytes) && limits.dataPayloadMaxBytes > 0
    && isSequence(limits.frameMaxBytes) && limits.frameMaxBytes > 0;
}

/** 校验 welcome 的版本与身份。 */
function welcomeRejection(frame: Extract<ControlFrameV2, { type: 'welcome' }>, deviceId: string): string | undefined {
  if (frame.version !== PROTOCOL_VERSION) return 'protocol-version-unsupported';
  if (frame.deviceId !== '' && frame.deviceId !== deviceId) return 'device-mismatch';
  if (!isSequence(frame.generation) || frame.generation < 1) return 'welcome-invalid';
  if (!isLimits(frame.limits)) return 'welcome-invalid';
  return undefined;
}

/**
 * 把控制平面地址转成 WebSocket 地址。
 * @param controlUrl - 控制平面地址，例如 `http://127.0.0.1:3170`。
 * @returns 去掉末尾斜杠的 WebSocket 基地址。
 */
export function linkOrigin(controlUrl: string): string {
  const trimmed = controlUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  throw new Error(`CHATDSH_CONTROL_URL 必须是 http 或 https 地址：${controlUrl}`);
}

/** 设备长连接客户端。 */
export class DeviceLinkClient {
  private readonly options: DeviceLinkClientOptions;
  private readonly statsValue: DeviceLinkClientStats = {
    dataFramesReceived: 0,
    dataFramesSent: 0,
    maxPayloadBytesReceived: 0,
    maxPayloadBytesSent: 0,
    creditFramesSent: 0,
    creditFramesReceived: 0,
    channelsOpened: 0,
    pingsSent: 0,
    pongsSent: 0,
    pingsReceived: 0,
    pongsReceived: 0,
  };
  private readonly waiters = new Set<WelcomeWaiter>();
  private socket: WebSocket | undefined;
  private session: DeviceLinkSession | undefined;
  private welcomeValue: DeviceLinkWelcome | undefined;
  private linkSpan: TelemetrySpan | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private deadTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private stopped = false;

  constructor(options: DeviceLinkClientOptions) {
    this.options = {
      ...options,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      deadAfterMs: options.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      headerTimeoutMs: options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
  }

  /** 当前 welcome；未完成握手时为空。 */
  get welcome(): DeviceLinkWelcome | undefined {
    return this.welcomeValue;
  }

  /** 是否已经完成握手且连接仍在。 */
  get online(): boolean {
    return this.session !== undefined && this.welcomeValue !== undefined;
  }

  /** 当前打开的通道数。 */
  get channelCount(): number {
    return this.session?.channelCount ?? 0;
  }

  /** 累计统计。 */
  get stats(): Readonly<DeviceLinkClientStats> {
    return this.statsValue;
  }

  /** 当前生效的遥测出口；传入函数时每次读取。 */
  private telemetry(): ChatdshTelemetry | undefined {
    const source = this.options.telemetry;
    return typeof source === 'function' ? source() : source;
  }

  /** 开始连接与重连。 */
  start(): void {
    this.stopped = false;
    if (this.socket !== undefined || this.reconnectTimer !== undefined) return;
    this.connect();
  }

  /** 停止连接、定时器与全部通道。 */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHandshakeTimer();
    this.clearHeartbeat();
    this.session?.dispose();
    this.session = undefined;
    this.welcomeValue = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && socket.readyState !== 3) socket.close(1000, 'stop');
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('device-link: stopped'));
    }
    this.waiters.clear();
    this.linkSpan?.end();
    this.linkSpan = undefined;
  }

  /** 等待下一次 welcome；已经在线时立即返回。 */
  waitForWelcome(timeoutMs?: number): Promise<DeviceLinkWelcome> {
    if (this.welcomeValue !== undefined) return Promise.resolve(this.welcomeValue);
    const timeout = timeoutMs ?? this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    return new Promise<DeviceLinkWelcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('device-link: welcome timeout'));
      }, timeout);
      timer.unref();
      const waiter: WelcomeWaiter = {
        resolve: (welcome) => {
          clearTimeout(timer);
          resolve(welcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      };
      this.waiters.add(waiter);
    });
  }

  /** 建立一次连接。 */
  private connect(): void {
    if (this.stopped) return;
    const telemetry = this.telemetry();
    const span = telemetry?.startSpan('chatdsh.runtime.device.link', {
      role: this.options.role,
      platform: this.options.platform,
    });
    this.linkSpan = span;
    const url = `${linkOrigin(this.options.controlUrl)}${DEVICE_LINK_PATH}`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.options.token}` } });
    this.socket = socket;
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      this.send({
        type: 'hello',
        version: PROTOCOL_VERSION,
        deviceId: this.options.deviceId,
        platform: this.options.platform,
        role: this.options.role,
        capabilities: this.options.capabilities,
      });
      this.handshakeTimer = setTimeout(() => this.protocolViolation('handshake-timeout'), this.options.handshakeTimeoutMs);
      this.handshakeTimer.unref();
      this.armDeadTimer();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        this.protocolViolation('frame-not-text');
        return;
      }
      this.handleMessage(event.data);
    });

    socket.addEventListener('error', () => {
      this.telemetry()?.event('chatdsh.runtime.device.rejected', {
        outcome: 'rejected',
        'error.type': 'link',
        'error.code': opened ? 'link-error' : 'connect-failed',
      });
    });

    socket.addEventListener('close', (event) => {
      this.onClose(socket, opened, event.code, event.reason);
    });
  }

  /** 处理一帧控制平面消息。 */
  private handleMessage(raw: string): void {
    this.armDeadTimer();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.protocolViolation('frame-invalid');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      this.protocolViolation('frame-invalid');
      return;
    }
    const frame = parsed as ControlFrameV2;
    if (frame.type === 'welcome') {
      this.onWelcome(frame);
      return;
    }
    if (frame.type === 'ping') {
      this.statsValue.pingsReceived += 1;
      this.send({ type: 'pong', generation: frame.generation, nonce: frame.nonce });
      this.statsValue.pongsSent += 1;
      return;
    }
    if (frame.type === 'pong') {
      this.statsValue.pongsReceived += 1;
      return;
    }
    if (this.session === undefined) {
      this.protocolViolation('welcome-required');
      return;
    }
    this.session.handleFrame(frame);
  }

  /** 处理 welcome：校验版本与预算，建立会话与心跳。 */
  private onWelcome(frame: Extract<ControlFrameV2, { type: 'welcome' }>): void {
    if (this.welcomeValue !== undefined) {
      this.protocolViolation('welcome-duplicate');
      return;
    }
    const rejection = welcomeRejection(frame, this.options.deviceId);
    if (rejection !== undefined) {
      this.protocolViolation(rejection);
      return;
    }
    this.clearHandshakeTimer();
    this.welcomeValue = {
      version: frame.version,
      deviceId: frame.deviceId,
      generation: frame.generation,
      limits: frame.limits,
    };
    this.session = new DeviceLinkSession({
      generation: frame.generation,
      limits: frame.limits,
      localOrigin: this.options.localOrigin,
      credentials: this.options.credentials,
      send: (deviceFrame: DeviceFrameV2) => this.send(deviceFrame),
      close: (code: number, reason: string) => this.closeWith(code, reason),
      telemetry: () => this.telemetry(),
      stats: this.statsValue,
      headerTimeoutMs: this.options.headerTimeoutMs as number,
      idleTimeoutMs: this.options.idleTimeoutMs as number,
    });
    this.reconnectDelayMs = RECONNECT_BASE_MS;
    this.startHeartbeat();
    this.linkSpan?.setAttribute('outcome', 'connected');
    this.telemetry()?.counter('chatdsh_runtime_device_links_total', {
      description: '设备长连接生命周期',
    }).add(1, { outcome: 'connected' });
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.resolve(this.welcomeValue);
    }
  }

  /** 连接关闭：收尾会话、写遥测、安排重连。 */
  private onClose(socket: WebSocket, opened: boolean, code: number, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.clearHandshakeTimer();
    this.clearHeartbeat();
    const hadWelcome = this.welcomeValue !== undefined;
    this.session?.dispose();
    this.session = undefined;
    this.welcomeValue = undefined;
    this.linkSpan?.setAttribute('outcome', hadWelcome ? 'closed' : 'failed');
    this.linkSpan?.end();
    this.linkSpan = undefined;
    if (opened) {
      this.telemetry()?.counter('chatdsh_runtime_device_links_total', {
        description: '设备长连接生命周期',
      }).add(1, { outcome: hadWelcome ? 'closed' : 'failed' });
    } else {
      this.telemetry()?.counter('chatdsh_runtime_device_links_total', {
        description: '设备长连接生命周期',
      }).add(1, { outcome: 'failed' });
    }
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.reject(new Error(`device-link: connection closed before welcome (${code} ${reason})`));
    }
    if (this.stopped) return;
    this.telemetry()?.counter('chatdsh_runtime_device_links_total', {
      description: '设备长连接生命周期',
    }).add(1, { outcome: 'reconnect' });
    this.scheduleReconnect();
  }

  /** 按当前退避间隔安排下一次连接，并把间隔翻倍。 */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
    this.reconnectDelayMs = Math.min(delay * 2, this.options.reconnectMaxMs as number);
  }

  /** 启动心跳：按间隔发 ping，按阈值判定失联。 */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const welcome = this.welcomeValue;
      if (welcome === undefined) return;
      this.send({ type: 'ping', generation: welcome.generation, nonce: randomUUID() });
      this.statsValue.pingsSent += 1;
    }, this.options.heartbeatMs as number);
    this.heartbeatTimer.unref();
    this.armDeadTimer();
  }

  /** 重置失联计时。 */
  private armDeadTimer(): void {
    if (this.deadTimer !== undefined) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => {
      this.telemetry()?.event('chatdsh.runtime.device.rejected', {
        outcome: 'rejected',
        'error.type': 'timeout',
        'error.code': 'heartbeat-timeout',
      });
      this.closeWith(4002, 'heartbeat-timeout');
    }, this.options.deadAfterMs as number);
    this.deadTimer.unref();
  }

  /** 清心跳与失联计时。 */
  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.deadTimer !== undefined) clearTimeout(this.deadTimer);
    this.heartbeatTimer = undefined;
    this.deadTimer = undefined;
  }

  /** 清握手计时。 */
  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  /** 协议违规：记一条事件并断开。 */
  private protocolViolation(code: string): void {
    this.telemetry()?.event('chatdsh.runtime.device.rejected', {
      outcome: 'rejected',
      'error.type': 'protocol',
      'error.code': code,
    });
    this.closeWith(4003, code);
  }

  /** 用给定关闭码断开当前连接。 */
  private closeWith(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState === 3) return;
    socket.close(code, reason);
  }

  /** 写一帧。连接不在可写状态时丢弃，重连会重建状态。 */
  private send(frame: DeviceFrameV2): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== 1) return;
    socket.send(JSON.stringify(frame));
  }
}
