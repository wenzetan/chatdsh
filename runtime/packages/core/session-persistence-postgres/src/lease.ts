/**
 * 跨进程写所有权：数据库级咨询锁加带 fencing token 的租约。
 *
 * 句柄先在自己的专用连接上取 `pg_try_advisory_lock`，再递增 `session_writers` 里该会话的
 * `fencing_token` 并写租约到期时刻。咨询锁随连接终止自动释放，因此进程崩溃或连接断开之后
 * 新持有者可以立刻接手租约；旧持有者的令牌随即失配，追加被拒绝。
 *
 * 续租只在自己仍是持有者时成功，失败即视为所有权永久丢失。
 * @module @chatdsh/core-session-persistence-postgres/lease
 */

import { SessionOwnershipLostError, type SessionId } from '@chatdsh/adapter';
import { asPostgresError, toNumber, type PgClient } from './pg.ts';
import { WRITERS_TABLE } from './schema.ts';

/** 租约配置。 */
export interface WriterLeaseOptions {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 本进程实例的持有者标识。 */
  readonly ownerId: string;
  /** 表所在 schema。 */
  readonly schema: string;
  /** 时刻来源。 */
  readonly now: () => number;
  /** 租约有效期。 */
  readonly ttlMs: number;
}

/** 租约取得失败：已有活跃持有者。 */
export class WriterLeaseHeldError extends Error {
  /** 被占用的会话标识。 */
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`会话 "${sessionId}" 已有活跃写持有者，拒绝取得写所有权`);
    this.name = 'WriterLeaseHeldError';
    this.sessionId = sessionId;
  }
}

/** 一条写租约。 */
export class WriterLease {
  private readonly client: PgClient;
  private readonly options: WriterLeaseOptions;
  private fencingToken: number | undefined;
  private released = false;

  constructor(client: PgClient, options: WriterLeaseOptions) {
    this.client = client;
    this.options = options;
  }

  /** 本次取得的 fencing token；未取得时抛出。 */
  get token(): number {
    if (this.fencingToken === undefined) {
      throw new Error(`会话 "${this.options.sessionId}" 还没有取得写租约`);
    }
    return this.fencingToken;
  }

  /** 租约是否已释放。 */
  get isReleased(): boolean {
    return this.released;
  }

  /**
   * 取得租约。
   *
   * 咨询锁取不到表示另一活跃持有者存在，直接拒绝；取到之后递增 fencing token 并落租约行。
   * 咨询锁空闲即说明上一持有者的连接已经终止，它留下的租约行不再可信，因此直接接手。
   * @returns 本持有者的 fencing token。
   */
  async acquire(): Promise<number> {
    const { schema, sessionId } = this.options;
    const locked = await this.client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [sessionId]);
    if (locked.rows[0]?.locked !== true) {
      throw new WriterLeaseHeldError(sessionId);
    }
    const now = this.options.now();
    const taken = await this.client.query(
      `insert into "${schema}".${WRITERS_TABLE} (session_id, owner_id, fencing_token, lease_expires_at, heartbeat_at)
       values ($1, $2, 1, $3, $4)
       on conflict (session_id) do update set
         owner_id = excluded.owner_id,
         fencing_token = "${schema}".${WRITERS_TABLE}.fencing_token + 1,
         lease_expires_at = excluded.lease_expires_at,
         heartbeat_at = excluded.heartbeat_at
       returning fencing_token`,
      [sessionId, this.options.ownerId, now + this.options.ttlMs, now],
    );
    const row = taken.rows[0];
    if (row === undefined) {
      await this.unlockQuietly();
      throw new WriterLeaseHeldError(sessionId);
    }
    this.fencingToken = toNumber(row.fencing_token, 'fencing_token');
    this.released = false;
    return this.fencingToken;
  }

  /**
   * 续租并确认仍然持有。
   *
   * @throws {SessionOwnershipLostError} 租约行不再属于本持有者。
   */
  async renew(): Promise<void> {
    const { schema, sessionId, ownerId } = this.options;
    const now = this.options.now();
    const renewed = await this.client.query(
      `update "${schema}".${WRITERS_TABLE}
         set lease_expires_at = $4, heartbeat_at = $5
       where session_id = $1 and owner_id = $2 and fencing_token = $3`,
      [sessionId, ownerId, this.token, now + this.options.ttlMs, now],
    );
    if ((renewed.rowCount ?? 0) === 0) {
      this.released = true;
      throw new SessionOwnershipLostError(sessionId as SessionId);
    }
  }

  /**
   * 在当前事务里核对租约仍然有效。
   *
   * 核对与事件写入落在同一个事务里：令牌失配、租约行消失或已过期都拒绝提交。
   * @throws {SessionOwnershipLostError} 本持有者不再是租约主人。
   */
  async verifyInTransaction(): Promise<void> {
    const { schema, sessionId } = this.options;
    const row = await this.client.query(
      `select owner_id, fencing_token, lease_expires_at from "${schema}".${WRITERS_TABLE} where session_id = $1`,
      [sessionId],
    );
    const current = row.rows[0];
    if (current === undefined) throw new SessionOwnershipLostError(sessionId as SessionId);
    const token = toNumber(current.fencing_token, 'fencing_token');
    const expiresAt = toNumber(current.lease_expires_at, 'lease_expires_at');
    if (token !== this.token || current.owner_id !== this.options.ownerId) {
      this.released = true;
      throw new SessionOwnershipLostError(sessionId as SessionId);
    }
    if (expiresAt < this.options.now()) {
      this.released = true;
      throw new SessionOwnershipLostError(sessionId as SessionId);
    }
  }

  /** 释放租约：先把租约行置为已过期，再放开咨询锁。可重复调用。 */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const { schema, sessionId, ownerId } = this.options;
    if (this.fencingToken !== undefined) {
      await this.client.query(
        `update "${schema}".${WRITERS_TABLE}
           set lease_expires_at = $4, heartbeat_at = $4
         where session_id = $1 and owner_id = $2 and fencing_token = $3`,
        [sessionId, ownerId, this.fencingToken, this.options.now()],
      );
    }
    await this.unlockQuietly();
  }

  /** 放开咨询锁；连接已终止时锁随连接消失，其它错误照原样抛出。 */
  private async unlockQuietly(): Promise<void> {
    if (this.fencingToken === undefined) return;
    try {
      await this.client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [this.options.sessionId]);
    } catch (error) {
      const failure = asPostgresError(error, '释放写租约');
      if (failure.name !== 'PostgresUnavailableError') throw failure;
    }
  }
}
