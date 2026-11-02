/**
 * 删除收件箱：软删除、恢复、永久删除与删除前的依赖检查。
 *
 * 软删除只写删除时刻，恢复把删除时刻清空；保留期从删除时刻起算，到期后恢复被拒绝。永久删除
 * 先给范围再要显式确认：被有效分享或记忆组引用的对象需要逐项确认影响，正在运行的会话直接
 * 拒绝。整个路径只动控制平面副本与分享记录，设备权威日志与工作区文件不在其中，结果里写明
 * 它们被保留。
 * @module @chatdsh/gateway/maintenance/deletion
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ChatdshError,
  CHATDSH_ERROR_CODES,
  deletionInboxItemSchema,
  permanentDeleteScopeSchema,
  restoreRequestSchema,
  restoreResultSchema,
  type DeletionInboxItem,
  type PermanentDeleteScope,
  type RestoreRequest,
  type RestoreResult,
} from '@chatdsh/core-contracts';
import type { ActiveRunSource } from './active-runs.ts';
import {
  attachmentAvailability,
  attachmentIdsOf,
  contentScopeOf,
} from './content.ts';
import { assertNoInternalCursor } from './dto.ts';
import {
  activeShareCountOf,
  databaseFileBytes,
  replicaEventsOf,
  replicaPayloadBytesOf,
  replicaTitleOf,
  sessionRowOf,
  sessionRows,
  type SessionRow,
} from './rows.ts';
import { DAY_MS, RetentionPolicyStore } from './retention.ts';
import { DATA_SPANS, type DataTelemetry } from './telemetry.ts';

/** 删除收件箱的依赖。 */
export interface DeletionInboxOptions {
  /** 控制平面数据库连接。 */
  readonly database: DatabaseSync;
  /** 保留策略。 */
  readonly retention: RetentionPolicyStore;
  /** 进行中运行的读取面。 */
  readonly activeRuns: ActiveRunSource;
  /** 数据根；附件与记忆组的判定用它。 */
  readonly dataRoot?: string;
}

/** 永久删除的输入。 */
export interface PermanentDeleteInput {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 已显式确认永久删除。 */
  readonly confirm: boolean;
  /** 依赖影响已逐项确认。 */
  readonly confirmDependencies?: boolean;
}

/** 永久删除的结果。 */
export interface PermanentDeleteOutcome {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 删除时刻的毫秒时间戳。 */
  readonly deletedAt: number;
  /** 删除的副本事件行数。 */
  readonly removedEvents: number;
  /** 删除的分享记录数。 */
  readonly removedShares: number;
  /** 删除的已读回执行数。 */
  readonly removedReceipts: number;
  /** 实际释放的磁盘字节数。 */
  readonly releasedBytes: number;
  /** 依赖计数。 */
  readonly dependencies: { readonly shares: number; readonly memoryGroups: number };
  /** 设备权威日志与工作区文件保留。 */
  readonly authoritativeLogsPreserved: true;
}

/** 记忆组对工作区的引用。 */
export interface MemoryGroupReference {
  /** 记忆组标识。 */
  readonly memoryGroupId: string;
  /** 记忆组显示名。 */
  readonly displayName: string;
}

/** 数据根。 */
function defaultDataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 数据库文件的真实字节，含同目录的旁路文件。 */
function physicalBytes(database: DatabaseSync): number {
  const location = database.location();
  if (location === null || location === '') return databaseFileBytes(database);
  let total = 0;
  for (const path of [location, `${location}-wal`, `${location}-shm`]) {
    if (!existsSync(path)) continue;
    total += statSync(path).size;
  }
  return total;
}

/**
 * 读取引用某个工作区的记忆组。
 *
 * 记忆组文件由记忆宿主写在数据根的 `memory/memory-groups.json`，每条记录带一组工作区
 * （设备标识与绝对路径）。文件不存在表示没有记忆组；文件存在但形状不合法时就地拒绝。
 * @param dataRoot - 数据根。
 * @param deviceId - 会话归属设备。
 * @param cwd - 会话的工作目录。
 * @returns 引用该工作区的记忆组。
 */
export function memoryGroupReferencesOf(dataRoot: string, deviceId: string, cwd: string): MemoryGroupReference[] {
  const path = join(dataRoot, 'memory', 'memory-groups.json');
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { readonly groups?: unknown }).groups)) {
    throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, '记忆组文件的形状不合法');
  }
  const out: MemoryGroupReference[] = [];
  for (const entry of (parsed as { readonly groups: unknown[] }).groups) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { readonly memoryGroupId?: unknown; readonly displayName?: unknown; readonly workspaces?: unknown };
    if (typeof record.memoryGroupId !== 'string' || typeof record.displayName !== 'string') continue;
    if (!Array.isArray(record.workspaces)) continue;
    const matched = record.workspaces.some((workspace: unknown) => {
      if (typeof workspace !== 'object' || workspace === null) return false;
      const ref = workspace as { readonly deviceId?: unknown; readonly path?: unknown };
      return ref.deviceId === deviceId && ref.path === cwd;
    });
    if (matched) out.push({ memoryGroupId: record.memoryGroupId, displayName: record.displayName });
  }
  return out;
}

/** 删除收件箱。 */
export class DeletionInbox {
  readonly #database: DatabaseSync;
  readonly #retention: RetentionPolicyStore;
  readonly #activeRuns: ActiveRunSource;
  readonly #dataRoot: string;
  readonly #telemetry: DataTelemetry;

  constructor(options: DeletionInboxOptions, telemetry: DataTelemetry) {
    this.#database = options.database;
    this.#retention = options.retention;
    this.#activeRuns = options.activeRuns;
    this.#dataRoot = options.dataRoot ?? defaultDataRoot();
    this.#telemetry = telemetry;
  }

  /**
   * 列出删除收件箱。
   * @param now - 判定时刻。
   * @returns 已软删除的会话，按删除时间倒序。
   */
  async inbox(now = Date.now()): Promise<DeletionInboxItem[]> {
    const days = (await this.#retention.read()).days;
    return this.#telemetry.run(DATA_SPANS.deletion, 'delete.inbox', {}, async () => {
      const items = sessionRows(this.#database)
        .filter((row) => row.deleted_at !== null)
        .map((row) => this.#itemOf(row, days, now))
        .sort((left, right) => right.deletedAt - left.deletedAt);
      assertNoInternalCursor(items, '删除收件箱');
      return items;
    });
  }

  /**
   * 软删除一个会话。
   * @param sessionId - 会话标识。
   * @param now - 删除时刻。
   * @returns 收件箱条目。
   */
  async softDelete(sessionId: string, now = Date.now()): Promise<DeletionInboxItem> {
    const days = (await this.#retention.read()).days;
    return this.#telemetry.run(DATA_SPANS.deletion, 'delete.soft', { count: 1 }, async () => {
      const row = this.#requireSession(sessionId);
      if (row.deleted_at !== null) {
        throw new ChatdshError(CHATDSH_ERROR_CODES.alreadyHandled, `会话 ${sessionId} 已经在删除收件箱里`);
      }
      this.#database.prepare('update sessions set deleted_at = ? where session_id = ? and deleted_at is null').run(now, sessionId);
      const item = this.#itemOf({ ...row, deleted_at: now }, days, now);
      assertNoInternalCursor(item, '删除收件箱条目');
      return item;
    });
  }

  /**
   * 恢复一个已软删除的会话。
   * @param request - 会话标识、操作标识与请求摘要。
   * @returns 恢复结果或拒绝原因。
   */
  async restore(request: RestoreRequest): Promise<RestoreResult> {
    const parsed = restoreRequestSchema.parse(request);
    const days = (await this.#retention.read()).days;
    return this.#telemetry.run(DATA_SPANS.deletion, 'delete.restore', { count: 1 }, async () => {
      const now = Date.now();
      const row = sessionRowOf(this.#database, parsed.sessionId);
      if (row === undefined) {
        return restoreResultSchema.parse({ outcome: 'rejected', code: CHATDSH_ERROR_CODES.sessionNotFound });
      }
      if (row.deleted_at === null) {
        return restoreResultSchema.parse({ outcome: 'rejected', code: CHATDSH_ERROR_CODES.alreadyHandled });
      }
      if (now >= row.deleted_at + days * DAY_MS) {
        return restoreResultSchema.parse({ outcome: 'rejected', code: CHATDSH_ERROR_CODES.restoreExpired });
      }
      const events = replicaEventsOf(this.#database, parsed.sessionId);
      if (events.length === 0) {
        return restoreResultSchema.parse({ outcome: 'rejected', code: CHATDSH_ERROR_CODES.replicaUnavailable });
      }
      this.#database.prepare('update sessions set deleted_at = null where session_id = ?').run(parsed.sessionId);
      const missing = attachmentAvailability(attachmentIdsOf(events), this.#dataRoot).missing;
      return restoreResultSchema.parse({
        outcome: 'restored',
        sessionId: parsed.sessionId,
        restoredAt: now,
        scope: contentScopeOf(events, { compressed: false, attachmentsComplete: missing.length === 0 }),
      });
    });
  }

  /**
   * 计算永久删除的范围。
   * @param sessionId - 会话标识。
   * @returns 删除范围，含依赖数与释放字节。
   */
  async permanentScope(sessionId: string): Promise<PermanentDeleteScope> {
    return this.#telemetry.run(DATA_SPANS.deletion, 'delete.scope', { count: 1 }, async () => {
      this.#requireSession(sessionId);
      const now = Date.now();
      const dependentShares = activeShareCountOf(this.#database, sessionId, now);
      const shares = this.#database.prepare('select count(*) as total from shares where session_id = ?').get(sessionId) as { total: number } | undefined;
      const objects: ('replica' | 'share')[] = ['replica'];
      if ((shares?.total ?? 0) > 0) objects.push('share');
      const scope = permanentDeleteScopeSchema.parse({
        sessionId,
        objects,
        dependentShares,
        bytes: replicaPayloadBytesOf(this.#database, sessionId),
        requiresConfirm: true,
      });
      assertNoInternalCursor(scope, '永久删除范围');
      return scope;
    });
  }

  /**
   * 永久删除一个会话的控制平面数据。
   * @param input - 会话标识与两级确认。
   * @returns 删除计数、释放字节与依赖结果。
   * @throws ChatdshError - 未确认、依赖未处理或会话正在运行。
   */
  async permanentDelete(input: PermanentDeleteInput): Promise<PermanentDeleteOutcome> {
    if (input.confirm !== true) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.requestInvalid, '永久删除需要显式确认');
    }
    return this.#telemetry.run(DATA_SPANS.deletion, 'delete.permanent', { count: 1 }, async () => {
      const row = this.#requireSession(input.sessionId);
      if (this.#activeRuns.list().includes(input.sessionId)) {
        throw new ChatdshError(CHATDSH_ERROR_CODES.objectInUse, `会话 ${input.sessionId} 正在运行，不能永久删除`, { running: 1 });
      }
      const now = Date.now();
      const dependentShares = activeShareCountOf(this.#database, input.sessionId, now);
      const groups = memoryGroupReferencesOf(this.#dataRoot, row.device_id, row.cwd);
      if ((dependentShares > 0 || groups.length > 0) && input.confirmDependencies !== true) {
        throw new ChatdshError(
          CHATDSH_ERROR_CODES.objectInUse,
          `会话 ${input.sessionId} 有 ${String(dependentShares)} 个有效分享与 ${String(groups.length)} 个记忆组引用，需要逐项确认影响`,
          { dependentShares, memoryGroups: groups.length },
        );
      }
      const before = physicalBytes(this.#database);
      let removedEvents = 0;
      let removedShares = 0;
      let removedReceipts = 0;
      this.#database.exec('begin');
      try {
        removedEvents = Number(this.#database.prepare('delete from replica_events where session_id = ?').run(input.sessionId).changes);
        this.#database.prepare('delete from replica_watermarks where session_id = ?').run(input.sessionId);
        removedReceipts = Number(this.#database.prepare('delete from read_receipts where session_id = ?').run(input.sessionId).changes);
        removedShares = Number(this.#database.prepare('delete from shares where session_id = ?').run(input.sessionId).changes);
        this.#database.prepare('delete from sessions where session_id = ?').run(input.sessionId);
        this.#database.exec('commit');
      } catch (error) {
        this.#database.exec('rollback');
        throw new ChatdshError(
          CHATDSH_ERROR_CODES.internalError,
          `永久删除失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#database.exec('pragma wal_checkpoint(truncate)');
      this.#database.exec('vacuum');
      const after = physicalBytes(this.#database);
      const releasedBytes = Math.max(0, before - after);
      this.#telemetry.reclaimed('delete.permanent', releasedBytes);
      const outcome: PermanentDeleteOutcome = {
        sessionId: input.sessionId,
        deletedAt: now,
        removedEvents,
        removedShares,
        removedReceipts,
        releasedBytes,
        dependencies: { shares: dependentShares, memoryGroups: groups.length },
        authoritativeLogsPreserved: true,
      };
      assertNoInternalCursor(outcome, '永久删除结果');
      return outcome;
    });
  }

  /** 取一条会话归属行，缺失时就地拒绝。 */
  #requireSession(sessionId: string): SessionRow {
    const row = sessionRowOf(this.#database, sessionId);
    if (row === undefined) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.sessionNotFound, `会话 ${sessionId} 不存在`);
    }
    return row;
  }

  /** 把一个会话归属行转成收件箱条目。 */
  #itemOf(row: SessionRow, days: number, now: number): DeletionInboxItem {
    const deletedAt = row.deleted_at as number;
    const expiresAt = deletedAt + days * DAY_MS;
    const remainingDays = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
    const fromReplica = replicaTitleOf(this.#database, row.session_id);
    const fromCwd = basename(row.cwd);
    const title = fromReplica ?? (fromCwd === '' ? row.session_id : fromCwd);
    return deletionInboxItemSchema.parse({
      sessionId: row.session_id,
      title: title.slice(0, 300),
      originDeviceId: row.device_id,
      deletedAt,
      retentionExpiresAt: expiresAt,
      remainingDays,
      bytes: replicaPayloadBytesOf(this.#database, row.session_id),
      restorable: now < expiresAt,
      hasShareDependency: activeShareCountOf(this.#database, row.session_id, now) > 0,
    });
  }
}
