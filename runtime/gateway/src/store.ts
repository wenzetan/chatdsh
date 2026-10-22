/**
 * 控制平面的配置与存储。
 *
 * 单机形态用内置的 SQLite（`node:sqlite`）：账号、会话归属、设备三张表。团队版把
 * 同一组接口换成 Postgres，调用方不变。
 * @module @chatdsh/gateway/store
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LlmGatewayConfig } from './llm.ts';

/** 控制平面配置。 */
export interface GatewayConfig {
  /** 监听地址。 */
  readonly host: string;
  /** 监听端口。 */
  readonly port: number;
  /** 运行时地址，反代的转发目标。 */
  readonly runtimeUrl: string;
  /** 按账号标识或登录名分派的运行时地址；缺省时全部走 runtimeUrl。 */
  readonly runtimeRoutes: Record<string, string>;
  /** 可达性提供方；决定来源身份从哪里取。 */
  readonly accessProvider: 'tailscale' | 'manual';
  /** SQLite 文件路径。 */
  readonly databasePath: string;
  /** 资源属性里的部署环境。 */
  readonly environment: string;
  /** 产品版本，写入遥测资源属性。 */
  readonly version: string;
  /** 通知的分级方式。 */
  readonly pushMode: 'all-at-once' | 'two-stage';
  /** 两段式通知的升级阈值，单位毫秒。 */
  readonly pushEscalationMs: number;
  /** 模型入口：上游地址、额度与凭据环境变量名。 */
  readonly llmGateway: LlmGatewayConfig;
}

/** 一条账号记录。 */
export interface AccountRecord {
  readonly id: string;
  /** 接入层给出的登录名；`local` 表示本机直连建立的账号。 */
  readonly login: string;
  readonly createdAt: number;
}

/** 一条会话归属记录。 */
export interface SessionOwnershipRecord {
  readonly sessionId: string;
  readonly accountId: string;
  readonly workspaceId?: string;
  readonly deviceId: string;
  readonly cwd: string;
  readonly kind: 'work' | 'chat';
  readonly createdAt: number;
}

/** 一条设备记录。 */
export interface DeviceRecord {
  readonly id: string;
  readonly accountId: string;
  readonly origin: string;
  readonly platform: string;
  readonly lastSeenAt: number;
}

/** 数据根：控制平面的数据与运行时共用 `DSH_HOME` 的约定。 */
export function dataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/**
 * 解析按账号分派的运行时地址。
 *
 * 取值是「账号标识或登录名 → 运行时地址」的 JSON 对象。格式不合法时直接抛出，不做兜底——
 * 分派表写错会让请求去错运行时，静默回退到默认地址更难排查。
 * @param raw - 环境变量原文。
 * @returns 分派表；未配置时为空。
 */
export function parseRuntimeRoutes(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const routes: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`运行时分派表的取值必须是字符串：${key}`);
    routes[key] = value;
  }
  return routes;
}

function parseOptionalCount(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数：${raw}`);
  return value;
}

/**
 * 解析模型入口配置。上游地址未配置时入口返回 503，不会静默转给别的地址。
 * @param env - 进程环境变量。
 * @returns 模型入口配置。
 */
export function parseLlmGateway(env: NodeJS.ProcessEnv): LlmGatewayConfig {
  const upstreamUrl = env.CHATDSH_LLM_GATEWAY_URL;
  if (upstreamUrl !== undefined) new URL(upstreamUrl);
  return {
    upstreamUrl,
    quota: {
      limit: parseOptionalCount(env.CHATDSH_LLM_QUOTA_LIMIT, 'CHATDSH_LLM_QUOTA_LIMIT'),
      used: parseOptionalCount(env.CHATDSH_LLM_QUOTA_USED, 'CHATDSH_LLM_QUOTA_USED'),
    },
    apiKeyEnv: env.CHATDSH_LLM_API_KEY_ENV,
  };
}

/**
 * 读取配置。环境变量优先，缺省值面向单机自托管。
 * @param env - 进程环境变量。
 * @returns 配置。
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const root = dataRoot();
  return {
    host: env.CHATDSH_GATEWAY_HOST ?? '127.0.0.1',
    port: Number.parseInt(env.CHATDSH_GATEWAY_PORT ?? '3170', 10),
    runtimeUrl: env.CHATDSH_RUNTIME_URL ?? 'http://127.0.0.1:3080',
    runtimeRoutes: parseRuntimeRoutes(env.CHATDSH_RUNTIME_ROUTES),
    accessProvider: env.CHATDSH_ACCESS_PROVIDER === 'manual' ? 'manual' : 'tailscale',
    databasePath: env.CHATDSH_GATEWAY_DB ?? join(root, 'gateway', 'gateway.sqlite'),
    environment: env.CHATDSH_ENVIRONMENT ?? 'local',
    version: env.CHATDSH_VERSION ?? '0.1.0',
    pushMode: env.CHATDSH_PUSH_MODE === 'all-at-once' ? 'all-at-once' : 'two-stage',
    pushEscalationMs: Number.parseInt(env.CHATDSH_PUSH_ESCALATION_MS ?? '120000', 10),
    llmGateway: parseLlmGateway(env),
  };
}

/**
 * 控制平面的存储。
 *
 * 表结构只在启动时建立一次；账号按登录名唯一，会话归属按会话标识唯一。
 */
export class GatewayStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      create table if not exists accounts (
        id text primary key,
        login text not null unique,
        created_at integer not null
      );
      create table if not exists sessions (
        session_id text primary key,
        account_id text not null,
        workspace_id text,
        device_id text not null,
        cwd text not null,
        kind text not null,
        created_at integer not null,
        deleted_at integer
      );
      create table if not exists devices (
        id text primary key,
        account_id text not null,
        origin text not null,
        platform text not null,
        last_seen_at integer not null
      );
      create index if not exists sessions_by_account on sessions(account_id);
      create index if not exists devices_by_account on devices(account_id);
      create table if not exists replica_events (
        session_id text not null,
        seq integer not null,
        account_id text not null,
        kind text not null,
        time integer not null,
        bytes integer not null,
        payload text,
        primary key (session_id, seq)
      );
      create table if not exists replica_watermarks (
        session_id text primary key,
        account_id text not null,
        watermark integer not null,
        updated_at integer not null
      );
      create table if not exists shares (
        token text primary key,
        session_id text not null,
        account_id text not null,
        up_to_seq integer not null,
        created_at integer not null,
        expires_at integer,
        revoked_at integer,
        visits integer not null default 0
      );
      create index if not exists shares_by_account on shares(account_id);
      create table if not exists scheduled_tasks (
        id text primary key,
        account_id text not null,
        session_id text,
        action text not null,
        payload text,
        due_at integer not null,
        created_at integer not null,
        executed_at integer,
        outcome text,
        cancelled_at integer
      );
      create index if not exists tasks_due on scheduled_tasks(due_at);
      create table if not exists push_queue (
        id text primary key,
        account_id text not null,
        device_id text,
        payload text not null,
        created_at integer not null,
        delivered_at integer,
        stage integer not null default 0,
        escalate_at integer
      );
      create index if not exists push_queue_by_account on push_queue(account_id);
      create table if not exists llm_quota (
        account_id text primary key,
        used integer not null
      );
      create table if not exists read_receipts (
        session_id text not null,
        device_id text not null,
        account_id text not null,
        read_up_to_seq integer not null,
        updated_at integer not null,
        primary key (session_id, device_id)
      );
    `);

    // 旧库补列：会话要记录它是由哪条会话导入而来的。
    const sessionColumns = this.database
      .prepare("select name from pragma_table_info('sessions')")
      .all() as unknown as { name: string }[];
    if (!new Set(sessionColumns.map((column) => column.name)).has('parent_session')) {
      this.database.exec('alter table sessions add column parent_session text');
    }

    // 旧库补列：第一段已投、等待升级的通知需要记录阶段与升级时刻。
    const pushColumns = this.database
      .prepare("select name from pragma_table_info('push_queue')")
      .all() as unknown as { name: string }[];
    const pushNames = new Set(pushColumns.map((column) => column.name));
    if (!pushNames.has('stage')) this.database.exec('alter table push_queue add column stage integer not null default 0');
    if (!pushNames.has('escalate_at')) this.database.exec('alter table push_queue add column escalate_at integer');
    // 早期版本只存事件信封；副本要承担跨设备浏览与导入，必须带上事件本体。
    const columns = this.database.prepare("select name from pragma_table_info('replica_events')").all() as { name: string }[];
    if (!columns.some((column) => column.name === 'payload')) {
      this.database.exec('alter table replica_events add column payload text');
    }
  }

  /** 取一个账号的模型额度已用量。 */
  llmQuotaUsed(accountId: string): number {
    const row = this.database.prepare('select used from llm_quota where account_id = ?').get(accountId) as { used: number } | undefined;
    return row?.used ?? 0;
  }

  /** 累加一个账号的模型额度用量。 */
  recordLlmQuota(accountId: string, tokens: number): number {
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error('额度用量必须是非负整数');
    this.database.prepare(
      'insert into llm_quota (account_id, used) values (?, ?) on conflict(account_id) do update set used = used + excluded.used',
    ).run(accountId, tokens);
    return this.llmQuotaUsed(accountId);
  }

  /** 按登录名取账号，不存在时建立。 */
  ensureAccount(login: string): AccountRecord {
    const existing = this.database.prepare('select id, login, created_at from accounts where login = ?').get(login) as
      | { id: string; login: string; created_at: number }
      | undefined;
    if (existing !== undefined) {
      return { id: existing.id, login: existing.login, createdAt: existing.created_at };
    }
    const record: AccountRecord = { id: crypto.randomUUID(), login, createdAt: Date.now() };
    this.database
      .prepare('insert into accounts (id, login, created_at) values (?, ?, ?)')
      .run(record.id, record.login, record.createdAt);
    return record;
  }

  /** 取一个账号。 */
  getAccount(id: string): AccountRecord | undefined {
    const row = this.database.prepare('select id, login, created_at from accounts where id = ?').get(id) as
      | { id: string; login: string; created_at: number }
      | undefined;
    return row === undefined ? undefined : { id: row.id, login: row.login, createdAt: row.created_at };
  }

  /** 写入或更新一条会话归属。 */
  upsertSession(record: SessionOwnershipRecord & { readonly parentSession?: string }): void {
    // 归属在会话创建时确定，之后不可修改。冲突时保留先写入的那一行：
    // 两个请求并发首次上报同一会话时，后到的不会覆盖设备与目录。
    this.database
      .prepare(`insert into sessions (session_id, account_id, workspace_id, device_id, cwd, kind, created_at, parent_session)
                values (?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(session_id) do nothing`)
      .run(record.sessionId, record.accountId, record.workspaceId ?? null, record.deviceId, record.cwd, record.kind, record.createdAt, record.parentSession ?? null);
  }

  /** 列出账号名下的会话归属，按创建时间倒序。 */
  listSessions(accountId: string): SessionOwnershipRecord[] {
    const rows = this.database
      .prepare('select session_id, account_id, workspace_id, device_id, cwd, kind, created_at, parent_session from sessions where account_id = ? and deleted_at is null order by created_at desc')
      .all(accountId) as { session_id: string; account_id: string; workspace_id: string | null; device_id: string; cwd: string; kind: string; created_at: number; parent_session: string | null }[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      accountId: row.account_id,
      workspaceId: row.workspace_id ?? undefined,
      deviceId: row.device_id,
      cwd: row.cwd,
      kind: row.kind === 'chat' ? 'chat' : 'work',
      createdAt: row.created_at,
      parentSession: row.parent_session ?? undefined,
    } as SessionOwnershipRecord & { parentSession?: string }));
  }

  /** 取一条会话归属。 */
  getSession(sessionId: string): SessionOwnershipRecord | undefined {
    const row = this.database
      .prepare('select session_id, account_id, workspace_id, device_id, cwd, kind, created_at from sessions where session_id = ?')
      .get(sessionId) as { session_id: string; account_id: string; workspace_id: string | null; device_id: string; cwd: string; kind: string; created_at: number } | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: row.session_id,
      accountId: row.account_id,
      workspaceId: row.workspace_id ?? undefined,
      deviceId: row.device_id,
      cwd: row.cwd,
      kind: row.kind === 'chat' ? 'chat' : 'work',
      createdAt: row.created_at,
    };
  }

  /** 记录一次设备活动。 */
  touchDevice(record: DeviceRecord): void {
    this.database
      .prepare(`insert into devices (id, account_id, origin, platform, last_seen_at)
                values (?, ?, ?, ?, ?)
                on conflict(id) do update set last_seen_at = excluded.last_seen_at, origin = excluded.origin`)
      .run(record.id, record.accountId, record.origin, record.platform, record.lastSeenAt);
  }

  /** 列出账号下的设备，按最近活动倒序。 */
  listDevices(accountId: string): DeviceRecord[] {
    const rows = this.database
      .prepare('select id, account_id, origin, platform, last_seen_at from devices where account_id = ? order by last_seen_at desc')
      .all(accountId) as { id: string; account_id: string; origin: string; platform: string; last_seen_at: number }[];
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      origin: row.origin,
      platform: row.platform,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /** 底层数据库句柄，供同一进程内的其他存储共用同一个连接。 */
  handle(): DatabaseSync {
    return this.database;
  }

  /** 关闭数据库。 */
  close(): void {
    this.database.close();
  }
}

/** 上报来的一条会话事件。`payload` 是事件本体，副本据此承担跨设备浏览、导入与分享渲染。 */
export interface ReplicaEventInput {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes: number;
  /** 事件本体；早期上报可能只有信封，此时为空。 */
  readonly payload?: unknown;
}

/** 副本追加结果。 */
export interface ReplicaAppendResult {
  /** 本次实际写入的条数（重复序号不计）。 */
  readonly written: number;
  /** 追加后的同步水位。 */
  readonly watermark: number;
}

/**
 * 会话副本：执行节点推送来的事件按 `seq` 追加成只读镜像。
 *
 * 副本不是权威，执行节点上的日志才是；副本用于跨设备浏览、会话导入与设备离线时读取。
 * 重复序号按幂等处理：同一个 `seq` 重复推送只保留第一条。
 */
export class ReplicaStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 把一个会话的事件追加到副本，返回写入条数与水位。 */
  append(accountId: string, sessionId: string, events: readonly ReplicaEventInput[]): ReplicaAppendResult {
    let written = 0;
    const insert = this.database.prepare(
      'insert or ignore into replica_events (session_id, seq, account_id, kind, time, bytes, payload) values (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const event of events) {
      const payload = event.payload === undefined ? null : JSON.stringify(event.payload);
      const result = insert.run(sessionId, event.seq, accountId, event.kind, event.time, event.bytes, payload);
      if (Number(result.changes) > 0) written += 1;
    }
    const row = this.database
      .prepare('select max(seq) as watermark from replica_events where session_id = ?')
      .get(sessionId) as { watermark: number | null } | undefined;
    const watermark = row?.watermark ?? 0;
    this.database
      .prepare(`insert into replica_watermarks (session_id, account_id, watermark, updated_at)
                values (?, ?, ?, ?)
                on conflict(session_id) do update set watermark = excluded.watermark, updated_at = excluded.updated_at`)
      .run(sessionId, accountId, watermark, Date.now());
    return { written, watermark };
  }

  /** 读一个会话的水位。 */
  watermarkOf(sessionId: string): number | undefined {
    const row = this.database
      .prepare('select watermark from replica_watermarks where session_id = ?')
      .get(sessionId) as { watermark: number } | undefined;
    return row?.watermark;
  }

  /** 列出账号名下的副本水位。 */
  listWatermarks(accountId: string): { sessionId: string; watermark: number; updatedAt: number }[] {
    const rows = this.database
      .prepare('select session_id, watermark, updated_at from replica_watermarks where account_id = ? order by updated_at desc')
      .all(accountId) as { session_id: string; watermark: number; updated_at: number }[];
    return rows.map((row) => ({ sessionId: row.session_id, watermark: row.watermark, updatedAt: row.updated_at }));
  }

  /** 读一个会话副本里的连续事件，按序号升序。 */
  read(sessionId: string, upToSeq?: number): { seq: number; kind: string; time: number; bytes: number; payload?: unknown }[] {
    const rows = (upToSeq === undefined
      ? this.database.prepare('select seq, kind, time, bytes, payload from replica_events where session_id = ? order by seq asc').all(sessionId)
      : this.database.prepare('select seq, kind, time, bytes, payload from replica_events where session_id = ? and seq <= ? order by seq asc').all(sessionId, upToSeq)) as
      { seq: number; kind: string; time: number; bytes: number; payload: string | null }[];
    return rows.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      time: row.time,
      bytes: row.bytes,
      payload: row.payload === null ? undefined : JSON.parse(row.payload) as unknown,
    }));
  }
}

/** 一条分享记录。快照的边界由 `upToSeq` 固定，源会话此后继续增长不会进入链接。 */
export interface ShareRecord {
  readonly token: string;
  readonly sessionId: string;
  readonly accountId: string;
  readonly upToSeq: number;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly visits: number;
}

/** 建立分享时的输入。 */
export interface ShareInput {
  readonly accountId: string;
  readonly sessionId: string;
  /** 快照上界；缺省取副本当前水位。 */
  readonly upToSeq?: number;
  /** 有效期的毫秒数；缺省表示不设期限。 */
  readonly ttlMs?: number;
}

/**
 * 分享记录。
 *
 * 令牌是 256 位随机值，不承载身份也无需验签；撤销即写入撤销时刻，访问立刻失效。
 * 记录保留而不是删除，因为访问计数与撤销历史都有查询价值。
 */
export class ShareStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 建立一条分享记录。 */
  create(input: ShareInput, watermark: number): ShareRecord {
    const token = randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const upToSeq = input.upToSeq ?? watermark;
    const expiresAt = input.ttlMs === undefined ? null : createdAt + input.ttlMs;
    this.database
      .prepare('insert into shares (token, session_id, account_id, up_to_seq, created_at, expires_at, revoked_at, visits) values (?, ?, ?, ?, ?, ?, null, 0)')
      .run(token, input.sessionId, input.accountId, upToSeq, createdAt, expiresAt);
    return {
      token,
      sessionId: input.sessionId,
      accountId: input.accountId,
      upToSeq,
      createdAt,
      expiresAt: expiresAt ?? undefined,
      visits: 0,
    };
  }

  /** 读一条分享记录。 */
  get(token: string): ShareRecord | undefined {
    const row = this.database
      .prepare('select token, session_id, account_id, up_to_seq, created_at, expires_at, revoked_at, visits from shares where token = ?')
      .get(token) as ShareRow | undefined;
    return row === undefined ? undefined : toShare(row);
  }

  /** 撤销一条分享。 */
  revoke(token: string, accountId: string): boolean {
    const result = this.database
      .prepare('update shares set revoked_at = ? where token = ? and account_id = ? and revoked_at is null')
      .run(Date.now(), token, accountId);
    return Number(result.changes) > 0;
  }

  /** 记一次访问。 */
  touch(token: string): void {
    this.database.prepare('update shares set visits = visits + 1 where token = ?').run(token);
  }

  /** 列出账号名下的分享记录。 */
  list(accountId: string): ShareRecord[] {
    const rows = this.database
      .prepare('select token, session_id, account_id, up_to_seq, created_at, expires_at, revoked_at, visits from shares where account_id = ? order by created_at desc')
      .all(accountId) as unknown as ShareRow[];
    return rows.map(toShare);
  }
}

interface ShareRow {
  token: string;
  session_id: string;
  account_id: string;
  up_to_seq: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  visits: number;
}

function toShare(row: ShareRow): ShareRecord {
  return {
    token: row.token,
    sessionId: row.session_id,
    accountId: row.account_id,
    upToSeq: row.up_to_seq,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    visits: row.visits,
  };
}

/** 定时任务的动作。`wake` 唤醒运行时并投递一次请求，`notify` 记录一条待推送。 */
export type TaskAction = 'wake' | 'notify';

/** 一条定时任务。 */
export interface TaskRecord {
  readonly id: string;
  readonly accountId: string;
  readonly sessionId?: string;
  readonly action: TaskAction;
  /** 动作的附加参数，按动作解释。 */
  readonly payload?: string;
  readonly dueAt: number;
  readonly createdAt: number;
  readonly executedAt?: number;
  /** 执行结果，取 `delivered`、`runtime-unreachable` 等。 */
  readonly outcome?: string;
  readonly cancelledAt?: number;
}

/** 建立定时任务的输入。 */
export interface TaskInput {
  readonly accountId: string;
  readonly sessionId?: string;
  readonly action: TaskAction;
  readonly payload?: string;
  /** 到期时刻的毫秒时间戳。 */
  readonly dueAt: number;
}

/**
 * 定时任务表。
 *
 * 控制平面是唯一的调度者：任务在这里登记，由调度循环到期取出并执行。执行过的任务保留
 * 记录（含结果），因此「有没有按期触发」可以事后查询。
 */
export class ScheduleStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 登记一条任务。 */
  create(input: TaskInput): TaskRecord {
    const record: TaskRecord = {
      id: randomBytes(12).toString('hex'),
      accountId: input.accountId,
      sessionId: input.sessionId,
      action: input.action,
      payload: input.payload,
      dueAt: input.dueAt,
      createdAt: Date.now(),
    };
    this.database
      .prepare('insert into scheduled_tasks (id, account_id, session_id, action, payload, due_at, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.accountId, record.sessionId ?? null, record.action, record.payload ?? null, record.dueAt, record.createdAt);
    return record;
  }

  /** 取出已经到期、尚未执行、也未取消的任务。 */
  due(now: number, limit = 32): TaskRecord[] {
    const rows = this.database
      .prepare(`select id, account_id, session_id, action, payload, due_at, created_at, executed_at, outcome, cancelled_at
                from scheduled_tasks
                where executed_at is null and cancelled_at is null and due_at <= ?
                order by due_at asc limit ?`)
      .all(now, limit) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** 记录一次执行结果。 */
  markExecuted(id: string, outcome: string): void {
    this.database
      .prepare('update scheduled_tasks set executed_at = ?, outcome = ? where id = ?')
      .run(Date.now(), outcome, id);
  }

  /** 取消一条任务。 */
  cancel(id: string, accountId: string): boolean {
    const result = this.database
      .prepare('update scheduled_tasks set cancelled_at = ? where id = ? and account_id = ? and executed_at is null and cancelled_at is null')
      .run(Date.now(), id, accountId);
    return Number(result.changes) > 0;
  }

  /** 列出账号名下的任务，按到期时刻升序。 */
  list(accountId: string): TaskRecord[] {
    const rows = this.database
      .prepare(`select id, account_id, session_id, action, payload, due_at, created_at, executed_at, outcome, cancelled_at
                from scheduled_tasks where account_id = ? order by due_at asc`)
      .all(accountId) as unknown as TaskRow[];
    return rows.map(toTask);
  }
}

interface TaskRow {
  id: string;
  account_id: string;
  session_id: string | null;
  action: string;
  payload: string | null;
  due_at: number;
  created_at: number;
  executed_at: number | null;
  outcome: string | null;
  cancelled_at: number | null;
}

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    sessionId: row.session_id ?? undefined,
    action: row.action === 'notify' ? 'notify' : 'wake',
    payload: row.payload ?? undefined,
    dueAt: row.due_at,
    createdAt: row.created_at,
    executedAt: row.executed_at ?? undefined,
    outcome: row.outcome ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
  };
}

/** 一条待投递的推送。 */
export interface PushItem {
  readonly id: string;
  readonly accountId: string;
  readonly deviceId?: string;
  /** 投递载荷，形如 `{ kind, sessionId, ... }` 的 JSON。 */
  readonly payload: string;
  readonly createdAt: number;
  /** 投递阶段：0 等待第一段，1 第一段已投、等待升级。 */
  readonly stage: number;
  /** 升级时刻；第一段投递后设置，到期仍未处理则推给全部在线设备。 */
  readonly escalateAt?: number;
}

/** 入队选项。 */
export interface PushEnqueueOptions {
  readonly deviceId?: string;
  readonly stage?: number;
  readonly escalateAt?: number;
}

/**
 * 离线推送队列。
 *
 * 设备不在线时消息落在这里，设备重新连接后按顺序补发；投递过的记录保留标记而不是删除，
 * 便于排查「为什么没收到」。队列只承载通知类消息，不承载会话内容本身。
 */
export class PushQueue {
  constructor(private readonly database: DatabaseSync) {}

  /** 入队一条推送。 */
  enqueue(accountId: string, payload: string, options: PushEnqueueOptions = {}): PushItem {
    const item: PushItem = {
      id: randomBytes(12).toString('hex'),
      accountId,
      deviceId: options.deviceId,
      payload,
      createdAt: Date.now(),
      stage: options.stage ?? 0,
      escalateAt: options.escalateAt,
    };
    this.database
      .prepare('insert into push_queue (id, account_id, device_id, payload, created_at, stage, escalate_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(item.id, item.accountId, item.deviceId ?? null, item.payload, item.createdAt, item.stage, item.escalateAt ?? null);
    return item;
  }

  /** 读第一段已投、到了升级时刻的通知。 */
  escalateDue(now: number, limit = 32): PushItem[] {
    const rows = this.database
      .prepare(`select id, account_id, device_id, payload, created_at, stage, escalate_at from push_queue
                where delivered_at is null and stage = 1 and escalate_at is not null and escalate_at <= ?
                order by escalate_at asc limit ?`)
      .all(now, limit) as unknown as { id: string; account_id: string; device_id: string | null; payload: string; created_at: number; stage: number; escalate_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      deviceId: row.device_id ?? undefined,
      payload: row.payload,
      createdAt: row.created_at,
      stage: row.stage,
      escalateAt: row.escalate_at ?? undefined,
    }));
  }

  /** 读账号名下尚未投递的推送，按入队顺序。 */
  pending(accountId: string, limit = 64): PushItem[] {
    const rows = this.database
      .prepare(`select id, account_id, device_id, payload, created_at, stage, escalate_at from push_queue
                where account_id = ? and delivered_at is null order by created_at asc limit ?`)
      .all(accountId, limit) as unknown as { id: string; account_id: string; device_id: string | null; payload: string; created_at: number; stage: number; escalate_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      deviceId: row.device_id ?? undefined,
      payload: row.payload,
      createdAt: row.created_at,
      stage: row.stage,
      escalateAt: row.escalate_at ?? undefined,
    }));
  }

  /** 标记若干条推送已投递。 */
  markDelivered(ids: readonly string[]): void {
    const now = Date.now();
    const statement = this.database.prepare('update push_queue set delivered_at = ? where id = ?');
    for (const id of ids) statement.run(now, id);
  }

  /** 账号名下未投递的条数。 */
  pendingCount(accountId: string): number {
    const row = this.database
      .prepare('select count(*) as total from push_queue where account_id = ? and delivered_at is null')
      .get(accountId) as { total: number } | undefined;
    return row?.total ?? 0;
  }
}

/** 一条已读回执。 */
export interface ReceiptRecord {
  readonly sessionId: string;
  readonly deviceId: string;
  /** 该设备读到的最末事件序号。 */
  readonly readUpToSeq: number;
  readonly updatedAt: number;
}

/**
 * 已读回执。
 *
 * 每台设备对每个会话记一个水位，未读数就是副本水位减去这个水位。回执只往前走：回退到更小的
 * 序号不会生效，避免乱序到达的请求把未读数放大。
 */
export class ReceiptStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 记一次已读；比已有水位小时忽略。 */
  /**
   * 记录某个设备的已读水位。水位只前进不后退：新值不大于当前值时直接返回当前记录。
   * 读与写之间没有别的写入者插入——同步的 SQLite 接口在同一进程内一次调用完成，
   * 因此不需要把比较交给 SQL 的 MAX 表达式。
   */
  mark(input: { sessionId: string; deviceId: string; accountId: string; readUpToSeq: number }): ReceiptRecord {
    const now = Date.now();
    const current = this.database
      .prepare('select read_up_to_seq, updated_at from read_receipts where session_id = ? and device_id = ?')
      .get(input.sessionId, input.deviceId) as { read_up_to_seq: number; updated_at: number } | undefined;
    if (current !== undefined && current.read_up_to_seq >= input.readUpToSeq) {
      return { sessionId: input.sessionId, deviceId: input.deviceId, readUpToSeq: current.read_up_to_seq, updatedAt: current.updated_at };
    }
    this.database
      .prepare(`insert into read_receipts (session_id, device_id, account_id, read_up_to_seq, updated_at)
                values (?, ?, ?, ?, ?)
                on conflict(session_id, device_id) do update set read_up_to_seq = excluded.read_up_to_seq, updated_at = excluded.updated_at`)
      .run(input.sessionId, input.deviceId, input.accountId, input.readUpToSeq, now);
    return { sessionId: input.sessionId, deviceId: input.deviceId, readUpToSeq: input.readUpToSeq, updatedAt: now };
  }

  /** 列出某会话各设备的已读水位，按设备标识排序。 */
  list(sessionId: string, accountId: string): ReceiptRecord[] {
    const rows = this.database
      .prepare(`select session_id, device_id, read_up_to_seq, updated_at from read_receipts
                where session_id = ? and account_id = ? order by device_id asc`)
      .all(sessionId, accountId) as unknown as { session_id: string; device_id: string; read_up_to_seq: number; updated_at: number }[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      deviceId: row.device_id,
      readUpToSeq: row.read_up_to_seq,
      updatedAt: row.updated_at,
    }));
  }
}
