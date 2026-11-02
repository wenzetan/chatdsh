/**
 * `schema_migrations` 登记表。
 *
 * 每行记录版本号、名称、校验和、状态与应用时刻。读取时与本程序的登记表逐条比对：
 * 出现未登记的更高版本即判定为未知较新 schema，校验和不一致即判定为定义被改动。
 * @module @chatdsh/gateway/storage/schema-ledger
 */

import type { MigrationRegistry, RegisteredMigration } from './schema-registry.ts';
import type { SqlExecutor } from './sqlite.ts';

/** 一条迁移的执行状态。 */
export type SchemaMigrationStatus = 'pending' | 'applied' | 'failed';

/** 登记表的一行。 */
export interface SchemaMigrationRecord {
  /** 版本号。 */
  readonly version: number;
  /** 迁移名称。 */
  readonly name: string;
  /** 应用时记录的定义校验和。 */
  readonly checksum: string;
  /** 执行状态。 */
  readonly status: SchemaMigrationStatus;
  /** 开始执行的毫秒时间戳。 */
  readonly startedAt?: number;
  /** 应用完成的毫秒时间戳；未完成时为空。 */
  readonly appliedAt?: number;
  /** 失败原因，仅失败行有值。 */
  readonly failureReason?: string;
}

/** schema 与本程序的匹配状态。 */
export type SchemaState = 'empty' | 'current' | 'pending' | 'newer-unknown' | 'checksum-mismatch' | 'migration-failed';

/** 校验和冲突。 */
export interface SchemaChecksumConflict {
  /** 版本号。 */
  readonly version: number;
  /** 登记值；未登记时为空。 */
  readonly registered?: string;
  /** 实际记录值。 */
  readonly applied: string;
}

/** 一次 schema 检查的结果。 */
export interface SchemaInspection {
  /** 匹配状态。 */
  readonly state: SchemaState;
  /** 已应用的最高版本，没有任何已应用行时为 0。 */
  readonly appliedVersion: number;
  /** 本程序登记的目标版本。 */
  readonly registeredVersion: number;
  /** 全部记录，按版本号升序。 */
  readonly records: readonly SchemaMigrationRecord[];
  /** 记录里未登记且高于目标版本的版本号。 */
  readonly unknownVersions: readonly number[];
  /** 校验和不一致的版本。 */
  readonly checksumConflicts: readonly SchemaChecksumConflict[];
  /** 失败状态行的版本。 */
  readonly failedVersions: readonly number[];
}

/** 登记表读写。 */
export class SchemaLedger {
  private readonly database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.database = database;
  }

  /** 建表；可重复执行。 */
  ensureTable(): void {
    this.database.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        checksum text not null,
        status text not null,
        started_at integer,
        applied_at integer,
        failure_reason text
      )
    `);
  }

  /** 读全部记录；登记表还没建立时为空。 */
  records(): readonly SchemaMigrationRecord[] {
    if (!this.database.tableExists('schema_migrations')) return [];
    const rows = this.database.all<{
      version: number;
      name: string;
      checksum: string;
      status: string;
      started_at: number | null;
      applied_at: number | null;
      failure_reason: string | null;
    }>('select version, name, checksum, status, started_at, applied_at, failure_reason from schema_migrations order by version');
    return rows.map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      status: statusOf(row.status, row.version),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
      ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    }));
  }

  /**
   * 把记录与登记表比对。
   * @param registry - 本程序的迁移登记表。
   * @returns 检查结果。
   */
  inspect(registry: MigrationRegistry): SchemaInspection {
    const records = this.records();
    const appliedVersion = records
      .filter((record) => record.status === 'applied')
      .reduce((max, record) => Math.max(max, record.version), 0);
    const unknownVersions = records
      .filter((record) => registry.entryFor(record.version) === undefined && record.version > registry.targetVersion)
      .map((record) => record.version);
    const checksumConflicts = records
      .filter((record) => registry.checksumFor(record.version) !== record.checksum)
      .map((record) => {
        const registered = registry.checksumFor(record.version);
        return registered === undefined
          ? { version: record.version, applied: record.checksum }
          : { version: record.version, registered, applied: record.checksum };
      });
    const failedVersions = records.filter((record) => record.status === 'failed').map((record) => record.version);

    let state: SchemaState;
    if (records.length === 0) state = 'empty';
    else if (unknownVersions.length > 0) state = 'newer-unknown';
    else if (checksumConflicts.length > 0) state = 'checksum-mismatch';
    else if (failedVersions.length > 0) state = 'migration-failed';
    else if (appliedVersion < registry.targetVersion) state = 'pending';
    else state = 'current';

    return {
      state,
      appliedVersion,
      registeredVersion: registry.targetVersion,
      records,
      unknownVersions,
      checksumConflicts,
      failedVersions,
    };
  }

  /** 记录一次开始。 */
  begin(migration: RegisteredMigration, startedAt: number): void {
    this.database.run(
      `insert into schema_migrations (version, name, checksum, status, started_at, applied_at, failure_reason)
       values (?, ?, ?, 'pending', ?, null, null)
       on conflict(version) do update set name = excluded.name, checksum = excluded.checksum, status = 'pending',
         started_at = excluded.started_at, applied_at = null, failure_reason = null`,
      [migration.version, migration.name, migration.checksum, startedAt],
    );
  }

  /** 记录一次成功应用。 */
  apply(migration: RegisteredMigration, appliedAt: number): void {
    this.database.run(
      `insert into schema_migrations (version, name, checksum, status, started_at, applied_at, failure_reason)
       values (?, ?, ?, 'applied', ?, ?, null)
       on conflict(version) do update set status = 'applied', applied_at = excluded.applied_at, failure_reason = null`,
      [migration.version, migration.name, migration.checksum, appliedAt, appliedAt],
    );
  }

  /** 记录一次失败。 */
  fail(migration: RegisteredMigration, reason: string, failedAt: number): void {
    this.database.run(
      `insert into schema_migrations (version, name, checksum, status, started_at, applied_at, failure_reason)
       values (?, ?, ?, 'failed', ?, null, ?)
       on conflict(version) do update set status = 'failed', failure_reason = excluded.failure_reason`,
      [migration.version, migration.name, migration.checksum, failedAt, reason],
    );
  }

  /**
   * 按版本顺序应用尚未应用的迁移。
   *
   * 每条迁移的语句与登记行在同一个事务里提交；语句失败时回滚并把该版本标记为失败，
   * 之后继续抛出，不做跳过。
   * @param registry - 迁移登记表。
   * @param options - 时刻来源，缺省取系统时钟。
   * @returns 应用完成的记录。
   */
  applyAll(registry: MigrationRegistry, options: { readonly now?: () => number } = {}): readonly SchemaMigrationRecord[] {
    const now = options.now ?? Date.now;
    this.ensureTable();
    const applied = new Set(
      this.records()
        .filter((record) => record.status === 'applied' && record.checksum === registry.checksumFor(record.version))
        .map((record) => record.version),
    );
    const done: SchemaMigrationRecord[] = [];
    for (const migration of registry.migrations) {
      if (applied.has(migration.version)) continue;
      const startedAt = now();
      try {
        this.database.transaction(() => {
          this.begin(migration, startedAt);
          for (const statement of migration.statements) this.database.exec(statement);
          this.apply(migration, now());
        });
      } catch (error) {
        this.fail(migration, error instanceof Error ? error.message : String(error), now());
        throw error;
      }
      done.push({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        status: 'applied',
      });
    }
    return done;
  }
}

/** 把数据库里的状态文本转成枚举；未知取值直接抛出。 */
function statusOf(raw: string, version: number): SchemaMigrationStatus {
  if (raw === 'pending' || raw === 'applied' || raw === 'failed') return raw;
  throw new Error(`schema_migrations 版本 ${version} 的状态非法：${raw}`);
}
