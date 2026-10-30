/**
 * 额度守卫。
 *
 * 一次模型请求发出之前先在这里判断是否还有额度。守卫持有本地读数：控制平面的账本是唯一
 * 权威，守卫只把上一次成功请求带回的用量累加在本地，用于在下一轮请求之前提前拒绝。
 * 单账号形态下额度只有一份读数，不分账号：账本键是固定常量。
 * 拒绝使用 {@link LlmQuotaError}，它同时带 DSH 的 `QUOTA` 码与控制平面的
 * `quota-exceeded` 码，调用方按 `code` 分支，不解析消息文本。
 * @module @chatdsh/host-llm-router/quota
 */

import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import { QUOTA_EXCEEDED_CODE } from '@chatdsh/adapter';

/** 额度配置。 */
export interface QuotaLimit {
  /** 额度上限，取 token 数；缺省表示不限制。 */
  readonly limit?: number;
  /** 启动时的已用额度。 */
  readonly used?: number;
}

/** 额度读数。 */
export interface QuotaReading {
  /** 是否允许发起请求。 */
  readonly allowed: boolean;
  /** 上限；不限制时缺省。 */
  readonly limit?: number;
  /** 已用额度。 */
  readonly used: number;
  /** 剩余额度；不限制时缺省。 */
  readonly remaining?: number;
}

/** 额度拒绝。`code` 取上游的 `QUOTA`，`chatdshCode` 取控制平面的错误码。 */
export class LlmQuotaError extends Error {
  /** 上游可路由的失败码，取值为 `QUOTA`。 */
  readonly code = QUOTA_EXCEEDED_CODE;

  /** 控制平面的跨组件错误码。 */
  readonly chatdshCode = CHATDSH_ERROR_CODES.quotaExceeded;

  /** 拒绝时的额度读数。 */
  readonly reading: QuotaReading;

  constructor(input: { limit: number; used: number }) {
    super(`模型额度已用尽：${input.used}/${input.limit}`);
    this.name = 'LlmQuotaError';
    this.reading = { allowed: false, limit: input.limit, used: input.used, remaining: 0 };
  }
}

/** 额度守卫。 */
export interface QuotaGuard {
  /** 判断能否发起请求；不能时抛 {@link LlmQuotaError}。 */
  check(): QuotaReading;
  /** 记录一次实际用量。 */
  record(tokens: number): void;
}

/**
 * 建立一个额度守卫。
 * @param limit - 额度配置。
 * @returns 守卫。
 */
export function createQuotaGuard(limit: QuotaLimit): QuotaGuard {
  let used = 0;
  const readingOf = (): QuotaReading => {
    const total = (limit.used ?? 0) + used;
    if (limit.limit === undefined) return { allowed: true, used: total };
    return {
      allowed: total < limit.limit,
      limit: limit.limit,
      used: total,
      remaining: Math.max(0, limit.limit - total),
    };
  };
  return {
    check(): QuotaReading {
      const reading = readingOf();
      if (!reading.allowed) {
        throw new LlmQuotaError({ limit: reading.limit as number, used: reading.used });
      }
      return reading;
    },
    record(tokens: number): void {
      if (!Number.isInteger(tokens) || tokens < 0) throw new Error(`额度用量必须是非负整数：${tokens}`);
      used += tokens;
    },
  };
}
