/**
 * 控制平面存储接口的 Postgres 实现。
 *
 * 端口与 `gateway/src/storage/interface.ts` 一一对应：幂等操作、访问会话、设备代次、配对码、
 * 连续副本、运行期入站、记忆出站、通知出站、迁移任务与备份清单。每个端口保留唯一约束与
 * 事务边界；重复登记幂等、异内容冲突、跨过缺口拒绝，语义与默认 SQLite 实现一致。
 *
 * 用量账本与检索文档另提供方法：用量按「会话编号加轮次」唯一，重复上报不重复计账；检索
 * 使用 `to_tsvector` 与 `ts_rank`，与 SQLite FTS5 的排序与摘要等价。
 * @module @chatdsh/gateway/postgres/control-plane
 */

import { randomUUID } from 'node:crypto';
import type {
  AccessSessionPort,
  AccessSessionRecord,
  BackupManifestRecord,
  BackupPort,
  ChatdshStorage,
  DeviceGenerationPort,
  DeviceGenerationRecord,
  MemoryOutboxPort,
  MemoryOutboxRecord,
  MigrationJobRecord,
  MigrationPort,
  NotificationOutboxPort,
  NotificationOutboxRecord,
  OperationPort,
  OperationRecord,
  PairingCodePort,
  PairingCodeRecord,
  ReplicaCursorRecord,
  ReplicaOutboxRecord,
  ReplicaPort,
  RunInboxPort,
  RunInboxRecord,
  StorageTransaction,
} from '../storage/interface.ts';
import { MigrationJobStore } from '../storage/migration-job.ts';
import type { SqlExecutor, SqlRow } from '../storage/sqlite.ts';
import { POSTGRES_STORAGE_ERROR_CODES, PostgresStorageError } from './errors.ts';
import { integerOf, nullableIntegerOf } from './pg-module.ts';
import { PostgresSearchIndex } from './search.ts';

/** 控制平面的 schema 版本。 */
export const CONTROL_PLANE_SCHEMA_VERSION = 1;

/** 一条用量记录。 */
export interface UsageRecord {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 轮次编号，从 1 开始。 */
  readonly turn: number;
  /** 所属工作区；聊天会话为空。 */
  readonly workspaceId?: string;
  /** 模型标识。 */
  readonly model: string;
  /** 提供方标识。 */
  readonly provider: string;
  /** 输入 token 数。 */
  readonly inputTokens: number;
  /** 输出 token 数。 */
  readonly outputTokens: number;
  /** 缓存命中 token 数。 */
  readonly cachedTokens: number;
  /** 推理 token 数。 */
  readonly reasoningTokens: number;
  /** 记录时刻的毫秒时间戳。 */
  readonly recordedAt: number;
}

/** 用量合计。 */
export interface UsageTotals {
  /** 用量行数。 */
  readonly rows: number;
  /** 输入 token 合计。 */
  readonly inputTokens: number;
  /** 输出 token 合计。 */
  readonly outputTokens: number;
  /** 缓存命中 token 合计。 */
  readonly cachedTokens: number;
  /** 推理 token 合计。 */
  readonly reasoningTokens: number;
}

/** Postgres 控制平面存储。 */
export class PostgresControlPlane implements ChatdshStorage {
  /** 已应用的 schema 版本。 */
  readonly schemaVersion = CONTROL_PLANE_SCHEMA_VERSION;
  /** 幂等操作。 */
  readonly operations: OperationPort;
  /** 访问会话与凭据。 */
  readonly accessSessions: AccessSessionPort;
  /** 设备代次。 */
  readonly deviceGenerations: DeviceGenerationPort;
  /** 配对码。 */
  readonly pairingCodes: PairingCodePort;
  /** 连续副本。 */
  readonly replicas: ReplicaPort;
  /** 运行期入站。 */
  readonly runInbox: RunInboxPort;
  /** 记忆出站。 */
  readonly memoryOutbox: MemoryOutboxPort;
  /** 通知出站。 */
  readonly notifications: NotificationOutboxPort;
  /** 迁移任务。 */
  readonly migrations: MigrationPort;
  /** 备份清单。 */
  readonly backups: BackupPort;
  /** 检索文档。 */
  readonly search: PostgresSearchIndex;
  private readonly database: SqlExecutor;
  private readonly openTransactions = new Set<string>();

  constructor(database: SqlExecutor) {
    this.database = database;
    this.operations = new PostgresOperations(database, this.openTransactions);
    this.accessSessions = new PostgresAccessSessions(database, this.openTransactions);
    this.deviceGenerations = new PostgresDeviceGenerations(database, this.openTransactions);
    this.pairingCodes = new PostgresPairingCodes(database, this.openTransactions);
    this.replicas = new PostgresReplicas(database, this.openTransactions);
    this.runInbox = new PostgresRunInbox(database, this.openTransactions);
    this.memoryOutbox = new PostgresMemoryOutbox(database, this.openTransactions);
    this.notifications = new PostgresNotificationOutbox(database, this.openTransactions);
    this.migrations = new MigrationJobStore({ database });
    this.backups = new PostgresBackups(database, this.openTransactions);
    this.search = new PostgresSearchIndex(database);
  }

  /** 建表；可重复执行。 */
  ensureSchema(): void {
    this.database.exec(`
      create table if not exists operations (
        operation_id text primary key,
        request_digest text not null,
        device_id text not null,
        state text not null,
        result_ref text,
        created_at bigint not null,
        expires_at bigint not null
      )
    `);
    this.database.exec(`
      create table if not exists access_sessions (
        token_hash text primary key,
        created_at bigint not null,
        expires_at bigint not null,
        revoked_at bigint,
        last_verified_at bigint
      )
    `);
    this.database.exec(`
      create table if not exists device_generations (
        device_id text primary key,
        generation integer not null,
        token_digest text not null,
        revoked_at bigint
      )
    `);
    this.database.exec(`
      create table if not exists pairing_codes (
        digest text primary key,
        role text not null,
        expires_at bigint not null,
        consumed_at bigint
      )
    `);
    this.database.exec(`
      create table if not exists replica_cursors (
        session_id text primary key,
        retention_generation integer not null,
        continuous_seq integer not null,
        digest text not null
      )
    `);
    this.database.exec(`
      create table if not exists replica_outbox (
        session_id text not null,
        seq integer not null,
        digest text not null,
        retention_generation integer not null,
        primary key (session_id, seq)
      )
    `);
    this.database.exec(`
      create table if not exists run_inbox (
        run_id text not null,
        event_id text not null,
        seq integer not null,
        payload_ref text not null,
        applied_at bigint not null,
        primary key (run_id, event_id)
      )
    `);
    this.database.exec(`
      create table if not exists memory_outbox (
        operation_id text primary key,
        session_id text not null,
        end_seq integer not null,
        bank text not null,
        state text not null,
        attempts integer not null,
        next_attempt_at bigint not null
      )
    `);
    this.database.exec(`
      create table if not exists notification_outbox (
        key text primary key,
        client_id text not null,
        state text not null,
        tag text not null,
        expires_at bigint not null
      )
    `);
    this.database.exec(`
      create table if not exists backup_manifests (
        manifest_id text primary key,
        schema_version integer not null,
        created_at bigint not null,
        domains text[] not null,
        key_version text not null,
        manifest_ref text not null
      )
    `);
    this.database.exec(`
      create table if not exists usage_ledger (
        session_id text not null,
        turn integer not null,
        workspace_id text,
        model text not null,
        provider text not null,
        input_tokens bigint not null,
        output_tokens bigint not null,
        cached_tokens bigint not null,
        reasoning_tokens bigint not null,
        recorded_at bigint not null,
        primary key (session_id, turn)
      )
    `);
    this.database.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        checksum text not null,
        applied_at bigint not null
      )
    `);
    this.database.exec(
      `insert into schema_migrations (version, checksum, applied_at) values (${CONTROL_PLANE_SCHEMA_VERSION}, 'control-plane-v${CONTROL_PLANE_SCHEMA_VERSION}', ${Date.now()}) on conflict (version) do nothing`,
    );
    this.database.exec(`
      create index if not exists usage_ledger_session_idx on usage_ledger (session_id, turn)
    `);
    this.search.ensureSchema();
  }

  /** 在一个事务里执行；回调抛出时整体回滚。 */
  transaction<T>(fn: (tx: StorageTransaction) => T): T {
    return this.database.transaction(() => {
      const tx: StorageTransaction = { id: randomUUID() };
      this.openTransactions.add(tx.id);
      try {
        return fn(tx);
      } finally {
        this.openTransactions.delete(tx.id);
      }
    });
  }

  /**
   * 登记一笔用量；同一会话同一轮次重复登记幂等，内容不同时拒绝。
   *
   * @param record - 用量记录。
   * @returns 实际保存的记录。
   */
  recordUsage(record: UsageRecord): UsageRecord {
    requireUsage(record);
    return this.transaction(() => {
      const inserted = this.database.get<{ session_id: string }>(
        `insert into usage_ledger
           (session_id, turn, workspace_id, model, provider, input_tokens, output_tokens, cached_tokens, reasoning_tokens, recorded_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (session_id, turn) do nothing
         returning session_id`,
        [
          record.sessionId,
          record.turn,
          record.workspaceId ?? null,
          record.model,
          record.provider,
          record.inputTokens,
          record.outputTokens,
          record.cachedTokens,
          record.reasoningTokens,
          record.recordedAt,
        ],
      );
      if (inserted !== undefined) return record;
      const existing = this.readUsage(record.sessionId, record.turn);
      if (existing === undefined) throw new Error(`用量记录写入后读不到：${record.sessionId}#${record.turn}`);
      if (
        existing.inputTokens !== record.inputTokens ||
        existing.outputTokens !== record.outputTokens ||
        existing.cachedTokens !== record.cachedTokens ||
        existing.reasoningTokens !== record.reasoningTokens ||
        existing.model !== record.model ||
        existing.provider !== record.provider
      ) {
        throw new PostgresStorageError(
          POSTGRES_STORAGE_ERROR_CODES.usageConflict,
          `会话 ${record.sessionId} 第 ${record.turn} 轮的用量与已登记内容不同`,
          { session: record.sessionId, turn: record.turn },
        );
      }
      return existing;
    });
  }

  /**
   * 读一笔用量。
   *
   * @param sessionId - 会话标识。
   * @param turn - 轮次。
   * @returns 记录；不存在时为空。
   */
  readUsage(sessionId: string, turn: number): UsageRecord | undefined {
    const row = this.database.get<SqlRow>(
      `select session_id, turn, workspace_id, model, provider, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, recorded_at
         from usage_ledger where session_id = ? and turn = ?`,
      [sessionId, turn],
    );
    return row === undefined ? undefined : usageOf(row);
  }

  /**
   * 列出全部用量记录，按会话与轮次升序。
   *
   * @returns 用量记录。
   */
  listUsage(): readonly UsageRecord[] {
    return this.database
      .all<SqlRow>(
        `select session_id, turn, workspace_id, model, provider, input_tokens, output_tokens,
                cached_tokens, reasoning_tokens, recorded_at
           from usage_ledger order by session_id asc, turn asc`,
      )
      .map(usageOf);
  }

  /**
   * 用量合计；给出会话标识时只统计该会话。
   *
   * @param sessionId - 可选会话标识。
   * @returns 合计。
   */
  usageTotals(sessionId?: string): UsageTotals {
    const row = this.database.get<SqlRow>(
      `select count(*) as rows, coalesce(sum(input_tokens), 0) as input_tokens,
              coalesce(sum(output_tokens), 0) as output_tokens,
              coalesce(sum(cached_tokens), 0) as cached_tokens,
              coalesce(sum(reasoning_tokens), 0) as reasoning_tokens
         from usage_ledger
         ${sessionId === undefined ? '' : 'where session_id = ?'}`,
      sessionId === undefined ? [] : [sessionId],
    );
    if (row === undefined) return { rows: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
    return {
      rows: integerOf(row.rows, 'rows'),
      inputTokens: integerOf(row.input_tokens, 'input_tokens'),
      outputTokens: integerOf(row.output_tokens, 'output_tokens'),
      cachedTokens: integerOf(row.cached_tokens, 'cached_tokens'),
      reasoningTokens: integerOf(row.reasoning_tokens, 'reasoning_tokens'),
    };
  }

  /** 释放连接；同步桥由调用方关闭。 */
  close(): void {
    this.database.exec('select 1');
  }
}

/** 用量记录的形状校验。 */
function requireUsage(record: UsageRecord): void {
  if (record.sessionId === '') throw new Error('用量记录缺少会话标识');
  if (!Number.isSafeInteger(record.turn) || record.turn < 1) {
    throw new Error(`用量记录的轮次必须是正整数，实际 ${String(record.turn)}`);
  }
  for (const [name, value] of [
    ['inputTokens', record.inputTokens],
    ['outputTokens', record.outputTokens],
    ['cachedTokens', record.cachedTokens],
    ['reasoningTokens', record.reasoningTokens],
    ['recordedAt', record.recordedAt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`用量记录的 ${name} 必须是非负整数，实际 ${String(value)}`);
    }
  }
}

/** 一行用量记录。 */
function usageOf(row: SqlRow): UsageRecord {
  return {
    sessionId: String(row.session_id),
    turn: integerOf(row.turn, 'turn'),
    ...(row.workspace_id === null || row.workspace_id === undefined
      ? {}
      : { workspaceId: String(row.workspace_id) }),
    model: String(row.model),
    provider: String(row.provider),
    inputTokens: integerOf(row.input_tokens, 'input_tokens'),
    outputTokens: integerOf(row.output_tokens, 'output_tokens'),
    cachedTokens: integerOf(row.cached_tokens, 'cached_tokens'),
    reasoningTokens: integerOf(row.reasoning_tokens, 'reasoning_tokens'),
    recordedAt: integerOf(row.recorded_at, 'recorded_at'),
  };
}

/** 端口基类：核对事务句柄来自本存储。 */
abstract class PostgresPort {
  protected readonly database: SqlExecutor;
  private readonly openTransactions: Set<string>;

  constructor(database: SqlExecutor, openTransactions: Set<string>) {
    this.database = database;
    this.openTransactions = openTransactions;
  }

  /** 确认事务句柄来自本存储。 */
  protected requireTransaction(tx: StorageTransaction): void {
    if (!this.openTransactions.has(tx.id)) {
      throw new Error(`写入必须在同一个事务内执行：${tx.id}`);
    }
  }
}

/** 幂等操作端口。 */
class PostgresOperations extends PostgresPort implements OperationPort {
  begin(
    tx: StorageTransaction,
    input: { operationId: string; requestDigest: string; deviceId: string; expiresAt: number; now: number },
  ): OperationRecord {
    this.requireTransaction(tx);
    if (input.operationId === '') throw new Error('操作登记缺少操作标识');
    if (input.requestDigest === '') throw new Error('操作登记缺少请求摘要');
    this.database.run(
      `insert into operations (operation_id, request_digest, device_id, state, result_ref, created_at, expires_at)
       values (?, ?, ?, 'pending', null, ?, ?)
       on conflict (operation_id) do nothing`,
      [input.operationId, input.requestDigest, input.deviceId, input.now, input.expiresAt],
    );
    const record = this.read(input.operationId);
    if (record === undefined) throw new Error(`操作登记写入后读不到：${input.operationId}`);
    if (record.requestDigest !== input.requestDigest) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.operationDigestConflict,
        `操作 ${input.operationId} 携带的请求摘要与已登记内容不同`,
        { operation: input.operationId },
      );
    }
    return record;
  }

  complete(tx: StorageTransaction, operationId: string, resultRef: string, now: number): OperationRecord {
    this.requireTransaction(tx);
    if (resultRef === '') throw new Error('完成操作缺少结果引用');
    this.database.run(`update operations set state = 'applied', result_ref = ?, expires_at = expires_at where operation_id = ?`, [
      resultRef,
      operationId,
    ]);
    const record = this.read(operationId);
    if (record === undefined) throw new Error(`操作 ${operationId} 不存在，无法登记完成结果`);
    void now;
    return record;
  }

  read(operationId: string): OperationRecord | undefined {
    const row = this.database.get<SqlRow>(
      `select operation_id, request_digest, device_id, state, result_ref, created_at, expires_at
         from operations where operation_id = ?`,
      [operationId],
    );
    if (row === undefined) return undefined;
    return {
      operationId: String(row.operation_id),
      requestDigest: String(row.request_digest),
      deviceId: String(row.device_id),
      state: String(row.state) as OperationRecord['state'],
      ...(row.result_ref === null || row.result_ref === undefined ? {} : { resultRef: String(row.result_ref) }),
      createdAt: integerOf(row.created_at, 'created_at'),
      expiresAt: integerOf(row.expires_at, 'expires_at'),
    };
  }

  purgeExpired(tx: StorageTransaction, now: number): number {
    this.requireTransaction(tx);
    const row = this.database.get<SqlRow>(
      `with removed as (delete from operations where expires_at < ? and state = 'applied' returning 1)
       select count(*) as n from removed`,
      [now],
    );
    return row === undefined ? 0 : integerOf(row.n, 'n');
  }
}

/** 访问会话端口。 */
class PostgresAccessSessions extends PostgresPort implements AccessSessionPort {
  create(tx: StorageTransaction, record: AccessSessionRecord): void {
    this.requireTransaction(tx);
    if (record.tokenHash === '') throw new Error('访问会话缺少令牌摘要');
    this.database.run(
      `insert into access_sessions (token_hash, created_at, expires_at, revoked_at, last_verified_at)
       values (?, ?, ?, ?, ?)
       on conflict (token_hash) do nothing`,
      [record.tokenHash, record.createdAt, record.expiresAt, record.revokedAt ?? null, record.lastVerifiedAt ?? null],
    );
  }

  verify(tx: StorageTransaction, tokenHash: string, now: number): AccessSessionRecord | undefined {
    this.requireTransaction(tx);
    const row = this.database.get<SqlRow>(
      `select token_hash, created_at, expires_at, revoked_at, last_verified_at
         from access_sessions where token_hash = ? and expires_at > ? and revoked_at is null`,
      [tokenHash, now],
    );
    if (row === undefined) return undefined;
    this.database.run(`update access_sessions set last_verified_at = ? where token_hash = ?`, [now, tokenHash]);
    return {
      tokenHash: String(row.token_hash),
      createdAt: integerOf(row.created_at, 'created_at'),
      expiresAt: integerOf(row.expires_at, 'expires_at'),
      ...(nullableIntegerOf(row.revoked_at, 'revoked_at') === undefined
        ? {}
        : { revokedAt: nullableIntegerOf(row.revoked_at, 'revoked_at') }),
      lastVerifiedAt: now,
    };
  }

  revoke(tx: StorageTransaction, tokenHash: string, now: number): void {
    this.requireTransaction(tx);
    this.database.run(`update access_sessions set revoked_at = ? where token_hash = ? and revoked_at is null`, [
      now,
      tokenHash,
    ]);
  }
}

/** 设备代次端口。 */
class PostgresDeviceGenerations extends PostgresPort implements DeviceGenerationPort {
  issue(tx: StorageTransaction, deviceId: string, tokenDigest: string): DeviceGenerationRecord {
    this.requireTransaction(tx);
    if (deviceId === '') throw new Error('设备代次缺少设备标识');
    if (tokenDigest === '') throw new Error('设备代次缺少令牌摘要');
    const row = this.database.get<SqlRow>(
      `insert into device_generations (device_id, generation, token_digest, revoked_at)
       values (?, 1, ?, null)
       on conflict (device_id) do update
         set generation = device_generations.generation + 1,
             token_digest = excluded.token_digest,
             revoked_at = null
       returning device_id, generation, token_digest, revoked_at`,
      [deviceId, tokenDigest],
    );
    if (row === undefined) throw new Error(`设备代次写入后读不到：${deviceId}`);
    return generationOf(row);
  }

  current(deviceId: string): DeviceGenerationRecord | undefined {
    const row = this.database.get<SqlRow>(
      `select device_id, generation, token_digest, revoked_at from device_generations where device_id = ?`,
      [deviceId],
    );
    return row === undefined ? undefined : generationOf(row);
  }

  revoke(tx: StorageTransaction, deviceId: string, now: number): void {
    this.requireTransaction(tx);
    this.database.run(`update device_generations set revoked_at = ? where device_id = ? and revoked_at is null`, [
      now,
      deviceId,
    ]);
  }
}

/** 一行设备代次。 */
function generationOf(row: SqlRow): DeviceGenerationRecord {
  return {
    deviceId: String(row.device_id),
    generation: integerOf(row.generation, 'generation'),
    tokenDigest: String(row.token_digest),
    ...(nullableIntegerOf(row.revoked_at, 'revoked_at') === undefined
      ? {}
      : { revokedAt: nullableIntegerOf(row.revoked_at, 'revoked_at') }),
  };
}

/** 配对码端口。 */
class PostgresPairingCodes extends PostgresPort implements PairingCodePort {
  issue(tx: StorageTransaction, record: PairingCodeRecord): void {
    this.requireTransaction(tx);
    if (record.digest === '') throw new Error('配对码缺少摘要');
    this.database.run(
      `insert into pairing_codes (digest, role, expires_at, consumed_at) values (?, ?, ?, ?)
       on conflict (digest) do nothing`,
      [record.digest, record.role, record.expiresAt, record.consumedAt ?? null],
    );
  }

  consume(tx: StorageTransaction, digest: string, now: number): PairingCodeRecord | undefined {
    this.requireTransaction(tx);
    const row = this.database.get<SqlRow>(
      `update pairing_codes set consumed_at = ?
         where digest = ? and consumed_at is null and expires_at > ?
       returning digest, role, expires_at, consumed_at`,
      [now, digest, now],
    );
    if (row === undefined) return undefined;
    return {
      digest: String(row.digest),
      role: String(row.role) as PairingCodeRecord['role'],
      expiresAt: integerOf(row.expires_at, 'expires_at'),
      ...(nullableIntegerOf(row.consumed_at, 'consumed_at') === undefined
        ? {}
        : { consumedAt: nullableIntegerOf(row.consumed_at, 'consumed_at') }),
    };
  }
}

/** 连续副本端口。 */
class PostgresReplicas extends PostgresPort implements ReplicaPort {
  cursor(sessionId: string): ReplicaCursorRecord | undefined {
    const row = this.database.get<SqlRow>(
      `select session_id, retention_generation, continuous_seq, digest from replica_cursors where session_id = ?`,
      [sessionId],
    );
    if (row === undefined) return undefined;
    return {
      sessionId: String(row.session_id),
      retentionGeneration: integerOf(row.retention_generation, 'retention_generation'),
      continuousSeq: integerOf(row.continuous_seq, 'continuous_seq'),
      digest: String(row.digest),
    };
  }

  advance(tx: StorageTransaction, record: ReplicaCursorRecord): ReplicaCursorRecord {
    this.requireTransaction(tx);
    const current = this.cursor(record.sessionId);
    if (current === undefined) {
      if (record.continuousSeq !== 0) {
        throw new PostgresStorageError(
          POSTGRES_STORAGE_ERROR_CODES.replicaGap,
          `会话 ${record.sessionId} 的连续前缀必须从 0 开始，实际 ${record.continuousSeq}`,
          { session: record.sessionId, expected: 0 },
        );
      }
      this.database.run(
        `insert into replica_cursors (session_id, retention_generation, continuous_seq, digest) values (?, ?, ?, ?)`,
        [record.sessionId, record.retentionGeneration, record.continuousSeq, record.digest],
      );
      return record;
    }
    if (record.retentionGeneration !== current.retentionGeneration) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.replicaRetentionStale,
        `会话 ${record.sessionId} 的保留代次 ${record.retentionGeneration} 不是当前代次 ${current.retentionGeneration}`,
        { session: record.sessionId, current: current.retentionGeneration },
      );
    }
    if (record.continuousSeq === current.continuousSeq) {
      if (record.digest !== current.digest) {
        throw new PostgresStorageError(
          POSTGRES_STORAGE_ERROR_CODES.replicaContentConflict,
          `会话 ${record.sessionId} 序号 ${record.continuousSeq} 的内容摘要与已提交内容不同`,
          { session: record.sessionId, seq: record.continuousSeq },
        );
      }
      return current;
    }
    if (record.continuousSeq !== current.continuousSeq + 1) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.replicaGap,
        `会话 ${record.sessionId} 的连续前缀不能跳过未确认区间：当前 ${current.continuousSeq}，请求 ${record.continuousSeq}`,
        { session: record.sessionId, expected: current.continuousSeq + 1 },
      );
    }
    this.database.run(
      `update replica_cursors set continuous_seq = ?, digest = ?, retention_generation = ? where session_id = ?`,
      [record.continuousSeq, record.digest, record.retentionGeneration, record.sessionId],
    );
    return record;
  }

  appendOutbox(tx: StorageTransaction, record: ReplicaOutboxRecord): void {
    this.requireTransaction(tx);
    this.database.run(
      `insert into replica_outbox (session_id, seq, digest, retention_generation) values (?, ?, ?, ?)
       on conflict (session_id, seq) do nothing`,
      [record.sessionId, record.seq, record.digest, record.retentionGeneration],
    );
  }

  pendingOutbox(limit: number): readonly ReplicaOutboxRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`待补传条数必须是正整数，实际 ${String(limit)}`);
    return this.database
      .all<SqlRow>(
        `select session_id, seq, digest, retention_generation from replica_outbox
          order by session_id asc, seq asc limit ?`,
        [limit],
      )
      .map((row) => ({
        sessionId: String(row.session_id),
        seq: integerOf(row.seq, 'seq'),
        digest: String(row.digest),
        retentionGeneration: integerOf(row.retention_generation, 'retention_generation'),
      }));
  }

  ackOutbox(tx: StorageTransaction, record: { sessionId: string; seq: number }): void {
    this.requireTransaction(tx);
    this.database.run(`delete from replica_outbox where session_id = ? and seq = ?`, [record.sessionId, record.seq]);
  }
}

/** 运行期入站端口。 */
class PostgresRunInbox extends PostgresPort implements RunInboxPort {
  apply(tx: StorageTransaction, record: RunInboxRecord): RunInboxRecord {
    this.requireTransaction(tx);
    this.database.run(
      `insert into run_inbox (run_id, event_id, seq, payload_ref, applied_at) values (?, ?, ?, ?, ?)
       on conflict (run_id, event_id) do nothing`,
      [record.runId, record.eventId, record.seq, record.payloadRef, record.appliedAt],
    );
    const existing = this.database.get<SqlRow>(
      `select run_id, event_id, seq, payload_ref, applied_at from run_inbox where run_id = ? and event_id = ?`,
      [record.runId, record.eventId],
    );
    if (existing === undefined) throw new Error(`运行事件写入后读不到：${record.runId}/${record.eventId}`);
    const stored: RunInboxRecord = {
      runId: String(existing.run_id),
      eventId: String(existing.event_id),
      seq: integerOf(existing.seq, 'seq'),
      payloadRef: String(existing.payload_ref),
      appliedAt: integerOf(existing.applied_at, 'applied_at'),
    };
    if (stored.seq !== record.seq || stored.payloadRef !== record.payloadRef) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.operationDigestConflict,
        `运行事件 ${record.runId}/${record.eventId} 的内容与已应用内容不同`,
        { run: record.runId, seq: record.seq },
      );
    }
    return stored;
  }

  applied(runId: string): readonly RunInboxRecord[] {
    return this.database
      .all<SqlRow>(
        `select run_id, event_id, seq, payload_ref, applied_at from run_inbox where run_id = ? order by seq asc`,
        [runId],
      )
      .map((row) => ({
        runId: String(row.run_id),
        eventId: String(row.event_id),
        seq: integerOf(row.seq, 'seq'),
        payloadRef: String(row.payload_ref),
        appliedAt: integerOf(row.applied_at, 'applied_at'),
      }));
  }

  reclaim(tx: StorageTransaction, runId: string, appliedBefore: number): number {
    this.requireTransaction(tx);
    const row = this.database.get<SqlRow>(
      `with removed as (delete from run_inbox where run_id = ? and applied_at < ? returning 1)
       select count(*) as n from removed`,
      [runId, appliedBefore],
    );
    return row === undefined ? 0 : integerOf(row.n, 'n');
  }
}

/** 记忆出站端口。 */
class PostgresMemoryOutbox extends PostgresPort implements MemoryOutboxPort {
  enqueue(tx: StorageTransaction, record: MemoryOutboxRecord): MemoryOutboxRecord {
    this.requireTransaction(tx);
    this.database.run(
      `insert into memory_outbox (operation_id, session_id, end_seq, bank, state, attempts, next_attempt_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (operation_id) do nothing`,
      [
        record.operationId,
        record.sessionId,
        record.endSeq,
        record.bank,
        record.state,
        record.attempts,
        record.nextAttemptAt,
      ],
    );
    const row = this.database.get<SqlRow>(
      `select operation_id, session_id, end_seq, bank, state, attempts, next_attempt_at
         from memory_outbox where operation_id = ?`,
      [record.operationId],
    );
    if (row === undefined) throw new Error(`记忆任务写入后读不到：${record.operationId}`);
    return memoryOutboxOf(row);
  }

  claim(now: number, limit: number): readonly MemoryOutboxRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`领取条数必须是正整数，实际 ${String(limit)}`);
    return this.database
      .all<SqlRow>(
        `select operation_id, session_id, end_seq, bank, state, attempts, next_attempt_at
           from memory_outbox where state = 'pending' and next_attempt_at <= ?
           order by next_attempt_at asc, operation_id asc limit ?`,
        [now, limit],
      )
      .map(memoryOutboxOf);
  }

  settle(tx: StorageTransaction, operationId: string, state: MemoryOutboxRecord['state'], nextAttemptAt: number): void {
    this.requireTransaction(tx);
    this.database.run(
      `update memory_outbox set state = ?, attempts = attempts + 1, next_attempt_at = ? where operation_id = ?`,
      [state, nextAttemptAt, operationId],
    );
  }
}

/** 一行记忆出站记录。 */
function memoryOutboxOf(row: SqlRow): MemoryOutboxRecord {
  return {
    operationId: String(row.operation_id),
    sessionId: String(row.session_id),
    endSeq: integerOf(row.end_seq, 'end_seq'),
    bank: String(row.bank),
    state: String(row.state) as MemoryOutboxRecord['state'],
    attempts: integerOf(row.attempts, 'attempts'),
    nextAttemptAt: integerOf(row.next_attempt_at, 'next_attempt_at'),
  };
}

/** 通知出站端口。 */
class PostgresNotificationOutbox extends PostgresPort implements NotificationOutboxPort {
  enqueue(tx: StorageTransaction, record: NotificationOutboxRecord): void {
    this.requireTransaction(tx);
    if (record.key === '') throw new Error('通知任务缺少业务关联键');
    this.database.run(
      `insert into notification_outbox (key, client_id, state, tag, expires_at) values (?, ?, ?, ?, ?)
       on conflict (key) do update set client_id = excluded.client_id, state = excluded.state,
         tag = excluded.tag, expires_at = excluded.expires_at`,
      [record.key, record.clientId, record.state, record.tag, record.expiresAt],
    );
  }

  due(now: number, limit: number): readonly NotificationOutboxRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`到期条数必须是正整数，实际 ${String(limit)}`);
    return this.database
      .all<SqlRow>(
        `select key, client_id, state, tag, expires_at from notification_outbox
          where state = 'pending' and expires_at > ? order by expires_at asc, key asc limit ?`,
        [now, limit],
      )
      .map((row) => ({
        key: String(row.key),
        clientId: String(row.client_id),
        state: String(row.state) as NotificationOutboxRecord['state'],
        tag: String(row.tag),
        expiresAt: integerOf(row.expires_at, 'expires_at'),
      }));
  }

  settle(tx: StorageTransaction, key: string, state: NotificationOutboxRecord['state']): void {
    this.requireTransaction(tx);
    this.database.run(`update notification_outbox set state = ? where key = ?`, [state, key]);
  }
}

/** 备份清单端口。 */
class PostgresBackups extends PostgresPort implements BackupPort {
  record(tx: StorageTransaction, record: BackupManifestRecord): void {
    this.requireTransaction(tx);
    if (record.manifestId === '') throw new Error('备份清单缺少标识');
    this.database.run(
      `insert into backup_manifests (manifest_id, schema_version, created_at, domains, key_version, manifest_ref)
       values (?, ?, ?, ?, ?, ?)
       on conflict (manifest_id) do update set schema_version = excluded.schema_version,
         created_at = excluded.created_at, domains = excluded.domains,
         key_version = excluded.key_version, manifest_ref = excluded.manifest_ref`,
      [
        record.manifestId,
        record.schemaVersion,
        record.createdAt,
        `{${record.domains.map((domain) => `"${domain.replaceAll('"', '""')}"`).join(',')}}`,
        record.keyVersion,
        record.manifestRef,
      ],
    );
  }

  manifest(manifestId: string): BackupManifestRecord | undefined {
    const row = this.database.get<SqlRow>(
      `select manifest_id, schema_version, created_at, domains, key_version, manifest_ref
         from backup_manifests where manifest_id = ?`,
      [manifestId],
    );
    return row === undefined ? undefined : manifestOf(row);
  }

  list(): readonly BackupManifestRecord[] {
    return this.database
      .all<SqlRow>(
        `select manifest_id, schema_version, created_at, domains, key_version, manifest_ref
           from backup_manifests order by created_at asc, manifest_id asc`,
      )
      .map(manifestOf);
  }
}

/** 一行备份清单。 */
function manifestOf(row: SqlRow): BackupManifestRecord {
  return {
    manifestId: String(row.manifest_id),
    schemaVersion: integerOf(row.schema_version, 'schema_version'),
    createdAt: integerOf(row.created_at, 'created_at'),
    domains: (row.domains as string[] | null) ?? [],
    keyVersion: String(row.key_version),
    manifestRef: String(row.manifest_ref),
  };
}

/** 迁移任务端口类型导出，便于测试构造。 */
export type { MigrationJobRecord };
