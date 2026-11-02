/**
 * Postgres 控制平面与导入入口。
 *
 * 连接串只从配置取得：没有配置时不构造连接、不建表，也不留下任何空连接池；默认本地部署
 * 继续使用 SQLite 与 JSONL。连接失败时直接抛出，不存在转到本地存储的分支。
 * @module @chatdsh/gateway/postgres
 */

import { PostgresControlPlane } from './control-plane.ts';
import { PostgresSqlExecutor } from './executor.ts';
import { SyncPostgres } from './sync-client.ts';
import { NO_POSTGRES_TELEMETRY, POSTGRES_SIGNALS, errorAttributes, type PostgresTelemetry } from './telemetry.ts';

export { PostgresControlPlane, CONTROL_PLANE_SCHEMA_VERSION } from './control-plane.ts';
export type { UsageRecord, UsageTotals } from './control-plane.ts';
export { PostgresSqlExecutor, toDollarPlaceholders } from './executor.ts';
export { SyncPostgres } from './sync-client.ts';
export {
  PostgresConfigError,
  PostgresUnavailableError,
  errorCodeOf,
  isConnectionFailure,
} from './pg-module.ts';
export { POSTGRES_STORAGE_ERROR_CODES, PostgresStorageError } from './errors.ts';
export { PostgresSearchIndex } from './search.ts';
export type { SearchDocument, SearchHit, SearchOptions, SearchPage } from './search.ts';
export {
  canonicalJson,
  indexDigest,
  logDigest,
  summarize,
  usageDigest,
} from './digest.ts';
export type { DigestDocument, DigestEvent, DigestSession, DigestUsage, MigrationDigests } from './digest.ts';
export { importSessions, searchTextOf, sourceFingerprint } from './import.ts';
export type {
  ImportOptions,
  ImportReport,
  ImportedEvent,
  ImportedSession,
  SessionLogSource,
  SessionLogTarget,
} from './import.ts';
export { importControlPlane } from './control-plane-import.ts';
export type { ControlPlaneImportOptions, ControlPlaneImportReport } from './control-plane-import.ts';
export {
  CONTROL_PLANE_TABLES,
  SqliteControlPlaneSource,
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from './sqlite-source.ts';
export type { ControlPlaneRecord, TableDefinition } from './sqlite-source.ts';
export { readSessionsFromPersistence } from './sources.ts';
export type { PersistenceLike } from './sources.ts';
export { POSTGRES_SIGNALS, NO_POSTGRES_TELEMETRY, errorAttributes } from './telemetry.ts';
export type { PostgresTelemetry } from './telemetry.ts';

/** 后端配置。 */
export interface PostgresBackendOptions {
  /** 连接串；缺省或空串时整个后端不构造。 */
  readonly connectionString?: string;
  /** 遥测出口。 */
  readonly telemetry?: PostgresTelemetry;
}

/** 可用的 Postgres 控制平面后端。 */
export interface PostgresBackend {
  /** 同步 Postgres 客户端。 */
  readonly client: SyncPostgres;
  /** 同步 SQL 执行端口。 */
  readonly executor: PostgresSqlExecutor;
  /** 控制平面存储。 */
  readonly controlPlane: PostgresControlPlane;
  /** 关闭连接。 */
  readonly close: () => void;
}

/**
 * 按配置构造后端。
 *
 * @param options - 连接串与遥测出口。
 * @returns 配置了连接串时的后端；没有配置时为空，且不构造任何连接。
 */
export function openPostgresBackend(options: PostgresBackendOptions = {}): PostgresBackend | undefined {
  const connectionString = options.connectionString?.trim() ?? '';
  if (connectionString === '') return undefined;
  const telemetry = options.telemetry ?? NO_POSTGRES_TELEMETRY;
  let backend: PostgresBackend | undefined;
  telemetry.runSpanSync(
    POSTGRES_SIGNALS.connect,
    { outcome: 'attempted' },
    (span) => {
      try {
        const client = new SyncPostgres(connectionString);
        const executor = new PostgresSqlExecutor(client);
        const controlPlane = new PostgresControlPlane(executor);
        backend = {
          client,
          executor,
          controlPlane,
          close: () => {
            client.close();
          },
        };
        span.setAttribute('outcome', 'ok');
        telemetry.counter(POSTGRES_SIGNALS.connectionsTotal, { description: 'Postgres 连接结果' }).add(1, {
          outcome: 'ok',
        });
      } catch (error) {
        const attributes = errorAttributes(error);
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', attributes['error.type'] ?? 'Error');
        span.setAttribute('error.code', attributes['error.code'] ?? 'Error');
        span.recordException(error);
        telemetry.event(POSTGRES_SIGNALS.rejected, { action: 'connect', outcome: 'failed', ...attributes });
        telemetry.counter(POSTGRES_SIGNALS.connectionsTotal, { description: 'Postgres 连接结果' }).add(1, {
          outcome: 'failed',
        });
        throw error;
      }
      return backend;
    },
  );
  if (backend === undefined) throw new Error('Postgres 后端构造完成但没有返回实例');
  return backend;
}
