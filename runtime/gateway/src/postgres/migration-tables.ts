/**
 * 迁移任务表在 Postgres 上的建表语句。
 *
 * SYS01 的任务表默认按 SQLite 的整数列建表，时间戳是毫秒时间戳，超过了 Postgres `integer`
 * 的范围。这里先用 `bigint` 建好同名的三张表，`MigrationJobStore.ensureTables()` 的
 * `create table if not exists` 随后的执行就是空操作，任务与检查点语义保持不变。
 * @module @chatdsh/gateway/postgres/migration-tables
 */

import type { SqlExecutor } from '../storage/sqlite.ts';
import {
  MIGRATION_CHECKPOINT_TABLE,
  MIGRATION_JOB_TABLE,
  MIGRATION_SWITCH_TABLE,
} from '../storage/migration-job.ts';

/** 建迁移任务、检查点与切换记录三张表；可重复执行。 */
export function ensurePostgresMigrationTables(executor: SqlExecutor): void {
  executor.exec(`
    create table if not exists ${MIGRATION_JOB_TABLE} (
      job_id text primary key,
      schema_version integer not null,
      source_digest text not null,
      target_digest text not null,
      checkpoint bigint not null,
      state text not null,
      manifest_ref text
    )
  `);
  executor.exec(`
    create table if not exists ${MIGRATION_CHECKPOINT_TABLE} (
      job_id text primary key,
      source_digest text not null,
      target_digest text not null,
      confirmed bigint not null,
      position bigint not null,
      recorded_at bigint not null
    )
  `);
  executor.exec(`
    create table if not exists ${MIGRATION_SWITCH_TABLE} (
      job_id text primary key,
      report_digest text not null,
      active_path text not null,
      switched_at bigint not null
    )
  `);
}
