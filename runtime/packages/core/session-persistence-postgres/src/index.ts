/**
 * PostgreSQL 会话持久化后端。
 *
 * 会话头存 `sessions`，事件日志存 `session_events`，两者按 `session_id` 关联。写入沿用
 * 上游的契约：事件从 0 连续、只追加、flush 是耐久屏障。写所有权在当前进程内用 Map 维护，
 * 与上游的「单写者」语义一致；多进程部署需要额外的租约表。
 * @module @chatdsh/core-session-persistence-postgres
 */

import { createRequire } from 'node:module';
import {
  schema as z,
  SessionAlreadyOwnedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  materializeAppendBatch,
  materializeCreateHeader,
  type SessionHeader,
} from '@chatdsh/adapter';

const require = createRequire(import.meta.url);
const { Pool } = require('pg') as {
  Pool: new (options: { connectionString: string }) => {
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    connect(): Promise<{
      query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
      release(): void;
    }>;
    end(): Promise<void>;
  };
};

/** 配置。 */
export interface PostgresPersistenceConfig {
  /** PostgreSQL 连接串。 */
  readonly connectionString: string;
  /** 表所在的 schema，缺省 public。 */
  readonly schema?: string;
}

/** 一行的形状。 */
interface SessionRow {
  readonly header: SessionHeader;
  readonly inherited_count: number;
}

/** 一个会话句柄。 */
class PostgresSessionHandle {
  readonly access: 'read' | 'write';

  constructor(
    private readonly backend: PostgresSessionPersistence,
    readonly header: SessionHeader,
    access: 'read' | 'write',
    readonly inheritedEventCount = 0,
  ) {
    this.access = access;
  }

  get id(): string {
    return this.header.id;
  }

  async read(offset = 0, length?: number): Promise<any> {
    const rows = await this.backend.selectEvents(this.id, offset, length);
    return { eventState: 'owned', events: rows as never[] };
  }

  async append(events: readonly any[]): Promise<void> {
    if (this.access !== 'write') throw new Error('read handle cannot append');
    await this.backend.appendEvents(this.id, events);
  }

  async flush(): Promise<void> {
    // Postgres 在 append 返回时已经持久化；这里是显式的耐久屏障占位。
  }

  async close(): Promise<void> {
    if (this.access === 'write') this.backend.release(this.id);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * PostgreSQL 会话持久化服务。
 */
export class PostgresSessionPersistence extends SessionPersistence {
  private readonly pool: ReturnType<typeof Pool.prototype.constructor> | { query: unknown };
  private readonly schema: string;
  private readonly owners = new Map<string, symbol>();

  constructor(ctx: never, config: PostgresPersistenceConfig) {
    super(ctx);
    this.schema = config.schema ?? 'public';
    this.pool = new Pool({ connectionString: config.connectionString }) as never;
  }

  /** 建 schema 与两张表。可重复执行。 */
  async initialize(): Promise<void> {
    await this.query(`create schema if not exists "${this.schema}"`);
    await this.query(`create table if not exists "${this.schema}".sessions (
      id text primary key,
      header jsonb not null,
      inherited_count integer not null default 0,
      created_at bigint not null
    )`);
    await this.query(`create table if not exists "${this.schema}".session_events (
      session_id text not null,
      seq integer not null,
      event jsonb not null,
      primary key (session_id, seq)
    )`);
  }

  async create(header: any, options?: any): Promise<any> {
    void options;
    const materialized = materializeCreateHeader(header);
    await this.query(
      `insert into "${this.schema}".sessions (id, header, inherited_count, created_at) values ($1, $2::jsonb, $3, $4)`,
      [materialized.id, JSON.stringify(materialized), 0, materialized.createdAt],
    );
    this.owners.set(materialized.id, Symbol('writer'));
    return new PostgresSessionHandle(this, materialized, 'write', 0);
  }

  async open(id: any, access: any): Promise<any> {
    const rows = await this.query(`select header, inherited_count from "${this.schema}".sessions where id = $1`, [id]);
    const row = rows[0] as SessionRow | undefined;
    if (row === undefined) throw new SessionPersistenceNotFoundError(id);
    if (access === 'write' && this.owners.has(id)) throw new SessionAlreadyOwnedError(id);
    if (access === 'write') this.owners.set(id, Symbol('writer'));
    return new PostgresSessionHandle(this, row.header, access, row.inherited_count);
  }

  async flush(): Promise<void> {
    // 每个 append 已经落库。
  }

  async stat(id: any): Promise<any> {
    const rows = await this.query(
      `select s.header, s.inherited_count, (select count(*)::int from "${this.schema}".session_events e where e.session_id = s.id) as event_count from "${this.schema}".sessions s where s.id = $1`,
      [id],
    );
    const row = rows[0] as (SessionRow & { event_count: number }) | undefined;
    if (row === undefined) return undefined;
    return { header: row.header, revision: String(row.event_count) as never, eventCount: row.event_count };
  }

  async list(options?: any): Promise<any> {
    void options;
    const rows = await this.query(
      `select s.header, s.inherited_count, (select count(*)::int from "${this.schema}".session_events e where e.session_id = s.id) as event_count from "${this.schema}".sessions s order by s.created_at`,
    );
    return (rows as (SessionRow & { event_count: number })[]).map((row) => ({
      header: row.header,
      revision: String(row.event_count) as never,
      eventCount: row.event_count,
    })) as never;
  }

  /** 释放连接池。 */
  async close(): Promise<void> {
    const pool = this.pool as { end(): Promise<void> };
    await pool.end();
    this.owners.clear();
  }

  /** 读取一段事件。 */
  async selectEvents(id: string, offset: number, length?: number): Promise<unknown[]> {
    const rows = await this.query(
      `select event from "${this.schema}".session_events where session_id = $1 and seq >= $2 order by seq${length === undefined ? '' : ' limit $3'}`,
      length === undefined ? [id, offset] : [id, offset, length],
    );
    return rows.map((row) => (row as { event: unknown }).event);
  }

  /** 追加一批事件，事务内校验连续。 */
  async appendEvents(id: string, events: readonly unknown[]): Promise<void> {
    if (events.length === 0) return;
    const client = await (this.pool as { connect(): Promise<{
      query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
      release(): void;
    }> }).connect();
    try {
      await client.query('begin');
      const rows = await client.query(
        `select coalesce(max(seq), -1) + 1 as next from "${this.schema}".session_events where session_id = $1`,
        [id],
      );
      const next = (rows.rows[0] as { next: number }).next;
      const batch = materializeAppendBatch(events as never) as readonly { seq: number }[];
      batch.forEach((event, index) => {
        if (event.seq !== next + index) throw new Error(`事件序号不连续：期望 ${next + index}`);
      });
      for (const event of batch) {
        await client.query(
          `insert into "${this.schema}".session_events (session_id, seq, event) values ($1, $2, $3::jsonb)`,
          [id, (event as { seq: number }).seq, JSON.stringify(event)],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 释放写所有权。 */
  release(id: string): void {
    this.owners.delete(id);
  }

  private async query(text: string, values?: unknown[]): Promise<unknown[]> {
    const pool = this.pool as { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
    const result = await pool.query(text, values);
    return result.rows;
  }
}

export const name = 'session-persistence-postgres';

/** 配置 schema。 */
export const Config = z.object({
  connectionString: z.string(),
  schema: z.string().default('public'),
});

/** 注册服务。 */
export function apply(ctx: { plugin(spec: unknown): unknown }, config: PostgresPersistenceConfig): void {
  ctx.plugin({ name: 'session-persistence-postgres-service', apply: (serviceCtx: never) => new PostgresSessionPersistence(serviceCtx, config) });
}
