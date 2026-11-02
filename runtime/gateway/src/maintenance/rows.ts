/**
 * 数据维护读写的表结构与行读取。
 *
 * 控制平面的 schema 由存储入口建立，这里只读它并核对必需的表与列：缺表缺列就地拒绝，不在
 * 残缺的库上继续算清理与删除。副本行同时保存排序用标量与完整事件，读取时把两者都取出来。
 * @module @chatdsh/gateway/maintenance/rows
 */

import type { DatabaseSync } from 'node:sqlite';
import { ChatdshError, CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';

/** 数据维护依赖的表与列。 */
export const MAINTENANCE_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  sessions: ['session_id', 'workspace_id', 'device_id', 'cwd', 'kind', 'created_at', 'parent_session', 'deleted_at'],
  replica_events: ['session_id', 'seq', 'kind', 'time', 'bytes', 'payload'],
  replica_watermarks: ['session_id', 'watermark', 'updated_at'],
  shares: ['token', 'session_id', 'up_to_seq', 'created_at', 'expires_at', 'revoked_at', 'visits'],
  read_receipts: ['session_id', 'device_id', 'read_up_to_seq', 'updated_at'],
  settings: ['namespace', 'key', 'value', 'updated_at'],
};

/** 一条会话归属行。 */
export interface SessionRow {
  readonly session_id: string;
  readonly workspace_id: string | null;
  readonly device_id: string;
  readonly cwd: string;
  readonly kind: string;
  readonly created_at: number;
  readonly parent_session: string | null;
  readonly deleted_at: number | null;
}

/** 一条副本事件行。 */
export interface ReplicaEventRow {
  readonly session_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes: number;
  readonly payload: string | null;
}

/** 一条分享行。 */
export interface ShareRow {
  readonly token: string;
  readonly session_id: string;
  readonly up_to_seq: number;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly visits: number;
}

/** 一张表的列名。 */
function columnsOf(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`select name from pragma_table_info('${table}')`).all() as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * 核对数据维护依赖的表与列。
 * @param database - 控制平面数据库连接。
 * @throws 缺表或缺列时就地拒绝。
 */
export function assertMaintenanceSchema(database: DatabaseSync): void {
  for (const [table, columns] of Object.entries(MAINTENANCE_SCHEMA)) {
    const existing = columnsOf(database, table);
    if (existing.length === 0) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `控制平面数据库缺少表 ${table}`);
    }
    const missing = columns.filter((column) => !existing.includes(column));
    if (missing.length > 0) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `表 ${table} 缺列：${missing.join('、')}`);
    }
  }
}

/**
 * 列出全部会话归属行，按创建时间倒序。
 * @param database - 控制平面数据库连接。
 * @returns 会话归属行。
 */
export function sessionRows(database: DatabaseSync): SessionRow[] {
  return database
    .prepare('select session_id, workspace_id, device_id, cwd, kind, created_at, parent_session, deleted_at from sessions order by created_at desc')
    .all() as unknown as SessionRow[];
}

/**
 * 取一条会话归属行。
 * @param database - 控制平面数据库连接。
 * @param sessionId - 会话标识。
 * @returns 会话归属行；不存在时为空。
 */
export function sessionRowOf(database: DatabaseSync, sessionId: string): SessionRow | undefined {
  return database
    .prepare('select session_id, workspace_id, device_id, cwd, kind, created_at, parent_session, deleted_at from sessions where session_id = ?')
    .get(sessionId) as unknown as SessionRow | undefined;
}

/**
 * 取一条会话的副本事件，按序号升序。
 * @param database - 控制平面数据库连接。
 * @param sessionId - 会话标识。
 * @returns 副本事件行。
 */
export function replicaEventsOf(database: DatabaseSync, sessionId: string): ReplicaEventRow[] {
  return database
    .prepare('select session_id, seq, kind, time, bytes, payload from replica_events where session_id = ? order by seq asc')
    .all(sessionId) as unknown as ReplicaEventRow[];
}

/**
 * 取一条会话副本的标题。
 * @param database - 控制平面数据库连接。
 * @param sessionId - 会话标识。
 * @returns 标题；没有标题事件时为空。
 */
export function replicaTitleOf(database: DatabaseSync, sessionId: string): string | undefined {
  const rows = database
    .prepare("select payload from replica_events where session_id = ? and kind = 'session/title' order by seq desc")
    .all(sessionId) as unknown as { payload: string | null }[];
  for (const row of rows) {
    if (row.payload === null) continue;
    const parsed: unknown = JSON.parse(row.payload);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const data = (parsed as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null) continue;
    const title = (data as { title?: unknown }).title;
    if (typeof title === 'string' && title !== '') return title;
  }
  return undefined;
}

/**
 * 取一条会话副本的真实事件字节数。
 * @param database - 控制平面数据库连接。
 * @param sessionId - 会话标识。
 * @returns 事件载荷的字节数之和。
 */
export function replicaPayloadBytesOf(database: DatabaseSync, sessionId: string): number {
  const row = database
    .prepare('select coalesce(sum(length(cast(payload as blob))), 0) as bytes from replica_events where session_id = ?')
    .get(sessionId) as { bytes: number } | undefined;
  return row?.bytes ?? 0;
}

/**
 * 数一条会话的有效分享。
 * @param database - 控制平面数据库连接。
 * @param sessionId - 会话标识。
 * @param now - 判定有效性的时刻。
 * @returns 有效分享条数。
 */
export function activeShareCountOf(database: DatabaseSync, sessionId: string, now: number): number {
  const row = database
    .prepare(`select count(*) as total from shares
              where session_id = ? and revoked_at is null and (expires_at is null or expires_at > ?)`)
    .get(sessionId, now) as { total: number } | undefined;
  return row?.total ?? 0;
}

/**
 * 取一条会话的有效分享记录。
 * @param database - 控制平面数据库连接。
 * @param sessionId - 会话标识。
 * @param now - 判定有效性的时刻。
 * @returns 有效分享行。
 */
export function activeSharesOf(database: DatabaseSync, sessionId: string, now: number): ShareRow[] {
  return database
    .prepare(`select token, session_id, up_to_seq, created_at, expires_at, revoked_at, visits from shares
              where session_id = ? and revoked_at is null and (expires_at is null or expires_at > ?) order by created_at desc`)
    .all(sessionId, now) as unknown as ShareRow[];
}

/**
 * 列出由一个会话导入而来、尚未删除的子会话。
 * @param database - 控制平面数据库连接。
 * @param sessionId - 源会话标识。
 * @returns 子会话归属行。
 */
export function childSessionsOf(database: DatabaseSync, sessionId: string): SessionRow[] {
  return database
    .prepare('select session_id, workspace_id, device_id, cwd, kind, created_at, parent_session, deleted_at from sessions where parent_session = ? and deleted_at is null order by created_at asc')
    .all(sessionId) as unknown as SessionRow[];
}

/**
 * 数据库文件的口径：页数乘页大小。
 * @param database - 控制平面数据库连接。
 * @returns 数据库文件字节数。
 */
export function databaseFileBytes(database: DatabaseSync): number {
  const pageCount = database.prepare('select page_count as value from pragma_page_count').get() as { value: number } | undefined;
  const pageSize = database.prepare('select page_size as value from pragma_page_size').get() as { value: number } | undefined;
  if (pageCount === undefined || pageSize === undefined) {
    throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, '读取数据库页信息失败');
  }
  return pageCount.value * pageSize.value;
}

/**
 * 按表统计真实占用页字节。
 * @param database - 控制平面数据库连接。
 * @returns 表名到页字节数的映射。
 */
export function tablePageBytes(database: DatabaseSync): Map<string, number> {
  const rows = database.prepare('select name, sum(pgsize) as bytes from dbstat group by name').all() as unknown as { name: string; bytes: number }[];
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.name, row.bytes);
  return out;
}
