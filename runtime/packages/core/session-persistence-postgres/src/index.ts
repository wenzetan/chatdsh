/**
 * PostgreSQL 会话持久化后端。
 *
 * 会话头与不可变事件序列分表存放，事件从 0 起连续、只追加；`flush` 是耐久屏障。跨进程
 * 单写者由数据库级咨询锁加带 fencing token 的租约表达：句柄在自己的专用连接上持锁，租约
 * 换手时令牌递增，旧持有者的追加一律被拒绝。数据库不可达时不退回任何本地写入。
 * @module @chatdsh/core-session-persistence-postgres
 */

import { randomUUID } from 'node:crypto';
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  assertStoredId,
  materializeCreateHeader,
  schema as z,
  type Context,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@chatdsh/adapter';
import { PostgresSessionHandle } from './handle.ts';
import { WriterLease, WriterLeaseHeldError } from './lease.ts';
import {
  PostgresConfigurationError,
  asPostgresError,
  errorCode,
  loadPg,
  requireConnectionString,
  toNumber,
  type PgClient,
  type PgPool,
} from './pg.ts';
import {
  EVENTS_TABLE,
  SESSIONS_TABLE,
  WRITERS_TABLE,
  assertSchemaVersion,
  ensureSchema,
  requireSchemaName,
} from './schema.ts';
import {
  NO_TELEMETRY,
  PERSISTENCE_SIGNALS,
  describeError,
  type PersistenceTelemetry,
} from './telemetry.ts';

/** 会话快照。 */
type Snapshot = Exclude<Awaited<ReturnType<SessionPersistence['stat']>>, undefined>;

/** 会话句柄的上游契约形状。 */
type Handle = Awaited<ReturnType<SessionPersistence['create']>>;

/** 一条会话行。 */
interface SessionRow {
  /** 不可变的会话头。 */
  readonly header: SessionHeader;
  /** 继承事件数。 */
  readonly inheritedCount: number;
  /** 已提交的事件条数。 */
  readonly eventCount: number;
  /** 软删除时刻。 */
  readonly deletedAt?: number;
}

/** 把事件条数转换成后端修订号。 */
function revisionOf(count: number): Snapshot['revision'] {
  return String(count) as unknown as Snapshot['revision'];
}

/** 配置。 */
export interface PostgresPersistenceConfig {
  /** PostgreSQL 连接串；只经安全配置传入，绝不出现在日志与遥测里。 */
  readonly connectionString?: string;
  /** 表所在的 schema，缺省 `public`。 */
  readonly schema?: string;
  /** 连接池上限，缺省 10；每个写句柄会独占一条连接。 */
  readonly poolSize?: number;
  /** 写租约有效期，缺省 15000 毫秒。 */
  readonly leaseTtlMs?: number;
  /** 续租间隔，缺省 5000 毫秒。 */
  readonly leaseHeartbeatMs?: number;
}

/** 列表选项：在上游的取消选项之外增加过滤与分页。 */
export interface PostgresListOptions {
  /** 可选取消。 */
  readonly signal?: AbortSignal;
  /** 按工作目录过滤。 */
  readonly cwd?: string;
  /** 按父会话过滤。 */
  readonly parentSession?: string;
  /** 按是否带继承前缀过滤。 */
  readonly seeded?: boolean;
  /** 创建时刻下界，含端。 */
  readonly createdAfter?: number;
  /** 创建时刻上界，含端。 */
  readonly createdBefore?: number;
  /** 跳过的条数。 */
  readonly offset?: number;
  /** 本页最多返回的条数；缺省或 0 表示不限制。 */
  readonly limit?: number;
  /** 排序：创建时刻倒序或正序。 */
  readonly order?: 'created-asc' | 'created-desc';
  /** 是否包含已软删除的会话。 */
  readonly includeDeleted?: boolean;
}

/** 一条已存事件行。 */
export interface StoredEventRow {
  /** 事件本身。 */
  readonly event: SessionEvent;
  /** 该会话的事件总数。 */
  readonly total: number;
}

/** 删除结果。 */
export interface DeleteOutcome {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 删除时刻的毫秒时间戳。 */
  readonly deletedAt: number;
}

/** PostgreSQL 会话持久化服务。 */
export class PostgresSessionPersistence extends SessionPersistence {
  /** 后端标签。 */
  readonly name = 'session-persistence-postgres';
  /** 表所在 schema。 */
  readonly schemaName: string;
  /** 续租间隔。 */
  readonly leaseHeartbeatMs: number;
  private readonly ownerId = randomUUID();
  private readonly leaseTtlMs: number;
  private pool: PgPool | undefined;
  private readyTask: Promise<void> | undefined;
  private readonly writers = new Map<string, PostgresSessionHandle>();
  private readonly openHandles = new Set<PostgresSessionHandle>();
  private shuttingDown = false;

  constructor(ctx: Context, config: PostgresPersistenceConfig) {
    super(ctx);
    this.schemaName = requireSchemaName(config.schema ?? 'public');
    this.leaseTtlMs = config.leaseTtlMs ?? 15_000;
    this.leaseHeartbeatMs = config.leaseHeartbeatMs ?? 5_000;
    if (this.leaseHeartbeatMs >= this.leaseTtlMs) {
      throw new PostgresConfigurationError('写租约的续租间隔必须小于有效期');
    }
    // 无配置时不构造连接池：连接串为空直接拒绝。
    this.pool = this.createPool(config);
    this.install();
  }

  /**
   * 建表并核对 schema 版本；可重复执行。
   *
   * @returns 完成后解析。
   */
  async initialize(): Promise<void> {
    await this.poolReady();
  }

  /**
   * 创建会话并取得写所有权。
   *
   * @param header - 不可变的会话头。
   * @param options - 可选取消与继承事件数。
   * @returns 属于调用方的写句柄。
   */
  async create(
    header: SessionHeader,
    options: { readonly signal?: AbortSignal; readonly inheritedEventCount?: number } = {},
  ): Promise<Handle> {
    return this.span('create', 'write', async () => {
      options.signal?.throwIfAborted();
      const snapshot = materializeCreateHeader(header);
      assertStoredId(snapshot.id, snapshot);
      const inherited = this.resolveInheritedCount(snapshot, options.inheritedEventCount);
      if (this.writers.has(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id);
      const pool = await this.poolReady();
      const client = await this.guard('取得写连接', () => pool.connect());
      const lease = this.newLease(client, snapshot.id);
      try {
        await this.guard('取得写租约', () => lease.acquire());
        await this.guard('开启会话事务', () => client.query('begin'));
        try {
          await this.guard('写入会话头', () =>
            client.query(
              `insert into "${this.schemaName}".${SESSIONS_TABLE}
                 (id, header, parent_session, inherited_count, created_at, last_activity_at, event_count)
               values ($1, $2::jsonb, $3, $4, $5, $5, 0)`,
              [snapshot.id, JSON.stringify(snapshot), snapshot.parentSession ?? null, inherited, snapshot.createdAt],
            ),
          );
          await this.guard('提交会话头', () => client.query('commit'));
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      } catch (error) {
        await lease.release().catch(() => undefined);
        client.release(true);
        if (errorCode(error) === '23505') throw new SessionAlreadyExistsError(snapshot.id);
        throw error;
      }
      const handle = new PostgresSessionHandle(this, {
        id: snapshot.id,
        header: snapshot,
        access: 'write',
        inheritedEventCount: inherited,
        cursor: 0,
        client,
        lease,
      });
      this.adopt(handle);
      return handle as Handle;
    });
  }

  /**
   * 打开既有会话。
   *
   * @param id - 会话标识。
   * @param access - `read` 或 `write`。
   * @param options - 可选取消。
   * @returns 打开后的句柄。
   */
  async open(
    id: SessionId,
    access: 'read' | 'write',
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Handle> {
    return this.span('open', access, async () => {
      options.signal?.throwIfAborted();
      const pool = await this.poolReady();
      const row = await this.selectSession(id);
      if (row === undefined || row.deletedAt !== undefined) throw new SessionPersistenceNotFoundError(id);
      if (access === 'read') {
        const handle = new PostgresSessionHandle(this, {
          id,
          header: row.header,
          access: 'read',
          inheritedEventCount: row.inheritedCount,
          cursor: row.eventCount,
        });
        this.adopt(handle);
        return handle as Handle;
      }
      if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
      const client = await this.guard('取得写连接', () => pool.connect());
      const lease = this.newLease(client, id);
      try {
        await this.guard('取得写租约', () => lease.acquire());
      } catch (error) {
        client.release(true);
        if (error instanceof WriterLeaseHeldError) throw new SessionAlreadyOwnedError(id);
        throw error;
      }
      const handle = new PostgresSessionHandle(this, {
        id,
        header: row.header,
        access: 'write',
        inheritedEventCount: row.inheritedCount,
        cursor: row.eventCount,
        client,
        lease,
      });
      this.adopt(handle);
      return handle as Handle;
    });
  }

  /** 释放本服务持有的全部写句柄，再关闭连接池。 */
  async close(): Promise<void> {
    this.shuttingDown = true;
    const errors: unknown[] = [];
    for (const handle of [...this.openHandles]) {
      try {
        await handle.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.openHandles.clear();
    this.writers.clear();
    const pool = this.pool;
    this.pool = undefined;
    if (pool !== undefined) {
      try {
        await pool.end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Postgres 会话后端关闭时仍有失败');
  }

  /**
   * 观察一个会话。
   *
   * @param id - 会话标识。
   * @returns 快照；不存在或已删除时为空。
   */
  async stat(id: SessionId): Promise<Snapshot | undefined> {
    await this.poolReady();
    const row = await this.selectSession(id);
    if (row === undefined || row.deletedAt !== undefined) return undefined;
    return { header: row.header, revision: revisionOf(row.eventCount), eventCount: row.eventCount };
  }

  /**
   * 列出会话，可按工作目录、父会话、种子标记与创建时刻过滤并分页。
   *
   * @param options - 过滤与分页选项。
   * @returns 快照列表。
   */
  async list(options: PostgresListOptions = {}): Promise<readonly Snapshot[]> {
    const pool = await this.poolReady();
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('list offset 必须是非负安全整数');
    const limit = options.limit ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('list limit 必须是非负安全整数');
    const order = options.order ?? 'created-desc';
    const result = await this.guard('列出会话', () =>
      pool.query(
        `select id, header, inherited_count, event_count, created_at, deleted_at
           from "${this.schemaName}".${SESSIONS_TABLE}
          where ($1::text is null or header->>'cwd' = $1)
            and ($2::text is null or parent_session = $2)
            and ($3::boolean is null or (header->>'isSeeded')::boolean = $3)
            and ($4::bigint is null or created_at >= $4)
            and ($5::bigint is null or created_at <= $5)
            and ($6::boolean or deleted_at is null)
          order by created_at ${order === 'created-asc' ? 'asc' : 'desc'}, id asc
          offset $7 limit $8`,
        [
          options.cwd ?? null,
          options.parentSession ?? null,
          options.seeded ?? null,
          options.createdAfter ?? null,
          options.createdBefore ?? null,
          options.includeDeleted === true,
          offset,
          limit === 0 ? null : limit,
        ],
      ),
    );
    return result.rows.map((row) => {
      const eventCount = toNumber(row.event_count, 'event_count');
      return {
        header: row.header as SessionHeader,
        revision: revisionOf(eventCount),
        eventCount,
      };
    });
  }

  /** 把每个活跃写句柄的实时事件写完并落盘。 */
  async flush(): Promise<void> {
    const errors: unknown[] = [];
    for (const writer of [...this.writers.values()]) {
      try {
        await writer.drainLive();
        await writer.flush();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Postgres 会话后端 flush 失败');
  }

  /**
   * 软删除一个会话：保留事件，隐藏于列表与打开，可恢复。
   *
   * @param id - 会话标识。
   * @param options - 可选取消。
   * @returns 删除结果。
   */
  async deleteSession(id: SessionId, options: { readonly signal?: AbortSignal } = {}): Promise<DeleteOutcome> {
    return this.span('delete', 'write', async () => {
      options.signal?.throwIfAborted();
      const pool = await this.poolReady();
      if (this.writers.get(id)?.ownsWrite === true) {
        throw new Error(`会话 "${id}" 仍有活跃写句柄，拒绝删除`);
      }
      const now = Date.now();
      const active = await this.guard('核对写租约', () =>
        pool.query(
          `select 1 from "${this.schemaName}".${WRITERS_TABLE} where session_id = $1 and lease_expires_at >= $2`,
          [id, now],
        ),
      );
      if (active.rows.length > 0) throw new Error(`会话 "${id}" 的写租约仍然有效，拒绝删除`);
      const updated = await this.guard('软删除会话', () =>
        pool.query(
          `update "${this.schemaName}".${SESSIONS_TABLE} set deleted_at = $2 where id = $1 and deleted_at is null`,
          [id, now],
        ),
      );
      if ((updated.rowCount ?? 0) === 0) throw new SessionPersistenceNotFoundError(id);
      return { sessionId: id, deletedAt: now };
    });
  }

  /**
   * 恢复一个软删除的会话。
   *
   * @param id - 会话标识。
   */
  async restoreSession(id: SessionId): Promise<void> {
    const pool = await this.poolReady();
    const updated = await this.guard('恢复会话', () =>
      pool.query(
        `update "${this.schemaName}".${SESSIONS_TABLE} set deleted_at = null where id = $1 and deleted_at is not null`,
        [id],
      ),
    );
    if ((updated.rowCount ?? 0) === 0) throw new SessionPersistenceNotFoundError(id);
  }

  /**
   * 读取一段事件行，附上该会话的事件总数。
   *
   * @param id - 会话标识。
   * @param offset - 起始序号。
   * @param length - 最多返回的条数。
   * @returns 事件行。
   */
  async selectEvents(id: string, offset: number, length: number): Promise<StoredEventRow[]> {
    const pool = await this.poolReady();
    const unlimited = length === Number.MAX_SAFE_INTEGER;
    const result = await this.guard('读取事件', () =>
      pool.query(
        `select e.event,
                (select count(*)::int from "${this.schemaName}".${EVENTS_TABLE} x where x.session_id = e.session_id) as total
           from "${this.schemaName}".${EVENTS_TABLE} e
          where e.session_id = $1 and e.seq >= $2
          order by e.seq
          ${unlimited ? '' : 'limit $3'}`,
        unlimited ? [id, offset] : [id, offset, length],
      ),
    );
    return result.rows.map((row) => ({
      event: row.event as SessionEvent,
      total: toNumber(row.total, 'total'),
    }));
  }

  /** 记一次追加结果。 */
  recordAppend(count: number, outcome: 'ok' | 'failed'): void {
    this.telemetry.counter(PERSISTENCE_SIGNALS.appendsTotal, { description: '会话事件追加结果' }).add(count, {
      outcome,
    });
  }

  /** 记一次写所有权丢失。 */
  recordOwnershipLoss(reason: string, error?: unknown): void {
    const described = error === undefined ? undefined : describeError(error);
    this.telemetry.event(PERSISTENCE_SIGNALS.ownershipLost, {
      reason,
      outcome: 'lost',
      'error.type': described?.['error.type'] ?? 'SessionOwnershipLostError',
      'error.code': described?.['error.code'] ?? reason,
    });
    this.telemetry
      .counter(PERSISTENCE_SIGNALS.ownershipLossesTotal, { description: '写所有权丢失次数' })
      .add(1, { reason });
    if (error !== undefined) {
      this.ctx.logger.warn(`session-persistence-postgres: 写所有权丢失（${reason}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 开始一个 span。 */
  startSpan(name: string, attributes: Record<string, string | number | boolean | undefined>) {
    return this.telemetry.startSpan(name, attributes);
  }

  /** 句柄关闭后回收登记。 */
  releaseHandle(handle: PostgresSessionHandle): void {
    this.openHandles.delete(handle);
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id);
  }

  /** 实时事件路由与句柄回收。 */
  private install(): void {
    const self = this;
    this.ctx.effect(function* () {
      yield () => {
        return (async () => {
          const errors: unknown[] = [];
          for (const handle of [...self.openHandles]) {
            try {
              await handle.close();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) throw new AggregateError(errors, `${self.name} 释放句柄失败`);
        })();
      };
      yield self.ctx.on('session/event', (session, event) => {
        const writer = self.writers.get(session.id);
        writer?.enqueueLive(event as SessionEvent, (error: unknown) => {
          self.ctx.logger.warn(
            `session-persistence-postgres: 会话 "${session.id}" 的后台写入失败，事件仍保留在缓冲里：${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
      yield self.ctx.on('session/flush', (session) => {
        const writer = self.writers.get(session.id);
        if (writer === undefined) return undefined;
        return (async () => {
          await writer.drainLive();
          await writer.flush();
        })();
      });
      yield self.ctx.on('session/disposed', (session) => {
        const writer = self.writers.get(session.id);
        if (writer === undefined) return undefined;
        void writer.close().catch(() => undefined);
        return undefined;
      });
    }, `${this.name} 实时路由与句柄`);
  }

  /** 登记一个新句柄。 */
  private adopt(handle: PostgresSessionHandle): void {
    this.openHandles.add(handle);
    if (handle.access === 'write') this.writers.set(handle.id, handle);
  }

  /** 构造租约。 */
  private newLease(client: PgClient, id: string): WriterLease {
    return new WriterLease(client, {
      sessionId: id,
      ownerId: this.ownerId,
      schema: this.schemaName,
      now: Date.now,
      ttlMs: this.leaseTtlMs,
    });
  }

  /** 读取会话行。 */
  private async selectSession(id: string): Promise<SessionRow | undefined> {
    const pool = await this.poolReady();
    const result = await this.guard('读取会话行', () =>
      pool.query(
        `select header, inherited_count, event_count, deleted_at
           from "${this.schemaName}".${SESSIONS_TABLE} where id = $1`,
        [id],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const deletedAt = row.deleted_at === null || row.deleted_at === undefined ? undefined : toNumber(row.deleted_at, 'deleted_at');
    return {
      header: row.header as SessionHeader,
      inheritedCount: toNumber(row.inherited_count, 'inherited_count'),
      eventCount: toNumber(row.event_count, 'event_count'),
      ...(deletedAt === undefined ? {} : { deletedAt }),
    };
  }

  /** 校验继承事件数与种子标记一致。 */
  private resolveInheritedCount(header: SessionHeader, inherited: number | undefined): number {
    const count = inherited ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`inheritedEventCount 必须是非负安全整数，实际 ${String(inherited)}`);
    }
    if (header.isSeeded && count === 0) {
      throw new Error(`会话 "${header.id}" 标记为种子会话，必须给出大于 0 的继承事件数`);
    }
    if (!header.isSeeded && count !== 0) {
      throw new Error(`会话 "${header.id}" 不是种子会话，不得带继承事件数`);
    }
    return count;
  }

  /** 创建连接池。 */
  private createPool(config: PostgresPersistenceConfig): PgPool {
    const connectionString = requireConnectionString(config.connectionString);
    const { Pool } = loadPg();
    return new Pool({
      connectionString,
      max: config.poolSize ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'chatdsh-session-persistence',
    });
  }

  /** 就绪任务：建表与版本闸门只执行一次。 */
  private ensureReady(): Promise<void> {
    this.readyTask ??= (async () => {
      const pool = this.requirePool();
      await ensureSchema(pool, this.schemaName);
      await assertSchemaVersion(pool, this.schemaName);
    })();
    return this.readyTask;
  }

  /** 等待就绪并返回连接池。 */
  private async poolReady(): Promise<PgPool> {
    if (this.shuttingDown) throw new Error('Postgres 会话后端已经关闭');
    await this.ensureReady();
    return this.requirePool();
  }

  /** 取连接池；未构造时抛出。 */
  private requirePool(): PgPool {
    if (this.pool === undefined) throw new PostgresConfigurationError('Postgres 会话后端没有可用的连接池');
    return this.pool;
  }

  /** 一次操作的外层 span 与失败属性。 */
  private async span<T>(operation: 'create' | 'open' | 'delete', access: 'read' | 'write', body: () => Promise<T>): Promise<T> {
    return this.telemetry.runSpan(
      PERSISTENCE_SIGNALS.open,
      { operation, access, outcome: 'attempted' },
      async (span) => {
        try {
          const result = await body();
          span.setAttribute('outcome', 'ok');
          return result;
        } catch (error) {
          span.setAttributes(describeError(error));
          span.recordException(error);
          throw error;
        }
      },
    );
  }

  /** 把连接级错误整理成可读错误。 */
  private async guard<T>(operation: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw asPostgresError(error, operation);
    }
  }

  /** 遥测出口。 */
  private get telemetry(): PersistenceTelemetry {
    const outlet = this.ctx.reflect.get('chatdshTelemetry') as PersistenceTelemetry | undefined;
    return outlet ?? NO_TELEMETRY;
  }
}

/** 插件名。 */
export const name = 'session-persistence-postgres';

/** 配置 schema。连接串只从组合层的安全配置读取，不设默认值。 */
export const Config = z.object({
  connectionString: z.string().required(),
  schema: z.string().default('public'),
  poolSize: z.natural().min(1).default(10),
  leaseTtlMs: z.natural().min(1000).default(15_000),
  leaseHeartbeatMs: z.natural().min(500).default(5_000),
});

/**
 * 挂载后端。
 *
 * @param ctx - 插件上下文。
 * @param config - 连接串、schema 与租约参数。
 */
export async function apply(ctx: Context, config: PostgresPersistenceConfig): Promise<void> {
  let fiber: ReturnType<Context['plugin']> | undefined;
  ctx.effect(function* () {
    fiber = ctx.plugin({
      name: 'session-persistence-postgres-service',
      apply(serviceCtx: Context) {
        new PostgresSessionPersistence(serviceCtx, config);
      },
    });
    yield fiber.dispose;
  }, 'session-persistence-postgres 资源');
  if (fiber === undefined) throw new Error('session-persistence-postgres: 插件没有完成注册');
  await fiber.await();
}

export { PostgresSessionHandle } from './handle.ts';
export { WriterLease, WriterLeaseHeldError } from './lease.ts';
export { PostgresConfigurationError, PostgresUnavailableError } from './pg.ts';
