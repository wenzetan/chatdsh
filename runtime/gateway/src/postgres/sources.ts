/**
 * 会话日志源：把会话持久化接缝读成可导入的形状。
 *
 * 只依赖接缝的 `list` 与 `open(id, 'read')`，因此 JSONL 后端与 Postgres 后端都能作为源；
 * 读句柄在读完之后立刻关闭，源文件保持只读，工具与附件正文不进入数据库。
 * @module @chatdsh/gateway/postgres/sources
 */

import type { ImportedEvent, ImportedSession } from './import.ts';
import { POSTGRES_STORAGE_ERROR_CODES, PostgresStorageError } from './errors.ts';

/** 会话头的形状。 */
interface HeaderLike {
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly isSeeded: boolean;
}

/** 读句柄的形状。 */
export interface ReadHandleLike {
  readonly header: HeaderLike;
  readonly inheritedEventCount: number;
  read(offset?: number, length?: number): Promise<{ readonly events: readonly Record<string, unknown>[] }>;
  close(): Promise<void>;
}

/** 会话持久化接缝的形状。 */
export interface PersistenceLike {
  list(): Promise<readonly { readonly header: HeaderLike }[]>;
  open(id: string, access: 'read'): Promise<ReadHandleLike>;
}

/** 把一条存储事件折成导入事件。 */
function eventOf(payload: Record<string, unknown>, index: number): ImportedEvent {
  const seq = payload.seq;
  const type = payload.type;
  const time = payload.time;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new PostgresStorageError(
      POSTGRES_STORAGE_ERROR_CODES.sourceInvalid,
      `会话日志里存在非法的事件序号：${String(seq)}`,
      { seq: index },
    );
  }
  if (typeof type !== 'string' || type === '') {
    throw new PostgresStorageError(POSTGRES_STORAGE_ERROR_CODES.sourceInvalid, '会话日志里存在没有种类的事件', {
      seq,
    });
  }
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0) {
    throw new PostgresStorageError(POSTGRES_STORAGE_ERROR_CODES.sourceInvalid, `会话日志的事件时刻非法：${String(time)}`, {
      seq,
    });
  }
  return { seq, type, time, payload };
}

/**
 * 读出一个接缝实例里的全部会话。
 *
 * @param persistence - 会话持久化接缝实例。
 * @returns 按标识升序的会话，含完整事件。
 */
export async function readSessionsFromPersistence(persistence: PersistenceLike): Promise<readonly ImportedSession[]> {
  const snapshots = await persistence.list();
  const ids = snapshots.map((snapshot) => snapshot.header.id).sort();
  const sessions: ImportedSession[] = [];
  for (const id of ids) {
    const handle = await persistence.open(id, 'read');
    try {
      const { events } = await handle.read(0, Number.MAX_SAFE_INTEGER);
      sessions.push({
        id,
        createdAt: handle.header.createdAt,
        ...(handle.header.cwd === undefined ? {} : { cwd: handle.header.cwd }),
        ...(handle.header.parentSession === undefined ? {} : { parentSession: handle.header.parentSession }),
        isSeeded: handle.header.isSeeded,
        inheritedEventCount: handle.inheritedEventCount,
        events: events.map((event, index) => eventOf(event, index)),
      });
    } finally {
      await handle.close();
    }
  }
  return sessions;
}
