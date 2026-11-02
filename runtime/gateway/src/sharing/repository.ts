/**
 * 分享记录、快照内容与分享包附件的存储。
 *
 * 快照内容在建立时写入并固定：消息文本、回合编号与附件副本各存一份，之后源会话继续写入
 * 不会改变已发布链接。表结构与控制平面其余表一致地使用 SQLite；建表语句在构造时执行，
 * 迁移登记由发行集成处理。
 * @module @chatdsh/gateway/sharing/repository
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ContentScope, ShareStatus } from '@chatdsh/core-contracts';
import type { ShareAttachmentRecord, ShareMessage } from './types.ts';

/** 一条已保存的分享。 */
export interface StoredShare {
  readonly token: string;
  readonly sessionId: string;
  readonly title: string;
  readonly scope: ContentScope;
  readonly turnNumbers: readonly number[];
  readonly fromTurn: number;
  readonly toTurn: number;
  /** 快照上界的事件序号，只用于诊断，不进入响应。 */
  readonly boundSeq: number;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
  readonly visits: number;
  /** 快照占用字节数：消息文本字节与附件字节之和。 */
  readonly bytes: number;
  readonly messageCount: number;
  readonly attachmentBytes: number;
  readonly operationId?: string;
  readonly requestDigest?: string;
}

/** 写入一条分享所需的全部内容。 */
export interface StoredShareInput {
  readonly share: Omit<StoredShare, 'visits' | 'revokedAt'>;
  readonly messages: readonly ShareMessage[];
  readonly attachments: readonly ShareAttachmentRecord[];
}

/** 数据库里的一行。 */
interface ShareRow {
  token: string;
  session_id: string;
  title: string;
  scope: string;
  turn_numbers: string;
  from_turn: number;
  to_turn: number;
  bound_seq: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  visits: number;
  bytes: number;
  message_count: number;
  attachment_bytes: number;
  operation_id: string | null;
  request_digest: string | null;
}

/** 消息的一行。 */
interface MessageRow {
  role: string;
  time: number;
  text: string;
}

/** 附件的一行。 */
interface AttachmentRow {
  attachment_id: string;
  filename: string;
  mime_type: string;
  size: number;
  digest: string;
  storage_key: string;
}

/** 把 JSON 列读成内容范围；内容不合法时就地抛出。 */
function scopeOf(raw: string): ContentScope {
  const parsed = JSON.parse(raw) as ContentScope;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('share_posts.scope 必须是对象');
  return parsed;
}

/** 把 JSON 列读成回合编号数组。 */
function turnsOf(raw: string): number[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'number')) {
    throw new Error('share_posts.turn_numbers 必须是数字数组');
  }
  return parsed;
}

/** 把一行转成分享记录。 */
function shareOf(row: ShareRow): StoredShare {
  return {
    token: row.token,
    sessionId: row.session_id,
    title: row.title,
    scope: scopeOf(row.scope),
    turnNumbers: turnsOf(row.turn_numbers),
    fromTurn: row.from_turn,
    toTurn: row.to_turn,
    boundSeq: row.bound_seq,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    visits: row.visits,
    bytes: row.bytes,
    messageCount: row.message_count,
    attachmentBytes: row.attachment_bytes,
    ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
    ...(row.request_digest === null ? {} : { requestDigest: row.request_digest }),
  };
}

/** 按时刻判定分享状态。 */
export function statusOf(share: StoredShare, now: number): ShareStatus {
  if (share.revokedAt !== undefined) return 'revoked';
  if (share.expiresAt !== undefined && share.expiresAt <= now) return 'expired';
  return 'active';
}

/** 分享存储。 */
export class ShareRepository {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      create table if not exists share_posts (
        token text primary key,
        session_id text not null,
        title text not null,
        scope text not null,
        turn_numbers text not null,
        from_turn integer not null,
        to_turn integer not null,
        bound_seq integer not null,
        created_at integer not null,
        expires_at integer,
        revoked_at integer,
        visits integer not null default 0,
        bytes integer not null,
        message_count integer not null,
        attachment_bytes integer not null,
        operation_id text,
        request_digest text
      );
      create unique index if not exists share_posts_operation on share_posts(operation_id) where operation_id is not null;
      create table if not exists share_messages (
        token text not null,
        ordinal integer not null,
        role text not null,
        time integer not null,
        text text not null,
        bytes integer not null,
        primary key (token, ordinal)
      );
      create table if not exists share_attachments (
        token text not null,
        attachment_id text not null,
        filename text not null,
        mime_type text not null,
        size integer not null,
        digest text not null,
        storage_key text not null,
        primary key (token, attachment_id)
      );
    `);
  }

  /** 在一个事务里写入分享、消息与附件。 */
  insert(input: StoredShareInput): void {
    const { share } = input;
    this.database.exec('begin');
    try {
      this.database
        .prepare(`insert into share_posts (token, session_id, title, scope, turn_numbers, from_turn, to_turn, bound_seq,
                   created_at, expires_at, revoked_at, visits, bytes, message_count, attachment_bytes, operation_id, request_digest)
                 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, ?, ?, ?, ?)`)
        .run(
          share.token,
          share.sessionId,
          share.title,
          JSON.stringify(share.scope),
          JSON.stringify(share.turnNumbers),
          share.fromTurn,
          share.toTurn,
          share.boundSeq,
          share.createdAt,
          share.expiresAt ?? null,
          share.bytes,
          share.messageCount,
          share.attachmentBytes,
          share.operationId ?? null,
          share.requestDigest ?? null,
        );
      const insertMessage = this.database.prepare(
        'insert into share_messages (token, ordinal, role, time, text, bytes) values (?, ?, ?, ?, ?, ?)',
      );
      input.messages.forEach((message, ordinal) => {
        insertMessage.run(share.token, ordinal, message.role, message.time, message.text, Buffer.byteLength(message.text, 'utf8'));
      });
      const insertAttachment = this.database.prepare(
        `insert into share_attachments (token, attachment_id, filename, mime_type, size, digest, storage_key)
         values (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const attachment of input.attachments) {
        insertAttachment.run(
          share.token,
          attachment.id,
          attachment.filename,
          attachment.mimeType,
          attachment.size,
          attachment.digest,
          attachment.storageKey,
        );
      }
      this.database.exec('commit');
    } catch (error) {
      this.database.exec('rollback');
      throw error;
    }
  }

  /** 按操作标识找分享。 */
  findByOperation(operationId: string): StoredShare | undefined {
    const row = this.database
      .prepare('select * from share_posts where operation_id = ?')
      .get(operationId) as ShareRow | undefined;
    return row === undefined ? undefined : shareOf(row);
  }

  /** 按令牌读分享。 */
  get(token: string): StoredShare | undefined {
    const row = this.database
      .prepare('select * from share_posts where token = ?')
      .get(token) as ShareRow | undefined;
    return row === undefined ? undefined : shareOf(row);
  }

  /** 列出全部分享，新建的在前。 */
  list(): StoredShare[] {
    const rows = this.database
      .prepare('select * from share_posts order by created_at desc, token asc')
      .all() as unknown as ShareRow[];
    return rows.map(shareOf);
  }

  /** 撤销一条分享；已经撤销时返回原撤销时刻。 */
  revoke(token: string, now: number): number | undefined {
    const share = this.get(token);
    if (share === undefined) return undefined;
    if (share.revokedAt !== undefined) return share.revokedAt;
    this.database
      .prepare('update share_posts set revoked_at = ? where token = ? and revoked_at is null')
      .run(now, token);
    return now;
  }

  /** 记一次公开访问。 */
  touch(token: string): void {
    this.database.prepare('update share_posts set visits = visits + 1 where token = ?').run(token);
  }

  /** 读快照里的消息，按写入顺序。 */
  messagesOf(token: string): ShareMessage[] {
    const rows = this.database
      .prepare('select role, time, text from share_messages where token = ? order by ordinal asc')
      .all(token) as unknown as MessageRow[];
    return rows.map((row) => {
      if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') {
        throw new Error(`share_messages.role 取值非法：${row.role}`);
      }
      return { role: row.role, time: row.time, text: row.text };
    });
  }

  /** 读分享包里的附件清单。 */
  attachmentsOf(token: string): ShareAttachmentRecord[] {
    const rows = this.database
      .prepare('select attachment_id, filename, mime_type, size, digest, storage_key from share_attachments where token = ? order by attachment_id asc')
      .all(token) as unknown as AttachmentRow[];
    return rows.map((row) => ({
      id: row.attachment_id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      digest: row.digest,
      storageKey: row.storage_key,
    }));
  }

  /** 读一份已授权附件。 */
  attachmentOf(token: string, attachmentId: string): ShareAttachmentRecord | undefined {
    return this.attachmentsOf(token).find((attachment) => attachment.id === attachmentId);
  }

  /** 全部分享占用的字节数。 */
  totalBytes(): number {
    const row = this.database
      .prepare('select coalesce(sum(bytes), 0) as total from share_posts')
      .get() as { total: number };
    return row.total;
  }
}
