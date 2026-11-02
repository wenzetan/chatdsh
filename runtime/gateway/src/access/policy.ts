/**
 * 通行密钥（WebAuthn）断言校验。
 *
 * 工作区没有 WebAuthn 服务库（`@simplewebauthn/server` 不在 `node_modules` 与 `.dsh-deps` 里），
 * 断言里的 CBOR 解码、COSE 公钥校验与签名验证统一由 `PasskeyAssertionVerifier` 端口提供，由
 * WP39 在接入成熟库时实现；本模块不手写任何证书或 CBOR 解析。
 *
 * 模块自己承担的部分：挑战一次性登记与过期、挑战必须由同一 RP ID 与同一精确 origin 签发、
 * 凭据必须已登记、签名计数器必须单调递增（回退按克隆处理）、公钥以信封加密保存。
 * @module @chatdsh/gateway/access/webauthn
 */

import { randomBytes } from 'node:crypto';
import { ChatdshError } from '@chatdsh/core-contracts';
import { openAccessSecret, parseAccessEnvelope, sealAccessSecret } from './keys.ts';
import type { AccessStore } from './store.ts';

/** 挑战的有效期，单位毫秒。 */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** 依赖方信息：RP ID 与部署的精确 origin。 */
export interface WebAuthnRelyingParty {
  /** RP ID，必须是主机名。 */
  readonly rpId: string;
  /** 精确 origin，例如 `https://chatdsh.example`。 */
  readonly origin: string;
}

/** 客户端提交的断言原始字段，全部为 base64url 写法。 */
export interface PasskeyAssertion {
  readonly credentialId: string;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
}

/** 断言校验结果。 */
export type PasskeyVerifyResult =
  | { readonly verified: true; readonly newSignCount: number }
  | { readonly verified: false };

/**
 * 成熟 WebAuthn 库的端口。实现必须完成 challenge 比对、origin 与 RP ID 校验、签名校验与
 * 用户验证标记检查，任一项不满足都返回 `verified: false`。
 */
export interface PasskeyAssertionVerifier {
  verify(input: {
    readonly rpId: string;
    readonly origin: string;
    readonly expectedChallenge: string;
    readonly assertion: PasskeyAssertion;
    readonly publicKey: string;
  }): Promise<PasskeyVerifyResult>;
}

/**
 * 校验 RP ID 与 origin 的组合关系：RP ID 必须是主机名，origin 的主机必须等于 RP ID 或是它的子域。
 * @param relyingParty - 依赖方信息。
 * @returns 规范化后的依赖方信息。
 */
export function validateRelyingParty(relyingParty: WebAuthnRelyingParty): WebAuthnRelyingParty {
  if (!/^[a-z0-9.-]+$/i.test(relyingParty.rpId) || relyingParty.rpId.includes('..')) {
    throw new Error(`WebAuthn 的 RP ID 必须是主机名：${relyingParty.rpId}`);
  }
  const url = new URL(relyingParty.origin);
  if (url.origin !== relyingParty.origin || url.username !== '' || url.password !== '') {
    throw new Error('WebAuthn 的 origin 必须是精确来源');
  }
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
    throw new Error('WebAuthn 只允许 HTTPS 来源或回环地址');
  }
  const host = url.hostname;
  if (host !== relyingParty.rpId && !host.endsWith(`.${relyingParty.rpId}`)) {
    throw new Error(`WebAuthn 的 origin 主机与 RP ID 不匹配：${host} 与 ${relyingParty.rpId}`);
  }
  return { rpId: relyingParty.rpId, origin: url.origin };
}

/**
 * 签发一张挑战。值为 256 位随机数，登记在库里，消费一次即失效。
 * @param store - 访问层存储。
 * @param relyingParty - 依赖方信息。
 * @param now - 当前时刻，单位毫秒。
 * @returns 挑战值与到期时刻。
 */
export function createPasskeyChallenge(
  store: AccessStore,
  relyingParty: WebAuthnRelyingParty,
  now: number
): { readonly challengeId: string; readonly expiresAt: number } {
  const challengeId = randomBytes(32).toString('base64url');
  const expiresAt = now + WEBAUTHN_CHALLENGE_TTL_MS;
  store.insertChallenge({ challengeId, origin: relyingParty.origin, rpId: relyingParty.rpId, createdAt: now, expiresAt });
  return { challengeId, expiresAt };
}

/** 校验断言所需的全部输入。 */
export interface PasskeyAssertionRequest {
  readonly store: AccessStore;
  /** 信封子密钥，用于解开已登记的公钥。 */
  readonly key: Buffer;
  readonly verifier: PasskeyAssertionVerifier;
  readonly relyingParty: WebAuthnRelyingParty;
  readonly assertion: PasskeyAssertion;
  /** 服务端签发的挑战标识。 */
  readonly challengeId: string;
  readonly now: number;
}

/**
 * 校验一次通行密钥断言。任何一项不满足都抛出 `passkey-rejected`。
 * @param request - 校验输入。
 */
export async function verifyPasskeyAssertion(request: PasskeyAssertionRequest): Promise<void> {
  const challenge = request.store.consumeChallenge(request.challengeId, request.now);
  if (challenge === undefined) throw new ChatdshError('passkey-rejected', '挑战不存在、已消费或已过期');
  if (challenge.origin !== request.relyingParty.origin || challenge.rpId !== request.relyingParty.rpId) {
    throw new ChatdshError('passkey-rejected', '挑战与当前来源不匹配');
  }
  const passkey = request.store.passkeyByCredentialId(request.assertion.credentialId);
  if (passkey === undefined) throw new ChatdshError('passkey-rejected', '凭据未登记');
  const publicKey = openAccessSecret(request.key, parseAccessEnvelope(passkey.sealedPublicKey), 'passkey').toString('utf8');
  const result = await request.verifier.verify({
    rpId: request.relyingParty.rpId,
    origin: request.relyingParty.origin,
    expectedChallenge: challenge.challengeId,
    assertion: request.assertion,
    publicKey,
  });
  if (!result.verified) throw new ChatdshError('passkey-rejected', '断言签名校验未通过');
  if (passkey.signCount > 0 && result.newSignCount <= passkey.signCount) {
    throw new ChatdshError('passkey-rejected', '签名计数器未递增，按克隆凭据拒绝');
  }
  request.store.touchPasskey(passkey.credentialId, result.newSignCount, request.now);
}

/**
 * 登记一条已通过注册校验的通行密钥。
 * @param store - 访问层存储。
 * @param key - 信封子密钥。
 * @param input - 凭据标识、公开密钥与初始计数器。
 * @param now - 当前时刻，单位毫秒。
 */
export function registerPasskey(
  store: AccessStore,
  key: Buffer,
  input: { readonly credentialId: string; readonly publicKey: string; readonly signCount: number },
  now: number
): void {
  if (input.credentialId.length === 0) throw new Error('通行密钥的凭据标识不能为空');
  if (input.publicKey.length === 0) throw new Error('通行密钥的公开密钥不能为空');
  if (!Number.isInteger(input.signCount) || input.signCount < 0) throw new Error('通行密钥的签名计数器不合法');
  store.insertPasskey({
    credentialId: input.credentialId,
    sealedPublicKey: JSON.stringify(sealAccessSecret(key, Buffer.from(input.publicKey, 'utf8'), 'passkey')),
    signCount: input.signCount,
    createdAt: now,
    lastUsedAt: now,
  });
}

/**
 * 是否已登记至少一条通行密钥。
 * @param store - 访问层存储。
 * @returns 已登记为 `true`。
 */
export function passkeyRegistered(store: AccessStore): boolean {
  return store.passkeys().length > 0;
}

/** 移除全部通行密钥。 */
export function removePasskeys(store: AccessStore): void {
  for (const passkey of store.passkeys()) store.deletePasskey(passkey.credentialId);
}
