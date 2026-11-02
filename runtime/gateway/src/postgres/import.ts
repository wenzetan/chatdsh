/**
 * JSONL 与 SQLite 数据导入 Postgres。
 *
 * 复制按 SYS01 的检查点分段：每批写完把位置与已确认条数写进 `migration_checkpoints`，中断
 * 后从检查点继续，摘要与任务记录不一致就拒绝续传。源保持只读：会话日志经只读句柄读出，
 * SQLite 源以只读方式打开；附件只保留引用，不写入任何表。
 *
 * 每批写入后用同一套摘要函数回读目标再比对，全部批次结束后再比对全日志、检索索引与用量
 * 三类摘要，任何不一致都拒绝宣布导入完成。
 * @module @chatdsh/gateway/postgres/import
 */

import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../storage/sqlite.ts';
import { MigrationJobStore } from '../storage/migration-job.ts';
import { STORAGE_ERROR_CODES, StorageError } from '../storage/errors.ts';
import type { UsageRecord } from './control-plane.ts';
import {
  indexDigest,
  logDigest,
  usageDigest,
  type DigestUsage,
  type MigrationDigests,
} from './digest.ts';
import { POSTGRES_STORAGE_ERROR_CODES, PostgresStorageError } from './errors.ts';
import type { SearchDocument } from './search.ts';
import { NO_POSTGRES_TELEMETRY, POSTGRES_SIGNALS, errorAttributes, type PostgresTelemetry } from './telemetry.ts';
import { ensurePostgresMigrationTables } from './migration-tables.ts';

/** 导入的一条事件；`payload` 是完整事件对象。 */
export interface ImportedEvent {
  /** 事件序号。 */
  readonly seq: number;
  /** 事件种类。 */
  readonly type: string;
  /** 事件时刻的毫秒时间戳。 */
  readonly time: number;
  /** 完整事件对象。 */
  readonly payload: Record<string, unknown>;
}

/** 导入的一个会话。 */
export interface ImportedSession {
  /** 会话标识。 */
  readonly id: string;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 工作目录。 */
  readonly cwd?: string;
  /** 父会话。 */
  readonly parentSession?: string;
  /** 是否带继承前缀。 */
  readonly isSeeded: boolean;
  /** 继承事件数。 */
  readonly inheritedEventCount: number;
  /** 事件列表，按序号升序。 */
  readonly events: readonly ImportedEvent[];
}

/** 会话日志源。 */
export interface SessionLogSource {
  /** 源格式标签。 */
  readonly kind: string;
  /** 源是否以只读方式打开。 */
  readonly readOnly: boolean;
  /** 读出全部会话。 */
  sessions(): Promise<readonly ImportedSession[]>;
}

/** 会话日志目标：会话持久化接缝的形状。 */
export interface SessionLogTarget {
  /** 创建会话并取得写句柄。 */
  create(
    header: {
      readonly id: string;
      readonly createdAt: number;
      readonly cwd?: string;
      readonly parentSession?: string;
      readonly isSeeded: boolean;
    },
    options: { readonly inheritedEventCount: number },
  ): Promise<{
    readonly id: string;
    append(events: readonly Record<string, unknown>[]): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
  }>;
  /** 以只读方式打开会话。 */
  open(
    id: string,
    access: 'read',
  ): Promise<{
    readonly header: { readonly id: string; readonly createdAt: number; readonly cwd?: string; readonly parentSession?: string; readonly isSeeded: boolean };
    readonly inheritedEventCount: number;
    read(offset?: number, length?: number): Promise<{ readonly events: readonly Record<string, unknown>[] }>;
    close(): Promise<void>;
  }>;
  /** 列出目标已有会话。 */
  list(): Promise<readonly { readonly header: { readonly id: string } }[]>;
}

/** 导入选项。 */
export interface ImportOptions {
  /** 会话日志源。 */
  readonly source: SessionLogSource;
  /** 会话日志目标。 */
  readonly target: SessionLogTarget;
  /** 检查点与检索索引使用的同步执行端口。 */
  readonly database: SqlExecutor;
  /** 检索索引。 */
  readonly search: { index(documents: readonly SearchDocument[]): void; digest(): string; count(): number };
  /** 任务标识；同一任务重跑从检查点继续。 */
  readonly jobId: string;
  /** 目标 schema 版本。 */
  readonly schemaVersion: number;
  /** 每批会话数，缺省 8。 */
  readonly batchSize?: number;
  /** 源侧用量行；给出时一并导入并比对。 */
  readonly usage?: readonly DigestUsage[];
  /** 用量写入函数；给出用量时必须提供。 */
  readonly recordUsage?: (record: UsageRecord) => void;
  /** 时刻来源。 */
  readonly now?: () => number;
  /** 校验进度回调用途：每批完成后收到位置。 */
  readonly onBatch?: (progress: { readonly position: number; readonly confirmed: number }) => void;
  /** 遥测出口。 */
  readonly telemetry?: PostgresTelemetry;
}

/** 导入报告。 */
export interface ImportReport {
  /** 任务标识。 */
  readonly jobId: string;
  /** 导入的会话数。 */
  readonly sessions: number;
  /** 导入的事件数。 */
  readonly events: number;
  /** 完成的批数。 */
  readonly batches: number;
  /** 源侧摘要。 */
  readonly source: MigrationDigests;
  /** 目标侧摘要。 */
  readonly target: MigrationDigests;
  /** 附件引用计数与写入数据库的字节数。 */
  readonly attachments: { readonly references: number; readonly bytesStored: number };
}

/** 从事件里取出参与检索的语义文本；只认识带模型可见文本的三种事件。 */
export function searchTextOf(event: ImportedEvent): string | undefined {
  const data = event.payload.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  switch (event.type) {
    case 'user/message':
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
      return textOfContent(record.content);
    case 'assistant/message': {
      const message = record.message;
      if (typeof message !== 'object' || message === null) return undefined;
      return textOfContent((message as Record<string, unknown>).content);
    }
    default:
      return typeof record.text === 'string' ? record.text : undefined;
  }
}

/** 把消息的内容块折成检索文本；只取文本块。 */
function textOfContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string' && record.text !== '') parts.push(record.text);
  }
  return parts.length === 0 ? undefined : parts.join('\n');
}

/** 从事件正文里数附件引用；只数引用，不取出任何字节。 */
function countAttachmentReferences(event: ImportedEvent): number {
  const data = event.payload.data;
  if (typeof data !== 'object' || data === null) return 0;
  const attachments = (data as Record<string, unknown>).attachments;
  return Array.isArray(attachments) ? attachments.length : 0;
}

/** 把一批会话折成日志摘要输入。 */
function digestSessionsOf(sessions: readonly ImportedSession[]) {
  return sessions.map((session) => ({
    id: session.id,
    events: session.events.map((event) => ({
      seq: event.seq,
      type: event.type,
      time: event.time,
      payload: event.payload,
    })),
  }));
}

/** 把一批事件折成检索文档。 */
function documentsOf(sessions: readonly ImportedSession[]): SearchDocument[] {
  const documents: SearchDocument[] = [];
  for (const session of sessions) {
    for (const event of session.events) {
      const text = searchTextOf(event);
      if (text === undefined) continue;
      documents.push({ sessionId: session.id, seq: event.seq, kind: event.type, time: event.time, content: text });
    }
  }
  return documents;
}

/** 目标侧已经存在的会话是否与源内容一致。 */
async function targetMatches(target: SessionLogTarget, session: ImportedSession): Promise<boolean> {
  const handle = await target.open(session.id, 'read');
  try {
    const { events } = await handle.read(0, Number.MAX_SAFE_INTEGER);
    if (events.length !== session.events.length) return false;
    const restored: ImportedSession = {
      ...session,
      events: events.map((payload, index) => ({
        seq: Number(payload.seq ?? index),
        type: String(payload.type ?? ''),
        time: Number(payload.time ?? 0),
        payload,
      })),
    };
    return logDigest(digestSessionsOf([restored])) === logDigest(digestSessionsOf([session]));
  } finally {
    await handle.close();
  }
}

/** 从目标读回一批会话。 */
async function readTarget(target: SessionLogTarget, ids: readonly string[]): Promise<ImportedSession[]> {
  const sessions: ImportedSession[] = [];
  for (const id of ids) {
    const handle = await target.open(id, 'read');
    try {
      const { events } = await handle.read(0, Number.MAX_SAFE_INTEGER);
      sessions.push({
        id,
        createdAt: handle.header.createdAt,
        ...(handle.header.cwd === undefined ? {} : { cwd: handle.header.cwd }),
        ...(handle.header.parentSession === undefined ? {} : { parentSession: handle.header.parentSession }),
        isSeeded: handle.header.isSeeded,
        inheritedEventCount: handle.inheritedEventCount,
        events: events.map((payload, index) => ({
          seq: Number(payload.seq ?? index),
          type: String(payload.type ?? ''),
          time: Number(payload.time ?? 0),
          payload,
        })),
      });
    } finally {
      await handle.close();
    }
  }
  return sessions;
}

/**
 * 执行一次导入。
 *
 * @param options - 源、目标、检查点存储与批次参数。
 * @returns 导入报告，含三类摘要的源与目标结果。
 */
export async function importSessions(options: ImportOptions): Promise<ImportReport> {
  const telemetry = options.telemetry ?? NO_POSTGRES_TELEMETRY;
  return telemetry.runSpan(
    POSTGRES_SIGNALS.migrate,
    { mode: 'session-log', outcome: 'attempted' },
    async (span) => {
      try {
        const report = await importSessionsInner(options);
        span.setAttribute('count', report.sessions);
        span.setAttribute('outcome', 'ok');
        telemetry
          .counter(POSTGRES_SIGNALS.migrationsTotal, { description: 'Postgres 迁移结果' })
          .add(1, { outcome: 'ok', mode: 'session-log' });
        return report;
      } catch (error) {
        const attributes = errorAttributes(error);
        span.setAttribute('count', 0);
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', attributes['error.type'] ?? 'Error');
        span.setAttribute('error.code', attributes['error.code'] ?? 'Error');
        span.recordException(error);
        telemetry.event(POSTGRES_SIGNALS.rejected, { action: 'migrate', outcome: 'failed', ...attributes });
        telemetry
          .counter(POSTGRES_SIGNALS.migrationsTotal, { description: 'Postgres 迁移结果' })
          .add(1, { outcome: 'failed', mode: 'session-log' });
        throw error;
      }
    },
  );
}

/** 导入主体。 */
async function importSessionsInner(options: ImportOptions): Promise<ImportReport> {
  const { source, target, database } = options;
  if (!source.readOnly) {
    throw new PostgresStorageError(
      POSTGRES_STORAGE_ERROR_CODES.sourceNotReadOnly,
      '导入源必须以只读方式打开，拒绝执行',
      { kind: source.kind },
    );
  }
  const batchSize = options.batchSize ?? 8;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error(`每批会话数必须是正整数，实际 ${String(batchSize)}`);
  const now = options.now ?? Date.now;
  ensurePostgresMigrationTables(database);
  const store = new MigrationJobStore({ database });
  store.ensureTables();

  const sessions = [...(await source.sessions())].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const session of sessions) {
    if (session.id === '') {
      throw new PostgresStorageError(POSTGRES_STORAGE_ERROR_CODES.sourceInvalid, '导入源存在没有标识的会话');
    }
    session.events.forEach((event, index) => {
      if (event.seq !== index) {
        throw new PostgresStorageError(
          POSTGRES_STORAGE_ERROR_CODES.sourceInvalid,
          `会话 ${session.id} 的事件序号不连续：位置 ${index} 上是 ${event.seq}`,
          { session: session.id, seq: event.seq },
        );
      }
    });
  }

  const sourceDigestOverall = digestOfSessions(sessions);
  const targetDigestOverall = digestOfSessions(await readTargetOrEmpty(target));
  const existing = store.job(options.jobId);
  if (existing !== undefined) {
    if (existing.schemaVersion !== options.schemaVersion) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '导入任务的目标 schema 版本与本次执行不一致，拒绝续传', {
        kind: 'version-mismatch',
        count: existing.schemaVersion,
      });
    }
    if (existing.sourceDigest !== sourceDigestOverall) {
      throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '导入任务的源摘要与本次执行不一致，拒绝续传', {
        kind: 'digest-mismatch',
      });
    }
    if (existing.state === 'switched') {
      throw new StorageError(STORAGE_ERROR_CODES.switchConflict, '导入任务已经完成，不能继续复制', {
        kind: 'already-switched',
      });
    }
  }

  const checkpoint = store.checkpoint(options.jobId);
  let position = checkpoint?.position ?? 0;
  let confirmed = checkpoint?.confirmed ?? 0;
  if (position > sessions.length) {
    throw new StorageError(STORAGE_ERROR_CODES.checkpointCorrupt, '导入检查点的位置超过了源会话数', {
      kind: 'position-out-of-range',
      count: position,
    });
  }
  store.transaction((tx) => {
    store.save(tx, {
      jobId: options.jobId,
      schemaVersion: options.schemaVersion,
      sourceDigest: sourceDigestOverall,
      targetDigest: targetDigestOverall,
      checkpoint: position,
      state: 'copying',
    });
  });

  let batches = 0;
  let imported = 0;
  let attachmentReferences = 0;
  const targetIds = new Set((await target.list()).map((snapshot) => snapshot.header.id));
  while (position < sessions.length) {
    const batch = sessions.slice(position, position + batchSize);
    for (const session of batch) {
      for (const event of session.events) attachmentReferences += countAttachmentReferences(event);
      if (targetIds.has(session.id)) {
        if (!(await targetMatches(target, session))) {
          throw new PostgresStorageError(
            POSTGRES_STORAGE_ERROR_CODES.digestMismatch,
            `目标已有会话 ${session.id}，内容与源不一致，拒绝覆盖`,
            { session: session.id },
          );
        }
      } else {
        const handle = await target.create(
          {
            id: session.id,
            createdAt: session.createdAt,
            ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
            ...(session.parentSession === undefined ? {} : { parentSession: session.parentSession }),
            isSeeded: session.isSeeded,
          },
          { inheritedEventCount: session.inheritedEventCount },
        );
        try {
          await handle.append(session.events.map((event) => event.payload));
          await handle.flush();
        } finally {
          await handle.close();
        }
        targetIds.add(session.id);
      }
      imported += 1;
    }
    options.search.index(documentsOf(batch));
    const written = await readTarget(target, batch.map((session) => session.id));
    const sourceDigest = logDigest(digestSessionsOf(batch));
    const targetDigest = logDigest(digestSessionsOf(written));
    if (sourceDigest !== targetDigest) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.digestMismatch,
        `第 ${batches + 1} 批的日志摘要与目标不一致，拒绝写入检查点`,
        { position, count: batch.length },
      );
    }
    position += batch.length;
    confirmed += batch.length;
    batches += 1;
    store.transaction((tx) => {
      store.save(tx, {
        jobId: options.jobId,
        schemaVersion: options.schemaVersion,
        sourceDigest: sourceDigestOverall,
        targetDigest: targetDigestOverall,
        checkpoint: position,
        state: 'copying',
      });
      store.saveCheckpoint(tx, {
        jobId: options.jobId,
        sourceDigest: sourceDigestOverall,
        targetDigest: targetDigestOverall,
        confirmed,
        position,
        recordedAt: now(),
      });
    });
    options.onBatch?.({ position, confirmed });
  }

  const targetSessions = await readTarget(target, sessions.map((session) => session.id));
  const usageRows = options.usage ?? [];
  for (const row of usageRows) {
    if (options.recordUsage === undefined) throw new Error('导入用量时必须提供用量写入函数');
    options.recordUsage({
      sessionId: row.sessionId,
      turn: row.turn,
      model: 'imported',
      provider: 'imported',
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      reasoningTokens: row.reasoningTokens,
      recordedAt: now(),
    });
  }

  const sourceDigests: MigrationDigests = {
    log: logDigest(digestSessionsOf(sessions)),
    index: indexDigest(documentsOf(sessions)),
    usage: usageDigest(usageRows),
    sessions: sessions.length,
    events: sessions.reduce((total, session) => total + session.events.length, 0),
    documents: documentsOf(sessions).length,
    usageRows: usageRows.length,
  };
  const targetDigests: MigrationDigests = {
    log: logDigest(digestSessionsOf(targetSessions)),
    index: options.search.digest(),
    usage: options.usage === undefined ? usageDigest([]) : usageDigest(options.usage),
    sessions: targetSessions.length,
    events: targetSessions.reduce((total, session) => total + session.events.length, 0),
    documents: options.search.count(),
    usageRows: usageRows.length,
  };
  for (const key of ['log', 'index', 'usage'] as const) {
    if (sourceDigests[key] !== targetDigests[key]) {
      throw new PostgresStorageError(
        POSTGRES_STORAGE_ERROR_CODES.digestMismatch,
        `导入完成后的${key === 'log' ? '全日志' : key === 'index' ? '检索索引' : '用量'}摘要与源不一致`,
        { kind: key },
      );
    }
  }
  store.transaction((tx) => {
    store.save(tx, {
      jobId: options.jobId,
      schemaVersion: options.schemaVersion,
      sourceDigest: sourceDigestOverall,
      targetDigest: targetDigestOverall,
      checkpoint: position,
      state: 'verified',
    });
  });
  return {
    jobId: options.jobId,
    sessions: imported,
    events: targetSessions.reduce((total, session) => total + session.events.length, 0),
    batches,
    source: sourceDigests,
    target: targetDigests,
    attachments: { references: attachmentReferences, bytesStored: 0 },
  };
}

/** 源与目标的全量日志摘要；目标为空时表示首次执行。 */
function digestOfSessions(sessions: readonly ImportedSession[]): string {
  return logDigest(digestSessionsOf(sessions));
}

/** 读回目标现有全部会话；读不到任何会话时返回空数组。 */
async function readTargetOrEmpty(target: SessionLogTarget): Promise<ImportedSession[]> {
  const listed = await target.list();
  return readTarget(target, listed.map((snapshot) => snapshot.header.id));
}

/** 源数据的稳定摘要，用于任务记录。 */
export function sourceFingerprint(sessions: readonly ImportedSession[]): string {
  const hash = createHash('sha256');
  for (const session of sessions) hash.update(`${session.id}\u0000${session.events.length}\u0001`);
  return hash.digest('hex');
}
