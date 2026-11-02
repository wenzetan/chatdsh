/**
 * 访问尝试的限流与失败锁定。
 *
 * 两个维度同时生效：来源维度限制单个网络地址的尝试速率与失败次数，部署维度限制整台部署的
 * 总量，避免换地址绕过。失败次数达到阈值后开始等待，初始 5 分钟，此后逐次翻倍，最长 1 小时。
 * 一次成功认证把两个维度的失败计数一起清零。
 * @module @chatdsh/gateway/access/limit
 */

import { createHash } from 'node:crypto';
import { ACCESS_SECURITY } from '@chatdsh/core-contracts';
import type { AccessStore } from './store.ts';

/** 限流与锁定的参数。 */
export interface AccessLimitOptions {
  /** 速率窗口长度，单位毫秒。 */
  readonly windowMs: number;
  /** 单个来源在每个窗口里允许的尝试次数。 */
  readonly sourceLimit: number;
  /** 整台部署在每个窗口里允许的尝试次数。 */
  readonly deploymentLimit: number;
  /** 开始锁定的失败次数。 */
  readonly lockoutThreshold: number;
  /** 锁定的初始长度，单位毫秒。 */
  readonly lockoutBaseMs: number;
  /** 锁定的最长长度，单位毫秒。 */
  readonly lockoutMaxMs: number;
}

/** 默认参数：来源每分钟 10 次、部署每分钟 30 次，累计 5 次失败进入等待。 */
export const DEFAULT_ACCESS_LIMITS: AccessLimitOptions = {
  windowMs: 60_000,
  sourceLimit: 10,
  deploymentLimit: 30,
  lockoutThreshold: ACCESS_SECURITY.lockoutThreshold,
  lockoutBaseMs: ACCESS_SECURITY.lockoutBaseMs,
  lockoutMaxMs: ACCESS_SECURITY.lockoutMaxMs,
};

/** 一次尝试的判定结果。 */
export type AccessLimitDecision =
  | { readonly allowed: true; readonly attemptsLeft: number }
  | { readonly allowed: false; readonly code: 'auth-rate-limited'; readonly attemptsLeft: number }
  | { readonly allowed: false; readonly code: 'auth-locked'; readonly attemptsLeft: 0; readonly lockedUntil: number };

/** 访问限流器。 */
export interface AccessLimiter {
  /** 在尝试校验凭据之前调用：速率超限或处于锁定期时拒绝。 */
  guard(source: string, now: number): AccessLimitDecision;
  /** 凭据校验失败后调用，返回累计失败与新的锁定时刻。 */
  fail(source: string, now: number): { readonly attemptsLeft: number; readonly lockedUntil?: number };
  /** 认证成功后调用：清零两个维度的失败计数与本窗口计数。 */
  succeed(source: string, now: number): void;
  /** 当前的锁定结束时刻；不在锁定期时为 `undefined`。 */
  lockedUntil(source: string, now: number): number | undefined;
}

/** 部署维度的固定桶名。 */
const DEPLOYMENT_BUCKET = 'deployment';

/**
 * 建立限流器。
 * @param store - 访问层存储。
 * @param options - 限流参数。
 * @returns 限流器。
 */
export function createAccessLimiter(store: AccessStore, options: AccessLimitOptions = DEFAULT_ACCESS_LIMITS): AccessLimiter {
  if (options.windowMs <= 0 || options.sourceLimit <= 0 || options.deploymentLimit <= 0) throw new Error('限流参数必须为正数');
  if (options.lockoutThreshold <= 0 || options.lockoutBaseMs <= 0 || options.lockoutMaxMs < options.lockoutBaseMs) {
    throw new Error('锁定参数不合法');
  }

  const bucketsOf = (source: string): [string, string] => [sourceBucket(source), DEPLOYMENT_BUCKET];

  const attemptsLeftOf = (source: string): number => {
    let failures = 0;
    for (const bucket of bucketsOf(source)) failures = Math.max(failures, store.failure(bucket)?.failures ?? 0);
    return Math.max(0, options.lockoutThreshold - failures);
  };

  return {
    guard(source: string, now: number): AccessLimitDecision {
      let lockedUntil = 0;
      for (const bucket of bucketsOf(source)) {
        const failure = store.failure(bucket);
        if (failure !== undefined && failure.lockedUntil > now) lockedUntil = Math.max(lockedUntil, failure.lockedUntil);
      }
      if (lockedUntil > now) return { allowed: false, code: 'auth-locked', attemptsLeft: 0, lockedUntil };
      const windowStart = Math.floor(now / options.windowMs);
      const sourceHits = store.bumpRate(sourceBucket(source), windowStart, now);
      const deploymentHits = store.bumpRate(DEPLOYMENT_BUCKET, windowStart, now);
      if (sourceHits > options.sourceLimit || deploymentHits > options.deploymentLimit) {
        return { allowed: false, code: 'auth-rate-limited', attemptsLeft: attemptsLeftOf(source) };
      }
      return { allowed: true, attemptsLeft: attemptsLeftOf(source) };
    },

    fail(source: string, now: number): { readonly attemptsLeft: number; readonly lockedUntil?: number } {
      let failures = 0;
      let lockedUntil = 0;
      for (const bucket of bucketsOf(source)) {
        const current = store.failure(bucket)?.failures ?? 0;
        const next = current + 1;
        const wait = next >= options.lockoutThreshold
          ? Math.min(options.lockoutBaseMs * 2 ** (next - options.lockoutThreshold), options.lockoutMaxMs)
          : 0;
        const until = wait > 0 ? now + wait : 0;
        store.writeFailure(bucket, next, until, now);
        failures = Math.max(failures, next);
        lockedUntil = Math.max(lockedUntil, until);
      }
      return lockedUntil > now
        ? { attemptsLeft: 0, lockedUntil }
        : { attemptsLeft: Math.max(0, options.lockoutThreshold - failures) };
    },

    succeed(source: string, now: number): void {
      const windowStart = Math.floor(now / options.windowMs);
      for (const bucket of bucketsOf(source)) {
        store.clearFailure(bucket);
        store.clearRate(bucket, windowStart);
      }
    },

    lockedUntil(source: string, now: number): number | undefined {
      let lockedUntil = 0;
      for (const bucket of bucketsOf(source)) {
        const failure = store.failure(bucket);
        if (failure !== undefined && failure.lockedUntil > now) lockedUntil = Math.max(lockedUntil, failure.lockedUntil);
      }
      return lockedUntil > now ? lockedUntil : undefined;
    },
  };
}

/** 来源桶名：只保存来源摘要，原地址不落库。 */
function sourceBucket(source: string): string {
  const digest = createHash('sha256').update(source, 'utf8').digest('hex');
  return `source:${digest.slice(0, 32)}`;
}
