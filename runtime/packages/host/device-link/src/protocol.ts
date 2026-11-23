/**
 * 设备长连接版本 2 的线协议类型与预算。
 *
 * 控制平面侧的权威定义在 `gateway/src/device-link.ts`；设备端按同一份线协议独立声明，
 * 避免设备插件反向依赖控制平面包。字段名、帧类型与预算取值必须与那一份保持一致。
 * @module @chatdsh/host-device-link/protocol
 */

/** 当前实现的通道协议版本。 */
export const PROTOCOL_VERSION = 2;

/** 设备发送心跳的间隔。 */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** 超过这个时长没有收到任何一帧就判定失联。 */
export const DEFAULT_DEAD_AFTER_MS = 75_000;

/** 建链后等待 welcome 的时长上限。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 等待本地运行时响应头的时长上限。 */
export const DEFAULT_HEADER_TIMEOUT_MS = 30_000;

/** 通道上没有数据流动的时长上限。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 75_000;

/** 单个数据帧里载荷的默认字节上限。 */
export const DEFAULT_DATA_PAYLOAD_MAX_BYTES = 32 * 1024;

/** 每条通道的默认初始单向额度。 */
export const DEFAULT_INITIAL_CREDIT_BYTES = 256 * 1024;

/** 前缀资源路径的长度上限。 */
export const MAX_PATH_LENGTH = 2048;

/** 设备在平台上的角色。 */
export type NodeRole = 'host' | 'executor' | 'both';

/** 通道种类。设备只声明并处理 `http` 与 `websocket`。 */
export type ChannelKind = 'http' | 'events' | 'websocket';

/** 一次连接上的固定预算，由 welcome 下发。 */
export interface LinkLimits {
  readonly maxChannels: number;
  readonly sendBufferBytes: number;
  readonly initialCreditBytes: number;
  readonly dataPayloadMaxBytes: number;
  readonly frameMaxBytes: number;
}

/** 控制平面下发的帧。 */
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

/** 设备回填的帧。 */
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
  }
  | { readonly type: 'end'; readonly channelId: string; readonly generation: number; readonly lastSeq: number }
  | { readonly type: 'credit'; readonly channelId: string; readonly generation: number; readonly bytes: number }
  | { readonly type: 'cancelled'; readonly channelId: string; readonly generation: number; readonly reason: string }
  | { readonly type: 'reset'; readonly channelId: string; readonly generation: number; readonly code: string };

/**
 * 校验控制平面下发的目标路径。
 *
 * 只接受以单个 `/` 开始的相对路径；完整地址、双斜杠、路径穿越与解码后越界全部拒绝。
 * @param path - 目标路径，可带查询串。
 * @returns 拒绝码；路径合法时为空。
 */
export function validateTargetPath(path: string): string | undefined {
  if (!path.startsWith('/')) return 'device-path-not-relative';
  const queryAt = path.indexOf('?');
  const pathOnly = queryAt === -1 ? path : path.slice(0, queryAt);
  if (pathOnly.startsWith('//') || pathOnly.includes('//')) return 'device-path-malformed';
  if (path.includes('\0')) return 'device-path-malformed';
  if (pathOnly.length > MAX_PATH_LENGTH) return 'device-path-too-long';
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
  if (decodedLength > MAX_PATH_LENGTH) return 'device-path-too-long';
  return undefined;
}

/** 从帧头取链路载体；只保留有取值的传播头。 */
export function traceCarrierOf(headers: Readonly<Record<string, string>>): { traceparent?: string; tracestate?: string } {
  const carrier: { traceparent?: string; tracestate?: string } = {};
  if (headers.traceparent !== undefined) carrier.traceparent = headers.traceparent;
  if (headers.tracestate !== undefined) carrier.tracestate = headers.tracestate;
  return carrier;
}
