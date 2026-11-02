/**
 * 资源拒绝的对外形状与携带拒绝的异常。
 *
 * 拒绝对象同时是响应体与遥测属性的来源：错误码、额度、实测值、单位与允许的处理入口都在
 * 这里定死，路由层只负责把它写进响应。
 * @module @chatdsh/core-limits/errors
 */

import {
  RESOURCE_ERROR_CODES,
  limitOf,
  type HandlingEntry,
  type LimitUnit,
  type ResourceErrorCode,
  type ResourceScope,
} from './policy.ts';

/** 一次资源拒绝的完整描述。 */
export interface ResourceRejection {
  /** 拒绝码。 */
  readonly code: ResourceErrorCode;
  /** HTTP 状态码。 */
  readonly status: number;
  /** 资源种类。 */
  readonly scope: ResourceScope;
  /** 单位的名字。 */
  readonly unit: LimitUnit;
  /** 该种类的上限数值。 */
  readonly limit: number;
  /** 实测数值；无法测量时为 0。 */
  readonly observed: number;
  /** 允许的处理入口。 */
  readonly entry: HandlingEntry;
  /** 处理说明。 */
  readonly guidance: string;
}

/**
 * 按种类构造一次拒绝。
 * @param scope - 资源种类。
 * @param observed - 实测数值；单位与该种类一致。
 * @returns 拒绝对象。
 */
export function rejectionOf(scope: ResourceScope, observed: number): ResourceRejection {
  const limit = limitOf(scope);
  return {
    code: limit.rejection.code,
    status: limit.rejection.status,
    scope,
    unit: limit.unit,
    limit: limit.value,
    observed,
    entry: limit.rejection.entry,
    guidance: limit.rejection.guidance,
  };
}

/**
 * 构造一次超过安全资源预算的拒绝。
 * @param scope - 控制平面或客户端的内存额度。
 * @param observed - 预估或实测的内存字节数。
 * @returns 拒绝对象。
 */
export function budgetRejection(scope: 'control-plane-memory' | 'client-memory', observed: number): ResourceRejection {
  return rejectionOf(scope, observed);
}

/** 携带拒绝的资源异常。抛出即表示本次处理不成立，调用方按拒绝写响应。 */
export class ResourceLimitError extends Error {
  /** 拒绝描述。 */
  readonly rejection: ResourceRejection;

  constructor(rejection: ResourceRejection) {
    super(`${rejection.code}：${rejection.scope} 超过 ${String(rejection.limit)} ${rejection.unit}`);
    this.name = 'ResourceLimitError';
    this.rejection = rejection;
  }
}

/** 拒绝是否属于尺寸类。 */
export function isSizeRejection(rejection: ResourceRejection): boolean {
  return rejection.code === RESOURCE_ERROR_CODES.payloadTooLarge;
}
