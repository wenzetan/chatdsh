/**
 * 轻量中继服务端的配置与存储。
 *
 * 使用 Node 内置 SQLite（`node:sqlite`），承载设备表、会话归属、会话只读副本、
 * 已读水位、推送队列与白名单设置。
 * @module @chatdsh/gateway/store
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 访问认证的启用方式。 */
export type GatewayAccessMode = 'disabled' | 'required';

/** 中继服务端配置。 */
export interface GatewayConfig {
  /** 监听地址。 */
  readonly host: string;
  /** 监听端口。 */
  readonly port: number;
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
  /** 访问认证的启用方式。 */
  readonly accessMode: GatewayAccessMode;
  /** PWA 清单与 Service Worker 的版本号。 */
  readonly pwaVersion: string;
  /** 配对码；未配置时配对端点返回 404。 */
  readonly pairingCode?: string;
  /** 对外访问的精确 origin；缺省按监听地址与实际端口拼出。 */
  readonly publicUrl?: string;
}

/** 一条会话归属记录。 */
export interface SessionOwnershipRecord {
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly deviceId: string;
  readonly cwd: string;
  readonly kind: 'work' | 'chat';
  readonly createdAt: number;
}

/** 一条设备活动记录。 */
export interface DeviceRecord {
  readonly id: string;
  readonly origin: string;
  readonly platform: string;
  readonly lastSeenAt: number;
}

/** 一条已配对客户端设备记录。令牌只保存 SHA-256 摘要。 */
export interface MobileDeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt?: number;
}

/** 设备在平台上的角色。 */
export type NodeRole = 'host' | 'executor' | 'both';

/** 一条执行节点记录。节点令牌只保存 SHA-256 摘要。 */
export interface NodeDeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly role: NodeRole;
  readonly capabilities: readonly string[];
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

type NodeRow = {
  id: string;
  name: string;
  platform: string;
  role: string;
  capabilities: string;
  created_at: number;
  last_seen_at: number;
};

function capabilitiesOf(raw: string): readonly string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('node_devices.capabilities 必须是 JSON 数组');
  return parsed.filter((item): item is string => typeof item === 'string');
}

function nodeRecordOf(row: NodeRow): NodeDeviceRecord {
  if (row.role !== 'host' && row.role !== 'executor' && row.role !== 'both') {
    throw new Error(`node_devices.role 取值非法：${row.role}`);
  }
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    role: row.role,
    capabilities: capabilitiesOf(row.capabilities),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** 数据根：中继服务端与运行时共用 `DSH_HOME` 的约定。 */
export function dataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function parseAccessMode(raw: string | undefined): GatewayAccessMode {
  if (raw === undefined || raw.trim() === '') return 'disabled';
  if (raw === 'disabled' || raw === 'required') return raw;
  throw new Error(`CHATDSH_ACCESS_MODE 只能取 disabled 或 required：${raw}`);
}

/** 读取配置。 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const root = dataRoot();
  const version = env.CHATDSH_VERSION ?? '0.1.0';
  return {
    host: env.CHATDSH_GATEWAY_HOST ?? '127.0.0.1',
    port: Number.parseInt(env.CHATDSH_GATEWAY_PORT ?? '3170', 10),
    databasePath: env.CHATDSH_GATEWAY_DB ?? join(root, 'gateway', 'gateway.sqlite'),
    environment: env.CHATDSH_ENVIRONMENT ?? 'local',
    version,
    pushMode: env.CHATDSH_PUSH_MODE === 'all-at-once' ? 'all-at-once' : 'two-stage',
    pushEscalationMs: Number.parseInt(env.CHATDSH_PUSH_ESCALATION_MS ?? '120000', 10),
    accessMode: parseAccessMode(env.CHATDSH_ACCESS_MODE),
    pwaVersion: env.CHATDSH_PWA_VERSION ?? version,
    ...(env.CHATDSH_PAIRING_CODE === undefined || env.CHATDSH_PAIRING_CODE === '' ? {} : { pairingCode: env.CHATDSH_PAIRING_CODE }),
    ...(env.CHATDSH_PUBLIC_URL === undefined || env.CHATDSH_PUBLIC_URL === '' ? {} : { publicUrl: env.CHATDSH_PUBLIC_URL }),
  };
}

function columnNamesOf(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`select name from pragma_table_info('${table}')`).all() as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

/** 中继服务端存储。 */
export class GatewayStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      create table if not exists sessions (
        session_id text primary key,
        workspace_id text,
        device_id text not null,
        cwd text not null,
        kind text not null,
        created_at integer not null,
        deleted_at integer,
        parent_session text
      );
      create table if not exists devices (
        id text primary key,
        origin text not null,
        platform text not null,
        last_seen_at integer not null
      );
      create table if not exists replica_events (
        session_id text not null,
        seq integer not null,
        kind text not null,
        time integer not null,
        bytes integer not null,
        payload text,
        primary key (session_id, seq)
      );
      create table if not exists replica_watermarks (
        session_id text primary key,
        watermark integer not null,
        updated_at integer not null
      );
      create table if not exists push_queue (
        id text primary key,
        device_id text,
        payload text not null,
        created_at integer not null,
        delivered_at integer,
        stage integer not null default 0,
        escalate_at integer
      );
      create table if not exists read_receipts (
        session_id text not null,
        device_id text not null,
        read_up_to_seq integer not null,
        updated_at integer not null,
        primary key (session_id, device_id)
      );
      create table if not exists mobile_devices (
        id text primary key,
        name text not null,
        platform text not null,
        token_hash text not null unique,
        created_at integer not null,
        last_seen_at integer not null,
        revoked_at integer
      );
      create table if not exists node_devices (
        id text primary key,
        name text not null,
        platform text not null,
        role text not null,
        capabilities text not null,
        token_hash text not null unique,
        created_at integer not null,
        last_seen_at integer not null
      );
      create table if not exists settings (
        namespace text not null,
        key text not null,
        value text not null,
        updated_at integer not null,
        primary key (namespace, key)
      );
    `);

    const sessionColumns = columnNamesOf(this.database, 'sessions');
    if (!sessionColumns.includes('parent_session')) {
      this.database.exec('alter table sessions add column parent_session text');
    }
    const pushNames = columnNamesOf(this.database, 'push_queue');
    if (!pushNames.includes('stage')) this.database.exec('alter table push_queue add column stage integer not null default 0');
    if (!pushNames.includes('escalate_at')) this.database.exec('alter table push_queue add column escalate_at integer');
    if (!columnNamesOf(this.database, 'replica_events').includes('payload')) {
      this.database.exec('alter table replica_events add column payload text');
    }
  }

  /** 写入一条会话归属；已存在时保留原记录。 */
  upsertSession(record: SessionOwnershipRecord & { readonly parentSession?: string }): void {
    this.database
      .prepare(`insert into sessions (session_id, workspace_id, device_id, cwd, kind, created_at, parent_session)
                values (?, ?, ?, ?, ?, ?, ?)
                on conflict(session_id) do nothing`)
      .run(record.sessionId, record.workspaceId ?? null, record.deviceId, record.cwd, record.kind, record.createdAt, record.parentSession ?? null);
  }

  /** 列出会话归属，按创建时间倒序。 */
  listSessions(): (SessionOwnershipRecord & { readonly parentSession?: string })[] {
    const rows = this.database
      .prepare('select session_id, workspace_id, device_id, cwd, kind, created_at, parent_session from sessions where deleted_at is null order by created_at desc')
      .all() as { session_id: string; workspace_id: string | null; device_id: string; cwd: string; kind: string; created_at: number; parent_session: string | null }[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      workspaceId: row.workspace_id ?? undefined,
      deviceId: row.device_id,
      cwd: row.cwd,
      kind: row.kind === 'chat' ? 'chat' : 'work',
      createdAt: row.created_at,
      parentSession: row.parent_session ?? undefined,
    }));
  }

  /** 读取一条会话归属。 */
  getSession(sessionId: string): SessionOwnershipRecord | undefined {
    const row = this.database
      .prepare('select session_id, workspace_id, device_id, cwd, kind, created_at from sessions where session_id = ?')
      .get(sessionId) as { session_id: string; workspace_id: string | null; device_id: string; cwd: string; kind: string; created_at: number } | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: row.session_id,
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
      .prepare(`insert into devices (id, origin, platform, last_seen_at)
                values (?, ?, ?, ?)
                on conflict(id) do update set last_seen_at = excluded.last_seen_at, origin = excluded.origin`)
      .run(record.id, record.origin, record.platform, record.lastSeenAt);
  }

  /** 列出活跃设备。 */
  listDevices(): DeviceRecord[] {
    const rows = this.database
      .prepare('select id, origin, platform, last_seen_at from devices order by last_seen_at desc')
      .all() as { id: string; origin: string; platform: string; last_seen_at: number }[];
    return rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      platform: row.platform,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /** 登记一台客户端设备。 */
  registerMobileDevice(input: { readonly id: string; readonly name: string; readonly platform: string; readonly tokenHash: string }): MobileDeviceRecord {
    const createdAt = Date.now();
    this.database
      .prepare('insert into mobile_devices (id, name, platform, token_hash, created_at, last_seen_at, revoked_at) values (?, ?, ?, ?, ?, ?, null)')
      .run(input.id, input.name, input.platform, input.tokenHash, createdAt, createdAt);
    return { id: input.id, name: input.name, platform: input.platform, createdAt, lastSeenAt: createdAt };
  }

  /** 按令牌摘要取客户端设备；已吊销按不存在处理。 */
  mobileDeviceByTokenHash(tokenHash: string): MobileDeviceRecord | undefined {
    const row = this.database
      .prepare('select id, name, platform, created_at, last_seen_at, revoked_at from mobile_devices where token_hash = ?')
      .get(tokenHash) as { id: string; name: string; platform: string; created_at: number; last_seen_at: number; revoked_at: number | null } | undefined;
    if (row === undefined || row.revoked_at !== null) return undefined;
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  /** 记一次客户端设备活动。 */
  touchMobileDevice(id: string): void {
    this.database.prepare('update mobile_devices set last_seen_at = ? where id = ?').run(Date.now(), id);
  }

  /** 列出已配对客户端设备。 */
  listMobileDevices(): MobileDeviceRecord[] {
    const rows = this.database
      .prepare('select id, name, platform, created_at, last_seen_at, revoked_at from mobile_devices order by created_at desc')
      .all() as { id: string; name: string; platform: string; created_at: number; last_seen_at: number; revoked_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }));
  }

  /** 吊销一台客户端设备。 */
  revokeMobileDevice(id: string): boolean {
    const result = this.database
      .prepare('update mobile_devices set revoked_at = ? where id = ? and revoked_at is null')
      .run(Date.now(), id);
    return Number(result.changes) > 0;
  }

  /** 登记一台执行节点。 */
  registerNode(input: {
    readonly id: string;
    readonly name: string;
    readonly platform: string;
    readonly role: NodeRole;
    readonly capabilities: readonly string[];
    readonly tokenHash: string;
  }): NodeDeviceRecord {
    const createdAt = Date.now();
    this.database
      .prepare('insert into node_devices (id, name, platform, role, capabilities, token_hash, created_at, last_seen_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, input.name, input.platform, input.role, JSON.stringify(input.capabilities), input.tokenHash, createdAt, createdAt);
    return {
      id: input.id,
      name: input.name,
      platform: input.platform,
      role: input.role,
      capabilities: [...input.capabilities],
      createdAt,
      lastSeenAt: createdAt,
    };
  }

  /** 按令牌摘要取执行节点。 */
  nodeByTokenHash(tokenHash: string): NodeDeviceRecord | undefined {
    const row = this.database
      .prepare('select id, name, platform, role, capabilities, created_at, last_seen_at from node_devices where token_hash = ?')
      .get(tokenHash) as NodeRow | undefined;
    return row === undefined ? undefined : nodeRecordOf(row);
  }

  /** 按标识取执行节点。 */
  nodeById(id: string): NodeDeviceRecord | undefined {
    const row = this.database
      .prepare('select id, name, platform, role, capabilities, created_at, last_seen_at from node_devices where id = ?')
      .get(id) as NodeRow | undefined;
    return row === undefined ? undefined : nodeRecordOf(row);
  }

  /** 列出执行节点。 */
  listNodes(): NodeDeviceRecord[] {
    const rows = this.database
      .prepare('select id, name, platform, role, capabilities, created_at, last_seen_at from node_devices order by last_seen_at desc')
      .all() as NodeRow[];
    return rows.map(nodeRecordOf);
  }

  /** 更新执行节点活动时间。 */
  touchNode(id: string): void {
    this.database.prepare('update node_devices set last_seen_at = ? where id = ?').run(Date.now(), id);
  }

  /** 底层数据库句柄。 */
  handle(): DatabaseSync {
    return this.database;
  }

  /** 关闭数据库。 */
  close(): void {
    this.database.close();
  }
}

/** 上报来的一条会话事件。 */
export interface ReplicaEventInput {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes: number;
  readonly payload?: unknown;
}

/** 副本追加结果。 */
export interface ReplicaAppendResult {
  readonly written: number;
  readonly watermark: number;
}

/** 会话副本摘要。 */
export interface ReplicaSummary {
  readonly updatedAt?: number;
  readonly title?: string;
}

function titleOfPayload(payload: string | null): string | undefined {
  if (payload === null) return undefined;
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const data = (parsed as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const title = (data as { title?: unknown }).title;
  return typeof title === 'string' && title !== '' ? title : undefined;
}

/** 会话只读副本存储。 */
export class ReplicaStore {
  constructor(private readonly database: DatabaseSync) {}

  append(sessionId: string, events: readonly ReplicaEventInput[]): ReplicaAppendResult {
    let written = 0;
    const insert = this.database.prepare(
      'insert or ignore into replica_events (session_id, seq, kind, time, bytes, payload) values (?, ?, ?, ?, ?, ?)',
    );
    for (const event of events) {
      const payload = event.payload === undefined ? null : JSON.stringify(event.payload);
      const result = insert.run(sessionId, event.seq, event.kind, event.time, event.bytes, payload);
      if (Number(result.changes) > 0) written += 1;
    }
    const row = this.database
      .prepare('select max(seq) as watermark from replica_events where session_id = ?')
      .get(sessionId) as { watermark: number | null } | undefined;
    const watermark = row?.watermark ?? 0;
    this.database
      .prepare(`insert into replica_watermarks (session_id, watermark, updated_at)
                values (?, ?, ?)
                on conflict(session_id) do update set watermark = excluded.watermark, updated_at = excluded.updated_at`)
      .run(sessionId, watermark, Date.now());
    return { written, watermark };
  }

  watermarkOf(sessionId: string): number | undefined {
    const row = this.database
      .prepare('select watermark from replica_watermarks where session_id = ?')
      .get(sessionId) as { watermark: number } | undefined;
    return row?.watermark;
  }

  listWatermarks(): { sessionId: string; watermark: number; updatedAt: number }[] {
    const rows = this.database
      .prepare('select session_id, watermark, updated_at from replica_watermarks order by updated_at desc')
      .all() as { session_id: string; watermark: number; updated_at: number }[];
    return rows.map((row) => ({ sessionId: row.session_id, watermark: row.watermark, updatedAt: row.updated_at }));
  }

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

  summaries(): Map<string, ReplicaSummary> {
    const out = new Map<string, ReplicaSummary>();
    const times = this.database
      .prepare('select session_id, max(time) as updated_at from replica_events group by session_id')
      .all() as { session_id: string; updated_at: number }[];
    for (const row of times) out.set(row.session_id, { updatedAt: row.updated_at });
    const titles = this.database
      .prepare("select session_id, payload from replica_events where kind = 'session/title' order by seq asc")
      .all() as { session_id: string; payload: string | null }[];
    for (const row of titles) {
      const title = titleOfPayload(row.payload);
      if (title === undefined) continue;
      out.set(row.session_id, { ...out.get(row.session_id), title });
    }
    return out;
  }
}

/** 一条待投递的推送。 */
export interface PushItem {
  readonly id: string;
  readonly deviceId?: string;
  readonly payload: string;
  readonly createdAt: number;
  readonly stage: number;
  readonly escalateAt?: number;
}

/** 入队选项。 */
export interface PushEnqueueOptions {
  readonly deviceId?: string;
  readonly stage?: number;
  readonly escalateAt?: number;
}

/** 离线推送队列。 */
export class PushQueue {
  constructor(private readonly database: DatabaseSync) {}

  enqueue(payload: string, options: PushEnqueueOptions = {}): PushItem {
    const item: PushItem = {
      id: randomBytes(12).toString('hex'),
      deviceId: options.deviceId,
      payload,
      createdAt: Date.now(),
      stage: options.stage ?? 0,
      escalateAt: options.escalateAt,
    };
    this.database
      .prepare('insert into push_queue (id, device_id, payload, created_at, stage, escalate_at) values (?, ?, ?, ?, ?, ?)')
      .run(item.id, item.deviceId ?? null, item.payload, item.createdAt, item.stage, item.escalateAt ?? null);
    return item;
  }

  escalateDue(now: number, limit = 32): PushItem[] {
    const rows = this.database
      .prepare(`select id, device_id, payload, created_at, stage, escalate_at from push_queue
                where delivered_at is null and stage = 1 and escalate_at is not null and escalate_at <= ?
                order by escalate_at asc limit ?`)
      .all(now, limit) as unknown as { id: string; device_id: string | null; payload: string; created_at: number; stage: number; escalate_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id ?? undefined,
      payload: row.payload,
      createdAt: row.created_at,
      stage: row.stage,
      escalateAt: row.escalate_at ?? undefined,
    }));
  }

  pending(limit = 64): PushItem[] {
    const rows = this.database
      .prepare(`select id, device_id, payload, created_at, stage, escalate_at from push_queue
                where delivered_at is null order by created_at asc limit ?`)
      .all(limit) as unknown as { id: string; device_id: string | null; payload: string; created_at: number; stage: number; escalate_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id ?? undefined,
      payload: row.payload,
      createdAt: row.created_at,
      stage: row.stage,
      escalateAt: row.escalate_at ?? undefined,
    }));
  }

  markDelivered(ids: readonly string[]): void {
    const now = Date.now();
    const statement = this.database.prepare('update push_queue set delivered_at = ? where id = ?');
    for (const id of ids) statement.run(now, id);
  }

  pendingCount(): number {
    const row = this.database
      .prepare('select count(*) as total from push_queue where delivered_at is null')
      .get() as { total: number } | undefined;
    return row?.total ?? 0;
  }

  withdraw(sessionId: string, callId: string): number {
    const rows = this.database
      .prepare('select id, payload from push_queue where delivered_at is null')
      .all() as unknown as { id: string; payload: string }[];
    const targets: string[] = [];
    for (const row of rows) {
      let parsed: { kind?: unknown; sessionId?: unknown; callId?: unknown };
      try {
        parsed = JSON.parse(row.payload) as { kind?: unknown; sessionId?: unknown; callId?: unknown };
      } catch {
        continue;
      }
      if (parsed.kind !== 'approval' || parsed.sessionId !== sessionId) continue;
      if (callId !== '' && parsed.callId !== callId) continue;
      targets.push(row.id);
    }
    if (targets.length === 0) return 0;
    const now = Date.now();
    const statement = this.database.prepare('update push_queue set delivered_at = ? where id = ?');
    for (const id of targets) statement.run(now, id);
    return targets.length;
  }
}

/** 一条已读回执。 */
export interface ReceiptRecord {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly readUpToSeq: number;
  readonly updatedAt: number;
}

/** 已读回执存储。 */
export class ReceiptStore {
  constructor(private readonly database: DatabaseSync) {}

  mark(input: { sessionId: string; deviceId: string; readUpToSeq: number }): ReceiptRecord {
    const now = Date.now();
    const current = this.database
      .prepare('select read_up_to_seq, updated_at from read_receipts where session_id = ? and device_id = ?')
      .get(input.sessionId, input.deviceId) as { read_up_to_seq: number; updated_at: number } | undefined;
    if (current !== undefined && current.read_up_to_seq >= input.readUpToSeq) {
      return { sessionId: input.sessionId, deviceId: input.deviceId, readUpToSeq: current.read_up_to_seq, updatedAt: current.updated_at };
    }
    this.database
      .prepare(`insert into read_receipts (session_id, device_id, read_up_to_seq, updated_at)
                values (?, ?, ?, ?)
                on conflict(session_id, device_id) do update set read_up_to_seq = excluded.read_up_to_seq, updated_at = excluded.updated_at`)
      .run(input.sessionId, input.deviceId, input.readUpToSeq, now);
    return { sessionId: input.sessionId, deviceId: input.deviceId, readUpToSeq: input.readUpToSeq, updatedAt: now };
  }

  list(sessionId: string): ReceiptRecord[] {
    const rows = this.database
      .prepare(`select session_id, device_id, read_up_to_seq, updated_at from read_receipts
                where session_id = ? order by device_id asc`)
      .all(sessionId) as unknown as { session_id: string; device_id: string; read_up_to_seq: number; updated_at: number }[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      deviceId: row.device_id,
      readUpToSeq: row.read_up_to_seq,
      updatedAt: row.updated_at,
    }));
  }
}

/** 跨设备同步的白名单命名空间。 */
export const SETTINGS_NAMESPACES = [
  'agent-default-model',
  'client-locale',
  'client-ui-chat',
  'client-product-analytics',
  'agent-preset-registry',
] as const;

export type SettingsNamespace = typeof SETTINGS_NAMESPACES[number];

export interface SettingRecord {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  readonly updatedAt: number;
}

export interface SettingInput {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
}

/** 白名单设置存储。 */
export class SettingsStore {
  constructor(private readonly database: DatabaseSync) {}

  put(input: SettingInput): number {
    const now = Date.now();
    this.database
      .prepare(`insert into settings (namespace, key, value, updated_at) values (?, ?, ?, ?)
                on conflict(namespace, key) do update set value = excluded.value, updated_at = excluded.updated_at`)
      .run(input.namespace, input.key, input.value, now);
    return now;
  }

  list(namespace: string): SettingRecord[] {
    const rows = this.database
      .prepare('select namespace, key, value, updated_at from settings where namespace = ? order by key asc')
      .all(namespace) as unknown as SettingRow[];
    return rows.map(toSetting);
  }

  snapshot(): Record<string, SettingRecord[]> {
    const out: Record<string, SettingRecord[]> = {};
    for (const namespace of SETTINGS_NAMESPACES) out[namespace] = this.list(namespace);
    return out;
  }
}

interface SettingRow {
  namespace: string;
  key: string;
  value: string;
  updated_at: number;
}

function toSetting(row: SettingRow): SettingRecord {
  return { namespace: row.namespace, key: row.key, value: row.value, updatedAt: row.updated_at };
}
