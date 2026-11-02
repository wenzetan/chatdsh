/**
 * 会话后端的表结构与 schema 版本闸门。
 *
 * 会话头与事件分开存：`sessions` 保存不可变的头与聚合计数，`session_events` 只追加，
 * 主键 `(session_id, seq)` 保证同一序号只有一份内容。写所有权落在 `session_writers`：
 * 一行一个会话，`fencing_token` 每次换手递增，旧持有者的令牌立刻失配。
 *
 * 未知的较新 schema 版本拒绝写入，与 SYS01 的迁移登记语义一致。
 * @module @chatdsh/core-session-persistence-postgres/schema
 */

import type { PgClient, PgPool } from './pg.ts';

/** 本实现认识的最高 schema 版本。 */
export const POSTGRES_SCHEMA_VERSION = 1;

/** 元数据表名。 */
export const META_TABLE = 'session_backend_meta';

/** 会话头表名。 */
export const SESSIONS_TABLE = 'sessions';

/** 事件表名。 */
export const EVENTS_TABLE = 'session_events';

/** 写所有权表名。 */
export const WRITERS_TABLE = 'session_writers';

/** 执行器：连接池或单连接都有 `query`。 */
export type Queryable = Pick<PgPool, 'query'> | Pick<PgClient, 'query'>;

/** schema 名必须是安全的标识符，否则拼进 SQL 会改变语义。 */
export function requireSchemaName(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Postgres schema 名非法：${schema}`);
  }
  return schema;
}

/** 建 schema 与全部表；可重复执行。 */
export async function ensureSchema(executor: Queryable, schema: string): Promise<void> {
  await executor.query(`create schema if not exists "${schema}"`);
  await executor.query(
    `create table if not exists "${schema}".${META_TABLE} (
       name text primary key,
       value text not null
     )`,
  );
  await executor.query(
    `create table if not exists "${schema}".${SESSIONS_TABLE} (
       id text primary key,
       header jsonb not null,
       parent_session text,
       inherited_count integer not null default 0,
       created_at bigint not null,
       last_activity_at bigint not null,
       event_count integer not null default 0,
       deleted_at bigint
     )`,
  );
  await executor.query(
    `create table if not exists "${schema}".${EVENTS_TABLE} (
       session_id text not null references "${schema}".${SESSIONS_TABLE}(id) on delete cascade,
       seq integer not null,
       time bigint not null,
       kind text not null,
       event jsonb not null,
       primary key (session_id, seq)
     )`,
  );
  await executor.query(
    `create table if not exists "${schema}".${WRITERS_TABLE} (
       session_id text primary key,
       owner_id text not null,
       fencing_token bigint not null,
       lease_expires_at bigint not null,
       heartbeat_at bigint not null
     )`,
  );
  // 列表按创建时刻排序、按工作目录过滤；后写入的会话排在后面。
  await executor.query(
    `create index if not exists "${schema}_sessions_created_idx" on "${schema}".${SESSIONS_TABLE} (created_at desc, id)`,
  );
  await executor.query(
    `create index if not exists "${schema}_sessions_cwd_idx" on "${schema}".${SESSIONS_TABLE} ((header->>'cwd'))`,
  );
  await executor.query(
    `create index if not exists "${schema}_sessions_parent_idx" on "${schema}".${SESSIONS_TABLE} (parent_session)`,
  );
}

/** 写入或核对 schema 版本；库里的版本更新时拒绝使用。 */
export async function assertSchemaVersion(executor: Queryable, schema: string): Promise<void> {
  const existing = await executor.query(
    `select value from "${schema}".${META_TABLE} where name = 'schema_version'`,
  );
  const raw = existing.rows[0]?.value;
  if (raw === undefined) {
    await executor.query(
      `insert into "${schema}".${META_TABLE} (name, value) values ('schema_version', $1)
       on conflict (name) do nothing`,
      [String(POSTGRES_SCHEMA_VERSION)],
    );
    return;
  }
  const stored = Number(raw);
  if (!Number.isSafeInteger(stored) || stored < 1) {
    throw new Error(`Postgres 会话后端的 schema 版本记录非法：${String(raw)}`);
  }
  if (stored > POSTGRES_SCHEMA_VERSION) {
    throw new Error(
      `Postgres 会话后端的 schema 版本 ${stored} 高于本实现支持的 ${POSTGRES_SCHEMA_VERSION}，拒绝写入；请升级运行时`,
    );
  }
}
