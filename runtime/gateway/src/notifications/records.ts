/**
 * 通知记录、已读、订阅与验证通知的存储。
 *
 * 记录按设备与访问客户端分别保存：通知本身带设备标识，已读按访问客户端的标识逐条记录，
 * 同一通知被任一客户端读过之后所有客户端都看到已读，各设备的读取时刻仍然保留下来。
 * 业务已处理用另一列保存，审批决定写入这一列，与已读互不影响。
 *
 * 通知正文只保存业务标题与摘要，命令与消息原文另存一列，只有在预览级别才进入下发内容。
 * @module @chatdsh/gateway/notifications/records
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CHATDSH_ERROR_CODES,
  NOTIFICATION_PERMISSIONS,
  PUSH_SUBSCRIPTION_STATES,
  type NotificationFilter,
  type NotificationKind,
  type NotificationProbe,
  type NotificationSettings,
  type PushSubscriptionState,
} from '@chatdsh/core-contracts';
import type { VapidKeys } from './web-push.ts';

/** 通知内容的隐私级别。 */
export const NOTIFICATION_PRIVACY_LEVELS = ['type', 'summary', 'preview'] as const;

/** 通知内容的隐私级别取值。 */
export type NotificationPrivacyLevel = (typeof NOTIFICATION_PRIVACY_LEVELS)[number];

/** 系统通知权限的取值。 */
export type NotificationPermission = (typeof NOTIFICATION_PERMISSIONS)[number];

/** 默认生效的通知设置。 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings & { readonly privacy: NotificationPrivacyLevel } = {
  deliveryMode: 'two-stage',
  firstStageSeconds: 120,
  secondStageSeconds: 600,
  onTurnEnd: true,
  onApproval: true,
  messagePreview: false,
  quietWhenFocused: true,
  privacy: 'summary',
};

/** 存下来的通知设置。 */
export interface StoredNotificationSettings extends NotificationSettings {
  /** 内容隐私级别。 */
  readonly privacy: NotificationPrivacyLevel;
  /** 服务端版本号，每次成功写入后递增。 */
  readonly revision: number;
  /** 最近写入时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 写入一条通知的输入。 */
export interface NotificationInput {
  /** 通知种类。 */
  readonly kind: NotificationKind;
  /** 业务标题，取业务对象名称。 */
  readonly title: string;
  /** 摘要；不含命令与消息原文。 */
  readonly summary: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知的稳定 tag。 */
  readonly tag?: string;
  /** 是否可撤回；缺省按种类决定。 */
  readonly revocable?: boolean;
  /** 命令或消息原文，只在预览级别下发。 */
  readonly previewText?: string;
  /** 去重键，同键在抑制窗口内合并。 */
  readonly dedupeKey: string;
  /** 事件发生时刻的毫秒时间戳。 */
  readonly createdAt?: number;
}

/** 存储里的一行通知。 */
export interface NotificationRow {
  /** 通知标识。 */
  readonly id: string;
  /** 通知种类。 */
  readonly kind: NotificationKind;
  /** 业务标题。 */
  readonly title: string;
  /** 摘要。 */
  readonly summary: string;
  /** 命令或消息原文。 */
  readonly previewText?: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知的稳定 tag。 */
  readonly tag?: string;
  /** 去重键。 */
  readonly dedupeKey: string;
  /** 是否可撤回。 */
  readonly revocable: boolean;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 业务已处理时刻。 */
  readonly handledAt?: number;
  /** 撤回时刻。 */
  readonly revokedAt?: number;
}

/** 通知中心的一条对外记录。 */
export interface NotificationView {
  /** 通知标识。 */
  readonly id: string;
  /** 通知种类。 */
  readonly kind: NotificationKind;
  /** 业务标题。 */
  readonly title: string;
  /** 摘要。 */
  readonly summary: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知的稳定 tag。 */
  readonly tag?: string;
  /** 是否可撤回。 */
  readonly revocable: boolean;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 首次被读的时刻；没有任何客户端读过时缺省。 */
  readonly readAt?: number;
  /** 业务已处理时刻。 */
  readonly handledAt?: number;
  /** 读过这条通知的访问客户端标识。 */
  readonly readClients: readonly string[];
}

/** 通知中心的一次分页读取。 */
export interface NotificationPage {
  /** 当前页的记录，按时间倒序。 */
  readonly items: readonly NotificationView[];
  /** 下一页游标；没有更多时缺省。 */
  readonly nextCursor?: string;
  /** 当前过滤条件下的未读条数。 */
  readonly unread: number;
  /** 当前过滤条件下的已处理条数。 */
  readonly handled: number;
}

/** 分页查询。 */
export interface NotificationQuery {
  /** 过滤条件。 */
  readonly filter: NotificationFilter;
  /** 每页条数。 */
  readonly limit: number;
  /** 上一页返回的游标。 */
  readonly cursor?: string;
  /** 只看某台设备的记录。 */
  readonly deviceId?: string;
  /** 只看某个会话的记录。 */
  readonly sessionId?: string;
  /** 时间下限的毫秒时间戳，闭区间。 */
  readonly since?: number;
  /** 时间上限的毫秒时间戳，闭区间。 */
  readonly until?: number;
}

/** 已读标记的结果。 */
export interface ReadResult {
  /** 本次新标记的条数。 */
  readonly marked: number;
  /** 已经处于已读状态的条数。 */
  readonly unchanged: number;
}

/** 一条推送订阅的完整记录，含密钥材料。 */
export interface SubscriptionRecord {
  /** 订阅标识。 */
  readonly id: string;
  /** 订阅所在设备。 */
  readonly deviceId: string;
  /** 订阅所属访问客户端。 */
  readonly clientId: string;
  /** 推送服务端点。 */
  readonly endpoint: string;
  /** 订阅公钥。 */
  readonly p256dh: string;
  /** 订阅认证密钥。 */
  readonly auth: string;
  /** 订阅状态。 */
  readonly state: PushSubscriptionState;
  /** 系统通知权限。 */
  readonly permission: NotificationPermission;
  /** 失效或失败时的错误码。 */
  readonly code?: string;
  /** 建立时刻。 */
  readonly createdAt: number;
  /** 最近更新时刻。 */
  readonly updatedAt: number;
}

/** 保存订阅的输入。 */
export interface SubscriptionInput {
  /** 订阅所在设备。 */
  readonly deviceId: string;
  /** 订阅所属访问客户端。 */
  readonly clientId: string;
  /** 推送服务端点。 */
  readonly endpoint: string;
  /** 订阅公钥。 */
  readonly p256dh: string;
  /** 订阅认证密钥。 */
  readonly auth: string;
  /** 系统通知权限。 */
  readonly permission: NotificationPermission;
}

/** 一条待投递的批次。 */
export interface DeliveryBatch {
  /** 批次所属范围：会话标识或全局。 */
  readonly scope: string;
  /** 阶段：1 为第一阶段，2 为第二阶段。 */
  readonly stage: number;
  /** 到期时刻的毫秒时间戳。 */
  readonly dueAt: number;
  /** 批次里的通知标识。 */
  readonly notificationIds: readonly string[];
}

/** 存储里的一行订阅。 */
type SubscriptionRow = {
  id: string;
  device_id: string;
  client_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  state: string;
  permission: string;
  code: string | null;
  created_at: number;
  updated_at: number;
};

/** 存储里的一行通知。 */
type NotificationDbRow = {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  preview_text: string | null;
  device_id: string | null;
  session_id: string | null;
  object_id: string | null;
  tag: string | null;
  dedupe_key: string;
  revocable: number;
  created_at: number;
  handled_at: number | null;
  revoked_at: number | null;
};

/** 游标无法解码时抛出，路由据此回 400 与 `cursor-invalid`。 */
export class CursorError extends Error {
  /** 错误码。 */
  readonly code = CHATDSH_ERROR_CODES.cursorInvalid;

  constructor(message: string) {
    super(message);
    this.name = 'CursorError';
  }
}

/** 把通知种类判定为可撤回的默认取值。 */
function revocableOf(kind: NotificationKind): boolean {
  return kind === 'approval' || kind === 'question' || kind === 'system';
}

/** 取一个非空字符串列。 */
function optionalOf(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

/** 把一行通知转成存储记录。 */
function rowOf(row: NotificationDbRow): NotificationRow {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    title: row.title,
    summary: row.summary ?? '',
    previewText: optionalOf(row.preview_text),
    deviceId: optionalOf(row.device_id),
    sessionId: optionalOf(row.session_id),
    objectId: optionalOf(row.object_id),
    tag: optionalOf(row.tag),
    dedupeKey: row.dedupe_key,
    revocable: row.revocable === 1,
    createdAt: row.created_at,
    handledAt: row.handled_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

/** 编码分页游标。 */
export function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

/**
 * 解码分页游标。
 * @param cursor - 客户端带回的游标。
 * @returns 时间戳与标识。
 */
export function decodeCursor(cursor: string): { createdAt: number; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('游标不是合法的 base64url 编码');
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new CursorError('游标结构不合法');
  const [createdAt, id] = parsed as [unknown, unknown];
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt) || createdAt < 0) {
    throw new CursorError('游标里的时间戳不合法');
  }
  if (typeof id !== 'string' || id === '') throw new CursorError('游标里的标识不合法');
  return { createdAt, id };
}

/**
 * 通知记录的存储。
 *
 * 表在构造时建立一次，内容按设备与访问客户端区分。所有查询都返回真实读到的行，不做
 * 兜底填充：查不到就是查不到。
 */
export class NotificationStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      create table if not exists notifications (
        id text primary key,
        kind text not null,
        title text not null,
        summary text,
        preview_text text,
        device_id text,
        session_id text,
        object_id text,
        tag text,
        dedupe_key text not null,
        revocable integer not null,
        created_at integer not null,
        handled_at integer,
        revoked_at integer
      );
      create index if not exists notifications_by_created on notifications(created_at desc, id desc);
      create index if not exists notifications_by_dedupe on notifications(dedupe_key, created_at desc);
      create table if not exists notification_reads (
        notification_id text not null,
        client_id text not null,
        device_id text,
        read_at integer not null,
        primary key (notification_id, client_id)
      );
      create table if not exists notification_deliveries (
        notification_id text not null,
        device_id text not null,
        stage integer not null,
        delivered_at integer not null,
        primary key (notification_id, device_id)
      );
      create table if not exists notification_batches (
        scope text primary key,
        stage integer not null,
        due_at integer not null,
        created_at integer not null
      );
      create table if not exists notification_batch_items (
        scope text not null,
        notification_id text not null,
        primary key (scope, notification_id)
      );
      create table if not exists notification_settings (
        id text primary key,
        delivery_mode text not null,
        first_stage_seconds integer not null,
        second_stage_seconds integer not null,
        on_turn_end integer not null,
        on_approval integer not null,
        message_preview integer not null,
        quiet_when_focused integer not null,
        privacy text not null,
        revision integer not null,
        updated_at integer not null
      );
      create table if not exists push_subscriptions (
        id text primary key,
        device_id text not null,
        client_id text not null,
        endpoint text not null,
        p256dh text not null,
        auth text not null,
        state text not null,
        permission text not null,
        code text,
        created_at integer not null,
        updated_at integer not null
      );
      create unique index if not exists push_subscriptions_by_endpoint on push_subscriptions(endpoint);
      create index if not exists push_subscriptions_by_device on push_subscriptions(device_id, state);
      create table if not exists push_vapid (
        id text primary key,
        subject text not null,
        public_key text not null,
        private_key text not null,
        created_at integer not null
      );
      create table if not exists notification_probes (
        id text primary key,
        subscription_id text not null,
        tag text not null,
        accepted_at integer,
        received_at integer,
        result text not null,
        code text,
        created_at integer not null
      );
      create table if not exists notification_focus (
        client_id text primary key,
        device_id text not null,
        session_id text,
        focused_at integer not null
      );
    `);
  }

  /** 写一条通知记录。 */
  record(input: NotificationInput): NotificationRow {
    const id = randomBytes(12).toString('hex');
    const createdAt = input.createdAt ?? Date.now();
    const revocable = input.revocable ?? revocableOf(input.kind);
    this.database
      .prepare(`insert into notifications
        (id, kind, title, summary, preview_text, device_id, session_id, object_id, tag, dedupe_key, revocable, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.kind,
        input.title,
        input.summary,
        input.previewText ?? null,
        input.deviceId ?? null,
        input.sessionId ?? null,
        input.objectId ?? null,
        input.tag ?? null,
        input.dedupeKey,
        revocable ? 1 : 0,
        createdAt,
      );
    const row = this.database.prepare('select * from notifications where id = ?').get(id) as unknown as NotificationDbRow;
    return rowOf(row);
  }

  /** 按标识读一条记录。 */
  byId(id: string): NotificationRow | undefined {
    const row = this.database.prepare('select * from notifications where id = ?').get(id) as unknown as NotificationDbRow | undefined;
    return row === undefined ? undefined : rowOf(row);
  }

  /** 读去重窗口内同键的最近一条记录。 */
  latestByDedupe(dedupeKey: string, since: number): NotificationRow | undefined {
    const row = this.database
      .prepare('select * from notifications where dedupe_key = ? and created_at >= ? order by created_at desc, id desc limit 1')
      .get(dedupeKey, since) as unknown as NotificationDbRow | undefined;
    return row === undefined ? undefined : rowOf(row);
  }

  /** 分页读通知，按时间倒序。 */
  list(query: NotificationQuery): NotificationPage {
    const where: string[] = ['revoked_at is null'];
    const params: (string | number)[] = [];
    if (query.filter === 'approval') where.push("kind = 'approval'");
    if (query.filter === 'run-result') where.push("kind in ('run-finished', 'run-failed')");
    if (query.filter === 'unread') where.push('not exists (select 1 from notification_reads r where r.notification_id = notifications.id)');
    if (query.deviceId !== undefined) {
      where.push('device_id = ?');
      params.push(query.deviceId);
    }
    if (query.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    if (query.since !== undefined) {
      where.push('created_at >= ?');
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push('created_at <= ?');
      params.push(query.until);
    }
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      where.push('(created_at < ? or (created_at = ? and id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.database
      .prepare(`select * from notifications where ${where.join(' and ')}
                order by created_at desc, id desc limit ?`)
      .all(...params, query.limit + 1) as unknown as NotificationDbRow[];
    const page = rows.slice(0, query.limit);
    const items = page.map((row) => this.viewOf(rowOf(row)));
    const last = items[items.length - 1];
    return {
      items,
      ...(rows.length > query.limit && last !== undefined ? { nextCursor: encodeCursor(last.createdAt, last.id) } : {}),
      unread: this.countUnread(query),
      handled: this.countHandled(query),
    };
  }

  /** 未读条数。 */
  countUnread(query: Pick<NotificationQuery, 'deviceId' | 'sessionId'>): number {
    const where = ['revoked_at is null', 'not exists (select 1 from notification_reads r where r.notification_id = notifications.id)'];
    const params: string[] = [];
    if (query.deviceId !== undefined) {
      where.push('device_id = ?');
      params.push(query.deviceId);
    }
    if (query.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    const row = this.database
      .prepare(`select count(*) as total from notifications where ${where.join(' and ')}`)
      .get(...params) as unknown as { total: number };
    return row.total;
  }

  /** 已处理条数。 */
  countHandled(query: Pick<NotificationQuery, 'deviceId' | 'sessionId'>): number {
    const where = ['revoked_at is null', 'handled_at is not null'];
    const params: string[] = [];
    if (query.deviceId !== undefined) {
      where.push('device_id = ?');
      params.push(query.deviceId);
    }
    if (query.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    const row = this.database
      .prepare(`select count(*) as total from notifications where ${where.join(' and ')}`)
      .get(...params) as unknown as { total: number };
    return row.total;
  }

  /**
   * 标记已读。
   *
   * 同一访问客户端重复标记按幂等处理：已有记录计入 `unchanged`，新写入的计入 `marked`。
   * 通知标识不存在时不写入，也不影响其他标识。
   * @param ids - 要标记的通知标识。
   * @param clientId - 访问客户端标识。
   * @param deviceId - 访问客户端所在设备。
   * @param now - 标记时刻。
   * @returns 新标记与未变化的条数。
   */
  markRead(ids: readonly string[], clientId: string, deviceId: string | undefined, now: number): ReadResult {
    const exists = this.database.prepare('select 1 as hit from notification_reads where notification_id = ? and client_id = ?');
    const known = this.database.prepare('select 1 as hit from notifications where id = ? and revoked_at is null');
    const insert = this.database.prepare(
      'insert into notification_reads (notification_id, client_id, device_id, read_at) values (?, ?, ?, ?)',
    );
    let marked = 0;
    let unchanged = 0;
    for (const id of ids) {
      if (known.get(id) === undefined) continue;
      if (exists.get(id, clientId) !== undefined) {
        unchanged += 1;
        continue;
      }
      insert.run(id, clientId, deviceId ?? null, now);
      marked += 1;
    }
    return { marked, unchanged };
  }

  /** 标记业务已处理，返回实际写入的条数。 */
  markHandled(ids: readonly string[], now: number): number {
    const statement = this.database.prepare('update notifications set handled_at = ? where id = ? and revoked_at is null and handled_at is null');
    let changed = 0;
    for (const id of ids) changed += Number(statement.run(now, id).changes);
    return changed;
  }

  /** 读一条通知的已读访问客户端。 */
  readClientsOf(id: string): { clientId: string; deviceId?: string; readAt: number }[] {
    const rows = this.database
      .prepare('select client_id, device_id, read_at from notification_reads where notification_id = ? order by read_at asc')
      .all(id) as unknown as { client_id: string; device_id: string | null; read_at: number }[];
    return rows.map((row) => ({
      clientId: row.client_id,
      ...(row.device_id === null ? {} : { deviceId: row.device_id }),
      readAt: row.read_at,
    }));
  }

  /**
   * 撤回同一审批关联键的可撤回通知，并把这些通知记为业务已处理。
   *
   * 审批决定之后，同键的待投递通知不再投递，已展示的系统通知按 tag 关闭。
   * @param options - 会话标识、工具调用标识与当前时刻。
   * @returns 被撤回的通知标识与它们的 tag。
   */
  withdrawApproval(options: { sessionId: string; callId: string; now: number }): { ids: string[]; tags: string[] } {
    const rows = this.database
      .prepare(`select id, tag from notifications
                where revoked_at is null and revocable = 1 and session_id = ? and (object_id = ? or tag = ?)`)
      .all(options.sessionId, options.callId, `approval-${options.callId}`) as unknown as { id: string; tag: string | null }[];
    if (rows.length === 0) return { ids: [], tags: [] };
    const revoke = this.database.prepare('update notifications set revoked_at = ?, handled_at = coalesce(handled_at, ?) where id = ?');
    const dropItems = this.database.prepare('delete from notification_batch_items where notification_id = ?');
    const dropDeliveries = this.database.prepare('delete from notification_deliveries where notification_id = ?');
    for (const row of rows) {
      revoke.run(options.now, options.now, row.id);
      dropItems.run(row.id);
      dropDeliveries.run(row.id);
    }
    return {
      ids: rows.map((row) => row.id),
      tags: rows.map((row) => row.tag).filter((tag): tag is string => tag !== null),
    };
  }

  /** 读生效中的通知设置。 */
  settings(): StoredNotificationSettings {
    const row = this.database
      .prepare('select * from notification_settings where id = ?')
      .get('default') as unknown as {
      delivery_mode: string;
      first_stage_seconds: number;
      second_stage_seconds: number;
      on_turn_end: number;
      on_approval: number;
      message_preview: number;
      quiet_when_focused: number;
      privacy: string;
      revision: number;
      updated_at: number;
    } | undefined;
    if (row === undefined) return { ...DEFAULT_NOTIFICATION_SETTINGS, revision: 0, updatedAt: 0 };
    return {
      deliveryMode: row.delivery_mode as NotificationSettings['deliveryMode'],
      firstStageSeconds: row.first_stage_seconds,
      secondStageSeconds: row.second_stage_seconds,
      onTurnEnd: row.on_turn_end === 1,
      onApproval: row.on_approval === 1,
      messagePreview: row.message_preview === 1,
      quietWhenFocused: row.quiet_when_focused === 1,
      privacy: row.privacy as NotificationPrivacyLevel,
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 写入通知设置。
   *
   * `revision` 用于拒绝过期写入：调用方传入当前读到的版本号，服务端只接受与存储一致的版本。
   * @param settings - 已经校验过的设置。
   * @param revision - 调用方读到的版本号。
   * @param now - 写入时刻。
   * @returns 写入之后的设置。
   */
  saveSettings(settings: NotificationSettings & { readonly privacy: NotificationPrivacyLevel }, revision: number, now: number): StoredNotificationSettings {
    const current = this.settings();
    if (revision !== current.revision) throw new SettingsConflictError(current);
    const next = current.revision + 1;
    this.database
      .prepare(`insert into notification_settings
        (id, delivery_mode, first_stage_seconds, second_stage_seconds, on_turn_end, on_approval, message_preview, quiet_when_focused, privacy, revision, updated_at)
        values ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          delivery_mode = excluded.delivery_mode,
          first_stage_seconds = excluded.first_stage_seconds,
          second_stage_seconds = excluded.second_stage_seconds,
          on_turn_end = excluded.on_turn_end,
          on_approval = excluded.on_approval,
          message_preview = excluded.message_preview,
          quiet_when_focused = excluded.quiet_when_focused,
          privacy = excluded.privacy,
          revision = excluded.revision,
          updated_at = excluded.updated_at`)
      .run(
        settings.deliveryMode,
        settings.firstStageSeconds,
        settings.secondStageSeconds,
        settings.onTurnEnd ? 1 : 0,
        settings.onApproval ? 1 : 0,
        settings.messagePreview ? 1 : 0,
        settings.quietWhenFocused ? 1 : 0,
        settings.privacy,
        next,
        now,
      );
    return this.settings();
  }

  /** 保存或更新一条推送订阅。 */
  upsertSubscription(input: SubscriptionInput, now: number): SubscriptionRecord {
    const existing = this.database
      .prepare('select * from push_subscriptions where endpoint = ?')
      .get(input.endpoint) as unknown as SubscriptionRow | undefined;
    if (existing === undefined) {
      const id = randomBytes(12).toString('hex');
      this.database
        .prepare(`insert into push_subscriptions
          (id, device_id, client_id, endpoint, p256dh, auth, state, permission, code, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, 'subscribed', ?, null, ?, ?)`)
        .run(id, input.deviceId, input.clientId, input.endpoint, input.p256dh, input.auth, input.permission, now, now);
      return this.subscriptionById(id);
    }
    this.database
      .prepare(`update push_subscriptions set device_id = ?, client_id = ?, p256dh = ?, auth = ?, state = 'subscribed',
                permission = ?, code = null, updated_at = ? where id = ?`)
      .run(input.deviceId, input.clientId, input.p256dh, input.auth, input.permission, now, existing.id);
    return this.subscriptionById(existing.id);
  }

  /** 按标识读一条订阅。 */
  subscriptionById(id: string): SubscriptionRecord {
    const row = this.database.prepare('select * from push_subscriptions where id = ?').get(id) as unknown as SubscriptionRow | undefined;
    if (row === undefined) throw new Error(`推送订阅不存在：${id}`);
    return this.subscriptionOf(row);
  }

  /** 读订阅；同一设备可以有多条。 */
  subscriptions(deviceId?: string): SubscriptionRecord[] {
    const rows = deviceId === undefined
      ? this.database.prepare('select * from push_subscriptions order by updated_at desc').all()
      : this.database.prepare('select * from push_subscriptions where device_id = ? order by updated_at desc').all(deviceId);
    return (rows as unknown as SubscriptionRow[]).map((row) => this.subscriptionOf(row));
  }

  /** 读当前生效的订阅。 */
  activeSubscriptions(deviceId?: string): SubscriptionRecord[] {
    return this.subscriptions(deviceId).filter((record) => record.state === 'subscribed');
  }

  /** 更新订阅状态。 */
  setSubscriptionState(id: string, state: PushSubscriptionState, code: string | undefined, now: number): SubscriptionRecord {
    this.database
      .prepare('update push_subscriptions set state = ?, code = ?, updated_at = ? where id = ?')
      .run(state, code ?? null, now, id);
    return this.subscriptionById(id);
  }

  /** 退订一台设备上的全部订阅。 */
  unsubscribe(deviceId: string, now: number): number {
    const result = this.database
      .prepare("update push_subscriptions set state = 'unsubscribed', updated_at = ? where device_id = ? and state = 'subscribed'")
      .run(now, deviceId);
    return Number(result.changes);
  }

  /**
   * 清理过期订阅。
   *
   * 两件事：超过保留期没有更新的订阅标记为过期；推送服务已经明确失效的订阅删除，避免
   * 每次投递都重试同一个死端点。
   * @param now - 当前时刻。
   * @param maxAgeMs - 订阅保留期。
   * @returns 标记过期的条数与删除的条数。
   */
  pruneSubscriptions(now: number, maxAgeMs: number): { expired: number; removed: number } {
    const expired = this.database
      .prepare("update push_subscriptions set state = 'expired', code = ? where state = 'subscribed' and updated_at < ?")
      .run(CHATDSH_ERROR_CODES.expired, now - maxAgeMs);
    const removed = this.database
      .prepare("delete from push_subscriptions where state in ('gone', 'unsubscribed')")
      .run();
    return { expired: Number(expired.changes), removed: Number(removed.changes) };
  }

  /** 读 VAPID 密钥；没有时生成并保存一对真实密钥。 */
  vapidKeys(): VapidKeys {
    const envSubject = process.env.CHATDSH_VAPID_SUBJECT;
    const envPublic = process.env.CHATDSH_VAPID_PUBLIC_KEY;
    const envPrivate = process.env.CHATDSH_VAPID_PRIVATE_KEY;
    const subject = envSubject === undefined || envSubject === '' ? 'mailto:chatdsh@localhost' : envSubject;
    if (envPublic !== undefined && envPublic !== '' && envPrivate !== undefined && envPrivate !== '') {
      return { subject, publicKey: envPublic, privateKey: envPrivate };
    }
    const row = this.database.prepare('select subject, public_key, private_key from push_vapid where id = ?').get('default') as unknown as
      { subject: string; public_key: string; private_key: string } | undefined;
    if (row !== undefined) return { subject: row.subject, publicKey: row.public_key, privateKey: row.private_key };
    const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = generated.privateKey.export({ format: 'jwk' });
    if (jwk.x === undefined || jwk.y === undefined || jwk.d === undefined) {
      throw new Error('生成的 VAPID 私钥缺少坐标或标量');
    }
    const publicKey = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]).toString('base64url');
    this.database
      .prepare('insert into push_vapid (id, subject, public_key, private_key, created_at) values (?, ?, ?, ?, ?)')
      .run('default', subject, publicKey, jwk.d, Date.now());
    return { subject, publicKey, privateKey: jwk.d };
  }

  /** 登记一次验证通知。 */
  createProbe(subscriptionId: string, tag: string, now: number): string {
    const id = randomBytes(16).toString('base64url');
    this.database
      .prepare('insert into notification_probes (id, subscription_id, tag, accepted_at, received_at, result, code, created_at) values (?, ?, ?, null, null, ?, null, ?)')
      .run(id, subscriptionId, tag, 'failed', now);
    return id;
  }

  /** 记录验证通知的服务端受理结果。 */
  acceptProbe(id: string, result: 'accepted' | 'failed', code: string | undefined, now: number): void {
    this.database
      .prepare('update notification_probes set accepted_at = ?, result = ?, code = ? where id = ?')
      .run(now, result, code ?? null, id);
  }

  /** 记录验证通知的客户端实际接收时刻。 */
  receiveProbe(id: string, now: number): NotificationProbe {
    const row = this.database.prepare('select * from notification_probes where id = ?').get(id) as unknown as {
      accepted_at: number | null;
      received_at: number | null;
      result: string;
      code: string | null;
    } | undefined;
    if (row === undefined) throw new Error(`验证通知不存在：${id}`);
    if (row.accepted_at === null) throw new Error(`验证通知还没有服务端受理结果：${id}`);
    this.database
      .prepare("update notification_probes set received_at = ?, result = 'delivered' where id = ?")
      .run(now, id);
    return {
      acceptedAt: row.accepted_at,
      receivedAt: now,
      result: 'delivered',
      ...(row.code === null ? {} : { code: row.code as NotificationProbe['code'] }),
    };
  }

  /** 读一次验证通知的当前结果。 */
  probe(id: string): NotificationProbe {
    const row = this.database.prepare('select * from notification_probes where id = ?').get(id) as unknown as {
      accepted_at: number | null;
      received_at: number | null;
      result: string;
      code: string | null;
    } | undefined;
    if (row === undefined) throw new Error(`验证通知不存在：${id}`);
    return {
      ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
      ...(row.received_at === null ? {} : { receivedAt: row.received_at }),
      result: row.result as NotificationProbe['result'],
      ...(row.code === null ? {} : { code: row.code as NotificationProbe['code'] }),
    };
  }

  /** 记下一个访问客户端当前聚焦的会话；传空串表示离开。 */
  setFocus(clientId: string, deviceId: string, sessionId: string, now: number): void {
    if (sessionId === '') {
      this.database.prepare('delete from notification_focus where client_id = ?').run(clientId);
      return;
    }
    this.database
      .prepare(`insert into notification_focus (client_id, device_id, session_id, focused_at) values (?, ?, ?, ?)
                on conflict(client_id) do update set device_id = excluded.device_id, session_id = excluded.session_id, focused_at = excluded.focused_at`)
      .run(clientId, deviceId, sessionId, now);
  }

  /** 判断某会话在某设备上是否正被聚焦。 */
  focused(deviceId: string, sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false;
    const row = this.database
      .prepare('select 1 as hit from notification_focus where device_id = ? and session_id = ? limit 1')
      .get(deviceId, sessionId);
    return row !== undefined;
  }

  /** 把一个批次里的通知挂到范围内，返回批次阶段变化之后的待投递批次。 */
  attachToBatch(scope: string, notificationId: string, dueAt: number, now: number): void {
    this.database
      .prepare(`insert into notification_batches (scope, stage, due_at, created_at) values (?, 1, ?, ?)
                on conflict(scope) do nothing`)
      .run(scope, dueAt, now);
    this.database
      .prepare('insert into notification_batch_items (scope, notification_id) values (?, ?) on conflict(scope, notification_id) do nothing')
      .run(scope, notificationId);
  }

  /** 读到期的批次，按到期时刻升序。 */
  dueBatches(now: number, limit = 32): DeliveryBatch[] {
    const rows = this.database
      .prepare('select scope, stage, due_at from notification_batches where due_at <= ? order by due_at asc limit ?')
      .all(now, limit) as unknown as { scope: string; stage: number; due_at: number }[];
    return rows.map((row) => {
      const items = this.database
        .prepare('select notification_id from notification_batch_items where scope = ?')
        .all(row.scope) as unknown as { notification_id: string }[];
      return {
        scope: row.scope,
        stage: row.stage,
        dueAt: row.due_at,
        notificationIds: items.map((item) => item.notification_id),
      };
    });
  }

  /** 把批次的阶段与到期时刻改为下一阶段。 */
  advanceBatch(scope: string, stage: number, dueAt: number): void {
    this.database.prepare('update notification_batches set stage = ?, due_at = ? where scope = ?').run(stage, dueAt, scope);
  }

  /** 结束一个批次：批次行与挂载关系一起清掉。 */
  closeBatch(scope: string): void {
    this.database.prepare('delete from notification_batch_items where scope = ?').run(scope);
    this.database.prepare('delete from notification_batches where scope = ?').run(scope);
  }

  /** 判断一条通知是否还需要投递：未撤回、未处理、未被任何客户端读过。 */
  pendingDelivery(id: string): boolean {
    const row = this.database
      .prepare(`select 1 as hit from notifications n where n.id = ? and n.revoked_at is null and n.handled_at is null
                and not exists (select 1 from notification_reads r where r.notification_id = n.id)`)
      .get(id);
    return row !== undefined;
  }

  /** 读一条通知已经投递过的设备。 */
  deliveredDevices(id: string): string[] {
    const rows = this.database
      .prepare('select device_id from notification_deliveries where notification_id = ?')
      .all(id) as unknown as { device_id: string }[];
    return rows.map((row) => row.device_id);
  }

  /** 记下一次投递。 */
  markDelivered(id: string, deviceId: string, stage: number, now: number): void {
    this.database
      .prepare('insert into notification_deliveries (notification_id, device_id, stage, delivered_at) values (?, ?, ?, ?) on conflict(notification_id, device_id) do nothing')
      .run(id, deviceId, stage, now);
  }

  /** 内部：把一行通知转成对外视图。 */
  private viewOf(row: NotificationRow): NotificationView {
    const reads = this.readClientsOf(row.id);
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      ...(row.deviceId === undefined ? {} : { deviceId: row.deviceId }),
      ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
      ...(row.objectId === undefined ? {} : { objectId: row.objectId }),
      ...(row.tag === undefined ? {} : { tag: row.tag }),
      revocable: row.revocable,
      createdAt: row.createdAt,
      ...(reads.length === 0 ? {} : { readAt: reads[0]?.readAt }),
      ...(row.handledAt === undefined ? {} : { handledAt: row.handledAt }),
      readClients: reads.map((read) => read.clientId),
    };
  }

  /** 内部：把一行订阅转成记录。 */
  private subscriptionOf(row: SubscriptionRow): SubscriptionRecord {
    if (!PUSH_SUBSCRIPTION_STATES.includes(row.state as PushSubscriptionState)) {
      throw new Error(`push_subscriptions.state 取值非法：${row.state}`);
    }
    if (!NOTIFICATION_PERMISSIONS.includes(row.permission as NotificationPermission)) {
      throw new Error(`push_subscriptions.permission 取值非法：${row.permission}`);
    }
    return {
      id: row.id,
      deviceId: row.device_id,
      clientId: row.client_id,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
      state: row.state as PushSubscriptionState,
      permission: row.permission as NotificationPermission,
      ...(row.code === null ? {} : { code: row.code }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/** 设置写入携带的版本号落后于服务端时抛出。 */
export class SettingsConflictError extends Error {
  /** 错误码。 */
  readonly code = CHATDSH_ERROR_CODES.revisionConflict;

  constructor(readonly current: StoredNotificationSettings) {
    super(`设置版本落后：当前 ${current.revision}`);
    this.name = 'SettingsConflictError';
  }
}
