/**
 * Web Push 的发送侧：VAPID 签名、aes128gcm 载荷加密与投递。
 *
 * 协议按 RFC 8292（VAPID）、RFC 8291（消息加密）与 RFC 8188（`aes128gcm` 内容编码）
 * 实现。签名与加密全部用 `node:crypto` 的真实算法完成：VAPID 用 P-256 的 ES256 签名，
 * 载荷用订阅公钥做 ECDH 派生密钥再走 AES-128-GCM。载荷不落明文，订阅密钥不进遥测。
 * @module @chatdsh/gateway/notifications/web-push
 */

import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';

/** 单条记录的长度上限，写在 `aes128gcm` 头部；载荷不超过它时只有一条记录。 */
export const RECORD_SIZE = 4096;

/** 载荷上限：头部、认证标签与填充分隔符之外可用的字节数。 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 1 - 16 - 86;

/** VAPID 令牌的有效期，单位秒；协议上限为 24 小时。 */
export const VAPID_TOKEN_SECONDS = 12 * 3600;

/** 一条推送订阅的密钥材料；与协议交互直接需要的三个字段。 */
export interface PushTarget {
  /** 订阅标识。 */
  readonly id: string;
  /** 推送服务的端点地址。 */
  readonly endpoint: string;
  /** 订阅方的 P-256 公钥，base64url 编码的未压缩点。 */
  readonly p256dh: string;
  /** 订阅方的认证密钥，base64url 编码的 16 字节。 */
  readonly auth: string;
}

/** VAPID 的密钥材料。 */
export interface VapidKeys {
  /** 联系地址，取 `mailto:` 或 `https:` 形式。 */
  readonly subject: string;
  /** 公钥，base64url 编码的未压缩点。 */
  readonly publicKey: string;
  /** 私钥，base64url 编码的 32 字节标量。 */
  readonly privateKey: string;
}

/** 加密的输入覆盖项；用于按公开测试向量核对结果。 */
export interface EncryptOptions {
  /** 固定的 16 字节盐。 */
  readonly salt?: Buffer;
  /** 固定的加密方临时私钥。 */
  readonly ephemeralPrivateKey?: Buffer;
}

/** 一次投递的结果。 */
export interface WebPushOutcome {
  /** 推送服务返回的状态码；网络失败时为 0。 */
  readonly status: number;
  /** 投递结论：`accepted` 为服务受理，`gone` 为订阅失效，`failed` 为失败。 */
  readonly outcome: 'accepted' | 'gone' | 'failed';
  /** 失败原因码；成功时缺省。 */
  readonly code?: string;
}

/** base64url 解码。 */
function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * 把推送服务的状态码映射成结论与原因码。
 * @param status - HTTP 状态码。
 * @returns 结论与原因码。
 */
export function classifyStatus(status: number): { outcome: WebPushOutcome['outcome']; code?: string } {
  if (status === 201 || status === 200 || status === 202) return { outcome: 'accepted' };
  if (status === 404 || status === 410) return { outcome: 'gone', code: CHATDSH_ERROR_CODES.pushEndpointGone };
  if (status === 413) return { outcome: 'failed', code: CHATDSH_ERROR_CODES.payloadTooLarge };
  if (status === 429) return { outcome: 'failed', code: CHATDSH_ERROR_CODES.rateLimited };
  if (status === 401 || status === 403) return { outcome: 'failed', code: CHATDSH_ERROR_CODES.pushPermissionDenied };
  if (status === 405 || status === 501) return { outcome: 'failed', code: CHATDSH_ERROR_CODES.pushUnsupported };
  if (status === 400) return { outcome: 'failed', code: CHATDSH_ERROR_CODES.requestInvalid };
  return { outcome: 'failed', code: CHATDSH_ERROR_CODES.internalError };
}

/**
 * 用订阅公钥加密一条推送载荷。
 *
 * 报文由 `aes128gcm` 头部与密文组成：头部带随机盐、记录长度、密钥标识长度与加密方临时
 * 公钥；密文尾部是 GCM 认证标签。明文尾部追加一个 `0x02` 填充分隔符。
 * @param target - 订阅的密钥材料。
 * @param plaintext - 载荷明文。
 * @param options - 固定盐与临时私钥，用于按公开测试向量核对结果。
 * @returns 可直接作为请求体的字节。
 */
export function encryptPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, plaintext: Buffer, options: EncryptOptions = {}): Buffer {
  if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`推送载荷超过上限：${plaintext.byteLength} > ${MAX_PAYLOAD_BYTES}`);
  }
  const subscriptionPublic = decodeBase64Url(target.p256dh);
  const authSecret = decodeBase64Url(target.auth);
  if (subscriptionPublic.byteLength !== 65 || subscriptionPublic[0] !== 0x04) {
    throw new Error('订阅公钥必须是 65 字节的未压缩 P-256 公钥');
  }
  if (authSecret.byteLength !== 16) {
    throw new Error('订阅认证密钥必须是 16 字节');
  }

  const ephemeral = createECDH('prime256v1');
  if (options.ephemeralPrivateKey === undefined) {
    ephemeral.generateKeys();
  } else {
    ephemeral.setPrivateKey(options.ephemeralPrivateKey);
  }
  const senderPublic = ephemeral.getPublicKey();
  const shared = ephemeral.computeSecret(subscriptionPublic);

  // 输入密钥材料由认证密钥当盐、两端公钥当上下文派生。
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), subscriptionPublic, senderPublic]);
  const inputKey = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const salt = options.salt ?? randomBytes(16);
  const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + senderPublic.byteLength);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.byteLength, 20);
  senderPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext]);
}

/**
 * 构造 VAPID 授权头。
 *
 * 令牌是 ES256 签名的 JWT，`aud` 取端点来源，签名用 IEEE P1363 的 `r||s` 排列，协议要求
 * 这种排列。公钥随 `k` 参数一起下发，推送服务据此验签。
 * @param endpoint - 推送服务端点。
 * @param keys - VAPID 密钥材料。
 * @param now - 当前时刻的毫秒时间戳。
 * @returns 授权头的取值。
 */
export function vapidHeader(endpoint: string, keys: VapidKeys, now: number): string {
  const audience = new URL(endpoint).origin;
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8').toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + VAPID_TOKEN_SECONDS,
    sub: keys.subject,
  }), 'utf8').toString('base64url');
  const privateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: decodeBase64Url(keys.publicKey).subarray(1, 33).toString('base64url'),
      y: decodeBase64Url(keys.publicKey).subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/** 投递参数。 */
export interface SendOptions {
  /** 目标订阅。 */
  readonly target: PushTarget;
  /** 载荷明文；按 UTF-8 编码。 */
  readonly payload: string;
  /** VAPID 密钥材料。 */
  readonly vapid: VapidKeys;
  /** 推送服务保留时长，单位秒。 */
  readonly ttlSeconds: number;
  /** 请求超时，单位毫秒。 */
  readonly timeoutMs: number;
  /** 当前时刻的毫秒时间戳，用于签名有效期。 */
  readonly now?: number;
  /** 发送实现；缺省用全局 `fetch`。 */
  readonly send?: typeof fetch;
}

/**
 * 向推送服务投递一条通知。
 *
 * 网络失败按失败结论返回并给出内部错误码，调用方据此计数；订阅失效由推送服务用 404 或
 * 410 明示，调用方据此把订阅标记为失效。
 * @param options - 目标、载荷、VAPID 与超时。
 * @returns 投递结论与状态码。
 */
export async function sendWebPush(options: SendOptions): Promise<WebPushOutcome> {
  const body = encryptPayload(options.target, Buffer.from(options.payload, 'utf8'));
  const send = options.send ?? fetch;
  const auth = vapidHeader(options.target.endpoint, options.vapid, options.now ?? Date.now());
  const headers: Record<string, string> = {
    'authorization': auth,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds),
    Urgency: 'normal',
  };
  const response = await send(options.target.endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  await response.body?.cancel();
  const classified = classifyStatus(response.status);
  return { status: response.status, ...classified };
}
