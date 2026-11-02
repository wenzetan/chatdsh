/**
 * 宿主侧的备份与恢复支持。
 *
 * 恢复产物在宿主侧要再核对一遍：恢复报告与恢复门禁按固定形状读取，会话日志从磁盘重读确认
 * 事件序号连续，对外服务在设备令牌与推送订阅逐项处置完成之前保持关闭。
 * @module @chatdsh/host-backup
 */

export {
  RESTORE_ARTIFACT_ERROR_CODES,
  RESTORE_GATE_FILENAME,
  RESTORE_REPORT_FILENAME,
  RestoreArtifactError,
  assertArtifactsAgree,
  readRestoreGate,
  readRestoreReport,
  restoreDispositionSchema,
  restoreGateSchema,
  restoreReportSchema,
  type RestoreArtifactErrorCode,
  type RestoreDisposition,
  type RestoreGate,
  type RestoreReport,
} from './artifact.ts';
export {
  DISPOSITION_ACTIONS,
  assertExternalServiceAllowed,
  dispositionSummary,
  pendingDispositions,
  planExternalServiceRelease,
  releaseExternalServices,
  writeRestoreGate,
  type DispositionAction,
  type DispositionChoice,
  type ExternalReleasePlan,
  type ExternalSurface,
} from './gate.ts';
export {
  MUTABLE_DOMAINS,
  RESTORED_MANIFEST_FILENAME,
  backupDomainSchema,
  backupManifestBodySchema,
  backupManifestSchema,
  backupObjectSchema,
  readRestoredManifest,
  verifyRestoredFiles,
  type BackupManifest,
  type RestoredFileCheck,
  type RestoredFilesReport,
} from './manifest.ts';
export { planStartupAfterRestore, type StartupRestoreInput, type StartupRestorePlan } from './startup.ts';
