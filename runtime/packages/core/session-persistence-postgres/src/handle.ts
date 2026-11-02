/**
 * 会话句柄：读、追加、耐久屏障与释放。
 *
 * 写句柄独占一个专用连接：咨询锁与租约都挂在这条连接上，连接终止就让租约失效。每次追加
 * 在同一个事务里核对 fencing token、校验序号连续、插入事件并推进会话头计数；令牌失配或
 * 连接已断都以 `SessionOwnershipLostError` 拒绝，绝不退回任何本地写入。
 * @module @chatdsh/core-session-persistence-postgres/handle
 */

import {
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistence,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
  validateStoredEvents,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@chatdsh/adapter';
import type { WriterLease } from './lease.ts';
import { asPostgresError, isConnectionError, type PgClient } from './pg.ts';
import { EVENTS_TABLE, SESSIONS_TABLE } from './schema.ts';
import { describeError, PERSISTENCE_SIGNALS } from './telemetry.ts';
import type { PostgresSessionPersistence } from './index.ts';

/** 上游契约里句柄的继承事件数类型（品牌化整数）。 */
type InheritedCount = Awaited<ReturnType<SessionPersistence['create']>>['inheritedEventCount'];

/** 句柄构造参数。 */
export interface PostgresSessionHandleOptions {
  /** 会话标识。 */
  readonly id: SessionId;
  /** 不可变的会话头。 */
  readonly header: SessionHeader;
  /** 访问方式。 */
  readonly access: 'read' | 'write';
  /** 来自父会话的继承事件数。 */
  readonly inheritedEventCount: number;
  /** 下一个可追加的序号。 */
  readonly cursor: number;
  /** 写句柄独占的连接。 */
  readonly client?: PgClient;
  /** 写句柄的租约。 */
  readonly lease?: WriterLease;
}

/** 一个会话句柄。写句柄持有专用连接与租约，读句柄只借用连接池。 */
export class PostgresSessionHandle {
  /** 会话标识。 */
  readonly id: SessionId;
  /** 不可变的会话头。 */
  readonly header: SessionHeader;
  /** 访问方式。 */
  readonly access: 'read' | 'write';
  /** 继承事件数。 */
  readonly inheritedEventCount: InheritedCount;
  private readonly backend: PostgresSessionPersistence;
  private readonly client: PgClient | undefined;
  private readonly lease: WriterLease | undefined;
  private cursor: number;
  private observedLength = 0;
  private chain: Promise<void> = Promise.resolve();
  private buffered: SessionEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private drainPaused = false;
  private draining: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private ownershipLost = false;

  constructor(backend: PostgresSessionPersistence, options: PostgresSessionHandleOptions) {
    this.backend = backend;
    this.id = options.id;
    this.header = options.header;
    this.access = options.access;
    this.inheritedEventCount = options.inheritedEventCount as InheritedCount;
    this.cursor = options.cursor;
    this.client = options.client;
    this.lease = options.lease;
    if (this.client !== undefined) {
      this.client.on('error', (error: Error) => this.markLost('connection-error', error));
      this.client.on('end', () => this.markLost('connection-closed'));
      this.startHeartbeat();
    }
  }

  /** 本句柄已提交的事件总数。 */
  get committedLength(): number {
    return this.cursor;
  }

  /** 本句柄是否仍持有写所有权。 */
  get ownsWrite(): boolean {
    return this.lease !== undefined && !this.ownershipLost && !this.closed;
  }

  /**
   * 读取一段事件。
   *
   * @param offset - 起始序号，缺省 0。
   * @param length - 最多返回的条数，缺省到日志末尾。
   * @param options - 可选取消。
   * @returns 调用方拥有的外层数组与事件值的所有权状态。
   */
  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly eventState: 'detached'; readonly events: readonly SessionEvent[] }> {
    this.assertOpen('read');
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset 必须是非负安全整数，实际 ${String(offset)}`);
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length 必须是非负安全整数，实际 ${String(length)}`);
    }
    options.signal?.throwIfAborted();
    const rows = await this.backend.selectEvents(this.id, offset, length);
    const fetched = rows.map((row) => row.event);
    if (fetched.length > 0 && fetched[0]!.seq !== offset) {
      throw new Error(`会话 "${this.id}" 的日志在序号 ${String(fetched[0]!.seq)} 处与请求的 ${offset} 不符`);
    }
    const validated = validateStoredEvents(this.header, fetched);
    const total = rows.length > 0 ? rows[rows.length - 1]!.total : this.observedLength;
    if (total < this.observedLength) {
      throw new Error(`会话 "${this.id}" 的存储日志比本句柄已观察到的前缀更短（${total} < ${this.observedLength}）`);
    }
    this.observedLength = Math.max(this.observedLength, total);
    return { eventState: 'detached', events: validated };
  }

  /**
   * 追加一批连续事件。
   *
   * @param events - 按序号升序、首条序号等于已存的下一个序号。
   * @param options - 可选取消。
   */
  async append(events: readonly SessionEvent[], options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const batch = materializeAppendBatch(events);
    await this.runWrite('append', async () => {
      options.signal?.throwIfAborted();
      await this.persistContiguous(batch);
    });
  }

  /**
   * 耐久屏障：把路由过来的实时事件写完，确认租约仍在自己手上。
   *
   * @param options - 可选取消。
   */
  async flush(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    this.assertWritable('flush');
    const span = this.backend.startSpan(PERSISTENCE_SIGNALS.flush, { 'session.id': this.id });
    try {
      await this.runWrite('flush', async () => {
        options.signal?.throwIfAborted();
        await this.persistBuffered();
        if (this.lease !== undefined && !this.ownershipLost) {
          await this.guard('续租', () => this.lease!.renew());
        }
      });
      span.setAttribute('count', this.buffered.length);
      span.setAttribute('outcome', 'ok');
    } catch (error) {
      span.setAttributes(describeError(error));
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  /** 释放句柄：先把缓冲写完，再释放租约与专用连接。可重复调用。 */
  close(): Promise<void> {
    this.closing ??= (async () => {
      let drainFailure: unknown;
      for (;;) {
        try {
          await this.drainLive();
        } catch (error) {
          drainFailure = error;
          break;
        }
        await this.chain;
        if (this.buffered.length === 0) break;
      }
      await this.chain;
      this.closed = true;
      this.stopHeartbeat();
      let releaseFailure: unknown;
      try {
        await this.lease?.release();
      } catch (error) {
        releaseFailure = error;
      }
      this.client?.release(this.ownershipLost);
      this.backend.releaseHandle(this);
      const failures = [drainFailure, releaseFailure].filter((value) => value !== undefined);
      if (failures.length > 1) {
        throw new AggregateError(failures, `会话 "${this.id}"：关闭时既无法写完缓冲也无法释放写租约`);
      }
      const first = failures[0];
      if (first !== undefined) throw first instanceof Error ? first : new Error(String(first));
    })();
    return this.closing;
  }

  /** `await using` 支持。 */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** 接收一条路由过来的实时事件。 */
  enqueueLive(event: SessionEvent, report: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event));
    if (this.batchTimer !== undefined || this.drainPaused) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.drainLive().catch(report);
    }, 200);
  }

  /** 把实时缓冲写完；并发调用合并到同一次。 */
  drainLive(): Promise<void> {
    this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    this.drainPaused = false;
    while (this.buffered.length > 0) {
      const batch = this.buffered.splice(0);
      await this.enqueueChain(async () => {
        try {
          await this.persistContiguous(materializeAppendBatch(batch));
        } catch (error) {
          this.buffered = batch.concat(this.buffered);
          this.drainPaused = true;
          throw error;
        }
      });
    }
  }

  /** 把当前缓冲写成一批。 */
  private async persistBuffered(): Promise<void> {
    if (this.buffered.length === 0) return;
    const batch = materializeAppendBatch(this.buffered.splice(0));
    await this.persistContiguous(batch);
  }

  /** 一次写入的公共体：租约核对、序号核对、插入与计数推进，全部在一个事务里。 */
  private async persistContiguous(batch: readonly SessionEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const client = this.requireClient();
    const span = this.backend.startSpan(PERSISTENCE_SIGNALS.append, {
      'session.id': this.id,
      seq: batch[0]!.seq,
      count: batch.length,
    });
    const expected = this.cursor;
    try {
      assertContiguous(this.id, batch as readonly SessionEvent[], expected);
      await this.transaction(client, async () => {
        await this.guard('核对写租约', () => this.lease!.verifyInTransaction());
        await this.guard('写入事件', () =>
          client.query(
            `insert into "${this.backend.schemaName}".${EVENTS_TABLE} (session_id, seq, time, kind, event)
             select $1, t.seq, t.time, t.kind, t.event
               from unnest($2::int[], $3::bigint[], $4::text[], $5::jsonb[]) as t(seq, time, kind, event)`,
            [
              this.id,
              batch.map((event) => event.seq),
              batch.map((event) => event.time),
              batch.map((event) => event.type),
              batch.map((event) => JSON.stringify(event)),
            ],
          ),
        );
        const last = batch[batch.length - 1]!;
        await this.guard('推进会话计数', () =>
          client.query(
            `update "${this.backend.schemaName}".${SESSIONS_TABLE}
                set event_count = $2, last_activity_at = $3
              where id = $1`,
            [this.id, expected + batch.length, last.time],
          ),
        );
      });
      this.cursor = expected + batch.length;
      this.observedLength = Math.max(this.observedLength, this.cursor);
      this.backend.recordAppend(batch.length, 'ok');
      span.setAttribute('outcome', 'ok');
    } catch (error) {
      this.backend.recordAppend(batch.length, 'failed');
      span.setAttributes(describeError(error));
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  /** 在专用连接上开一个事务；回调抛出时回滚。 */
  private async transaction(client: PgClient, body: () => Promise<void>): Promise<void> {
    await this.guard('开启事务', () => client.query('begin'));
    try {
      await body();
      await this.guard('提交事务', () => client.query('commit'));
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        const failure = asPostgresError(rollbackError, '回滚事务');
        if (!isConnectionError(rollbackError)) {
          throw new AggregateError([error, failure], '追加失败且回滚也失败');
        }
      }
      throw error;
    }
  }

  /** 执行一次写路径调用；连接级错误在写句柄上视为所有权丢失。 */
  private async guard<T>(operation: string, body: () => Promise<T>): Promise<T> {
    if (this.ownershipLost) throw new SessionOwnershipLostError(this.id);
    try {
      return await body();
    } catch (error) {
      const failure = asPostgresError(error, operation);
      if (failure instanceof SessionOwnershipLostError) {
        this.markLost('lease-mismatch', failure);
        throw failure;
      }
      if (isConnectionError(error)) {
        this.markLost('connection-closed', failure);
        throw new SessionOwnershipLostError(this.id);
      }
      throw failure;
    }
  }

  /** 标记所有权丢失并记一次遥测。 */
  private markLost(reason: 'connection-error' | 'connection-closed' | 'lease-mismatch', error?: unknown): void {
    if (this.ownershipLost) return;
    this.ownershipLost = true;
    this.stopHeartbeat();
    this.backend.recordOwnershipLoss(reason, error);
  }

  /** 启动周期续租。 */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const lease = this.lease;
      if (lease === undefined || this.ownershipLost || this.closed) return;
      lease.renew().catch((error: unknown) => this.markLost('lease-mismatch', error));
    }, this.backend.leaseHeartbeatMs);
    this.heartbeatTimer.unref();
  }

  /** 停止周期续租。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /** 取专用连接。 */
  private requireClient(): PgClient {
    if (this.client === undefined) throw new SessionReadOnlyError(this.id, 'append');
    return this.client;
  }

  /** 句柄关闭后拒绝一切操作。 */
  private assertOpen(operation: string): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, operation);
  }

  /** 写操作的前置检查。 */
  private assertWritable(operation: string): void {
    this.assertOpen(operation);
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, operation);
    if (this.ownershipLost) throw new SessionOwnershipLostError(this.id);
  }

  /** 串行执行一次公开的写操作。 */
  private async runWrite<T>(operation: string, body: () => Promise<T>): Promise<T> {
    this.assertWritable(operation);
    const next = this.chain.then(body);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 把一次内部写入串到本句柄的链上。 */
  private async enqueueChain<T>(body: () => Promise<T>): Promise<T> {
    const next = this.chain.then(body);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
