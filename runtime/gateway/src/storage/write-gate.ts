/**
 * 写入许可判定。
 *
 * 只有登记表与本程序完全一致时才允许写入。出现未知较新版本、校验和冲突、失败行或尚未
 * 应用的迁移，一律拒绝写入并抛出带原因码的错误。
 * @module @chatdsh/gateway/storage/write-gate
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { STORAGE_ERROR_CODES, StorageError, type StorageErrorCode } from './errors.ts';
import type { SchemaInspection, SchemaLedger, SchemaState } from './schema-ledger.ts';
import type { MigrationRegistry } from './schema-registry.ts';

/** 写入许可判定。 */
export interface SchemaWriteDecision {
  /** 是否允许写入。 */
  readonly allowed: boolean;
  /** schema 匹配状态。 */
  readonly state: SchemaState;
  /** 拒绝原因码；允许时为空。 */
  readonly reason?: StorageErrorCode;
}

/**
 * 按检查结果判定写入许可。
 * @param inspection - schema 检查结果。
 * @returns 判定。
 */
export function decideSchemaWrites(inspection: SchemaInspection): SchemaWriteDecision {
  switch (inspection.state) {
    case 'current':
      return { allowed: true, state: inspection.state };
    case 'empty':
    case 'pending':
      return { allowed: false, state: inspection.state, reason: STORAGE_ERROR_CODES.schemaVersionPending };
    case 'newer-unknown':
      return { allowed: false, state: inspection.state, reason: STORAGE_ERROR_CODES.schemaVersionUnknown };
    case 'checksum-mismatch':
      return { allowed: false, state: inspection.state, reason: STORAGE_ERROR_CODES.schemaChecksumMismatch };
    case 'migration-failed':
      return { allowed: false, state: inspection.state, reason: STORAGE_ERROR_CODES.schemaMigrationFailed };
  }
}

/** 写入许可检查需要的遥测面。 */
export type WriteGateTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter'>;

/**
 * 校验 schema 与登记表一致，不一致时抛出。
 * @param options - 登记表、存储与遥测。
 * @returns schema 检查结果；允许写入时调用方继续。
 */
export function assertSchemaWritable(options: {
  readonly ledger: SchemaLedger;
  readonly registry: MigrationRegistry;
  readonly telemetry: WriteGateTelemetry;
}): SchemaInspection {
  const inspection = options.ledger.inspect(options.registry);
  const decision = decideSchemaWrites(inspection);
  const counter = options.telemetry.counter('chatdsh_gateway_migration_schema_checks_total', {
    description: '存储 schema 写入许可检查结果',
  });
  if (decision.allowed) {
    counter.add(1, { outcome: 'allowed' });
    return inspection;
  }
  counter.add(1, { outcome: 'rejected', 'error.code': decision.reason ?? 'unknown' });
  options.telemetry.event('chatdsh.gateway.migration.schema.rejected', {
    outcome: 'rejected',
    'error.type': 'StorageError',
    'error.code': decision.reason ?? STORAGE_ERROR_CODES.schemaVersionUnknown,
    kind: inspection.state,
    count: inspection.appliedVersion,
  });
  throw new StorageError(decision.reason ?? STORAGE_ERROR_CODES.schemaVersionUnknown, messageOf(inspection), {
    state: inspection.state,
    applied: inspection.appliedVersion,
    registered: inspection.registeredVersion,
  });
}

/** 组出带具体版本与状态的说明。 */
function messageOf(inspection: SchemaInspection): string {
  switch (inspection.state) {
    case 'newer-unknown':
      return `存储 schema 版本 ${inspection.unknownVersions.join('、')} 高于本程序登记的最高版本 ${inspection.registeredVersion}，拒绝写入`;
    case 'checksum-mismatch':
      return `存储 schema 版本 ${inspection.checksumConflicts.map((conflict) => conflict.version).join('、')} 的校验和与登记不一致，拒绝写入`;
    case 'migration-failed':
      return `存储 schema 版本 ${inspection.failedVersions.join('、')} 的上一次迁移失败，拒绝写入`;
    default:
      return `存储 schema 处于 ${inspection.appliedVersion}/${inspection.registeredVersion}，尚未迁移到登记版本，拒绝写入`;
  }
}
