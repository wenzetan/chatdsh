/**
 * 控制平面的配置与存储。
 *
 * 当前形态用内置的 SQLite（`node:sqlite`）。单用户部署下没有账号表与账号列：会话归属按
 * 设备记录，额度只有一份读数。换 Postgres 时把同一组接口换实现，调用方不变。
 * @module @chatdsh/gateway/store
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LlmGatewayConfig } from './llm.ts';

/** 访问认证的启用方式。 */
export type GatewayAccessMode = 'disabled' | 'required';

/** 控制平面配置。 */
export interface GatewayConfig {
  /** 监听地址。 */
  readonly host: string;
  /** 监听端口。 */
  readonly port: number;
  /** 运行时地址，反代的转发目标。 */
  readonly runtimeUrl: string;
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
  /** 访问认证的启用方式；`disabled` 时按单账号边界处理写动作。 */
  readonly accessMode: GatewayAccessMode;
  /** 备份根目录；备份集、恢复目录与切换记录都落在这里。 */
  readonly backupRoot: string;
  /** PWA 清单与 Service Worker 的版本号，写进清单描述与缓存名。 */
  readonly pwaVersion: string;
  /** 手机配对码；未配置时配对端点返回 404。 */
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

/** 一条设备记录。 */
export interface DeviceRecord {
  readonly id: string;
  readonly origin: string;
  readonly platform: string;
  readonly lastSeenAt: number;
}

/** 一条手机设备记录。令牌本身不落库，只保存 SHA-256 摘要。 */
export interface MobileDeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt?: number;
}

/** 设备在平台上的位置。 */
export type NodeRole = 'host' | 'executor' | 'both';

/** 一条执行节点记录。节点令牌同样只保存 SHA-256 摘要。 */
export interface NodeDeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly role: NodeRole;
  /** 设备自报的能力标识，落库时序列化成 JSON 数组。 */
  readonly capabilities: readonly string[];
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/** `node_devices` 的一行。 */
type NodeRow = {
  id: string;
  name: string;
  platform: string;
  role: string;
  capabilities: string;
  created_at: number;
  last_seen_at: number;
};

/** 能力列按 JSON 数组存取。列内容不合法时直接抛出，不做兜底。 */
function capabilitiesOf(raw: string): readonly string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('node_devices.capabilities 必须是 JSON 数组');
  return parsed.filter((item): item is string => typeof item === 'string');
}

/** 把一行数据库记录转成节点记录。 */
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

/** 数据根：控制平面的数据与运行时共用 `DSH_HOME` 的约定。 */
export function dataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
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
 * 解析访问认证的启用方式。取值不认识时直接失败，不静默退到任何一种模式。
 * @param raw - `CHATDSH_ACCESS_MODE` 的取值。
 * @returns 访问模式。
 */
export function parseAccessMode(raw: string | undefined): GatewayAccessMode {
  if (raw === undefined || raw.trim() === '') return 'disabled';
  if (raw === 'disabled' || raw === 'required') return raw;
  throw new Error(`CHATDSH_ACCESS_MODE 只能取 disabled 或 required：${raw}`);
}

/**
 * 读取配置。环境变量优先，缺省值面向单机自托管。
 * @param env - 进程环境变量。
 * @returns 配置。
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const root = dataRoot();
  const version = env.CHATDSH_VERSION ?? '0.1.0';
  return {
    host: env.CHATDSH_GATEWAY_HOST ?? '127.0.0.1',
    port: Number.parseInt(env.CHATDSH_GATEWAY_PORT ?? '3170', 10),
    runtimeUrl: env.CHATDSH_RUNTIME_URL ?? 'http://127.0.0.1:3080',
    databasePath: env.CHATDSH_GATEWAY_DB ?? join(root, 'gateway', 'gateway.sqlite'),
    environment: env.CHATDSH_ENVIRONMENT ?? 'local',
    version,
    pushMode: env.CHATDSH_PUSH_MODE === 'all-at-once' ? 'all-at-once' : 'two-stage',
    pushEscalationMs: Number.parseInt(env.CHATDSH_PUSH_ESCALATION_MS ?? '120000', 10),
    accessMode: parseAccessMode(env.CHATDSH_ACCESS_MODE),
    backupRoot: env.CHATDSH_BACKUP_ROOT ?? join(root, 'backups'),
    pwaVersion: env.CHATDSH_PWA_VERSION ?? version,
    llmGateway: parseLlmGateway(env),
    ...(env.CHATDSH_PAIRING_CODE === undefined || env.CHATDSH_PAIRING_CODE === '' ? {} : { pairingCode: env.CHATDSH_PAIRING_CODE }),
    ...(env.CHATDSH_PUBLIC_URL === undefined || env.CHATDSH_PUBLIC_URL === '' ? {} : { publicUrl: env.CHATDSH_PUBLIC_URL }),
  };
}

/** 额度账本的唯一键：单账号下额度只有一份读数。 */
export const LLM_QUOTA_KEY = 'quota';

/** 旧库迁移覆盖的表：凡是有过 `account_id` 列的表都列在这里。 */
const ACCOUNT_TABLES = [
  'sessions',
  'devices',
  'replica_events',
  'replica_watermarks',
  'shares',
  'push_queue',
  'read_receipts',
  'mobile_devices',
  'node_devices',
  'automations',
] as const;

/** 取一张表的列名；表不存在时为空。 */
function columnNamesOf(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`select name from pragma_table_info('${table}')`).all() as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

/** 判断一张表是否存在。 */
function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * 把旧库迁移到单账号形态：删账号表、删各表的账号列、把额度账本并成一行。
 *
 * SQLite 的 `alter table ... drop column` 不允许删被索引或被主键引用的列，所以先删引用
 * `account_id` 的索引；主键里含账号列的表与额度账本改为重建表再搬数据。整段在一个事务里
 * 完成，重复执行是空操作。
 * @param database - 数据库连接。
 */
export function migrateAccountColumns(database: DatabaseSync): void {
  const hasLegacyData = ACCOUNT_TABLES.some((table) => tableExists(database, table) && columnNamesOf(database, table).includes('account_id'));
  const hasLegacyQuota = tableExists(database, 'llm_quota') && columnNamesOf(database, 'llm_quota').includes('account_id');
  const hasLegacyMcp = (tableExists(database, 'mcp_servers') && columnNamesOf(database, 'mcp_servers').includes('account_id'))
    || (tableExists(database, 'mcp_endpoints') && columnNamesOf(database, 'mcp_endpoints').includes('account_id'));
  const hasAccounts = tableExists(database, 'accounts');
  if (!hasLegacyData && !hasLegacyQuota && !hasLegacyMcp && !hasAccounts) return;

  database.exec('begin');
  try {
    // 引用账号列的索引必须先删，drop column 才不会被拒绝。
    const indexes = database
      .prepare("select name from sqlite_master where type = 'index' and sql is not null and sql like '%account_id%'")
      .all() as unknown as { name: string }[];
    for (const index of indexes) database.exec(`drop index if exists "${index.name}"`);

    for (const table of ACCOUNT_TABLES) {
      if (!tableExists(database, table) || !columnNamesOf(database, table).includes('account_id')) continue;
      database.exec(`alter table ${table} drop column account_id`);
    }

    if (hasLegacyQuota) {
      database.exec(`
        create table llm_quota_single (
          key text primary key,
          used integer not null
        );
        insert into llm_quota_single (key, used)
          select '${LLM_QUOTA_KEY}', coalesce(sum(used), 0) from llm_quota;
        drop table llm_quota;
        alter table llm_quota_single rename to llm_quota;
      `);
    }

    if (tableExists(database, 'mcp_servers') && columnNamesOf(database, 'mcp_servers').includes('account_id')) {
      database.exec(`
        create table mcp_servers_single (
          name text primary key,
          created_by text not null,
          created_at integer not null
        );
        insert or ignore into mcp_servers_single (name, created_by, created_at)
          select name, created_by, created_at from mcp_servers order by created_at;
        drop table mcp_servers;
        alter table mcp_servers_single rename to mcp_servers;
      `);
    }

    if (tableExists(database, 'mcp_endpoints') && columnNamesOf(database, 'mcp_endpoints').includes('account_id')) {
      database.exec(`
        create table mcp_endpoints_single (
          server text not null,
          device_id text not null,
          transport text not null,
          row text not null,
          credential_env text,
          updated_at integer not null,
          primary key (server, device_id)
        );
        insert or ignore into mcp_endpoints_single (server, device_id, transport, row, credential_env, updated_at)
          select server, device_id, transport, row, credential_env, updated_at from mcp_endpoints;
        drop table mcp_endpoints;
        alter table mcp_endpoints_single rename to mcp_endpoints;
        create index if not exists mcp_endpoints_by_device on mcp_endpoints(device_id);
      `);
    }

    if (hasAccounts) database.exec('drop table accounts');
    database.exec('commit');
  } catch (error) {
    database.exec('rollback');
    throw error;
  }
}

/**
 * 控制平面的存储。
 *
 * 表结构只在启动时建立一次；会话归属按会话标识唯一。旧库在构造时迁移到单账号形态。
 */
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
        deleted_at integer
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
      create table if not exists shares (
        token text primary key,
        session_id text not null,
        up_to_seq integer not null,
        created_at integer not null,
        expires_at integer,
        revoked_at integer,
        visits integer not null default 0
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
      create table if not exists llm_quota (
        key text primary key,
        used integer not null
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

    // 旧库补列：会话要记录它是由哪条会话导入而来的。
    const sessionColumns = columnNamesOf(this.database, 'sessions');
    if (!sessionColumns.includes('parent_session')) {
      this.database.exec('alter table sessions add column parent_session text');
    }

    // 旧库补列：第一段已投、等待升级的通知需要记录阶段与升级时刻。
    const pushNames = columnNamesOf(this.database, 'push_queue');
    if (!pushNames.includes('stage')) this.database.exec('alter table push_queue add column stage integer not null default 0');
    if (!pushNames.includes('escalate_at')) this.database.exec('alter table push_queue add column escalate_at integer');
    // 早期版本只存事件信封；副本要承担跨设备浏览与导入，必须带上事件本体。
    if (!columnNamesOf(this.database, 'replica_events').includes('payload')) {
      this.database.exec('alter table replica_events add column payload text');
    }

    // 旧库迁移：删账号表与账号列，额度账本并成一行。
    migrateAccountColumns(this.database);
  }

  /** 取模型额度已用量。 */
  llmQuotaUsed(): number {
    const row = this.database.prepare('select used from llm_quota where key = ?').get(LLM_QUOTA_KEY) as { used: number } | undefined;
    return row?.used ?? 0;
  }

  /** 累加模型额度用量。 */
  recordLlmQuota(tokens: number): number {
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error('额度用量必须是非负整数');
    this.database.prepare(
      'insert into llm_quota (key, used) values (?, ?) on conflict(key) do update set used = used + excluded.used',
    ).run(LLM_QUOTA_KEY, tokens);
    return this.llmQuotaUsed();
  }

  /** 写入或更新一条会话归属。 */
  upsertSession(record: SessionOwnershipRecord & { readonly parentSession?: string }): void {
    // 归属在会话创建时确定，之后不可修改。冲突时保留先写入的那一行：
    // 两个请求并发首次上报同一会话时，后到的不会覆盖设备与目录。
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

  /** 取一条会话归属。 */
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

  /** 列出设备，按最近活动倒序。 */
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

  /** 登记一台已配对的手机设备。 */
  registerMobileDevice(input: { readonly id: string; readonly name: string; readonly platform: string; readonly tokenHash: string }): MobileDeviceRecord {
    const createdAt = Date.now();
    this.database
      .prepare('insert into mobile_devices (id, name, platform, token_hash, created_at, last_seen_at, revoked_at) values (?, ?, ?, ?, ?, ?, null)')
      .run(input.id, input.name, input.platform, input.tokenHash, createdAt, createdAt);
    return { id: input.id, name: input.name, platform: input.platform, createdAt, lastSeenAt: createdAt };
  }

  /** 按令牌摘要取手机设备；已撤销的记录按不存在处理。 */
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

  /** 记一次手机设备活动。 */
  touchMobileDevice(id: string): void {
    this.database.prepare('update mobile_devices set last_seen_at = ? where id = ?').run(Date.now(), id);
  }

  /** 列出已配对的手机设备；已吊销的记录同样返回，供设置面显示吊销状态。 */
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

  /** 吊销一台手机设备；返回是否确实吊销了未吊销的记录。 */
  revokeMobileDevice(id: string): boolean {
    const result = this.database
      .prepare('update mobile_devices set revoked_at = ? where id = ? and revoked_at is null')
      .run(Date.now(), id);
    return Number(result.changes) > 0;
  }

  /** 登记一台执行节点。令牌摘要不重复，同一台设备重复配对会写进新的一行。 */
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

  /** 列出执行节点，按最近活动倒序。 */
  listNodes(): NodeDeviceRecord[] {
    const rows = this.database
      .prepare('select id, name, platform, role, capabilities, created_at, last_seen_at from node_devices order by last_seen_at desc')
      .all() as NodeRow[];
    return rows.map(nodeRecordOf);
  }

  /** 记一次执行节点活动。 */
  touchNode(id: string): void {
    this.database.prepare('update node_devices set last_seen_at = ? where id = ?').run(Date.now(), id);
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
 * 副本里一个会话的摘要：左栏列表只读这两项。
 */
export interface ReplicaSummary {
  /** 副本里最新事件的时间；没有副本时为空。 */
  readonly updatedAt?: number;
  /** 副本里最新 `session/title` 事件的标题；没有标题事件时为空。 */
  readonly title?: string;
}

/**
 * 从一条标题事件的载荷里取标题。
 *
 * 上报的载荷是完整的事件记录，即 `{seq, type, time, data}`，标题在 `data.title` 上；
 * 结构不认识时当作没有标题，由调用方回退到 `cwd` 末段。
 * @param payload - 副本里存的事件载荷（JSON 文本）。
 * @returns 标题文本；取不到时为空。
 */
function titleOfPayload(payload: string | null): string | undefined {
  if (payload === null) return undefined;
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const data = (parsed as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const title = (data as { title?: unknown }).title;
  return typeof title === 'string' && title !== '' ? title : undefined;
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

  /** 读一个会话的水位。 */
  watermarkOf(sessionId: string): number | undefined {
    const row = this.database
      .prepare('select watermark from replica_watermarks where session_id = ?')
      .get(sessionId) as { watermark: number } | undefined;
    return row?.watermark;
  }

  /** 列出副本水位。 */
  listWatermarks(): { sessionId: string; watermark: number; updatedAt: number }[] {
    const rows = this.database
      .prepare('select session_id, watermark, updated_at from replica_watermarks order by updated_at desc')
      .all() as { session_id: string; watermark: number; updated_at: number }[];
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

  /**
   * 列出全部会话副本的摘要。
   *
   * 两条聚合查询：一条取每个会话的最新事件时间，一条取全部标题事件（按序号升序，同会话
   * 后到的覆盖先到的）。标题事件是日志事件里最稀疏的一类，这样读避免逐会话查询。
   * @returns 会话标识到摘要的映射。
   */
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

/** 一条分享记录。快照的边界由 `upToSeq` 固定，源会话此后继续增长不会进入链接。 */
export interface ShareRecord {
  readonly token: string;
  readonly sessionId: string;
  readonly upToSeq: number;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly visits: number;
}

/** 建立分享时的输入。 */
export interface ShareInput {
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
      .prepare('insert into shares (token, session_id, up_to_seq, created_at, expires_at, revoked_at, visits) values (?, ?, ?, ?, ?, null, 0)')
      .run(token, input.sessionId, upToSeq, createdAt, expiresAt);
    return {
      token,
      sessionId: input.sessionId,
      upToSeq,
      createdAt,
      expiresAt: expiresAt ?? undefined,
      visits: 0,
    };
  }

  /** 读一条分享记录。 */
  get(token: string): ShareRecord | undefined {
    const row = this.database
      .prepare('select token, session_id, up_to_seq, created_at, expires_at, revoked_at, visits from shares where token = ?')
      .get(token) as ShareRow | undefined;
    return row === undefined ? undefined : toShare(row);
  }

  /** 撤销一条分享。 */
  revoke(token: string): boolean {
    const result = this.database
      .prepare('update shares set revoked_at = ? where token = ? and revoked_at is null')
      .run(Date.now(), token);
    return Number(result.changes) > 0;
  }

  /** 记一次访问。 */
  touch(token: string): void {
    this.database.prepare('update shares set visits = visits + 1 where token = ?').run(token);
  }

  /** 列出分享记录。 */
  list(): ShareRecord[] {
    const rows = this.database
      .prepare('select token, session_id, up_to_seq, created_at, expires_at, revoked_at, visits from shares order by created_at desc')
      .all() as unknown as ShareRow[];
    return rows.map(toShare);
  }
}

interface ShareRow {
  token: string;
  session_id: string;
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
    upToSeq: row.up_to_seq,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    visits: row.visits,
  };
}

/** 一条待投递的推送。 */
export interface PushItem {
  readonly id: string;
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

  /** 读第一段已投、到了升级时刻的通知。 */
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

  /** 读尚未投递的推送，按入队顺序。 */
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

  /** 标记若干条推送已投递。 */
  markDelivered(ids: readonly string[]): void {
    const now = Date.now();
    const statement = this.database.prepare('update push_queue set delivered_at = ? where id = ?');
    for (const id of ids) statement.run(now, id);
  }

  /** 未投递的条数。 */
  pendingCount(): number {
    const row = this.database
      .prepare('select count(*) as total from push_queue where delivered_at is null')
      .get() as { total: number } | undefined;
    return row?.total ?? 0;
  }

  /** 撤回尚未投递、载荷里带同一会话与同一关联键的通知，返回撤回条数。 */
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

  /** 列出某会话各设备的已读水位，按设备标识排序。 */
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

/** 同步设置的白名单命名空间：只有这几类设置跨设备同步，路径与平台相关的设置留在本机。 */
export const SETTINGS_NAMESPACES = [
  'agent-default-model',
  'client-locale',
  'client-ui-chat',
  'client-product-analytics',
  'agent-preset-registry',
] as const;

/** 白名单命名空间的取值集合。 */
export type SettingsNamespace = typeof SETTINGS_NAMESPACES[number];

/** 一个命名空间下的一条设置。 */
export interface SettingRecord {
  readonly namespace: string;
  readonly key: string;
  /** 设置的 JSON 文本。 */
  readonly value: string;
  /** 控制平面接收这次写入的时刻。 */
  readonly updatedAt: number;
}

/** 写入一条设置的输入。 */
export interface SettingInput {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
}

/**
 * 设置的存储。
 *
 * 只有白名单里的命名空间会落库；时间取控制平面的接收时刻，不取设备时钟，冲突因此
 * 统一按「最后写入者胜」判定。
 */
export class SettingsStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 写入一条设置，返回控制平面接收时刻。 */
  put(input: SettingInput): number {
    const now = Date.now();
    this.database
      .prepare(`insert into settings (namespace, key, value, updated_at) values (?, ?, ?, ?)
                on conflict(namespace, key) do update set value = excluded.value, updated_at = excluded.updated_at`)
      .run(input.namespace, input.key, input.value, now);
    return now;
  }

  /** 读一个命名空间下的全部设置，按 key 升序。 */
  list(namespace: string): SettingRecord[] {
    const rows = this.database
      .prepare('select namespace, key, value, updated_at from settings where namespace = ? order by key asc')
      .all(namespace) as unknown as SettingRow[];
    return rows.map(toSetting);
  }

  /** 读全部白名单命名空间的设置，按命名空间分组。 */
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
