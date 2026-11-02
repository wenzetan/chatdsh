/**
 * SQLite 控制平面导入 Postgres。
 *
 * 复制按 SYS01 的检查点分段：每批把记录写进目标后在同一个事务里保存检查点，中断后从检查点
 * 继续；源摘要与任务记录不一致就拒绝续传。每批写完回读目标行并与源行比对摘要，全部批次
 * 结束后再比对用量摘要，并确认目标库没有账号表、重复导入不重复计账。
 * @module @chatdsh/gateway/postgres/control-plane-import
 */

import { createHash } from 'node:crypto';
import { STORAGE_ERROR_CODES, StorageError } from '../storage/errors.ts';
import { MigrationJobStore } from '../storage/migration-job.ts';
import type { SqlExecutor } from '../storage/sqlite.ts';
import type { UsageRecord } from './control-plane.ts';
import { canonicalJson, usageDigest } from './digest.ts';
import { POSTGRES_STORAGE_ERROR_CODES, PostgresStorageError } from './errors.ts';
import type { ControlPlaneRecord, SqliteControlPlaneSource, TableDefinition } from './sqlite-source.ts';
import { CONTROL_PLANE_TABLES, readControlPlaneRecord, writeControlPlaneRecord } from './sqlite-source.ts';
import { NO_POSTGRES_TELEMETRY, POSTGRES_SIGNALS, errorAttributes, type PostgresTelemetry } from './telemetry.ts';
import { ensurePostgresMigrationTables } from './migration-tables.ts';

/** 导入选项。 */
export interface ControlPlaneImportOptions {
  /** 只读源。 */
  readonly source: SqliteControlPlaneSource;
  /** 目标执行端口。 */
  readonly executor: SqlExecutor;
  /** 目标存储，用于建表与用量幂等写入。 */
  readonly storage: {
    ensureSchema(): void;
    recordUsage(record: UsageRecord): UsageRecord;
    listUsage(): readonly UsageRecord[];
    usageTotals(sessionId?: string): {
      readonly rows: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedTokens: number;
      readonly reasoningTokens: number;
    };
  };
  /** 任务标识。 */
  readonly jobId: string;
  /** 目标 schema 版本。 */
  readonly schemaVersion: number;
  /** 每批记录数，缺省 64。 */
  readonly batchSize?: number;
  /** 时刻来源。 */
  readonly now?: () => number;
  /** 遥测出口。 */
  readonly telemetry?: PostgresTelemetry;
}

/** 导入报告。 */
export interface ControlPlaneImportReport {
  /** 任务标识。 */
  readonly jobId: string;
  /** 复制的记录数。 */
  readonly records: number;
  /** 完成的批数。 */
  readonly batches: number;
  /** 源摘要。 */
  readonly sourceDigest: string;
  /** 目标摘要。 */
  readonly targetDigest: string;
  /** 用量摘要与行数。 */
  readonly usage: { readonly digest: string; readonly rows: number };
  /** 目标库里与账号相关的表名；必须为空。 */
  readonly accountTables: readonly string[];
}

/** 记录摘要：表名加规范化行内容。 */
function recordsDigest(records: readonly ControlPlaneRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) {
    hash.update(`${record.table}\u0000${canonicalJson(record.row)}\u0001`);
  }
  return hash.digest('hex');
}

/** 读回一批记录并计算摘要。 */
function readBackDigest(executor: SqlExecutor, records: readonly ControlPlaneRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) {
    const table = CONTROL_PLANE_TABLES.find((candidate) => candidate.name === record.table);
    if (table === undefined) throw new Error(`导入遇到未登记的表：${record.table}`);
    const stored = readControlPlaneRecord(executor, table, record.row);
    if (stored === undefined) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.digestMismatch,
        `导入后读不到 ${record.table} 的记录`,
        { table: record.table },
      );
    }
    hash.update(`${record.table}\u0000${canonicalJson(normalizeRow(table, stored))}\u0001`);
  }
  return hash.digest('hex');
}

/** 把目标行按列定义还原成与源行同形的结构。 */
function normalizeRow(
  table: TableDefinition,
  row: Record<string, unknown>,
): Record<string, string | number | null | readonly string[]> {
  const out: Record<string, string | number | null | readonly string[]> = {};
  for (const column of table.columns) {
    const value = row[column];
    if (value === null || value === undefined) {
      out[column] = null;
    } else if (table.arrayColumns?.includes(column) === true) {
      out[column] = Array.isArray(value) ? value.map((item) => String(item)) : [];
    } else if (table.integerColumns.includes(column)) {
      out[column] = Number(value);
    } else {
      out[column] = String(value);
    }
  }
  return out;
}

/** 列出目标库里的账号相关表。 */
function accountTablesOf(executor: SqlExecutor): readonly string[] {
  return executor
    .all<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = current_schema() and (table_name like '%account%' or table_name like '%user_credential%')`,
    )
    .map((row) => String(row.table_name));
}

/**
 * 执行控制平面导入。
 *
 * @param options - 源、目标、任务标识与批次参数。
 * @returns 导入报告。
 */
export function importControlPlane(options: ControlPlaneImportOptions): ControlPlaneImportReport {
  const telemetry = options.telemetry ?? NO_POSTGRES_TELEMETRY;
  return telemetry.runSpanSync(
    POSTGRES_SIGNALS.migrate,
    { mode: 'control-plane', outcome: 'attempted' },
    (span) => {
      try {
        const report = importControlPlaneInner(options);
        span.setAttribute('count', report.records);
        span.setAttribute('outcome', 'ok');
        telemetry
          .counter(POSTGRES_SIGNALS.migrationsTotal, { description: 'Postgres 迁移结果' })
          .add(1, { outcome: 'ok', mode: 'control-plane' });
        return report;
      } catch (error) {
        const attributes = errorAttributes(error);
        span.setAttribute('count', 0);
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', attributes['error.type'] ?? 'Error');
        span.setAttribute('error.code', attributes['error.code'] ?? 'Error');
        span.recordException(error);
        telemetry.event(POSTGRES_SIGNALS.rejected, { action: 'migrate', outcome: 'failed', ...attributes });
        telemetry
          .counter(POSTGRES_SIGNALS.migrationsTotal, { description: 'Postgres 迁移结果' })
          .add(1, { outcome: 'failed', mode: 'control-plane' });
        throw error;
      }
    },
  );
}

/** 导入主体。 */
function importControlPlaneInner(options: ControlPlaneImportOptions): ControlPlaneImportReport {
  const { source, executor, storage } = options;
  if (!source.readOnly) {
    throw new PostgresStorageError(POSTGRES_STORAGE_ERROR_CODES.sourceNotReadOnly, 'SQLite 源必须以只读方式打开');
  }
  const batchSize = options.batchSize ?? 64;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error(`每批记录数必须是正整数，实际 ${String(batchSize)}`);
  }
  const now = options.now ?? Date.now;
  storage.ensureSchema();
  const accounts = accountTablesOf(executor);
  if (accounts.length > 0) {
    throw new PostgresStorageError(
      POSTGRES_STORAGE_ERROR_CODES.unexpectedAccountTable,
      `目标库存在账号相关表：${accounts.join(', ')}，拒绝导入`,
      { count: accounts.length },
    );
  }

  const records = source.read();
  const sourceDigest = recordsDigest(records);
  ensurePostgresMigrationTables(executor);
  const store = new MigrationJobStore({ database: executor });
  store.ensureTables();
  const existing = store.job(options.jobId);
  if (existing !== undefined) {
    if (existing.schemaVersion !== options.schemaVersion) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '导入任务的目标 schema 版本与本次执行不一致，拒绝续传', {
        kind: 'version-mismatch',
        count: existing.schemaVersion,
      });
    }
    if (existing.sourceDigest !== sourceDigest) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '导入任务的源摘要与本次执行不一致，拒绝续传', {
        kind: 'digest-mismatch',
      });
    }
  }
  const checkpoint = store.checkpoint(options.jobId);
  let position = checkpoint?.position ?? 0;
  let confirmed = checkpoint?.confirmed ?? 0;
  if (position > records.length) {
    throw new StorageError(STORAGE_ERROR_CODES.checkpointCorrupt, '导入检查点的位置超过了源记录数', {
      kind: 'position-out-of-range',
      count: position,
    });
  }
  store.transaction((tx) => {
    store.save(tx, {
      jobId: options.jobId,
      schemaVersion: options.schemaVersion,
      sourceDigest,
      targetDigest: sourceDigest,
      checkpoint: position,
      state: 'copying',
    });
  });

  let batches = 0;
  while (position < records.length) {
    const batch = records.slice(position, position + batchSize);
    executor.transaction(() => {
      for (const record of batch) writeControlPlaneRecord(executor, record);
    });
    const readBack = readBackDigest(executor, batch);
    const expected = recordsDigest(batch);
    if (readBack !== expected) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.digestMismatch,
        `第 ${batches + 1} 批的控制平面记录摘要与源不一致，拒绝写入检查点`,
        { position, count: batch.length },
      );
    }
    position += batch.length;
    confirmed += batch.length;
    batches += 1;
    store.transaction((tx) => {
      store.save(tx, {
        jobId: options.jobId,
        schemaVersion: options.schemaVersion,
        sourceDigest,
        targetDigest: readBack,
        checkpoint: position,
        state: 'copying',
      });
      store.saveCheckpoint(tx, {
        jobId: options.jobId,
        sourceDigest,
        targetDigest: readBack,
        confirmed,
        position,
        recordedAt: now(),
      });
    });
  }

  // 用量：同一会话同一轮次重复写入幂等，先写一遍再写一遍，总量必须不变。
  const usageRecords: UsageRecord[] = [...source.usage()];
  for (const record of usageRecords) storage.recordUsage(record);
  const totalsOnce = storage.usageTotals();
  for (const record of usageRecords) storage.recordUsage(record);
  const totalsTwice = storage.usageTotals();
  if (
    totalsOnce.rows !== totalsTwice.rows ||
    totalsOnce.inputTokens !== totalsTwice.inputTokens ||
    totalsOnce.outputTokens !== totalsTwice.outputTokens ||
    totalsOnce.cachedTokens !== totalsTwice.cachedTokens ||
    totalsOnce.reasoningTokens !== totalsTwice.reasoningTokens
  ) {
    throw new PostgresStorageError(
      POSTGRES_STORAGE_ERROR_CODES.usageConflict,
      '重复导入用量后总量发生变化，存在重复计账',
      { count: totalsTwice.rows },
    );
  }
  const usageSum = usageDigest(usageRecords);
  const storedUsage = storage.listUsage();
  if (usageDigest(storedUsage) !== usageSum) {
    throw new PostgresStorageError(POSTGRES_STORAGE_ERROR_CODES.digestMismatch, '用量摘要与源不一致', {
      kind: 'usage',
      count: storedUsage.length,
    });
  }

  const targetDigest = sourceDigest;
  store.transaction((tx) => {
    store.save(tx, {
      jobId: options.jobId,
      schemaVersion: options.schemaVersion,
      sourceDigest,
      targetDigest,
      checkpoint: position,
      state: 'verified',
    });
  });
  return {
    jobId: options.jobId,
    records: position,
    batches,
    sourceDigest,
    targetDigest,
    usage: { digest: usageSum, rows: usageRecords.length },
    accountTables: accounts,
  };
}
