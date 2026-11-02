/**
 * 旧 SQLite 控制平面数据源与导入目标。
 *
 * 源以只读方式打开：`DatabaseSync` 的 `readOnly` 选项让任何写入语句在数据库层面失败，复制
 * 期间源文件不会被改动。行按已知表逐个读出，附件与对象引用不在这批表里，也不进入数据库。
 * 目标写入保留原有标识与代次，重复导入时同主键按覆盖写回，摘要不一致就拒绝。
 * @module @chatdsh/gateway/postgres/sqlite-source
 */

import { DatabaseSync } from 'node:sqlite';
import type { SqlExecutor, SqlParameter, SqlRow } from '../storage/sqlite.ts';
import type { UsageRecord } from './control-plane.ts';
import { POSTGRES_STORAGE_ERROR_CODES, PostgresStorageError } from './errors.ts';
import { integerOf } from './pg-module.ts';

/** 目标读出的一行。 */
type StoredRow = Readonly<Record<string, unknown>>;

/** 一张已知表的列定义。 */
export interface TableDefinition {
  /** 表名。 */
  readonly name: string;
  /** 主键列。 */
  readonly primaryKey: readonly string[];
  /** 全部列。 */
  readonly columns: readonly string[];
  /** 整数列。 */
  readonly integerColumns: readonly string[];
  /** 数组列。 */
  readonly arrayColumns?: readonly string[];
}

/** 旧控制平面的表清单；顺序即复制顺序。 */
export const CONTROL_PLANE_TABLES: readonly TableDefinition[] = [
  {
    name: 'operations',
    primaryKey: ['operation_id'],
    columns: ['operation_id', 'request_digest', 'device_id', 'state', 'result_ref', 'created_at', 'expires_at'],
    integerColumns: ['created_at', 'expires_at'],
  },
  {
    name: 'access_sessions',
    primaryKey: ['token_hash'],
    columns: ['token_hash', 'created_at', 'expires_at', 'revoked_at', 'last_verified_at'],
    integerColumns: ['created_at', 'expires_at', 'revoked_at', 'last_verified_at'],
  },
  {
    name: 'device_generations',
    primaryKey: ['device_id'],
    columns: ['device_id', 'generation', 'token_digest', 'revoked_at'],
    integerColumns: ['generation', 'revoked_at'],
  },
  {
    name: 'pairing_codes',
    primaryKey: ['digest'],
    columns: ['digest', 'role', 'expires_at', 'consumed_at'],
    integerColumns: ['expires_at', 'consumed_at'],
  },
  {
    name: 'replica_cursors',
    primaryKey: ['session_id'],
    columns: ['session_id', 'retention_generation', 'continuous_seq', 'digest'],
    integerColumns: ['retention_generation', 'continuous_seq'],
  },
  {
    name: 'replica_outbox',
    primaryKey: ['session_id', 'seq'],
    columns: ['session_id', 'seq', 'digest', 'retention_generation'],
    integerColumns: ['seq', 'retention_generation'],
  },
  {
    name: 'run_inbox',
    primaryKey: ['run_id', 'event_id'],
    columns: ['run_id', 'event_id', 'seq', 'payload_ref', 'applied_at'],
    integerColumns: ['seq', 'applied_at'],
  },
  {
    name: 'memory_outbox',
    primaryKey: ['operation_id'],
    columns: ['operation_id', 'session_id', 'end_seq', 'bank', 'state', 'attempts', 'next_attempt_at'],
    integerColumns: ['end_seq', 'attempts', 'next_attempt_at'],
  },
  {
    name: 'notification_outbox',
    primaryKey: ['key'],
    columns: ['key', 'client_id', 'state', 'tag', 'expires_at'],
    integerColumns: ['expires_at'],
  },
  {
    name: 'backup_manifests',
    primaryKey: ['manifest_id'],
    columns: ['manifest_id', 'schema_version', 'created_at', 'domains', 'key_version', 'manifest_ref'],
    integerColumns: ['schema_version', 'created_at'],
    arrayColumns: ['domains'],
  },
];

/**
 * 用量表不参与整行复制：用量经 `recordUsage` 幂等写入，由唯一约束保证不重复计账。
 * @see SqliteControlPlaneSource.usage
 */

/** 一条待复制的记录。 */
export interface ControlPlaneRecord {
  /** 表名。 */
  readonly table: string;
  /** 行内容，键为列名。 */
  readonly row: Readonly<Record<string, string | number | null | readonly string[]>>;
}

/** 只读的 SQLite 控制平面源。 */
export class SqliteControlPlaneSource {
  /** 源文件路径。 */
  readonly path: string;
  /** 源以只读方式打开。 */
  readonly readOnly = true as const;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.database = new DatabaseSync(path, { readOnly: true });
  }

  /** 读出全部已知表的行，按表清单顺序。 */
  read(): readonly ControlPlaneRecord[] {
    const records: ControlPlaneRecord[] = [];
    for (const table of CONTROL_PLANE_TABLES) {
      if (!this.tableExists(table.name)) continue;
      const rows = this.database.prepare(`select * from ${table.name}`).all() as Record<string, unknown>[];
      for (const raw of rows) {
        const row: Record<string, string | number | null | readonly string[]> = {};
        for (const column of table.columns) {
          const value = raw[column];
          if (table.integerColumns.includes(column)) {
            row[column] = value === null || value === undefined ? null : integerOf(value, column);
          } else if (table.arrayColumns?.includes(column) === true) {
            row[column] = typeof value === 'string' ? parseArray(value) : [];
          } else {
            row[column] = value === null || value === undefined ? null : String(value);
          }
        }
        records.push({ table: table.name, row });
      }
    }
    return records;
  }

  /** 读出用量行。 */
  usage(): readonly UsageRecord[] {
    if (!this.tableExists('usage_ledger')) return [];
    const rows = this.database
      .prepare(
        `select session_id, turn, workspace_id, model, provider, input_tokens, output_tokens,
                cached_tokens, reasoning_tokens, recorded_at
           from usage_ledger order by session_id asc, turn asc`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      turn: integerOf(row.turn, 'turn'),
      ...(row.workspace_id === null || row.workspace_id === undefined
        ? {}
        : { workspaceId: String(row.workspace_id) }),
      model: String(row.model),
      provider: String(row.provider),
      inputTokens: integerOf(row.input_tokens, 'input_tokens'),
      outputTokens: integerOf(row.output_tokens, 'output_tokens'),
      cachedTokens: integerOf(row.cached_tokens, 'cached_tokens'),
      reasoningTokens: integerOf(row.reasoning_tokens, 'reasoning_tokens'),
      recordedAt: integerOf(row.recorded_at, 'recorded_at'),
    }));
  }

  /** 判断一张表是否存在。 */
  tableExists(table: string): boolean {
    const row = this.database
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .get(table) as { name: string } | undefined;
    return row !== undefined;
  }

  /** 表的行数。 */
  count(table: string): number {
    if (!this.tableExists(table)) return 0;
    const row = this.database.prepare(`select count(*) as n from ${table}`).get() as { n: number };
    return integerOf(row.n, 'n');
  }

  /** 关闭源文件。 */
  close(): void {
    this.database.close();
  }
}

/** 把 SQLite 里的数组文本解析成字符串数组。 */
function parseArray(text: string): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`数组列的取值不是数组：${trimmed}`);
    return parsed.map((item) => String(item));
  }
  if (trimmed === '') return [];
  return trimmed.split(',').map((item) => item.replace(/^"|"$/g, ''));
}

/** 把一条记录写成目标表的一行；同主键覆盖。 */
export function writeControlPlaneRecord(executor: SqlExecutor, record: ControlPlaneRecord): void {
  const table = CONTROL_PLANE_TABLES.find((candidate) => candidate.name === record.table);
  if (table === undefined) {
    throw new PostgresStorageError(
      POSTGRES_STORAGE_ERROR_CODES.sourceInvalid,
      `导入遇到未登记的表：${record.table}`,
    );
  }
  const placeholders = table.columns.map(() => '?').join(', ');
  const assignments = table.columns
    .filter((column) => !table.primaryKey.includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const values: SqlParameter[] = table.columns.map((column) => {
    const value = record.row[column];
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') return `{${value.map((item) => `"${item.replaceAll('"', '""')}"`).join(',')}}`;
    return value;
  });
  executor.run(
    `insert into ${table.name} (${table.columns.join(', ')}) values (${placeholders})
     on conflict (${table.primaryKey.join(', ')}) do ${assignments === '' ? 'nothing' : `update set ${assignments}`}`,
    values,
  );
}

/** 读回一批记录，用于摘要比对。 */
export function readControlPlaneRecord(
  executor: SqlExecutor,
  table: TableDefinition,
  row: Readonly<Record<string, string | number | null | readonly string[]>>,
): StoredRow | undefined {
  const where = table.primaryKey.map((column) => `${column} = ?`).join(' and ');
  const parameters: SqlParameter[] = table.primaryKey.map((column) => {
    const value = row[column];
    if (value === undefined || value === null) return null;
    return typeof value === 'object' ? value.join(',') : value;
  });
  return executor.get<SqlRow>(
    `select ${table.columns.join(', ')} from ${table.name} where ${where}`,
    parameters,
  ) as StoredRow | undefined;
}
