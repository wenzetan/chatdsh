/**
 * 分配之前的额度判定。
 *
 * 守卫只比较数值，不读内容、不申请缓冲。流式读取用 {@link CountedBytes} 逐块累计：累计值
 * 超过上限立即判定失败，调用方在拼接之前停止，因此内存占用不会越过额度。
 * @module @chatdsh/core-limits/guard
 */

import { rejectionOf, type ResourceRejection } from './errors.ts';
import { limitOf, type LimitUnit, type ResourceScope } from './policy.ts';

/** 判定结果。 */
export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ResourceRejection };

/** 通过。 */
export const GUARD_OK: GuardVerdict = Object.freeze({ ok: true });

/** 核对额度单位，防止把毫秒当字节判定。 */
function assertUnit(scope: ResourceScope, unit: LimitUnit): void {
  const limit = limitOf(scope);
  if (limit.unit !== unit) throw new Error(`${scope} 的单位是 ${limit.unit}，不能按 ${unit} 判定`);
}

/**
 * 按字节数判定。
 * @param scope - 资源种类；单位必须是字节。
 * @param observed - 实测或声明的字节数。
 * @returns 判定结果。
 */
export function guardBytes(scope: ResourceScope, observed: number): GuardVerdict {
  assertUnit(scope, 'bytes');
  const limit = limitOf(scope);
  if (!Number.isFinite(observed) || observed < 0) {
    throw new Error(`字节数必须是非负有限数：${scope}=${String(observed)}`);
  }
  return observed > limit.value ? { ok: false, rejection: rejectionOf(scope, observed) } : GUARD_OK;
}

/**
 * 按数量判定。
 * @param scope - 资源种类；单位必须是个。
 * @param observed - 实测数量。
 * @returns 判定结果。
 */
export function guardCount(scope: ResourceScope, observed: number): GuardVerdict {
  assertUnit(scope, 'items');
  const limit = limitOf(scope);
  if (!Number.isInteger(observed) || observed < 0) {
    throw new Error(`数量必须是非负整数：${scope}=${String(observed)}`);
  }
  return observed > limit.value ? { ok: false, rejection: rejectionOf(scope, observed) } : GUARD_OK;
}

/**
 * 按时长判定。
 * @param scope - 资源种类；单位必须是毫秒。
 * @param observed - 实测毫秒数。
 * @returns 判定结果。
 */
export function guardMilliseconds(scope: ResourceScope, observed: number): GuardVerdict {
  assertUnit(scope, 'milliseconds');
  const limit = limitOf(scope);
  if (!Number.isFinite(observed) || observed < 0) {
    throw new Error(`时长必须是非负有限数：${scope}=${String(observed)}`);
  }
  return observed > limit.value ? { ok: false, rejection: rejectionOf(scope, observed) } : GUARD_OK;
}

/**
 * 按声明长度判定。读请求体之前先看 `content-length`，超过额度直接拒绝，不进入读取循环。
 * @param scope - 资源种类。
 * @param declared - 声明的字节数；没有声明时为 `undefined`。
 * @returns 判定结果。
 */
export function guardDeclaredLength(scope: ResourceScope, declared: number | undefined): GuardVerdict {
  if (declared === undefined) return GUARD_OK;
  return guardBytes(scope, declared);
}

/**
 * 流式累计器。只累计数值，不保存内容。
 */
export class CountedBytes {
  private total = 0;
  private exceeded = false;

  constructor(private readonly scope: ResourceScope) {
    assertUnit(scope, 'bytes');
  }

  /** 已累计的字节数。 */
  get bytes(): number {
    return this.total;
  }

  /** 是否已经越过上限。越界之后不再累计，避免无界增长。 */
  get overLimit(): boolean {
    return this.exceeded;
  }

  /** 该种类的上限。 */
  get limit(): number {
    return limitOf(this.scope).value;
  }

  /**
   * 累计一块的长度。
   * @param bytes - 这一块的字节数。
   * @returns 累计后是否仍在额度内。
   */
  accept(bytes: number): boolean {
    if (this.exceeded) return false;
    this.total += bytes;
    if (this.total > this.limit) {
      this.exceeded = true;
      return false;
    }
    return true;
  }

  /**
   * 取判定结果。越界时实测值取上限加一，表示实际超过而不是虚报总量。
   * @returns 判定结果。
   */
  verdict(): GuardVerdict {
    if (this.exceeded) return { ok: false, rejection: rejectionOf(this.scope, this.limit + 1) };
    return GUARD_OK;
  }
}

/** 期限对象。 */
export interface Deadline {
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 到期时刻的毫秒时间戳。 */
  readonly expiresAt: number;
  /** 剩余毫秒数；已到期为 0。 */
  remaining(now?: number): number;
  /** 是否已经到期。 */
  expired(now?: number): boolean;
  /** 到期时的拒绝描述。 */
  rejection(): ResourceRejection;
}

const DEADLINE_SCOPES = new Set<ResourceScope>([
  'read-timeout',
  'write-accept-timeout',
  'stream-idle-timeout',
  'cancel-timeout',
]);

/**
 * 建立一个期限。
 * @param scope - 期限种类。
 * @param now - 起始时刻；缺省取当前时间。
 * @returns 期限对象。
 */
export function createDeadline(scope: ResourceScope, now: number = Date.now()): Deadline {
  if (!DEADLINE_SCOPES.has(scope)) throw new Error(`不是期限种类：${scope}`);
  const limit = limitOf(scope);
  const startedAt = now;
  const expiresAt = startedAt + limit.value;
  return {
    startedAt,
    expiresAt,
    remaining(at: number = Date.now()): number {
      return Math.max(0, expiresAt - at);
    },
    expired(at: number = Date.now()): boolean {
      return at >= expiresAt;
    },
    rejection(): ResourceRejection {
      return rejectionOf(scope, limit.value);
    },
  };
}
