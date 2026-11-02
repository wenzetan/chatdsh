/**
 * 存储接口、schema 登记、写入许可与迁移执行。
 *
 * 迁移相关的入口都在这里：{@link preflightMigration} 做维护窗口预检查，
 * {@link MigrationJobStore} 保存任务与检查点，{@link MigrationJobRunner} 持锁分批复制，
 * {@link switchToTarget} 按验证报告执行显式切换。
 * @module @chatdsh/gateway/storage
 */

export { STORAGE_ERROR_CODES, StorageError, type StorageErrorCode } from './errors.ts';
export { SqliteDatabase, type SqlExecutor, type SqlParameter, type SqlRow } from './sqlite.ts';
export {
  MigrationRegistry,
  migrationChecksum,
  type RegisteredMigration,
  type SchemaMigrationEntry,
} from './schema-registry.ts';
export {
  SchemaLedger,
  type SchemaChecksumConflict,
  type SchemaInspection,
  type SchemaMigrationRecord,
  type SchemaMigrationStatus,
  type SchemaState,
} from './schema-ledger.ts';
export { assertSchemaWritable, decideSchemaWrites, type SchemaWriteDecision, type WriteGateTelemetry } from './write-gate.ts';
export {
  MigrationJobStore,
  MIGRATION_CHECKPOINT_TABLE,
  MIGRATION_JOB_TABLE,
  MIGRATION_SWITCH_TABLE,
  type MigrationCheckpointRecord,
  type MigrationJobStoreOptions,
  type MigrationSwitchRecord,
} from './migration-job.ts';
export {
  preflightMigration,
  type MigrationPreflightCheck,
  type MigrationPreflightInput,
  type MigrationPreflightReport,
  type MigrationPreflightTelemetry,
  type MigrationSourceFormat,
  type MigrationWriterScan,
} from './preflight.ts';
export {
  readVerificationReport,
  switchToTarget,
  writeVerificationReport,
  type MigrationSwitchInput,
  type MigrationSwitchResult,
  type MigrationSwitchTelemetry,
  type MigrationVerificationReport,
} from './switchover.ts';
export {
  MigrationJobRunner,
  type MigrationCopyBatch,
  type MigrationCopyBatchInput,
  type MigrationCopyBatchResult,
  type MigrationRunInput,
  type MigrationRunResult,
  type MigrationRunnerTelemetry,
} from '../migrations/runner.ts';
export type {
  AccessSessionPort,
  AccessSessionRecord,
  BackupManifestRecord,
  BackupPort,
  ChatdshStorage,
  DeviceGenerationPort,
  DeviceGenerationRecord,
  MemoryOutboxPort,
  MemoryOutboxRecord,
  MigrationJobRecord,
  MigrationPort,
  NotificationOutboxPort,
  NotificationOutboxRecord,
  OperationPort,
  OperationRecord,
  OperationState,
  PairingCodePort,
  PairingCodeRecord,
  ReplicaCursorRecord,
  ReplicaOutboxRecord,
  ReplicaPort,
  RunInboxPort,
  RunInboxRecord,
  StorageTransaction,
} from './interface.ts';
