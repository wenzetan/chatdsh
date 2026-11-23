import { DatabaseSync } from 'node:sqlite';

/** SQL 参数允许的原始类型。 */
export type SqlParameter = string | number | bigint | Uint8Array | null;

/** 一行查询结果。 */
export type SqlRow = Record<string, unknown>;

/** 最小 SQL 执行接口，供连续副本与控制平面共用同一把连接。 */
export interface SqlExecutor {
  exec(sql: string): void;
  all<T extends SqlRow>(sql: string, parameters?: readonly SqlParameter[]): T[];
  get<T extends SqlRow>(sql: string, parameters?: readonly SqlParameter[]): T | undefined;
  run(sql: string, parameters?: readonly SqlParameter[]): void;
  transaction<T>(fn: () => T): T;
  tableExists(table: string): boolean;
}

/** 包装 `node:sqlite` 的同步执行器。 */
export class SqliteDatabase implements SqlExecutor {
  private readonly database: DatabaseSync;
  private depth = 0;

  constructor(path: string | DatabaseSync) {
    this.database = typeof path === 'string' ? new DatabaseSync(path) : path;
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

  tableExists(table: string): boolean {
    const row = this.database
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .get(table) as { name: string } | undefined;
    return row !== undefined;
  }

  close(): void {
    this.database.close();
  }
}
