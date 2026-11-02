/**
 * 数据维护：用量、副本清理、保留策略、删除收件箱与血缘。
 *
 * 这一层以控制平面数据库连接为入口，按域拆成五个服务，共用同一个遥测包装与同一套表结构
 * 校验。设备侧的字节清点由调用方注入（运行时宿主提供真实文件系统清点），这一层负责把副本
 * 读数与归属索引交给它，并核对返回形状。
 *
 * 存储主入口的接入属于后续工作包，这里只提供可独立装配的服务集合。
 * @module @chatdsh/gateway/maintenance
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { ActiveRunRegistry, type ActiveRunSource } from './active-runs.ts';
import { ReplicaCleanup } from './cleanup.ts';
import { gatewayDataRoot } from './content.ts';
import { DeletionInbox } from './deletion.ts';
import { SessionLineage } from './lineage.ts';
import { assertMaintenanceSchema } from './rows.ts';
import { RetentionPolicyStore } from './retention.ts';
import { DataTelemetry } from './telemetry.ts';
import { DataUsageService, type StorageMeasurement } from './usage.ts';

export { ActiveRunRegistry } from './active-runs.ts';
export type { ActiveRunSource } from './active-runs.ts';
export { ReplicaCleanup } from './cleanup.ts';
export type {
  CleanupCandidate,
  CleanupEstimateQuery,
  CleanupEstimateView,
  CleanupExecuteInput,
  CleanupOutcome,
} from './cleanup.ts';
export {
  attachmentAvailability,
  attachmentIdsOf,
  charCountOf,
  contentScopeOf,
  gatewayDataRoot,
  importedRecordOf,
  inheritedPrefixLength,
} from './content.ts';
export type { ImportedRecord } from './content.ts';
export { DeletionInbox, memoryGroupReferencesOf } from './deletion.ts';
export type {
  DeletionInboxOptions,
  MemoryGroupReference,
  PermanentDeleteInput,
  PermanentDeleteOutcome,
} from './deletion.ts';
export { assertNoInternalCursor, INTERNAL_CURSOR_KEYS } from './dto.ts';
export { SessionLineage } from './lineage.ts';
export type { LineageView } from './lineage.ts';
export {
  activeShareCountOf,
  activeSharesOf,
  assertMaintenanceSchema,
  childSessionsOf,
  databaseFileBytes,
  MAINTENANCE_SCHEMA,
  replicaEventsOf,
  replicaPayloadBytesOf,
  replicaTitleOf,
  sessionRowOf,
  sessionRows,
  tablePageBytes,
} from './rows.ts';
export type { ReplicaEventRow, SessionRow, ShareRow } from './rows.ts';
export { DAY_MS, RETENTION_KEY, RETENTION_NAMESPACE, RetentionPolicyStore } from './retention.ts';
export type {
  RetentionCandidate,
  RetentionCandidateQuery,
  RetentionPolicyView,
} from './retention.ts';
export {
  DATA_OPERATIONS_METRIC,
  DATA_RECLAIMED_METRIC,
  DATA_REJECTED_EVENT,
  DATA_SPANS,
  DataTelemetry,
} from './telemetry.ts';
export type { DataAction, DataActionAttributes, DataSpanName } from './telemetry.ts';
export { DataUsageService, replicaStoreUsage } from './usage.ts';
export type {
  DataUsageReport,
  DataUsageRequest,
  ReplicaSessionUsage,
  ReplicaStoreUsage,
  StorageMeasurement,
  StorageMeasurementInput,
  StorageMeasurementReport,
  StorageMeasurementRow,
  UsageAttachmentRef,
  UsageReplicaRef,
  UsageSessionRef,
} from './usage.ts';

/** 装配数据维护服务所需的依赖。 */
export interface DataMaintenanceOptions {
  /** 控制平面数据库连接。 */
  readonly database: DatabaseSync;
  /** 设备侧的真实字节清点，由运行时宿主提供。 */
  readonly measure: StorageMeasurement;
  /** 遥测出口；缺省时全部遥测退化为空操作。 */
  readonly telemetry?: ChatdshTelemetry;
  /** 进行中运行的读取面；缺省使用进程内登记表。 */
  readonly activeRuns?: ActiveRunSource;
  /** 数据根；缺省取 `DSH_HOME` 或 `~/.dsh`。 */
  readonly dataRoot?: string;
}

/** 数据维护服务集合。 */
export class DataMaintenance {
  /** 用量统计。 */
  readonly usage: DataUsageService;
  /** 副本保留策略。 */
  readonly retention: RetentionPolicyStore;
  /** 副本清理。 */
  readonly cleanup: ReplicaCleanup;
  /** 删除收件箱。 */
  readonly deletion: DeletionInbox;
  /** 血缘查询。 */
  readonly lineage: SessionLineage;

  constructor(options: DataMaintenanceOptions) {
    assertMaintenanceSchema(options.database);
    const telemetry = new DataTelemetry(options.telemetry);
    const dataRoot = options.dataRoot ?? gatewayDataRoot();
    const retention = new RetentionPolicyStore(options.database, telemetry);
    this.retention = retention;
    this.usage = new DataUsageService(
      options.database,
      options.measure,
      telemetry,
      async () => (await retention.read()).days,
    );
    this.cleanup = new ReplicaCleanup(options.database, retention, telemetry);
    this.deletion = new DeletionInbox({
      database: options.database,
      retention,
      activeRuns: options.activeRuns ?? new ActiveRunRegistry(),
      dataRoot,
    }, telemetry);
    this.lineage = new SessionLineage(options.database, telemetry, dataRoot);
  }
}
