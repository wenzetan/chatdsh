/**
 * 同步 SQL 执行端口在 Postgres 上的实现。
 *
 * 迁移登记、任务检查点与导入复制都只依赖 `SqlExecutor`，换引擎时实现同一端口即可。SQL 里
 * 的 `?` 占位符在这里转换成 Postgres 的 `$n`，字符串字面量与带引号的标识符原样保留。
 * 事务边界落在同步桥的那一条连接上，嵌套调用复用外层事务。
 * @module @chatdsh/gateway/postgres/executor
 */

import type { SqlExecutor, SqlParameter, SqlRow } from '../storage/sqlite.ts';
import { asUnavailable } from './pg-module.ts';
import type { SyncPostgres } from './sync-client.ts';

/** 把 `?` 占位符转换成 `$n`；跳过单引号字符串与双引号标识符。 */
export function toDollarPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let parameter = 0;
  let quote: string | undefined;
  while (index < sql.length) {
    const char = sql[index]!;
    if (quote !== undefined) {
      out += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          out += quote;
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '?') {
      parameter += 1;
      out += `$${parameter}`;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Postgres 上的同步 SQL 执行端口。 */
export class PostgresSqlExecutor implements SqlExecutor {
  private readonly client: SyncPostgres;
  private depth = 0;

  constructor(client: SyncPostgres) {
    this.client = client;
  }

  /** 执行一段不含参数的 SQL。 */
  exec(sql: string): void {
    this.run(sql);
  }

  /** 取全部结果行。 */
  all<T extends SqlRow>(sql: string, parameters: readonly SqlParameter[] = []): T[] {
    return this.query(sql, parameters).rows as T[];
  }

  /** 取第一行。 */
  get<T extends SqlRow>(sql: string, parameters: readonly SqlParameter[] = []): T | undefined {
    return this.query(sql, parameters).rows[0] as T | undefined;
  }

  /** 执行一条写入语句。 */
  run(sql: string, parameters: readonly SqlParameter[] = []): void {
    this.query(sql, parameters);
  }

  /** 在一个事务里执行；回调抛出时回滚并继续抛出。 */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.run('begin');
    this.depth += 1;
    try {
      const result = fn();
      this.run('commit');
      return result;
    } catch (error) {
      this.run('rollback');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  /** 判断一张表是否存在。 */
  tableExists(table: string): boolean {
    const rows = this.query(
      'select table_name from information_schema.tables where table_schema = current_schema() and table_name = $1',
      [table],
    ).rows;
    return rows.length > 0;
  }

  /** 执行一次查询，连接级错误包装成不可达。 */
  private query(sql: string, parameters: readonly SqlParameter[]) {
    try {
      return this.client.query(toDollarPlaceholders(sql), parameters);
    } catch (error) {
      throw asUnavailable(error, '执行控制平面 SQL');
    }
  }
}
