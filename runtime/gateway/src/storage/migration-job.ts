/**
 * 迁移任务与检查点的持久记录。
 *
 * 任务行保存任务标识、目标 schema 版本、源与目标摘要、检查点位置、状态与备份清单引用；
 * 检查点行保存已确认记录条数与复制位置。两者按任务标识唯一，写入与读取都经过同一个 SQL
 * 执行端口，进程重启后从同一位置继续。摘要不一致或字段非法时就地抛出，不做修补。
 * @module @chatdsh/gateway/storage/migration-job
 */

import { randomUUID } from 'node:crypto';
import { STORAGE_ERROR_CODES, StorageError } from './errors.ts';
import type { MigrationJobRecord, MigrationPort, StorageTransaction } from './interface.ts';
import type { SqlExecutor } from './sqlite.ts';

/** 任务表名。 */
export const MIGRATION_JOB_TABLE = 'migration_jobs';

/** 检查点表名。 */
export const MIGRATION_CHECKPOINT_TABLE = 'migration_checkpoints';

/** 切换记录表名。 */
export const MIGRATION_SWITCH_TABLE = 'migration_switches';

/** 一条检查点记录。 */
export interface MigrationCheckpointRecord {
  /** 任务标识。 */
  readonly jobId: string;
  /** 源摘要，必须与任务记录一致。 */
  readonly sourceDigest: string;
  /** 目标摘要，必须与任务记录一致。 */
  readonly targetDigest: string;
  /** 已确认写入目标的记录条数。 */
  readonly confirmed: number;
  /** 目标中最后一条记录的位置；空目标为 0。 */
  readonly position: number;
  /** 写入时刻的毫秒时间戳。 */
  readonly recordedAt: number;
}

/** 一条已完成的切换记录。 */
export interface MigrationSwitchRecord {
  /** 任务标识。 */
  readonly jobId: string;
  /** 切换所用验证报告内容的 SHA-256 摘要。 */
  readonly reportDigest: string;
  /** 切换后的活动路径。 */
  readonly activePath: string;
  /** 切换时刻的毫秒时间戳。 */
  readonly switchedAt: number;
}

/** 任务记录的全部状态取值。 */
const JOB_STATES: readonly MigrationJobRecord['state'][] = [
  'planned',
  'copying',
  'verified',
  'switched',
  'failed',
  'aborted',
];

/** 任务与检查点存储的构造选项。 */
export interface MigrationJobStoreOptions {
  /** SQL 执行端口。 */
  readonly database: SqlExecutor;
}

/**
 * 迁移任务与检查点的持久实现。
 *
 * 端口方法要求调用方在本存储的 {@link MigrationJobStore.transaction} 回调里执行；SQLite 的
 * 事务边界按连接生效，句柄用来确认写入落在同一个事务里。
 */
export class MigrationJobStore implements MigrationPort {
  private readonly database: SqlExecutor;
  private readonly openTransactions = new Set<string>();

  constructor(options: MigrationJobStoreOptions) {
    this.database = options.database;
  }

  /** 建表；可重复执行。 */
  ensureTables(): void {
    this.database.exec(`
      create table if not exists ${MIGRATION_JOB_TABLE} (
        job_id text primary key,
        schema_version integer not null,
        source_digest text not null,
        target_digest text not null,
        checkpoint integer not null,
        state text not null,
        manifest_ref text
      )
    `);
    this.database.exec(`
      create table if not exists ${MIGRATION_CHECKPOINT_TABLE} (
        job_id text primary key,
        source_digest text not null,
        target_digest text not null,
        confirmed integer not null,
        position integer not null,
        recorded_at integer not null
      )
    `);
    this.database.exec(`
      create table if not exists ${MIGRATION_SWITCH_TABLE} (
        job_id text primary key,
        report_digest text not null,
        active_path text not null,
        switched_at integer not null
      )
    `);
  }

  /** 在一个事务里执行；回调抛出时整体回滚。 */
  transaction<T>(fn: (tx: StorageTransaction) => T): T {
    return this.database.transaction(() => {
      const tx: StorageTransaction = { id: randomUUID() };
      this.openTransactions.add(tx.id);
      try {
        return fn(tx);
      } finally {
        this.openTransactions.delete(tx.id);
      }
    });
  }

  /** 读任务记录；没有该任务或表不存在时为空。 */
  job(jobId: string): MigrationJobRecord | undefined {
    if (!this.database.tableExists(MIGRATION_JOB_TABLE)) return undefined;
    const row = this.database.get<{
      job_id: string;
      schema_version: number;
      source_digest: string;
      target_digest: string;
      checkpoint: number;
      state: string;
      manifest_ref: string | null;
    }>(
      `select job_id, schema_version, source_digest, target_digest, checkpoint, state, manifest_ref
       from ${MIGRATION_JOB_TABLE} where job_id = ?`,
      [jobId],
    );
    if (row === undefined) return undefined;
    return {
      jobId: stringOf(row.job_id, 'job_id'),
      schemaVersion: countOf(row.schema_version, 'schema_version'),
      sourceDigest: digestOf(row.source_digest, 'source_digest'),
      targetDigest: digestOf(row.target_digest, 'target_digest'),
      checkpoint: countOf(row.checkpoint, 'checkpoint'),
      state: stateOf(row.state),
      ...(row.manifest_ref === null ? {} : { manifestRef: digestOf(row.manifest_ref, 'manifest_ref') }),
    };
  }

  /** 写入或更新任务记录。 */
  save(tx: StorageTransaction, record: MigrationJobRecord): void {
    this.requireTransaction(tx);
    requireJobRecord(record);
    this.ensureTables();
    this.database.run(
      `insert into ${MIGRATION_JOB_TABLE}
         (job_id, schema_version, source_digest, target_digest, checkpoint, state, manifest_ref)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(job_id) do update set schema_version = excluded.schema_version,
         source_digest = excluded.source_digest, target_digest = excluded.target_digest,
         checkpoint = excluded.checkpoint, state = excluded.state, manifest_ref = excluded.manifest_ref`,
      [
        record.jobId,
        record.schemaVersion,
        record.sourceDigest,
        record.targetDigest,
        record.checkpoint,
        record.state,
        record.manifestRef ?? null,
      ],
    );
  }

  /** 读检查点；源或目标摘要与任务记录不一致时抛出，字段非法时抛出。 */
  checkpoint(jobId: string): MigrationCheckpointRecord | undefined {
    if (!this.database.tableExists(MIGRATION_CHECKPOINT_TABLE)) return undefined;
    const row = this.database.get<{
      job_id: string;
      source_digest: string;
      target_digest: string;
      confirmed: number;
      position: number;
      recorded_at: number;
    }>(
      `select job_id, source_digest, target_digest, confirmed, position, recorded_at
       from ${MIGRATION_CHECKPOINT_TABLE} where job_id = ?`,
      [jobId],
    );
    if (row === undefined) return undefined;
    const record: MigrationCheckpointRecord = {
      jobId: stringOf(row.job_id, 'job_id', CHECKPOINT_CORRUPT),
      sourceDigest: digestOf(row.source_digest, 'source_digest', CHECKPOINT_CORRUPT),
      targetDigest: digestOf(row.target_digest, 'target_digest', CHECKPOINT_CORRUPT),
      confirmed: countOf(row.confirmed, 'confirmed', CHECKPOINT_CORRUPT),
      position: countOf(row.position, 'position', CHECKPOINT_CORRUPT),
      recordedAt: countOf(row.recorded_at, 'recorded_at', CHECKPOINT_CORRUPT),
    };
    const job = this.job(jobId);
    if (job === undefined) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointCorrupt, `检查点没有对应的迁移任务：${jobId}`, {
        kind: 'job-missing',
      });
    }
    if (job.sourceDigest !== record.sourceDigest || job.targetDigest !== record.targetDigest) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '检查点记录的源或目标摘要与迁移任务不一致', {
        kind: 'digest-mismatch',
        count: record.position,
      });
    }
    return record;
  }

  /** 写入检查点；位置或已确认条数不得倒退。 */
  saveCheckpoint(tx: StorageTransaction, record: MigrationCheckpointRecord): MigrationCheckpointRecord {
    this.requireTransaction(tx);
    requireCheckpointRecord(record);
    this.ensureTables();
    const job = this.job(record.jobId);
    if (job === undefined) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '检查点没有对应的迁移任务，拒绝写入', {
        kind: 'job-missing',
      });
    }
    if (job.sourceDigest !== record.sourceDigest || job.targetDigest !== record.targetDigest) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '检查点的源或目标摘要与迁移任务不一致，拒绝写入', {
        kind: 'digest-mismatch',
      });
    }
    const existing = this.checkpoint(record.jobId);
    if (existing !== undefined && (record.position < existing.position || record.confirmed < existing.confirmed)) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '检查点的位置或已确认条数比既有记录更小，拒绝写入', {
        kind: 'checkpoint-regression',
        count: record.position,
      });
    }
    this.database.run(
      `insert into ${MIGRATION_CHECKPOINT_TABLE}
         (job_id, source_digest, target_digest, confirmed, position, recorded_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(job_id) do update set source_digest = excluded.source_digest,
         target_digest = excluded.target_digest, confirmed = excluded.confirmed,
         position = excluded.position, recorded_at = excluded.recorded_at`,
      [record.jobId, record.sourceDigest, record.targetDigest, record.confirmed, record.position, record.recordedAt],
    );
    return record;
  }

  /** 读切换记录；该任务尚未切换时为空。 */
  switchRecord(jobId: string): MigrationSwitchRecord | undefined {
    if (!this.database.tableExists(MIGRATION_SWITCH_TABLE)) return undefined;
    const row = this.database.get<{
      job_id: string;
      report_digest: string;
      active_path: string;
      switched_at: number;
    }>(
      `select job_id, report_digest, active_path, switched_at from ${MIGRATION_SWITCH_TABLE} where job_id = ?`,
      [jobId],
    );
    if (row === undefined) return undefined;
    return {
      jobId: stringOf(row.job_id, 'job_id'),
      reportDigest: digestOf(row.report_digest, 'report_digest'),
      activePath: stringOf(row.active_path, 'active_path'),
      switchedAt: countOf(row.switched_at, 'switched_at'),
    };
  }

  /** 写入切换记录；同一任务只保留一份。 */
  saveSwitch(tx: StorageTransaction, record: MigrationSwitchRecord): void {
    this.requireTransaction(tx);
    if (record.jobId === '' || record.reportDigest === '' || record.activePath === '') {
      throw new Error('切换记录缺少任务标识、报告摘要或活动路径');
    }
    if (!Number.isSafeInteger(record.switchedAt) || record.switchedAt < 0) {
      throw new Error(`切换时刻必须是非负整数，实际 ${String(record.switchedAt)}`);
    }
    this.ensureTables();
    const existing = this.switchRecord(record.jobId);
    if (existing !== undefined) {
      throw new StorageError(STORAGE_ERROR_CODES.switchConflict, '迁移任务已有切换记录，拒绝重复写入', {
        kind: 'switch-record-exists',
      });
    }
    this.database.run(
      `insert into ${MIGRATION_SWITCH_TABLE} (job_id, report_digest, active_path, switched_at) values (?, ?, ?, ?)`,
      [record.jobId, record.reportDigest, record.activePath, record.switchedAt],
    );
  }

  /** 确认句柄来自本存储打开的事务。 */
  private requireTransaction(tx: StorageTransaction): void {
    if (!this.openTransactions.has(tx.id)) {
      throw new Error(`迁移记录的写入必须在同一个事务内执行：${tx.id}`);
    }
  }
}

/** 任务记录的字段校验。 */
function requireJobRecord(record: MigrationJobRecord): void {
  if (record.jobId === '') throw new Error('迁移任务缺少任务标识');
  if (!Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) {
    throw new Error(`迁移任务的目标 schema 版本必须是正整数，实际 ${String(record.schemaVersion)}`);
  }
  if (record.sourceDigest === '' || record.targetDigest === '') throw new Error('迁移任务缺少源或目标摘要');
  if (!Number.isSafeInteger(record.checkpoint) || record.checkpoint < 0) {
    throw new Error(`迁移任务的检查点位置必须是非负整数，实际 ${String(record.checkpoint)}`);
  }
  if (!JOB_STATES.includes(record.state)) throw new Error(`迁移任务的状态非法：${String(record.state)}`);
}

/** 检查点记录的字段校验。 */
function requireCheckpointRecord(record: MigrationCheckpointRecord): void {
  if (record.jobId === '') throw new Error('检查点缺少任务标识');
  if (record.sourceDigest === '' || record.targetDigest === '') throw new Error('检查点缺少源或目标摘要');
  for (const [name, value] of [
    ['confirmed', record.confirmed],
    ['position', record.position],
    ['recordedAt', record.recordedAt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`检查点的 ${name} 必须是非负整数，实际 ${String(value)}`);
    }
  }
}

/** 字段非法时的错误构造方式。 */
type CorruptFactory = (message: string, field: string) => Error;

/** 任务行的字段非法按程序错误处理。 */
const JOB_CORRUPT: CorruptFactory = (message) => new Error(message);

/** 检查点行的字段非法按检查点损坏处理。 */
const CHECKPOINT_CORRUPT: CorruptFactory = (message, field) =>
  new StorageError(STORAGE_ERROR_CODES.checkpointCorrupt, message, { kind: field });

/** 读字符串字段。 */
function stringOf(value: string, field: string, corrupt: CorruptFactory = JOB_CORRUPT): string {
  if (typeof value !== 'string' || value === '') throw corrupt(`迁移记录缺少字段 ${field}`, field);
  return value;
}

/** 读摘要字段。 */
function digestOf(value: string, field: string, corrupt: CorruptFactory = JOB_CORRUPT): string {
  if (typeof value !== 'string' || value === '') throw corrupt(`迁移记录缺少字段 ${field}`, field);
  return value;
}

/** 读非负整数字段。 */
function countOf(value: number, field: string, corrupt: CorruptFactory = JOB_CORRUPT): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(`迁移记录的 ${field} 不是非负整数`, field);
  }
  return value;
}

/** 读任务状态；未知取值直接抛出。 */
function stateOf(value: string): MigrationJobRecord['state'] {
  if ((JOB_STATES as readonly string[]).includes(value)) return value as MigrationJobRecord['state'];
  throw new Error(`迁移任务的状态非法：${value}`);
}
