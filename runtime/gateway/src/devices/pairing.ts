/**
 * 配对码的签发、一次性消费与尝试限流。
 *
 * 配对码是控制平面发放给待配对设备的短期凭据。配对码有有效期，成功使用时立即作废，
 * 同一个来源地址连续输错达到上限后进入等待期，等待期内的正确配对码同样拒绝。配对码只以
 * 摘要形式保存，明文只出现在签发响应里。
 * @module @chatdsh/gateway/devices/pairing
 */

import { createHash, randomInt } from 'node:crypto';

/** 配对码默认有效期，单位毫秒。 */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

/** 同一来源地址允许的失败尝试上限。 */
export const PAIRING_ATTEMPT_LIMIT = 5;

/** 失败尝试达到上限后的等待时长，单位毫秒。 */
export const PAIRING_LOCKOUT_MS = 60_000;

/** 配对码的字符数。 */
export const PAIRING_CODE_LENGTH = 16;

/** 同时在册的配对码上限。 */
export const PAIRING_CODE_LIMIT = 256;

/** 记录失败尝试的来源地址上限。 */
export const PAIRING_SOURCE_LIMIT = 1024;

/** 已过期或已用过的配对码再保留多久，让再次提交得到 `pairing-code-expired`。 */
export const PAIRING_REMEMBER_MS = 60 * 60_000;

/** 每个可见分组的字符数。 */
const GROUP_LENGTH = 4;

/** 去掉容易看错的 0、O、1、I。 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 配对码的展示形式。 */
export type PairingKind = 'qr' | 'manual';

/** 配对失败的稳定错误码。 */
export type PairingRejectionCode =
  | 'pairing-code-invalid'
  | 'pairing-code-expired'
  | 'pairing-rate-limited';

/** 签发出来的配对码。明文 `code` 只交给签发响应。 */
export interface IssuedPairingCode {
  readonly kind: PairingKind;
  readonly controlUrl: string;
  readonly code: string;
  readonly expiresAt: number;
}

/** 一条在册的配对记录；`code` 不保存明文，按摘要索引。 */
interface PairingEntry {
  readonly controlUrl: string;
  readonly kind: PairingKind;
  readonly expiresAt: number;
  consumedAt: number | undefined;
}

/** 一个来源地址的失败计数与等待截止时刻。 */
interface AttemptState {
  failures: number;
  lockedUntil: number;
}

/** 一次消费的结果。 */
export type PairingConsumeResult =
  | {
    readonly ok: true;
    readonly controlUrl: string;
    readonly kind: PairingKind;
    readonly expiresAt: number;
  }
  | {
    readonly ok: false;
    readonly code: PairingRejectionCode;
    /** 限流时的剩余等待时长，单位毫秒。 */
    readonly retryAfterMs?: number;
  };

/** 配对服务的构造选项。 */
export interface PairingServiceOptions {
  /** 有效期，缺省 {@link PAIRING_CODE_TTL_MS}。 */
  readonly ttlMs?: number;
  /** 失败尝试上限，缺省 {@link PAIRING_ATTEMPT_LIMIT}。 */
  readonly attemptLimit?: number;
  /** 等待时长，缺省 {@link PAIRING_LOCKOUT_MS}。 */
  readonly lockoutMs?: number;
}

/** 把来源地址收敛成限流键。 */
export function pairingSourceOf(request: { readonly socket?: { readonly remoteAddress?: string } }): string {
  return request.socket?.remoteAddress ?? 'unknown';
}

/** 把用户输入收敛成比较用的写法。 */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 配对码按摘要索引与存储，明文不留在服务端状态里。 */
function digestOf(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** 生成一段配对码，按四位一组书写，便于手填。 */
function generateCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < PAIRING_CODE_LENGTH / GROUP_LENGTH; group += 1) {
    let text = '';
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      text += ALPHABET.charAt(randomInt(ALPHABET.length));
    }
    groups.push(text);
  }
  return groups.join('-');
}

/**
 * 配对码登记。
 *
 * 签发、消费、限流都在同一个实例里完成，路由与手机通道共用同一个实例即可得到一致的
 * 一次性语义。实例不启动定时器：过期的配对码在每次签发与消费时清理。
 */
export class PairingService {
  private readonly ttlMs: number;
  private readonly attemptLimit: number;
  private readonly lockoutMs: number;
  private readonly entries = new Map<string, PairingEntry>();
  private readonly attempts = new Map<string, AttemptState>();

  constructor(options: PairingServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
    this.attemptLimit = options.attemptLimit ?? PAIRING_ATTEMPT_LIMIT;
    this.lockoutMs = options.lockoutMs ?? PAIRING_LOCKOUT_MS;
    if (this.attemptLimit < 1) throw new Error('配对失败尝试上限必须大于 0');
    if (this.lockoutMs < 1) throw new Error('配对等待时长必须大于 0');
  }

  /** 签发一枚配对码。 */
  issue(input: { readonly controlUrl: string; readonly kind?: PairingKind; readonly ttlMs?: number }): IssuedPairingCode {
    const now = Date.now();
    this.prune(now);
    const code = generateCode();
    const expiresAt = now + (input.ttlMs ?? this.ttlMs);
    this.entries.set(digestOf(normalizePairingCode(code)), {
      controlUrl: input.controlUrl,
      kind: input.kind ?? 'manual',
      expiresAt,
      consumedAt: undefined,
    });
    this.enforceEntryLimit();
    return { kind: input.kind ?? 'manual', controlUrl: input.controlUrl, code, expiresAt };
  }

  /**
   * 把一枚外部配置的固定配对码登记进本实例。
   *
   * 手机通道仍支持由环境变量配置的配对码，登记之后它同样一次使用、到期失效。
   * @param code - 固定配对码明文。
   * @param input - 控制平面地址与有效期。
   */
  adopt(code: string, input: { readonly controlUrl: string; readonly ttlMs?: number }): void {
    const now = Date.now();
    this.prune(now);
    this.entries.set(digestOf(normalizePairingCode(code)), {
      controlUrl: input.controlUrl,
      kind: 'manual',
      expiresAt: now + (input.ttlMs ?? this.ttlMs),
      consumedAt: undefined,
    });
    this.enforceEntryLimit();
  }

  /**
   * 消费一枚配对码。
   *
   * 校验顺序固定为：来源地址等待期、配对码是否在册、是否已用或过期。成功即作废；输错
   * 累计到上限后进入等待期。过期或已用过的配对码不再累计失败次数。
   * @param code - 客户端提交的配对码，允许带空格与连字符。
   * @param source - 来源地址，用于失败尝试限流。
   */
  consume(code: string, source: string): PairingConsumeResult {
    const now = Date.now();
    this.prune(now);
    const wait = this.lockedFor(source, now);
    if (wait > 0) return { ok: false, code: 'pairing-rate-limited', retryAfterMs: wait };
    const normalized = normalizePairingCode(code);
    if (normalized.length !== PAIRING_CODE_LENGTH) {
      this.recordFailure(source, now);
      return { ok: false, code: 'pairing-code-invalid' };
    }
    const entry = this.entries.get(digestOf(normalized));
    if (entry === undefined) {
      this.recordFailure(source, now);
      return { ok: false, code: 'pairing-code-invalid' };
    }
    if (entry.consumedAt !== undefined || entry.expiresAt <= now) {
      return { ok: false, code: 'pairing-code-expired' };
    }
    entry.consumedAt = now;
    this.clearFailures(source);
    return { ok: true, controlUrl: entry.controlUrl, kind: entry.kind, expiresAt: entry.expiresAt };
  }

  /** 在册且未消费、未过期的配对码数量。 */
  pendingCount(): number {
    const now = Date.now();
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.consumedAt === undefined && entry.expiresAt > now) pending += 1;
    }
    return pending;
  }

  /** 清理过期记录，供诊断与测试观察内存占用。 */
  prune(now = Date.now()): void {
    for (const [digest, entry] of this.entries) {
      if (entry.expiresAt + PAIRING_REMEMBER_MS <= now) this.entries.delete(digest);
    }
    for (const [source, state] of this.attempts) {
      if (state.lockedUntil !== 0 && state.lockedUntil <= now) this.attempts.delete(source);
    }
  }

  /** 等待期剩余时长；等待结束后清掉该来源的记录。 */
  private lockedFor(source: string, now: number): number {
    const state = this.attempts.get(source);
    if (state === undefined || state.lockedUntil === 0) return 0;
    if (state.lockedUntil > now) return state.lockedUntil - now;
    this.attempts.delete(source);
    return 0;
  }

  /** 记一次失败尝试；达到上限时进入等待期。 */
  private recordFailure(source: string, now: number): void {
    const state = this.attempts.get(source) ?? { failures: 0, lockedUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.attemptLimit) state.lockedUntil = now + this.lockoutMs;
    this.attempts.delete(source);
    this.attempts.set(source, state);
    while (this.attempts.size > PAIRING_SOURCE_LIMIT) {
      const oldest = this.attempts.keys().next();
      if (oldest.done === true) return;
      this.attempts.delete(oldest.value);
    }
  }

  /** 成功使用后清掉该来源的失败计数。 */
  private clearFailures(source: string): void {
    this.attempts.delete(source);
  }

  /** 在册条数超出上限时挤掉最早到期的一条。 */
  private enforceEntryLimit(): void {
    while (this.entries.size > PAIRING_CODE_LIMIT) {
      let oldestDigest: string | undefined;
      let oldestExpiry = Infinity;
      for (const [digest, entry] of this.entries) {
        if (entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt;
          oldestDigest = digest;
        }
      }
      if (oldestDigest === undefined) return;
      this.entries.delete(oldestDigest);
    }
  }
}
