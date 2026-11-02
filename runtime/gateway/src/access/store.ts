/**
 * 访问层的持久化。
 *
 * 单用户部署没有账号表：凭据按种类各存一行，访问会话只保存令牌摘要，其余记录按用途分表。
 * 全部表与网关其余存储共用同一个 SQLite 连接，句柄由 `GatewayStore.handle()` 提供，写操作
 * 在需要互斥处使用事务或带条件的单条更新。
 * @module @chatdsh/gateway/access/store
 */

import type { DatabaseSync } from 'node:sqlite';

/** 一条访问会话记录。令牌本体不落库，只保存 SHA-256 摘要。 */
export interface AccessSessionRow {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly clientName: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
}

/** 一次性票据记录：第二因素票据与 WebSocket 连接票据共用一张表。 */
export interface AccessTicketRow {
  readonly kind: string;
  readonly ticketHash: string;
  readonly expiresAt: number;
  readonly consumedAt?: number;
}

/** 一条 WebAuthn 挑战记录。 */
export interface AccessChallengeRow {
  readonly challengeId: string;
  readonly origin: string;
  readonly rpId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** 一条通行密钥记录。公钥以部署密钥信封加密后保存，不落明文。 */
export interface AccessPasskeyRow {
  readonly credentialId: string;
  readonly sealedPublicKey: string;
  readonly signCount: number;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

/** 某一来源或整台部署的失败计数与锁定状态。 */
export interface AccessFailureRow {
  readonly failures: number;
  readonly lockedUntil: number;
}

/** 恢复码的统计结果。 */
export interface RecoveryCodeStats {
  readonly total: number;
  readonly remaining: number;
}

interface SessionSqlRow {
  readonly session_id: string;
  readonly token_hash: string;
  readonly client_name: string;
  readonly created_at: number;
  readonly last_active_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

interface TicketSqlRow {
  readonly kind: string;
  readonly ticket_hash: string;
  readonly expires_at: number;
  readonly consumed_at: number | null;
}

interface ChallengeSqlRow {
  readonly challenge_id: string;
  readonly origin: string;
  readonly rp_id: string;
  readonly created_at: number;
  readonly expires_at: number;
}

interface PasskeySqlRow {
  readonly credential_id: string;
  readonly sealed_public_key: string;
  readonly sign_count: number;
  readonly created_at: number;
  readonly last_used_at: number;
}

/** 访问层的表结构。建表是幂等的，进程启动时执行一次。 */
const SCHEMA = `
  create table if not exists access_credentials (
    kind text primary key,
    digest text not null,
    created_at integer not null,
    updated_at integer not null
  );
  create table if not exists access_sessions (
    session_id text primary key,
    token_hash text not null unique,
    client_name text not null,
    created_at integer not null,
    last_active_at integer not null,
    expires_at integer not null,
    revoked_at integer
  );
  create table if not exists access_tickets (
    kind text not null,
    ticket_hash text not null,
    created_at integer not null,
    expires_at integer not null,
    consumed_at integer,
    primary key (kind, ticket_hash)
  );
  create table if not exists access_reauth (
    session_id text not null,
    action text not null,
    verified_at integer not null,
    primary key (session_id, action)
  );
  create table if not exists access_rate (
    bucket text not null,
    window_start integer not null,
    hits integer not null,
    primary key (bucket, window_start)
  );
  create table if not exists access_failures (
    bucket text primary key,
    failures integer not null,
    locked_until integer not null,
    updated_at integer not null
  );
  create table if not exists access_totp_steps (
    step integer primary key,
    consumed_at integer not null
  );
  create table if not exists access_recovery_codes (
    code_hash text primary key,
    created_at integer not null,
    consumed_at integer
  );
  create table if not exists access_challenges (
    challenge_id text primary key,
    origin text not null,
    rp_id text not null,
    created_at integer not null,
    expires_at integer not null,
    consumed_at integer
  );
  create table if not exists access_passkeys (
    credential_id text primary key,
    sealed_public_key text not null,
    sign_count integer not null,
    created_at integer not null,
    last_used_at integer not null
  );
`;

/** 凭据种类：密码摘要、TOTP 秘密信封与恢复码生成标记各占一行。 */
export type AccessCredentialKind = 'password' | 'totp' | 'recovery-codes';

/**
 * 访问层的存储。
 *
 * 表结构由本类建立，其余控制器共用同一个连接。所有写入立即提交，避免票据与会话状态在
 * 进程异常终止后停留在半完成状态。
 */
export class AccessStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    this.database.exec(SCHEMA);
  }

  /** 读取一种凭据记录。 */
  credential(kind: AccessCredentialKind): { readonly digest: string; readonly updatedAt: number } | undefined {
    const row = this.database.prepare('select digest, updated_at from access_credentials where kind = ?').get(kind) as
      | { digest: string; updated_at: number }
      | undefined;
    return row === undefined ? undefined : { digest: row.digest, updatedAt: row.updated_at };
  }

  /** 写入一种凭据记录。 */
  writeCredential(kind: AccessCredentialKind, digest: string, now: number): void {
    this.database.prepare(
      `insert into access_credentials (kind, digest, created_at, updated_at) values (?, ?, ?, ?)
       on conflict (kind) do update set digest = excluded.digest, updated_at = excluded.updated_at`
    ).run(kind, digest, now, now);
  }

  /** 删除一种凭据记录。 */
  deleteCredential(kind: AccessCredentialKind): boolean {
    return Number(this.database.prepare('delete from access_credentials where kind = ?').run(kind).changes) > 0;
  }

  /** 登记一条访问会话。 */
  insertSession(row: AccessSessionRow): void {
    this.database.prepare(
      `insert into access_sessions (session_id, token_hash, client_name, created_at, last_active_at, expires_at, revoked_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    ).run(row.sessionId, row.tokenHash, row.clientName, row.createdAt, row.lastActiveAt, row.expiresAt, row.revokedAt ?? null);
  }

  /** 按令牌摘要查会话：摘要命中才可能命中会话，令牌本体从不参与查询。 */
  sessionByTokenHash(tokenHash: string): AccessSessionRow | undefined {
    const row = this.database
      .prepare('select session_id, token_hash, client_name, created_at, last_active_at, expires_at, revoked_at from access_sessions where token_hash = ?')
      .get(tokenHash) as SessionSqlRow | undefined;
    return row === undefined ? undefined : sessionOf(row);
  }

  /** 按会话标识查会话。 */
  sessionById(sessionId: string): AccessSessionRow | undefined {
    const row = this.database
      .prepare('select session_id, token_hash, client_name, created_at, last_active_at, expires_at, revoked_at from access_sessions where session_id = ?')
      .get(sessionId) as SessionSqlRow | undefined;
    return row === undefined ? undefined : sessionOf(row);
  }

  /** 列出全部访问会话，最近建立在前。 */
  sessions(): AccessSessionRow[] {
    const rows = this.database
      .prepare('select session_id, token_hash, client_name, created_at, last_active_at, expires_at, revoked_at from access_sessions order by created_at desc')
      .all() as unknown as SessionSqlRow[];
    return rows.map(sessionOf);
  }

  /** 记录一次活动，并按需要推进到期时刻。 */
  touchSession(sessionId: string, lastActiveAt: number, expiresAt: number): void {
    this.database
      .prepare('update access_sessions set last_active_at = ?, expires_at = ? where session_id = ? and revoked_at is null')
      .run(lastActiveAt, expiresAt, sessionId);
  }

  /** 撤销一条会话；返回是否确实从有效状态变为撤销状态。 */
  revokeSession(sessionId: string, at: number): boolean {
    const result = this.database
      .prepare('update access_sessions set revoked_at = ? where session_id = ? and revoked_at is null')
      .run(at, sessionId);
    return Number(result.changes) > 0;
  }

  /** 撤销全部会话，可保留当前会话；返回撤销条数。 */
  revokeAllSessions(at: number, exceptSessionId?: string): number {
    const result = exceptSessionId === undefined
      ? this.database.prepare('update access_sessions set revoked_at = ? where revoked_at is null').run(at)
      : this.database.prepare('update access_sessions set revoked_at = ? where revoked_at is null and session_id <> ?').run(at, exceptSessionId);
    return Number(result.changes);
  }

  /** 登记一张一次性票据，摘要入库。 */
  insertTicket(kind: string, ticketHash: string, expiresAt: number, now: number): void {
    this.database
      .prepare('insert into access_tickets (kind, ticket_hash, created_at, expires_at, consumed_at) values (?, ?, ?, ?, null)')
      .run(kind, ticketHash, now, expiresAt);
  }

  /**
   * 消费一张一次性票据：只有把未消费的行更新成功才返回票据，重复提交拿不到第二次。
   * 过期的票据同样被消费并返回 `undefined`，避免残余票据被后续请求再次尝试。
   */
  consumeTicket(kind: string, ticketHash: string, now: number): AccessTicketRow | undefined {
    const row = this.database
      .prepare('select kind, ticket_hash, expires_at, consumed_at from access_tickets where kind = ? and ticket_hash = ?')
      .get(kind, ticketHash) as TicketSqlRow | undefined;
    if (row === undefined) return undefined;
    const result = this.database
      .prepare('update access_tickets set consumed_at = ? where kind = ? and ticket_hash = ? and consumed_at is null')
      .run(now, kind, ticketHash);
    if (Number(result.changes) === 0) return undefined;
    if (row.expires_at <= now) return undefined;
    return { kind: row.kind, ticketHash: row.ticket_hash, expiresAt: row.expires_at, consumedAt: row.consumed_at ?? undefined };
  }

  /** 记录一次敏感动作的再认证通过时刻。 */
  recordReauth(sessionId: string, action: string, at: number): void {
    this.database.prepare(
      `insert into access_reauth (session_id, action, verified_at) values (?, ?, ?)
       on conflict (session_id, action) do update set verified_at = excluded.verified_at`
    ).run(sessionId, action, at);
  }

  /** 读取某一敏感动作最近一次再认证时刻。 */
  reauthAt(sessionId: string, action: string): number | undefined {
    const row = this.database
      .prepare('select verified_at from access_reauth where session_id = ? and action = ?')
      .get(sessionId, action) as { verified_at: number } | undefined;
    return row?.verified_at;
  }

  /** 删除某一会话的全部再认证记录，会话撤销时一并清理。 */
  clearReauth(sessionId: string): void {
    this.database.prepare('delete from access_reauth where session_id = ?').run(sessionId);
  }

  /** 在固定窗口里累加一次尝试并返回累计值，同时清理过期窗口。 */
  bumpRate(bucket: string, windowStart: number, now: number): number {
    const row = this.database.prepare(
      `insert into access_rate (bucket, window_start, hits) values (?, ?, 1)
       on conflict (bucket, window_start) do update set hits = hits + 1
       returning hits`
    ).get(bucket, windowStart) as { hits: number } | undefined;
    this.database.prepare('delete from access_rate where window_start < ?').run(windowStart - 1);
    if (row === undefined) throw new Error(`限流计数写入失败：${bucket} ${now}`);
    return row.hits;
  }

  /** 读取固定窗口里的累计次数。 */
  rateCount(bucket: string, windowStart: number): number {
    const row = this.database
      .prepare('select hits from access_rate where bucket = ? and window_start = ?')
      .get(bucket, windowStart) as { hits: number } | undefined;
    return row?.hits ?? 0;
  }

  /** 读取失败计数与锁定状态。 */
  failure(bucket: string): AccessFailureRow | undefined {
    const row = this.database
      .prepare('select failures, locked_until from access_failures where bucket = ?')
      .get(bucket) as { failures: number; locked_until: number } | undefined;
    return row === undefined ? undefined : { failures: row.failures, lockedUntil: row.locked_until };
  }

  /** 写入失败计数与锁定时刻。 */
  writeFailure(bucket: string, failures: number, lockedUntil: number, now: number): void {
    this.database.prepare(
      `insert into access_failures (bucket, failures, locked_until, updated_at) values (?, ?, ?, ?)
       on conflict (bucket) do update set failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`
    ).run(bucket, failures, lockedUntil, now);
  }

  /** 清空失败计数：一次成功认证把该来源与整台部署一起归零。 */
  clearFailure(bucket: string): void {
    this.database.prepare('delete from access_failures where bucket = ?').run(bucket);
  }

  /** 清空失败计数并丢弃本窗口的限流计数。 */
  clearRate(bucket: string, windowStart: number): void {
    this.database.prepare('delete from access_rate where bucket = ? and window_start = ?').run(bucket, windowStart);
  }

  /** 认领一个 TOTP 时间片；同一时间片只允许认领一次，返回是否认领成功。 */
  consumeTotpStep(step: number, now: number): boolean {
    const result = this.database
      .prepare('insert into access_totp_steps (step, consumed_at) values (?, ?) on conflict (step) do nothing')
      .run(step, now);
    return Number(result.changes) > 0;
  }

  /** 过期时间片的清理，保留最近若干时间片供重放判定。 */
  pruneTotpSteps(before: number): void {
    this.database.prepare('delete from access_totp_steps where step < ?').run(before);
  }

  /** 用新一批恢复码摘要替换全部旧记录。 */
  replaceRecoveryCodes(hashes: readonly string[], now: number): void {
    this.database.exec('begin');
    try {
      this.database.prepare('delete from access_recovery_codes').run();
      const insert = this.database.prepare('insert into access_recovery_codes (code_hash, created_at, consumed_at) values (?, ?, null)');
      for (const hash of hashes) insert.run(hash, now);
      this.database.exec('commit');
    } catch (error) {
      this.database.exec('rollback');
      throw error;
    }
  }

  /** 消费一条恢复码；同一条码只有第一次更新能成功。 */
  consumeRecoveryCode(codeHash: string, now: number): boolean {
    const result = this.database
      .prepare('update access_recovery_codes set consumed_at = ? where code_hash = ? and consumed_at is null')
      .run(now, codeHash);
    return Number(result.changes) > 0;
  }

  /** 恢复码的条数与剩余条数。 */
  recoveryCodeStats(): RecoveryCodeStats {
    const row = this.database
      .prepare('select count(*) as total, sum(case when consumed_at is null then 1 else 0 end) as remaining from access_recovery_codes')
      .get() as { total: number; remaining: number | null } | undefined;
    return { total: row?.total ?? 0, remaining: row?.remaining ?? 0 };
  }

  /** 删除全部恢复码。 */
  deleteRecoveryCodes(): void {
    this.database.prepare('delete from access_recovery_codes').run();
  }

  /** 登记一张 WebAuthn 挑战。 */
  insertChallenge(row: AccessChallengeRow): void {
    this.database
      .prepare('insert into access_challenges (challenge_id, origin, rp_id, created_at, expires_at, consumed_at) values (?, ?, ?, ?, ?, null)')
      .run(row.challengeId, row.origin, row.rpId, row.createdAt, row.expiresAt);
  }

  /** 消费一张 WebAuthn 挑战；重复使用与过期都返回 `undefined`。 */
  consumeChallenge(challengeId: string, now: number): AccessChallengeRow | undefined {
    const row = this.database
      .prepare('select challenge_id, origin, rp_id, created_at, expires_at from access_challenges where challenge_id = ?')
      .get(challengeId) as ChallengeSqlRow | undefined;
    if (row === undefined) return undefined;
    const result = this.database
      .prepare('update access_challenges set consumed_at = ? where challenge_id = ? and consumed_at is null')
      .run(now, challengeId);
    if (Number(result.changes) === 0) return undefined;
    if (row.expires_at <= now) return undefined;
    return {
      challengeId: row.challenge_id,
      origin: row.origin,
      rpId: row.rp_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** 按凭据标识查通行密钥。 */
  passkeyByCredentialId(credentialId: string): AccessPasskeyRow | undefined {
    const row = this.database
      .prepare('select credential_id, sealed_public_key, sign_count, created_at, last_used_at from access_passkeys where credential_id = ?')
      .get(credentialId) as PasskeySqlRow | undefined;
    return row === undefined ? undefined : passkeyOf(row);
  }

  /** 列出全部通行密钥。 */
  passkeys(): AccessPasskeyRow[] {
    const rows = this.database
      .prepare('select credential_id, sealed_public_key, sign_count, created_at, last_used_at from access_passkeys order by created_at asc')
      .all() as unknown as PasskeySqlRow[];
    return rows.map(passkeyOf);
  }

  /** 登记一条通行密钥。 */
  insertPasskey(row: AccessPasskeyRow): void {
    this.database
      .prepare('insert into access_passkeys (credential_id, sealed_public_key, sign_count, created_at, last_used_at) values (?, ?, ?, ?, ?)')
      .run(row.credentialId, row.sealedPublicKey, row.signCount, row.createdAt, row.lastUsedAt);
  }

  /** 记录一次通行密钥使用与新的计数器。 */
  touchPasskey(credentialId: string, signCount: number, now: number): void {
    this.database
      .prepare('update access_passkeys set sign_count = ?, last_used_at = ? where credential_id = ?')
      .run(signCount, now, credentialId);
  }

  /** 删除一条通行密钥。 */
  deletePasskey(credentialId: string): boolean {
    return Number(this.database.prepare('delete from access_passkeys where credential_id = ?').run(credentialId).changes) > 0;
  }
}

function sessionOf(row: SessionSqlRow): AccessSessionRow {
  return {
    sessionId: row.session_id,
    tokenHash: row.token_hash,
    clientName: row.client_name,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function passkeyOf(row: PasskeySqlRow): AccessPasskeyRow {
  return {
    credentialId: row.credential_id,
    sealedPublicKey: row.sealed_public_key,
    signCount: row.sign_count,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
