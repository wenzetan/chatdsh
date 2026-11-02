/**
 * 聚合会话列表：按设备分组的会话清单，左栏用它渲染。
 *
 * 数据来自会话归属表与控制平面的副本存储，不查询设备：设备全部离线时左栏照常列出会话，
 * 只标记设备离线。标题取副本里最新的 `session/title` 事件，副本里没有标题事件时用 `cwd`
 * 的末段。
 * @module @chatdsh/gateway/sessions
 */

import type { GatewayStore, ReplicaStore } from './store.ts';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/** 左栏里的一条会话。 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly title: string;
  /** 最近一次活动的时间：副本里最新事件的时间，没有副本时取归属的创建时间。 */
  readonly updatedAt: number;
  readonly cwd: string;
  /** 工作区显示名，取 `cwd` 的末段；左栏按它跨设备合并同一个仓库的多份检出。 */
  readonly workspaceName: string;
  readonly kind: 'work' | 'chat';
}

/** 左栏里的一台设备与它名下的会话。 */
export interface DeviceSessions {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  /** 长连接在线状态；离线只影响标记，不影响列表。 */
  readonly online: boolean;
  readonly lastSeenAt: number;
  readonly sessions: readonly SessionSummary[];
}

/** 聚合结果。 */
export interface SessionsSnapshot {
  readonly devices: readonly DeviceSessions[];
}

/** 聚合输入。 */
export interface AggregateSessionsOptions {
  readonly store: GatewayStore;
  readonly replica: ReplicaStore;
  /** 在线判定，由设备长连接表给出。 */
  readonly online: (deviceId: string) => boolean;
}

/**
 * 取 `cwd` 的末段作为标题兜底。
 * @param cwd - 会话头里的工作目录。
 * @returns 末段目录名；路径为空时返回空字符串。
 */
function cwdTail(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter((segment) => segment !== '');
  return segments.length === 0 ? '' : (segments[segments.length - 1] ?? '');
}

/**
 * 聚合按设备分组的会话列表。
 * @param options - 存储、副本与在线判定。
 * @returns 设备与其会话，设备按最近活动倒序，会话按最近活动倒序。
 */
export function aggregateSessions(options: AggregateSessionsOptions): SessionsSnapshot {
  const { store, replica, online } = options;
  const nodes = store.listNodes();
  const summaries = replica.summaries();
  const groups = new Map<string, { deviceId: string; name: string; platform: string; lastSeenAt: number; sessions: SessionSummary[] }>();

  for (const node of nodes) {
    groups.set(node.id, {
      deviceId: node.id,
      name: node.name,
      platform: node.platform,
      lastSeenAt: node.lastSeenAt,
      sessions: [],
    });
  }

  for (const owned of store.listSessions()) {
    const summary = summaries.get(owned.sessionId);
    const group = groups.get(owned.deviceId) ?? {
      deviceId: owned.deviceId,
      name: owned.deviceId,
      platform: 'unknown',
      lastSeenAt: 0,
      sessions: [],
    };
    groups.set(owned.deviceId, group);
    group.sessions.push({
      sessionId: owned.sessionId,
      title: (summary?.title ?? cwdTail(owned.cwd)) || owned.sessionId,
      updatedAt: summary?.updatedAt ?? owned.createdAt,
      cwd: owned.cwd,
      workspaceName: cwdTail(owned.cwd) || owned.sessionId,
      kind: owned.kind,
    });
  }

  const devices = [...groups.values()].map((group) => ({
    deviceId: group.deviceId,
    name: group.name,
    platform: group.platform,
    online: online(group.deviceId),
    lastSeenAt: group.lastSeenAt,
    sessions: [...group.sessions].sort((left, right) => right.updatedAt - left.updatedAt),
  }));
  devices.sort((left, right) => right.lastSeenAt - left.lastSeenAt);

  return { devices };
}

/** 客户端列表只返回业务状态，内部日志序号留在存储层。 */
export interface ClientSessionSummary extends SessionSummary {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly online: boolean;
  readonly unreadMessages: number;
}

export interface ClientSessionPageQuery {
  readonly clientId: string;
  readonly deviceIds: readonly string[] | 'all';
  readonly deviceId?: string;
  readonly query: string;
  readonly limit: number;
  readonly after?: readonly [number, string];
}

interface ClientSessionRow {
  session_id: string;
  device_id: string;
  device_name: string;
  cwd: string;
  kind: 'work' | 'chat';
  title: string;
  updated_at: number;
  unread_messages: number;
}

const registeredDatabases = new WeakSet<DatabaseSync>();

/** 结果集在数据库内限制到一页加一条，设备范围在读取事件摘要前过滤。 */
export function createClientSessionQuery(database: DatabaseSync, online: (deviceId: string) => boolean) {
  if (!registeredDatabases.has(database)) {
    database.function('chatdsh_cwd_tail', { deterministic: true }, (value) => cwdTail(String(value)));
    database.function('chatdsh_casefold', { deterministic: true }, (value) => String(value).toLowerCase());
    database.function('chatdsh_identifier_digest', { deterministic: true }, (value) => createHash('sha256').update(String(value)).digest('hex'));
    registeredDatabases.add(database);
  }
  const anchor = database.prepare(`select s.session_id from sessions s where s.deleted_at is null
    and chatdsh_identifier_digest(s.session_id) = $digest
    and ($scope is null or s.device_id in (select value from json_each($scope)))
    and ($device is null or s.device_id = $device) limit 1`);
  const statement = database.prepare(`
    with summaries as materialized (
      select s.session_id, s.device_id, s.cwd, s.kind,
        coalesce(n.name, s.device_id) as device_name,
        coalesce((select json_extract(e.payload, '$.data.title') from replica_events e
          where e.session_id = s.session_id and e.kind = 'session/title'
            and json_type(e.payload, '$.data.title') = 'text'
            and json_extract(e.payload, '$.data.title') <> ''
          order by e.seq desc limit 1), nullif(chatdsh_cwd_tail(s.cwd), ''), s.session_id) as title,
        coalesce((select max(e.time) from replica_events e where e.session_id = s.session_id), s.created_at) as updated_at
      from sessions s left join node_devices n on n.id = s.device_id
      where s.deleted_at is null
        and ($scope is null or s.device_id in (select value from json_each($scope)))
        and ($device is null or s.device_id = $device)
    ), selected as materialized (
      select * from summaries
      where instr(chatdsh_casefold(title), $query) > 0
        and ($after_time is null or updated_at < $after_time
          or (updated_at = $after_time and session_id > $after_id collate binary))
      order by updated_at desc, session_id collate binary asc limit $count
    )
    select selected.*, (select count(*) from replica_events e
      where e.session_id = selected.session_id and e.kind = 'assistant/message'
        and e.seq > coalesce((select r.read_up_to_seq from read_receipts r
          where r.session_id = selected.session_id and r.device_id = $client), -1)) as unread_messages
    from selected order by updated_at desc, session_id collate binary asc
  `);
  const query = (input: ClientSessionPageQuery): { items: ClientSessionSummary[]; hasMore: boolean } => {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) throw new Error('每页条数需要在 1 到 200 之间');
    const rows = statement.all({
      $scope: input.deviceIds === 'all' ? null : JSON.stringify(input.deviceIds),
      $device: input.deviceId ?? null,
      $query: input.query.toLowerCase(),
      $after_time: input.after?.[0] ?? null,
      $after_id: input.after?.[1] ?? null,
      $count: input.limit + 1,
      $client: input.clientId,
    }) as unknown as ClientSessionRow[];
    return {
      hasMore: rows.length > input.limit,
      items: rows.slice(0, input.limit).map((row) => ({
        sessionId: row.session_id, deviceId: row.device_id, deviceName: row.device_name,
        cwd: row.cwd, workspaceName: cwdTail(row.cwd) || row.session_id, kind: row.kind,
        title: row.title, updatedAt: row.updated_at, unreadMessages: row.unread_messages,
        online: online(row.device_id),
      })),
    };
  };
  return Object.assign(query, {
    resolveAnchor(digest: string, deviceIds: readonly string[] | 'all', deviceId?: string): string | undefined {
      const row = anchor.get({ $digest: digest, $scope: deviceIds === 'all' ? null : JSON.stringify(deviceIds), $device: deviceId ?? null }) as { session_id: string } | undefined;
      return row?.session_id;
    },
  });
}
