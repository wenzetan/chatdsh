/**
 * 导出任务的持久化。
 *
 * 任务行写进控制平面数据库的同一条连接，表由本模块建立并核对列：缺列就地拒绝，不在残缺的
 * 表上继续跑生命周期。行里只放范围、状态、计数、附件清单与文件名，文件字节写在导出包目录。
 * 事件序号、副本水位与内部存储键都不出现在对外视图形状里。
 * @module @chatdsh/gateway/exports/store
 */

import type { DatabaseSync } from 'node:sqlite';
import { ChatdshError, CHATDSH_ERROR_CODES, type ExportScope } from '@chatdsh/core-contracts';

/** 导出任务依赖的表与列。 */
export const EXPORT_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  export_jobs: [
    'job_id',
    'operation_id',
    'request_digest',
    'state',
    'format',
    'source_kind',
    'source_id',
    'source_version',
    'private_export',
    'event_count',
    'char_count',
    'bytes',
    'attachments_json',
    'scope_json',
    'created_at',
    'completed_at',
    'expires_at',
    'code',
    'filename',
    'storage_key',
    'content_type',
  ],
};

/** 一条导出任务行。 */
export interface ExportJobRow {
  readonly job_id: string;
  readonly operation_id: string;
  readonly request_digest: string;
  readonly state: string;
  readonly format: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly source_version: number | null;
  readonly private_export: number;
  readonly event_count: number;
  readonly char_count: number;
  readonly bytes: number;
  readonly attachments_json: string;
  readonly scope_json: string;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly expires_at: number | null;
  readonly code: string | null;
  readonly filename: string | null;
  readonly storage_key: string | null;
  readonly content_type: string | null;
}

/** 写入一条任务所需的字段。 */
export interface ExportJobInsert {
  readonly jobId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly state: string;
  readonly exportScope: ExportScope;
  readonly eventCount: number;
  readonly charCount: number;
  readonly bytes: number;
  readonly attachmentsJson: string;
  readonly createdAt: number;
}

/** 更新任务时可写的字段。 */
export interface ExportJobPatch {
  readonly state?: string;
  readonly bytes?: number;
  readonly completedAt?: number;
  readonly expiresAt?: number;
  readonly code?: string;
  readonly filename?: string;
  readonly storageKey?: string;
  readonly contentType?: string;
}

/** 建表语句。 */
const CREATE_TABLE = `
  create table if not exists export_jobs (
    job_id text primary key,
    operation_id text not null,
    request_digest text not null,
    state text not null,
    format text not null,
    source_kind text not null,
    source_id text not null,
    source_version integer,
    private_export integer not null,
    event_count integer not null,
    char_count integer not null,
    bytes integer not null,
    attachments_json text not null,
    scope_json text not null,
    created_at integer not null,
    completed_at integer,
    expires_at integer,
    code text,
    filename text,
    storage_key text,
    content_type text
  );
  create unique index if not exists export_jobs_operation on export_jobs(operation_id);
`;

/** 一张表的列名。 */
function columnsOf(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`select name from pragma_table_info('${table}')`).all() as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * 建立并核对导出任务表。
 * @param database - 控制平面数据库连接。
 * @throws 缺表或缺列时就地拒绝。
 */
export function ensureExportSchema(database: DatabaseSync): void {
  database.exec(CREATE_TABLE);
  for (const [table, columns] of Object.entries(EXPORT_SCHEMA)) {
    const existing = columnsOf(database, table);
    if (existing.length === 0) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `导出任务缺少表 ${table}`);
    }
    const missing = columns.filter((column) => !existing.includes(column));
    if (missing.length > 0) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `表 ${table} 缺列：${missing.join('、')}`);
    }
  }
}

/** 导出任务的读写。 */
export class ExportJobStore {
  constructor(private readonly database: DatabaseSync) {
    ensureExportSchema(database);
  }

  /**
   * 写一条任务。
   * @param job - 任务字段。
   */
  insert(job: ExportJobInsert): void {
    const source = job.exportScope.source;
    this.database.prepare(`insert into export_jobs (
        job_id, operation_id, request_digest, state, format, source_kind, source_id, source_version,
        private_export, event_count, char_count, bytes, attachments_json, scope_json, created_at,
        completed_at, expires_at, code, filename, storage_key, content_type
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, null)`)
      .run(
        job.jobId,
        job.operationId,
        job.requestDigest,
        job.state,
        job.exportScope.format,
        source.kind,
        source.kind === 'session' ? source.sessionId : source.artifactId,
        source.kind === 'artifact' ? source.version : null,
        job.exportScope.privateExport ? 1 : 0,
        job.eventCount,
        job.charCount,
        job.bytes,
        job.attachmentsJson,
        JSON.stringify(job.exportScope),
        job.createdAt,
      );
  }

  /**
   * 更新一条任务。
   * @param jobId - 任务标识。
   * @param patch - 要写的字段。
   */
  update(jobId: string, patch: ExportJobPatch): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const push = (column: string, value: string | number | null | undefined): void => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    push('state', patch.state);
    push('bytes', patch.bytes);
    push('completed_at', patch.completedAt);
    push('expires_at', patch.expiresAt);
    push('code', patch.code);
    push('filename', patch.filename);
    push('storage_key', patch.storageKey);
    push('content_type', patch.contentType);
    if (sets.length === 0) return;
    values.push(jobId);
    this.database.prepare(`update export_jobs set ${sets.join(', ')} where job_id = ?`).run(...values);
  }

  /**
   * 按标识取任务。
   * @param jobId - 任务标识。
   * @returns 任务行；不存在时为空。
   */
  byId(jobId: string): ExportJobRow | undefined {
    return this.database.prepare('select * from export_jobs where job_id = ?').get(jobId) as unknown as ExportJobRow | undefined;
  }

  /**
   * 按操作标识取任务。
   * @param operationId - 操作标识。
   * @returns 任务行；不存在时为空。
   */
  byOperation(operationId: string): ExportJobRow | undefined {
    return this.database
      .prepare('select * from export_jobs where operation_id = ?')
      .get(operationId) as unknown as ExportJobRow | undefined;
  }

  /**
   * 列出最近的任务。
   * @param limit - 最多返回的条数。
   * @returns 任务行，按建立时刻倒序。
   */
  list(limit: number): ExportJobRow[] {
    return this.database
      .prepare('select * from export_jobs order by created_at desc limit ?')
      .all(limit) as unknown as ExportJobRow[];
  }
}
