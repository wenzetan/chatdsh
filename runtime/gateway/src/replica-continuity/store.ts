/**
 * 连续副本的接收端存储。
 *
 * 一个会话的副本由三样东西共同定义：按序号连续的事件、内部连续前缀与真实字节账本。
 * 三者与通知登记在同一个事务里提交，事务之外看不到半批写入。连续前缀从 -1 开始，
 * 同一序号同一摘要幂等确认，摘要不同返回冲突，序号跳过未确认区间返回缺口。
 *
 * 清理不删除保留记录：清理把保留代次加一并标记为已清理，旧代次的上报一律拒绝，
 * 已清理的副本不会被旧补传自动重建；显式重新获取再加一个代次并恢复写入。
 * @module @chatdsh/gateway/replica-continuity/store
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { SqlRow, SqlExecutor } from '../storage/sqlite.ts';
import { REPLICA_ERROR_CODES, ReplicaContinuityError } from './errors.ts';

/** 一条待写入副本的事件。 */
export interface ReplicaEventInput {
  /** 会话内部的序号；同一会话内严格递增，从 0 开始。 */
  readonly seq: number;
  /** 事件种类，例如 `user/message`。 */
  readonly kind: string;
  /** 事件时刻的毫秒时间戳。 */
  readonly time: number;
  /** 事件正文。 */
  readonly payload: unknown;
}

/** 一次上报。 */
export interface ReplicaAppendRequest {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 上报设备；会话归属在首次写入时登记。 */
  readonly deviceId: string;
  /** 保留代次；与当前代次不同即拒绝。 */
  readonly retentionGeneration: number;
  /** 本批事件，按序号升序。 */
  readonly events: readonly ReplicaEventInput[];
}

/** 一条已提交的副本事件。 */
export interface CommittedReplicaEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  /** 接收端计量的正文字节数。 */
  readonly bytes: number;
  /** 接收端按正文计算的摘要。 */
  readonly digest: string;
}

/** 一次上报的结果。 */
export interface ReplicaAppendResult {
  readonly sessionId: string;
  /** 本次提交后的连续前缀。 */
  readonly acknowledgedThrough: number;
  /** 新写入的条数。 */
  readonly appended: number;
  /** 已存在且内容一致的条数。 */
  readonly duplicates: number;
  /** 全部已提交事件的字节数。 */
  readonly bytesCommitted: number;
  readonly retentionGeneration: number;
  /** 本次新提交的事件，供提交之后广播。 */
  readonly committed: readonly CommittedReplicaEvent[];
}

/** 一条会话保留记录的对外形状。 */
export interface ReplicaRetentionState {
  readonly sessionId: string;
  readonly generation: number;
  readonly state: 'active' | 'cleared';
}

/** 一个会话副本的内部状态；只供上报方恢复游标与受权限保护的测试断言。 */
export interface ReplicaCursorView {
  readonly sessionId: string;
  readonly deviceId: string | undefined;
  readonly retentionGeneration: number;
  readonly retentionState: 'active' | 'cleared';
  readonly continuousSeq: number;
  readonly eventCount: number;
  readonly bytesCommitted: number;
  /** 最后一次提交的时刻。 */
  readonly updatedAt: number;
}

/** 一条副本通知登记。 */
export interface ReplicaNotificationRecord {
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
}

/** 读到的一条副本事件。 */
export interface StoredReplicaEvent {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes: number;
  readonly digest: string;
  readonly payload: unknown;
}

/** 游标行的列。 */
interface CursorRow extends SqlRow {
  readonly retention_generation: number;
  readonly continuous_seq: number;
  readonly digest: string;
  readonly committed_bytes: number;
  readonly updated_at: number;
}

/** 摘要行的列。 */
interface DigestRow extends SqlRow {
  readonly digest: string;
}

/** 保留行的列。 */
interface RetentionRow extends SqlRow {
  readonly generation: number;
  readonly state: string;
}

/** 归属行的列。 */
interface OwnerRow extends SqlRow {
  readonly device_id: string;
}

/** 令牌行的列。 */
interface TokenRow extends SqlRow {
  readonly token_digest: string;
  readonly revoked_at: number | null;
}

/** 计数行的列。 */
interface CountRow extends SqlRow {
  readonly total: number;
}

/** 事件行的列。 */
interface EventRow extends SqlRow {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly payload_bytes: number;
  readonly digest: string;
  readonly payload: string;
}

/** 通知行的列。 */
interface NotificationRow extends SqlRow {
  readonly seq: number;
  readonly kind: string;
}

/** 规范化 JSON：对象键排序，数组保持顺序。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 计算正文摘要。 */
export function replicaDigestOf(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** 计算正文的 UTF-8 字节数。 */
export function replicaBytesOf(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/** 连续副本存储。 */
export class ReplicaContinuityStore {
  constructor(private readonly executor: SqlExecutor) {
    this.migrate();
  }

  private migrate(): void {
    this.executor.exec(`
      create table if not exists replica_events (
        session_id text not null,
        seq integer not null,
        kind text not null,
        time integer not null,
        payload_bytes integer not null,
        digest text not null,
        payload text not null,
        primary key (session_id, seq)
      );
      create table if not exists replica_cursors (
        session_id text primary key,
        retention_generation integer not null,
        continuous_seq integer not null,
        digest text not null,
        committed_bytes integer not null,
        updated_at integer not null
      );
      create table if not exists replica_retention (
        session_id text primary key,
        generation integer not null,
        state text not null,
        updated_at integer not null
      );
      create table if not exists replica_owners (
        session_id text primary key,
        device_id text not null
      );
      create table if not exists replica_notifications (
        id integer primary key autoincrement,
        session_id text not null,
        seq integer not null,
        kind text not null,
        created_at integer not null
      );
      create table if not exists replica_gaps (
        session_id text primary key,
        expected_seq integer not null,
        updated_at integer not null
      );
      create table if not exists replica_tokens (
        device_id text primary key,
        token_digest text not null,
        revoked_at integer
      );
    `);
  }

  /** 登记或替换一台设备的节点令牌。 */
  registerToken(deviceId: string, token: string): void {
    this.executor.run(
      `insert into replica_tokens (device_id, token_digest, revoked_at) values (?, ?, null)
       on conflict(device_id) do update set token_digest = excluded.token_digest, revoked_at = null`,
      [deviceId, createHash('sha256').update(token).digest('hex')],
    );
  }

  /** 撤销一台设备的令牌。 */
  revokeToken(deviceId: string): void {
    this.executor.run('update replica_tokens set revoked_at = ? where device_id = ?', [Date.now(), deviceId]);
  }

  /** 校验节点令牌；令牌无效、已撤销或设备不存在都返回假。 */
  authorize(deviceId: string, token: string): boolean {
    const row = this.executor.get<TokenRow>('select token_digest, revoked_at from replica_tokens where device_id = ?', [deviceId]);
    if (row === undefined || row.revoked_at !== null) return false;
    const expected = Buffer.from(row.token_digest, 'hex');
    const actual = createHash('sha256').update(token).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** 读一个会话的保留记录。 */
  retentionOf(sessionId: string): ReplicaRetentionState {
    const row = this.retentionRowOf(sessionId);
    if (row === undefined) return { sessionId, generation: 0, state: 'active' };
    return { sessionId, generation: Number(row.generation), state: row.state === 'cleared' ? 'cleared' : 'active' };
  }

  /** 清理一个会话的副本：保留代次加一，事件、游标、通知与缺口一并删除。 */
  clear(sessionId: string): ReplicaRetentionState {
    return this.executor.transaction(() => {
      const current = this.retentionRowOf(sessionId);
      const generation = (current === undefined ? 0 : Number(current.generation)) + 1;
      this.writeRetention(sessionId, generation, 'cleared');
      this.executor.run('delete from replica_events where session_id = ?', [sessionId]);
      this.executor.run('delete from replica_cursors where session_id = ?', [sessionId]);
      this.executor.run('delete from replica_notifications where session_id = ?', [sessionId]);
      this.executor.run('delete from replica_gaps where session_id = ?', [sessionId]);
      return { sessionId, generation, state: 'cleared' as const };
    });
  }

  /** 显式重新获取：再增加一个代次并恢复写入，旧代次的补传永久失效。 */
  reacquire(sessionId: string): ReplicaRetentionState {
    return this.executor.transaction(() => {
      const current = this.retentionRowOf(sessionId);
      const generation = (current === undefined ? 0 : Number(current.generation)) + 1;
      this.writeRetention(sessionId, generation, 'active');
      this.executor.run('delete from replica_gaps where session_id = ?', [sessionId]);
      return { sessionId, generation, state: 'active' as const };
    });
  }

  /** 记录一次缺口，供落后会话计数使用。 */
  recordGap(sessionId: string, expectedSeq: number): void {
    this.executor.run(
      `insert into replica_gaps (session_id, expected_seq, updated_at) values (?, ?, ?)
       on conflict(session_id) do update set expected_seq = excluded.expected_seq, updated_at = excluded.updated_at`,
      [sessionId, expectedSeq, Date.now()],
    );
  }

  /** 当前仍有缺口的会话数。 */
  pendingGapCount(): number {
    const row = this.executor.get<CountRow>('select count(*) as total from replica_gaps');
    return row === undefined ? 0 : Number(row.total);
  }

  /** 读一个会话的内部状态。 */
  cursorView(sessionId: string): ReplicaCursorView {
    const retention = this.retentionOf(sessionId);
    const cursor = this.cursorRowOf(sessionId);
    const owner = this.ownerOf(sessionId);
    const count = this.executor.get<CountRow>('select count(*) as total from replica_events where session_id = ?', [sessionId]);
    return {
      sessionId,
      deviceId: owner,
      retentionGeneration: retention.generation,
      retentionState: retention.state,
      continuousSeq: cursor === undefined ? -1 : Number(cursor.continuous_seq),
      eventCount: count === undefined ? 0 : Number(count.total),
      bytesCommitted: cursor === undefined ? 0 : Number(cursor.committed_bytes),
      updatedAt: cursor === undefined ? 0 : Number(cursor.updated_at),
    };
  }

  /** 读一个会话的全部事件，按序号升序。 */
  readEvents(sessionId: string, upToSeq?: number): readonly StoredReplicaEvent[] {
    const limit = upToSeq === undefined ? '' : ' and seq <= ?';
    const parameters = upToSeq === undefined ? [sessionId] : [sessionId, upToSeq];
    const rows = this.executor.all<EventRow>(
      `select seq, kind, time, payload_bytes, digest, payload from replica_events where session_id = ?${limit} order by seq asc`,
      parameters,
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      kind: String(row.kind),
      time: Number(row.time),
      bytes: Number(row.payload_bytes),
      digest: String(row.digest),
      payload: JSON.parse(String(row.payload)) as unknown,
    }));
  }

  /** 读一个会话的通知登记，按登记顺序。 */
  notificationsOf(sessionId: string): readonly ReplicaNotificationRecord[] {
    const rows = this.executor.all<NotificationRow>(
      'select seq, kind from replica_notifications where session_id = ? order by id asc',
      [sessionId],
    );
    return rows.map((row) => ({ sessionId, seq: Number(row.seq), kind: String(row.kind) }));
  }

  /**
   * 提交一批事件。
   *
   * 事件、连续前缀、字节账本与通知登记在同一个事务里写入；任何一条被拒绝时整批回滚。
   * @param request - 一次上报。
   * @returns 提交结果，含本次新提交的事件。
   */
  append(request: ReplicaAppendRequest): ReplicaAppendResult {
    return this.executor.transaction(() => {
      const sessionId = request.sessionId;
      const retentionRow = this.retentionRowOf(sessionId);
      const retention = retentionRow === undefined
        ? { sessionId, generation: 0, state: 'active' as const }
        : {
          sessionId,
          generation: Number(retentionRow.generation),
          state: retentionRow.state === 'cleared' ? 'cleared' as const : 'active' as const,
        };
      if (retentionRow === undefined) this.writeRetention(sessionId, retention.generation, retention.state);
      if (retention.state !== 'active' || retention.generation !== request.retentionGeneration) {
        throw new ReplicaContinuityError(
          REPLICA_ERROR_CODES.retentionStale,
          409,
          '上报携带的保留代次不是当前代次',
          { currentGeneration: retention.generation, state: retention.state },
        );
      }
      const owner = this.ownerOf(sessionId);
      if (owner !== undefined && owner !== request.deviceId) {
        throw new ReplicaContinuityError(
          REPLICA_ERROR_CODES.ownerMismatch,
          409,
          '会话归属另一台设备',
          { deviceId: owner },
        );
      }
      if (owner === undefined) {
        this.executor.run('insert into replica_owners (session_id, device_id) values (?, ?)', [sessionId, request.deviceId]);
      }
      if (request.events.length === 0) {
        throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '上报批次为空');
      }
      const cursor = this.cursorRowOf(sessionId);
      let lastSeq = cursor === undefined ? -1 : Number(cursor.continuous_seq);
      let lastDigest = cursor === undefined ? '' : String(cursor.digest);
      const baseBytes = cursor === undefined ? 0 : Number(cursor.committed_bytes);
      let appendedBytes = 0;
      let appended = 0;
      let duplicates = 0;
      let expected = lastSeq + 1;
      let previousSeq = -1;
      const committed: CommittedReplicaEvent[] = [];
      for (const event of request.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
          throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件序号不合法', { seq: event.seq });
        }
        if (typeof event.kind !== 'string' || event.kind === '') {
          throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件种类不合法', { seq: event.seq });
        }
        if (!Number.isFinite(event.time)) {
          throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件时间不合法', { seq: event.seq });
        }
        if (event.payload === undefined) {
          throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '事件正文缺失', { seq: event.seq });
        }
        if (previousSeq >= 0 && event.seq <= previousSeq) {
          throw new ReplicaContinuityError(REPLICA_ERROR_CODES.invalidPayload, 400, '批内事件序号不严格递增', { seq: event.seq });
        }
        previousSeq = event.seq;
        const payloadText = JSON.stringify(event.payload);
        const bytes = Buffer.byteLength(payloadText);
        const digest = replicaDigestOf(event.payload);
        if (event.seq <= lastSeq) {
          const stored = this.eventDigestOf(sessionId, event.seq);
          if (stored === undefined) {
            throw new ReplicaContinuityError(
              REPLICA_ERROR_CODES.gap,
              409,
              '连续前缀声明的事件缺失',
              { expectedSeq: lastSeq + 1, seq: event.seq },
            );
          }
          if (stored !== digest) {
            throw new ReplicaContinuityError(
              REPLICA_ERROR_CODES.contentConflict,
              409,
              '同一序号的内容不同',
              { seq: event.seq },
            );
          }
          duplicates += 1;
          continue;
        }
        if (event.seq !== expected) {
          throw new ReplicaContinuityError(
            REPLICA_ERROR_CODES.gap,
            409,
            '事件序号跳过未确认区间',
            { expectedSeq: expected, seq: event.seq },
          );
        }
        this.executor.run(
          `insert into replica_events (session_id, seq, kind, time, payload_bytes, digest, payload)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [sessionId, event.seq, event.kind, event.time, bytes, digest, payloadText],
        );
        committed.push({ sessionId, seq: event.seq, kind: event.kind, time: event.time, bytes, digest });
        appendedBytes += bytes;
        appended += 1;
        lastSeq = event.seq;
        lastDigest = digest;
        expected += 1;
      }
      this.executor.run(
        `insert into replica_cursors (session_id, retention_generation, continuous_seq, digest, committed_bytes, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(session_id) do update set
           retention_generation = excluded.retention_generation,
           continuous_seq = excluded.continuous_seq,
           digest = excluded.digest,
           committed_bytes = excluded.committed_bytes,
           updated_at = excluded.updated_at`,
        [sessionId, retention.generation, lastSeq, lastDigest, baseBytes + appendedBytes, Date.now()],
      );
      for (const event of committed) {
        this.executor.run(
          'insert into replica_notifications (session_id, seq, kind, created_at) values (?, ?, ?, ?)',
          [sessionId, event.seq, event.kind, Date.now()],
        );
      }
      this.executor.run('delete from replica_gaps where session_id = ?', [sessionId]);
      return {
        sessionId,
        acknowledgedThrough: lastSeq,
        appended,
        duplicates,
        bytesCommitted: baseBytes + appendedBytes,
        retentionGeneration: retention.generation,
        committed,
      };
    });
  }

  private writeRetention(sessionId: string, generation: number, state: 'active' | 'cleared'): void {
    this.executor.run(
      `insert into replica_retention (session_id, generation, state, updated_at) values (?, ?, ?, ?)
       on conflict(session_id) do update set generation = excluded.generation, state = excluded.state, updated_at = excluded.updated_at`,
      [sessionId, generation, state, Date.now()],
    );
  }

  private retentionRowOf(sessionId: string): RetentionRow | undefined {
    return this.executor.get<RetentionRow>('select generation, state from replica_retention where session_id = ?', [sessionId]);
  }

  private cursorRowOf(sessionId: string): CursorRow | undefined {
    return this.executor.get<CursorRow>(
      'select retention_generation, continuous_seq, digest, committed_bytes, updated_at from replica_cursors where session_id = ?',
      [sessionId],
    );
  }

  private ownerOf(sessionId: string): string | undefined {
    const row = this.executor.get<OwnerRow>('select device_id from replica_owners where session_id = ?', [sessionId]);
    return row === undefined ? undefined : String(row.device_id);
  }

  private eventDigestOf(sessionId: string, seq: number): string | undefined {
    const row = this.executor.get<DigestRow>('select digest from replica_events where session_id = ? and seq = ?', [sessionId, seq]);
    return row === undefined ? undefined : String(row.digest);
  }
}
