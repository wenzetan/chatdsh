/**
 * 手机业务通道的接入层：控制平面对外提供与运行时插件一致的配对接口。
 *
 * 上游 Android 与 iOS 客户端的配对模型是「Base64URL 配对载荷 → 带 dsh-pair 子协议连
 * WebSocket → 同一条连接上先收到 paired 帧，再收到 hello 帧」。配对连接必须活到 hello
 * 到达，客户端在手动配对期间不会重连。把同一套接口在控制平面上实现，客户端不需要改任何
 * 协议代码：它只要把配对载荷里的地址指向控制平面即可。控制平面校验配对码、签发自己的
 * 设备令牌、把 paired 帧写给手机，再把连接桥接到运行时的插件，插件发出的 hello 与后续
 * 业务帧原样到达客户端；插件只看得到一个本机回环连接。
 *
 * 握手与帧编解码由 `websocket.ts` 提供，与设备长连接共用。
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
import { rejectUpgrade } from './websocket.ts';

/** 配对只在使用一次性配对码时发生；之后的连接一律用设备令牌。 */
export interface MobileChannelOptions {
  /** 一次性配对码；未配置时配对子协议一律拒绝。 */
  readonly pairingCode: string | undefined;
  /** 运行时插件监听的基地址，手机连接桥接到这里。 */
  readonly runtimeUrl: string;
  readonly store: GatewayStore;
  readonly telemetry: ChatdshTelemetry;
}

/** 升级前的处理结果：要么直接把连接桥接到上游，要么就地拒绝。 */
export interface ChannelDecision {
  /** 桥接目标路径；`undefined` 表示已就地处理、不再桥接。 */
  readonly bridgePath?: string;
  /** 改写的发往上游的请求头；值为 `null` 表示删除该请求头。 */
  readonly headers?: Record<string, string | null>;
  /** 上游升级成功后写给手机的文本帧。 */
  readonly preamble?: string;
  /** 上游拒绝升级时撤销已经写入的配对结果。 */
  readonly rollback?: () => void;
}

/** 插件的手机业务通道路径。 */
const MOBILE_CHANNEL_PATH = '/ws/mobile';

/** 手机客户端与插件共同使用的通道子协议。 */
const MOBILE_PROTOCOL = 'dsh-mobile-v1';

/** 判断升级请求是否走手机业务通道。 */
export function isMobileChannelPath(path: string): boolean {
  return path === MOBILE_CHANNEL_PATH;
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

/**
 * 处理一次手机通道升级。
 *
 * 三条路径：
 * 1. 带一次性配对码：校验配对码，签发设备令牌，桥接到插件，并把 `paired` 帧写给手机；
 *    插件的 `hello` 随后在同一连接上到达客户端，配对完成。
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
    const record = options.store.registerMobileDevice({
      id: randomUUID(),
      name: deviceNameOf(request),
      platform: platformOf(request),
      tokenHash: deviceTokenHash(token),
    });
    options.telemetry.counter('chatdsh_mobile_upgrades_total', { description: '手机 WebSocket 升级次数' })
      .add(1, { outcome: 'paired' });
    return {
      bridgePath: MOBILE_CHANNEL_PATH,
      headers: runtimeHeaders(request),
      preamble: JSON.stringify({
        kind: 'paired',
        token,
        device: { id: record.id, name: record.name },
      }),
      rollback: () => {
        options.store.revokeMobileDevice(record.id);
        options.telemetry.event('chatdsh.gateway.mobile.rejected', {
          action: 'ws-pair',
          outcome: 'rejected',
          'error.type': 'runtime',
          'error.code': 'runtime-upgrade-rejected',
        });
      },
    };
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
  return { bridgePath: MOBILE_CHANNEL_PATH, headers: runtimeHeaders(request) };
}

/**
 * 发往运行时的请求头：手机带来的凭据由控制平面消费，不进运行时。
 *
 * 子协议只保留通道版本，`dsh-pair.<code>` 与 `dsh-auth.<token>` 会被插件当成它自己的
 * 凭据再校验一次，而插件侧的设备鉴权按设计是关闭的。`host` 与 `origin` 由调用方改写。
 */
function runtimeHeaders(request: IncomingMessage): Record<string, string | null> {
  return {
    authorization: null,
    'x-chatdsh-device-token': null,
    'sec-websocket-protocol': channelProtocolsOf(request),
  };
}

/** 子协议里属于通道协商的部分，去掉承载凭据的那些条目。 */
function channelProtocolsOf(request: IncomingMessage): string {
  const offered = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !entry.startsWith('dsh-pair.') && !entry.startsWith('dsh-auth.'));
  return offered.length === 0 ? MOBILE_PROTOCOL : offered.join(', ');
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
