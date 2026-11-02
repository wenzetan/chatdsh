/**
 * 存储接口的 SQL 执行端口与 SQLite 实现。
 *
 * 迁移登记、任务记录与验证都只依赖 `SqlExecutor`，换 Postgres 时实现同一端口即可。
 * SQLite 实现基于 `node:sqlite`，可在只读模式下打开，源数据在切换前一直以只读连接访问。
 * @module @chatdsh/gateway/storage/sqlite
 */

import { DatabaseSync } from 'node:sqlite';

/** 单个参数值。 */
export type SqlParameter = string | number | bigint | null | Uint8Array;

/** 一行结果。 */
export type SqlRow = Readonly<Record<string, SqlParameter>>;

/** SQL 执行端口。 */
export interface SqlExecutor {
  /** 执行一段不含参数的 SQL。 */
  exec(sql: string): void;
  /** 取全部结果行。 */
  all<T extends SqlRow>(sql: string, parameters?: readonly SqlParameter[]): T[];
  /** 取第一行。 */
  get<T extends SqlRow>(sql: string, parameters?: readonly SqlParameter[]): T | undefined;
  /** 执行一条写入语句。 */
  run(sql: string, parameters?: readonly SqlParameter[]): void;
  /** 在一个写事务里执行；回调抛出时回滚并继续抛出。 */
  transaction<T>(fn: () => T): T;
  /** 判断一张表是否存在。 */
  tableExists(table: string): boolean;
}

/** SQLite 存储数据库。 */
export class SqliteDatabase implements SqlExecutor {
  /** 数据库文件路径。 */
  readonly path: string;
  /** 是否以只读方式打开。 */
  readonly readOnly: boolean;
  private readonly database: DatabaseSync;
  private depth = 0;

  constructor(path: string, options: { readonly readOnly?: boolean } = {}) {
    this.path = path;
    this.readOnly = options.readOnly ?? false;
    this.database = new DatabaseSync(path, { readOnly: this.readOnly });
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  all<T extends SqlRow>(sql: string, parameters: readonly SqlParameter[] = []): T[] {
    return this.database.prepare(sql).all(...parameters) as T[];
  }

  get<T extends SqlRow>(sql: string, parameters: readonly SqlParameter[] = []): T | undefined {
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }

  run(sql: string, parameters: readonly SqlParameter[] = []): void {
    this.database.prepare(sql).run(...parameters);
  }

  transaction<T>(fn: () => T): T {
    // 嵌套调用复用外层事务：迁移登记在一个事务里写入多行时不会重复开启。
    if (this.depth > 0) return fn();
    this.database.exec('begin immediate');
    this.depth += 1;
    try {
      const result = fn();
      this.database.exec('commit');
      return result;
    } catch (error) {
      this.database.exec('rollback');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  /** 释放底层句柄。 */
  close(): void {
    this.database.close();
  }

  tableExists(table: string): boolean {
    const row = this.database
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .get(table) as { name: string } | undefined;
    return row !== undefined;
  }
}
