/**
 * 存储与迁移错误。
 *
 * 每个失败分支都有稳定的原因码，供上层判定与遥测的 `error.code` 使用。错误在发生位置就地
 * 抛出，调用方不做兜底重试。
 * @module @chatdsh/gateway/storage/errors
 */

/** 存储迁移失败原因码。 */
export const STORAGE_ERROR_CODES = {
  /** 目标 schema 版本高于本程序登记的版本。 */
  schemaVersionUnknown: 'schema-version-unknown',
  /** 目标 schema 尚未迁移到登记的最高版本。 */
  schemaVersionPending: 'schema-version-pending',
  /** 已应用版本的校验和与登记值不一致。 */
  schemaChecksumMismatch: 'schema-checksum-mismatch',
  /** 上一次迁移以失败状态结束，需要人工处理。 */
  schemaMigrationFailed: 'schema-migration-failed',
  /** 迁移锁被另一个仍然存活的进程持有。 */
  migrationLockHeld: 'migration-lock-held',
  /** 迁移锁是残留锁，必须先回收。 */
  migrationLockStale: 'migration-lock-stale',
  /** 释放锁时给出的标识与当前持有者不符。 */
  migrationLockMismatch: 'migration-lock-mismatch',
  /** 预检查未通过。 */
  preflightFailed: 'preflight-failed',
  /** 检查点记录的源或目标与当前不一致。 */
  checkpointMismatch: 'checkpoint-mismatch',
  /** 检查点文件内容无法解析或缺少必需字段。 */
  checkpointCorrupt: 'checkpoint-corrupt',
  /** 验证未通过。 */
  verificationFailed: 'verification-failed',
  /** 切换条件不满足；验证报告未通过时属于此码。 */
  switchNotAllowed: 'switch-not-allowed',
  /** 同一任务已按另一份验证报告完成切换。 */
  switchConflict: 'switch-conflict',
  /** 源在复制期间被打开为可写，违反只读约定。 */
  sourceNotReadOnly: 'source-not-readonly',
  /** 单批复制结果与批次登记的摘要不一致。 */
  batchDigestMismatch: 'batch-digest-mismatch',
} as const;

/** 失败原因码取值。 */
export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];

/**
 * 存储与迁移错误。
 *
 * `details` 只放原因码、枚举值、计数与版本号，不放文件内容与原文。
 */
export class StorageError extends Error {
  /** 稳定的原因码，写入遥测的 `error.code`。 */
  readonly code: StorageErrorCode;
  /** 附加判定信息。 */
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(code: StorageErrorCode, message: string, details: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.details = details;
  }
}
