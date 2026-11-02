/**
 * 会话检索的 Postgres 实现。
 *
 * 每个事件折叠成一条检索文档（会话、序号、种类、时刻、语义文本），`to_tsvector('simple')`
 * 建 GIN 索引。查询用 `websearch_to_tsquery` 把输入当数据解释，永不作为可执行语法；排序用
 * `ts_rank`，摘要用 `ts_headline`，分页用不透明游标。这些与 SQLite FTS5 的排序与摘要等价。
 *
 * 索引摘要按 `(会话, 序号, 种类, 文本)` 逐行计算，供迁移前后比对。
 * @module @chatdsh/gateway/postgres/search
 */

import { createHash } from 'node:crypto';
import type { SqlExecutor, SqlRow } from '../storage/sqlite.ts';
import { integerOf } from './pg-module.ts';

/** 一条检索文档。 */
export interface SearchDocument {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 事件序号。 */
  readonly seq: number;
  /** 事件种类。 */
  readonly kind: string;
  /** 事件时刻的毫秒时间戳。 */
  readonly time: number;
  /** 参与检索的语义文本。 */
  readonly content: string;
}

/** 一条命中。 */
export interface SearchHit {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 事件序号。 */
  readonly seq: number;
  /** 事件种类。 */
  readonly kind: string;
  /** 事件时刻。 */
  readonly time: number;
  /** 相关度分数。 */
  readonly score: number;
  /** 命中位置附近的纯文本摘要。 */
  readonly snippet: string;
}

/** 一页结果。 */
export interface SearchPage {
  /** 本页命中。 */
  readonly items: readonly SearchHit[];
  /** 下一页游标；没有更多时缺省。 */
  readonly nextCursor?: string;
}

/** 查询选项。 */
export interface SearchOptions {
  /** 本页最多返回的条数，缺省 20。 */
  readonly limit?: number;
  /** 上一次返回的游标。 */
  readonly cursor?: string;
  /** 限定某个会话。 */
  readonly sessionId?: string;
}

/** Postgres 检索索引。 */
export class PostgresSearchIndex {
  private readonly database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.database = database;
  }

  /** 建表与索引；可重复执行。 */
  ensureSchema(): void {
    this.database.exec(`
      create table if not exists search_documents (
        session_id text not null,
        seq integer not null,
        kind text not null,
        time bigint not null,
        content text not null,
        primary key (session_id, seq)
      )
    `);
    this.database.exec(`
      create index if not exists search_documents_fts_idx
        on search_documents using gin (to_tsvector('simple', content))
    `);
  }

  /**
   * 写入一批检索文档；同一 (会话, 序号) 重复写入幂等。
   *
   * @param documents - 检索文档。
   */
  index(documents: readonly SearchDocument[]): void {
    for (const document of documents) {
      if (document.sessionId === '') throw new Error('检索文档缺少会话标识');
      if (!Number.isSafeInteger(document.seq) || document.seq < 0) {
        throw new Error(`检索文档的序号必须是非负整数，实际 ${String(document.seq)}`);
      }
      this.database.run(
        `insert into search_documents (session_id, seq, kind, time, content) values (?, ?, ?, ?, ?)
         on conflict (session_id, seq) do update set kind = excluded.kind, time = excluded.time, content = excluded.content`,
        [document.sessionId, document.seq, document.kind, document.time, document.content],
      );
    }
  }

  /**
   * 全文检索。
   *
   * @param query - 查询文本，按数据解释。
   * @param options - 条数、游标与会话限制。
   * @returns 一页命中与下一页游标。
   */
  search(query: string, options: SearchOptions = {}): SearchPage {
    const trimmed = query.trim();
    if (trimmed === '') return { items: [] };
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`检索条数必须是正整数，实际 ${String(limit)}`);
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`检索游标非法：${options.cursor ?? ''}`);
    const rows = this.database.all<SqlRow>(
      `select session_id, seq, kind, time,
              ts_rank(to_tsvector('simple', content), websearch_to_tsquery('simple', ?)) as score,
              ts_headline('simple', content, websearch_to_tsquery('simple', ?),
                          'MaxFragments=1,MaxWords=32,MinWords=8,StartSel=,StopSel=') as snippet
         from search_documents
        where to_tsvector('simple', content) @@ websearch_to_tsquery('simple', ?)
          ${options.sessionId === undefined ? '' : 'and session_id = ?'}
        order by score desc, session_id asc, seq asc
        offset ? limit ?`,
      options.sessionId === undefined
        ? [trimmed, trimmed, trimmed, offset, limit + 1]
        : [trimmed, trimmed, trimmed, options.sessionId, offset, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => ({
        sessionId: String(row.session_id),
        seq: integerOf(row.seq, 'seq'),
        kind: String(row.kind),
        time: integerOf(row.time, 'time'),
        score: Number(row.score),
        snippet: String(row.snippet),
      })),
      ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  /**
   * 索引摘要：按 `(会话, 序号, 种类, 文本)` 逐行累加。
   *
   * @returns 十六进制摘要。
   */
  digest(): string {
    const hash = createHash('sha256');
    for (const row of this.database.all<SqlRow>(
      `select session_id, seq, kind, content from search_documents order by session_id asc, seq asc`,
    )) {
      hash.update(`${String(row.session_id)}\u0000${integerOf(row.seq, 'seq')}\u0000${String(row.kind)}\u0000${String(row.content)}\u0001`);
    }
    return hash.digest('hex');
  }

  /**
   * 索引行数。
   *
   * @param sessionId - 可选会话标识。
   * @returns 行数。
   */
  count(sessionId?: string): number {
    const row = this.database.get<SqlRow>(
      `select count(*) as n from search_documents ${sessionId === undefined ? '' : 'where session_id = ?'}`,
      sessionId === undefined ? [] : [sessionId],
    );
    return row === undefined ? 0 : integerOf(row.n, 'n');
  }
}
