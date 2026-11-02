/**
 * 控制平面 Postgres 实现的错误码。
 *
 * 每个失败分支有稳定的原因码；驳回类错误带原因码，连接类错误由同步桥统一成
 * `PostgresUnavailableError`。原因码只放枚举值、计数与标识，不放正文。
 * @module @chatdsh/gateway/postgres/errors
 */

/** 控制平面 Postgres 实现的原因码。 */
export const POSTGRES_STORAGE_ERROR_CODES = {
  /** 同一操作标识携带了不同的请求摘要。 */
  operationDigestConflict: 'operation-digest-conflict',
  /** 同一序号的内容摘要与已提交内容不同。 */
  replicaContentConflict: 'replica-content-conflict',
  /** 事件序号跳过未确认区间。 */
  replicaGap: 'replica-gap',
  /** 保留代次不是当前代次。 */
  replicaRetentionStale: 'replica-retention-stale',
  /** 同一会话同一轮次的用量内容不同。 */
  usageConflict: 'usage-conflict',
  /** 导入源在复制期间被打开为可写。 */
  sourceNotReadOnly: 'source-not-readonly',
  /** 导入的摘要核对未通过。 */
  digestMismatch: 'digest-mismatch',
  /** 导入源缺少必需的标识。 */
  sourceInvalid: 'source-invalid',
  /** 目标库出现账号表，导入拒绝继续。 */
  unexpectedAccountTable: 'unexpected-account-table',
} as const;

/** 原因码取值。 */
export type PostgresStorageErrorCode =
  (typeof POSTGRES_STORAGE_ERROR_CODES)[keyof typeof POSTGRES_STORAGE_ERROR_CODES];

/** 控制平面 Postgres 实现的错误。 */
export class PostgresStorageError extends Error {
  /** 稳定原因码。 */
  readonly code: PostgresStorageErrorCode;
  /** 结构化细节。 */
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: PostgresStorageErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = 'PostgresStorageError';
    this.code = code;
    this.details = details;
  }
}
