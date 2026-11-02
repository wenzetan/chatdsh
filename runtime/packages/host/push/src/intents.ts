/**
 * 设备的补传意图。
 *
 * 事件先写进权威日志，然后在这里登记一条只带序号的意图；正文始终从权威日志读取。
 * 意图是持久记录，进程重启后按它继续补传；控制平面确认连续前缀之后才删除已确认的意图。
 * 每个会话另存保留代次与状态，已清理副本的旧代次不会因为重试被自动重建。
 * @module @chatdsh/host-push/intents
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 会话补传状态。 */
export const REPLICA_INTENT_STATES = ['active', 'stale', 'gap', 'conflict', 'unauthorized'] as const;

/** 状态取值。 */
export type ReplicaIntentState = (typeof REPLICA_INTENT_STATES)[number];

/** 一条待补传意图。 */
export interface ReplicaIntentRecord {
  readonly sessionId: string;
  readonly seq: number;
  readonly retentionGeneration: number;
}

/** 一个会话已确认的连续前缀。 */
export interface ReplicaConfirmedRecord {
  readonly sessionId: string;
  readonly retentionGeneration: number;
  readonly continuousSeq: number;
}

/** 一个会话的补传状态。 */
export interface ReplicaSessionState {
  readonly sessionId: string;
  readonly retentionGeneration: number;
  readonly state: ReplicaIntentState;
}

/** 一行意图。 */
interface IntentRow {
  readonly seq: number;
  readonly retention_generation: number;
}

/** 一行确认记录。 */
interface ConfirmedRow {
  readonly retention_generation: number;
  readonly continuous_seq: number;
}

/** 一行状态记录。 */
interface StateRow {
  readonly retention_generation: number;
  readonly state: string;
}

/** 一列会话标识。 */
interface SessionRow {
  readonly session_id: string;
}

/** 设备侧补传意图存储。 */
export class ReplicaIntentStore {
  private readonly database: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      create table if not exists replica_intents (
        session_id text not null,
        seq integer not null,
        retention_generation integer not null,
        created_at integer not null,
        primary key (session_id, seq)
      );
      create table if not exists replica_confirmed (
        session_id text primary key,
        retention_generation integer not null,
        continuous_seq integer not null,
        updated_at integer not null
      );
      create table if not exists replica_states (
        session_id text primary key,
        retention_generation integer not null,
        state text not null,
        updated_at integer not null
      );
    `);
  }

  /** 在一个事务里执行；已经处于事务内时复用外层事务。 */
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

  /** 释放句柄。 */
  close(): void {
    this.database.close();
  }

  /** 登记一条待补传意图；重复登记同一序号不改变已有记录。 */
  markPending(sessionId: string, seq: number, retentionGeneration: number): void {
    this.database
      .prepare('insert or ignore into replica_intents (session_id, seq, retention_generation, created_at) values (?, ?, ?, ?)')
      .run(sessionId, seq, retentionGeneration, Date.now());
  }

  /** 批量登记待补传意图。 */
  markPendingBatch(sessionId: string, seqs: readonly number[], retentionGeneration: number): void {
    this.transaction(() => {
      const statement = this.database.prepare(
        'insert or ignore into replica_intents (session_id, seq, retention_generation, created_at) values (?, ?, ?, ?)',
      );
      const now = Date.now();
      for (const seq of seqs) statement.run(sessionId, seq, retentionGeneration, now);
    });
  }

  /** 读一个会话的待补传意图，按序号升序。 */
  pendingOf(sessionId: string, limit: number): readonly ReplicaIntentRecord[] {
    const rows = this.database
      .prepare('select seq, retention_generation from replica_intents where session_id = ? order by seq asc limit ?')
      .all(sessionId, limit) as unknown as IntentRow[];
    return rows.map((row) => ({ sessionId, seq: Number(row.seq), retentionGeneration: Number(row.retention_generation) }));
  }

  /** 一个会话仍待补传的条数。 */
  pendingCountOf(sessionId: string): number {
    const row = this.database
      .prepare('select count(*) as total from replica_intents where session_id = ?')
      .get(sessionId) as { total: number } | undefined;
    return row === undefined ? 0 : Number(row.total);
  }

  /** 有待补传意图的会话。 */
  pendingSessions(): readonly string[] {
    const rows = this.database
      .prepare('select distinct session_id from replica_intents order by session_id asc')
      .all() as unknown as SessionRow[];
    return rows.map((row) => String(row.session_id));
  }

  /** 全部登记过意图、确认记录或状态的会话。 */
  sessions(): readonly string[] {
    const rows = this.database
      .prepare(`select session_id from replica_intents
                union select session_id from replica_confirmed
                union select session_id from replica_states
                order by session_id asc`)
      .all() as unknown as SessionRow[];
    return rows.map((row) => String(row.session_id));
  }

  /** 读已确认的连续前缀。 */
  confirmedOf(sessionId: string): ReplicaConfirmedRecord | undefined {
    const row = this.database
      .prepare('select retention_generation, continuous_seq from replica_confirmed where session_id = ?')
      .get(sessionId) as ConfirmedRow | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId,
      retentionGeneration: Number(row.retention_generation),
      continuousSeq: Number(row.continuous_seq),
    };
  }

  /** 记录连续前缀并删除已确认的意图。 */
  confirm(sessionId: string, throughSeq: number, retentionGeneration: number): void {
    this.transaction(() => {
      this.database
        .prepare(`insert into replica_confirmed (session_id, retention_generation, continuous_seq, updated_at)
                  values (?, ?, ?, ?)
                  on conflict(session_id) do update set
                    retention_generation = excluded.retention_generation,
                    continuous_seq = excluded.continuous_seq,
                    updated_at = excluded.updated_at`)
        .run(sessionId, retentionGeneration, throughSeq, Date.now());
      this.database
        .prepare('delete from replica_intents where session_id = ? and seq <= ?')
        .run(sessionId, throughSeq);
    });
  }

  /** 写一个会话的保留代次与状态。 */
  setState(sessionId: string, retentionGeneration: number, state: ReplicaIntentState): void {
    this.database
      .prepare(`insert into replica_states (session_id, retention_generation, state, updated_at)
                values (?, ?, ?, ?)
                on conflict(session_id) do update set
                  retention_generation = excluded.retention_generation,
                  state = excluded.state,
                  updated_at = excluded.updated_at`)
      .run(sessionId, retentionGeneration, state, Date.now());
  }

  /** 读一个会话的补传状态。 */
  stateOf(sessionId: string): ReplicaSessionState | undefined {
    const row = this.database
      .prepare('select retention_generation, state from replica_states where session_id = ?')
      .get(sessionId) as StateRow | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId,
      retentionGeneration: Number(row.retention_generation),
      state: row.state as ReplicaIntentState,
    };
  }
}
