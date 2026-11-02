/**
 * 备份、校验与隔离恢复。
 *
 * {@link createBackup} 生成加密的一致性备份并写清单与检查点；{@link verifyBackup} 逐项核对
 * 清单、对象、密钥、空间与外部边界；{@link restoreBackup} 把备份写进全新目录并核对归属、
 * 事件连续、附件字节、加密凭据与软件兼容；{@link planRestoreSwitch} 与
 * {@link activateRestoredRoot} 在用户确认之后才把恢复目录换到正式位置。
 * 命令、路由与设置页入口由后续集成工作包接入，本模块只提供可独立装配的能力。
 * @module @chatdsh/gateway/backup
 */

export { BACKUP_ERROR_CODES, BackupError, type BackupErrorCode } from './errors.ts';
export {
  BACKUP_ALGORITHM,
  BACKUP_FORMAT_VERSION,
  BACKUP_PRODUCT,
  CHECKPOINT_FILENAME,
  MANIFEST_FILENAME,
  OBJECTS_DIRECTORY,
  manifestDigestOf,
  readBackupManifest,
  type BackupDomainEntry,
  type BackupDomainKind,
  type BackupEncryptionInfo,
  type BackupExcludedEntry,
  type BackupExternalBoundary,
  type BackupKeyRequirement,
  type BackupManifest,
  type BackupManifestBody,
  type BackupObjectEntry,
  type BackupRestorePoint,
  type BackupRetentionPolicy,
  type BackupSoftwareInfo,
  type BackupTotals,
  type KeyCheckEntry,
} from './manifest.ts';
export {
  BACKUP_DOMAINS,
  BACKUP_EXCLUDED_DOMAINS,
  CONTROL_PLANE_DATABASE,
  planBackup,
  readRestorePoint,
  readSchemaVersion,
  snapshotControlPlane,
  sourceDigestOf,
  type BackupDomainSpec,
  type BackupPlan,
  type PlannedObject,
} from './domains.ts';
export {
  BACKUP_KEY_BYTES,
  backupKeyIdOf,
  deriveBackupKey,
  objectAad,
  openKeyCheck,
  openObject,
  readBackupKeyFile,
  sealKeyCheck,
  sealObject,
  type KeyCheck,
  type SealedObject,
} from './crypto.ts';
export {
  DIRECTORY_MODE,
  FILE_MODE,
  assertFreeBytes,
  containedPath,
  digestFile,
  directoryEmptyOrAbsent,
  listTree,
  writeJsonAtomic,
  type TreeFile,
} from './files.ts';
export { BACKUP_RETENTION, listBackupSets, planRetention, pruneBackups, type BackupSetEntry, type RetentionPlan } from './retention.ts';
export {
  CHECKPOINT_VERSION,
  createBackup,
  loadCheckpoint,
  objectKeyOf,
  requireExternalBoundary,
  type BackupCheckpoint,
  type BackupProgress,
  type CheckpointObject,
  type CreateBackupInput,
  type CreateBackupResult,
  type ExternalServiceInput,
} from './create.ts';
export { verifyBackup, type BackupVerificationReport, type VerifyBackupInput } from './verify.ts';
export {
  RESTORE_GATE_FILENAME,
  RESTORE_REPORT_FILENAME,
  RESTORED_MANIFEST_FILENAME,
  prepareRestoredRoot,
  restoreBackup,
  verifyContinuity,
  verifyOwnership,
  type ContinuityCheck,
  type RestoreBackupInput,
  type RestoreDisposition,
  type RestoreGate,
  type RestorePrepared,
  type RestoreReport,
} from './restore.ts';
export {
  RESTORE_SWITCH_FILENAME,
  activateRestoredRoot,
  planRestoreSwitch,
  type RestoreSwitchConfirmation,
  type RestoreSwitchPlan,
  type RestoreSwitchResult,
} from './switch.ts';
export {
  BACKUP_EVENTS,
  BACKUP_METRICS,
  BACKUP_SPANS,
  BackupRecorder,
  type BackupAction,
  type BackupActionAttributes,
  type BackupSpanName,
  type BackupTelemetry,
} from './telemetry.ts';
