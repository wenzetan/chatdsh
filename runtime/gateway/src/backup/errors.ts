/**
 * 备份、校验与隔离恢复的错误。
 *
 * 每个失败分支都有稳定的原因码，写入遥测的 `error.code`，供界面与命令给出明确的下一步条件。
 * 需要重新配置才能继续的分支同时带 `recovery` 说明；错误在发生位置就地抛出，不做兜底重试。
 * @module @chatdsh/gateway/backup/errors
 */

/** 备份与恢复失败原因码。 */
export const BACKUP_ERROR_CODES = {
  /** 清单或备份格式版本高于本程序支持的版本。 */
  formatUnsupported: 'backup-format-unsupported',
  /** 备份目录里没有清单。 */
  manifestMissing: 'backup-manifest-missing',
  /** 清单内容无法解析或缺少必需字段。 */
  manifestCorrupt: 'backup-manifest-corrupt',
  /** 清单声明的摘要与正文不一致，清单被改写。 */
  manifestDigestMismatch: 'backup-manifest-digest-mismatch',
  /** 数据根不存在或缺少控制平面数据库。 */
  sourceMissing: 'backup-source-missing',
  /** 数据根里出现符号链接或特殊文件，无法取得稳定内容。 */
  sourceEntryUnsupported: 'backup-source-entry-unsupported',
  /** 检查点记录的源与当前源不一致，拒绝在另一个源上续跑。 */
  checkpointMismatch: 'backup-checkpoint-mismatch',
  /** 检查点文件无法解析。 */
  checkpointCorrupt: 'backup-checkpoint-corrupt',
  /** 备份对象文件不存在。 */
  objectMissing: 'backup-object-missing',
  /** 备份对象的密文认证失败，内容已损坏。 */
  objectCorrupt: 'backup-object-corrupt',
  /** 解密后的字节与清单登记的摘要不一致。 */
  objectDigestMismatch: 'backup-object-digest-mismatch',
  /** 目标文件系统剩余空间不足。 */
  diskSpaceInsufficient: 'backup-disk-space-insufficient',
  /** 备份密钥缺失，无法解密对象。 */
  keyMissing: 'backup-key-missing',
  /** 备份密钥与清单登记的密钥标识不符。 */
  keyMismatch: 'backup-key-mismatch',
  /** 密钥标识相符但认证失败，密钥内容不可用。 */
  keyUndecryptable: 'backup-key-undecryptable',
  /** 外部服务已接入却没有备份结果引用。 */
  externalScopeIncomplete: 'backup-external-scope-incomplete',
  /** 恢复目标已经存在且非空。 */
  restoreTargetExists: 'restore-target-exists',
  /** 恢复目标的父目录不可写。 */
  restoreTargetUnusable: 'restore-target-unusable',
  /** 备份的 schema 版本高于当前软件支持的版本。 */
  restoreVersionIncompatible: 'restore-version-incompatible',
  /** 会话归属在恢复后与设备记录不一致。 */
  restoreOwnershipInvalid: 'restore-ownership-invalid',
  /** 恢复后的事件序号存在缺口或与水位不一致。 */
  restoreEventGap: 'restore-event-gap',
  /** 恢复后的附件字节与清单摘要不一致。 */
  restoreAttachmentMismatch: 'restore-attachment-mismatch',
  /** 恢复后的加密凭据无法用提供的密钥解开。 */
  restoreCredentialUndecryptable: 'restore-credential-undecryptable',
  /** 切换未取得用户确认。 */
  restoreSwitchNotConfirmed: 'restore-switch-not-confirmed',
  /** 切换目标仍存在，未按约定先处置现有根。 */
  restoreLiveRootPresent: 'restore-live-root-present',
  /** 设备令牌与推送订阅的处置没有逐项确认。 */
  restoreDispositionIncomplete: 'restore-disposition-incomplete',
} as const;

/** 备份与恢复失败原因码取值。 */
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[keyof typeof BACKUP_ERROR_CODES];

/**
 * 备份与恢复错误。
 *
 * `details` 只放原因码、枚举值、计数、版本号与相对路径，不放文件内容与凭据原文。
 */
export class BackupError extends Error {
  /** 稳定的原因码，写入遥测的 `error.code`。 */
  readonly code: BackupErrorCode;
  /** 附加判定信息。 */
  readonly details: Readonly<Record<string, string | number | boolean>>;
  /** 需要重新配置才能继续时给出的条件，按顺序展示。 */
  readonly recovery: readonly string[];

  constructor(
    code: BackupErrorCode,
    message: string,
    details: Record<string, string | number | boolean> = {},
    recovery: readonly string[] = [],
  ) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.details = details;
    this.recovery = recovery;
  }
}
