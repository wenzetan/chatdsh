/**
 * 连续副本的错误码与错误类型。
 *
 * 每个错误带一个稳定的原因码与对应的 HTTP 状态；上报方按原因码决定重传、请求缺失区间
 * 还是停止。缺口、冲突与保留代次过期都必须能被上报方区分。
 * @module @chatdsh/gateway/replica-continuity/errors
 */

/** 连续副本的原因码。 */
export const REPLICA_ERROR_CODES = {
  /** 节点令牌缺失、无效或已撤销。 */
  unauthorized: 'replica-unauthorized',
  /** 会话归属另一台设备。 */
  ownerMismatch: 'replica-owner-mismatch',
  /** 上报携带的保留代次不是当前代次，已清理的副本不会被自动重建。 */
  retentionStale: 'replica-retention-stale',
  /** 同一序号的内容摘要与已提交内容不同。 */
  contentConflict: 'replica-content-conflict',
  /** 事件序号跳过了未确认的区间。 */
  gap: 'replica-gap',
  /** 请求体的字段不合法，或批内序号不严格递增。 */
  invalidPayload: 'replica-invalid-payload',
} as const;

/** 原因码取值。 */
export type ReplicaErrorCode = (typeof REPLICA_ERROR_CODES)[keyof typeof REPLICA_ERROR_CODES];

/** 连续副本的错误。 */
export class ReplicaContinuityError extends Error {
  constructor(
    /** 稳定原因码。 */
    readonly code: ReplicaErrorCode,
    /** 对应的 HTTP 状态。 */
    readonly status: number,
    message: string,
    /** 结构化细节，随响应一起返回。 */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ReplicaContinuityError';
  }
}
