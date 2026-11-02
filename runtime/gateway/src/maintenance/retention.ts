/**
 * 副本保留策略：读写保留周期，计算到期对象。
 *
 * 保留周期存在控制平面的设置表里，命名空间固定，缺省 90 天，允许 1 到 3650 天。到期对象按
 * 「副本里最新事件早于截止时刻」判定，逐会话给出副本字节、事件条数、到期时刻与依赖它的分享
 * 和导入条数。软删除的会话不算副本清理的候选：它们归删除收件箱的保留期管。
 * @module @chatdsh/gateway/maintenance/retention
 */

import type { DatabaseSync } from 'node:sqlite';
import { ChatdshError, CHATDSH_ERROR_CODES, RETENTION_DAYS_RANGE } from '@chatdsh/core-contracts';
import { activeShareCountOf } from './rows.ts';
import { DATA_SPANS, type DataTelemetry } from './telemetry.ts';

/** 保留策略在设置表里的命名空间。 */
export const RETENTION_NAMESPACE = 'replica-retention';

/** 保留策略在设置表里的键。 */
export const RETENTION_KEY = 'days';

/** 一天的毫秒数。 */
export const DAY_MS = 86_400_000;

/** 一份保留策略。 */
export interface RetentionPolicyView {
  /** 保留周期，单位天。 */
  readonly days: number;
  /** 最近写入时刻的毫秒时间戳；从未写入时缺省。 */
  readonly updatedAt?: number;
  /** 取的是缺省值。 */
  readonly defaulted: boolean;
}

/** 一个到期对象。 */
export interface RetentionCandidate {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 归属设备；没有归属记录时为空。 */
  readonly deviceId: string;
  /** 工作区标识。 */
  readonly workspaceId?: string;
  /** 没有归属记录的孤儿副本。 */
  readonly orphan: boolean;
  /** 副本里的事件条数。 */
  readonly eventCount: number;
  /** 副本载荷的真实字节数。 */
  readonly replicaBytes: number;
  /** 副本里最新事件的时间。 */
  readonly lastEventAt: number;
  /** 到期时刻的毫秒时间戳。 */
  readonly expiresAt: number;
  /** 依赖该副本的有效分享数。 */
  readonly dependentShares: number;
  /** 从该会话导入且尚未删除的子会话数。 */
  readonly activeImports: number;
}

/** 到期对象的查询条件。 */
export interface RetentionCandidateQuery {
  /** 判定到期与依赖的当前时刻。 */
  readonly now?: number;
  /** 覆盖保留周期；缺省取已保存的策略。 */
  readonly days?: number;
  /** 只保留这些会话；缺省不限制。 */
  readonly sessionIds?: readonly string[];
  /** 只保留该设备的副本；缺省不限制。 */
  readonly deviceId?: string;
  /** 只保留该工作区的副本；缺省不限制。 */
  readonly workspaceId?: string;
}

/** 校验保留周期。 */
function assertDays(days: number): number {
  if (!Number.isInteger(days) || days < RETENTION_DAYS_RANGE.min || days > RETENTION_DAYS_RANGE.max) {
    throw new ChatdshError(
      CHATDSH_ERROR_CODES.replicaRetentionInvalid,
      `副本保留周期必须是 ${String(RETENTION_DAYS_RANGE.min)} 到 ${String(RETENTION_DAYS_RANGE.max)} 之间的整数天`,
      { days },
    );
  }
  return days;
}

/** 副本保留策略的存储。 */
export class RetentionPolicyStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly telemetry: DataTelemetry,
  ) {}

  /**
   * 读取保留策略。
   * @returns 保留策略；从未写入时返回缺省值并标明来源。
   */
  async read(): Promise<RetentionPolicyView> {
    return this.telemetry.run(DATA_SPANS.retention, 'retention.read', {}, async () => {
      const row = this.database
        .prepare('select value, updated_at from settings where namespace = ? and key = ?')
        .get(RETENTION_NAMESPACE, RETENTION_KEY) as { value: string; updated_at: number } | undefined;
      if (row === undefined) return { days: RETENTION_DAYS_RANGE.default, defaulted: true };
      const days = Number.parseInt(row.value, 10);
      if (!Number.isInteger(days) || String(days) !== row.value.trim()) {
        throw new ChatdshError(CHATDSH_ERROR_CODES.replicaRetentionInvalid, `已保存的副本保留周期不合法：${row.value}`);
      }
      assertDays(days);
      return { days, updatedAt: row.updated_at, defaulted: false };
    });
  }

  /**
   * 写入保留策略。
   * @param days - 保留周期，单位天。
   * @returns 写入后的策略。
   */
  async write(days: number): Promise<RetentionPolicyView> {
    const value = assertDays(days);
    return this.telemetry.run(DATA_SPANS.retention, 'retention.write', { count: value }, async () => {
      const now = Date.now();
      this.database
        .prepare(`insert into settings (namespace, key, value, updated_at) values (?, ?, ?, ?)
                  on conflict(namespace, key) do update set value = excluded.value, updated_at = excluded.updated_at`)
        .run(RETENTION_NAMESPACE, RETENTION_KEY, String(value), now);
      return { days: value, updatedAt: now, defaulted: false };
    });
  }

  /**
   * 计算到期对象。
   * @param query - 当前时刻、保留周期与会话过滤。
   * @returns 到期对象，按最新事件时间升序。
   */
  async candidates(query: RetentionCandidateQuery = {}): Promise<RetentionCandidate[]> {
    const now = query.now ?? Date.now();
    const days = query.days ?? (await this.read()).days;
    assertDays(days);
    return this.telemetry.run(DATA_SPANS.retention, 'retention.candidates', {}, async () => {
      const cutoff = now - days * DAY_MS;
      const rows = this.database
        .prepare(`select r.session_id as session_id,
                         s.device_id as device_id,
                         s.workspace_id as workspace_id,
                         coalesce(sum(length(cast(r.payload as blob))), 0) as bytes,
                         count(*) as events,
                         max(r.time) as last_time
                  from replica_events r
                  left join sessions s on s.session_id = r.session_id
                  where (s.session_id is null or s.deleted_at is null)
                  group by r.session_id
                  having max(r.time) < ?
                  order by last_time asc`)
        .all(cutoff) as unknown as { session_id: string; device_id: string | null; workspace_id: string | null; bytes: number; events: number; last_time: number }[];
      const filter = query.sessionIds === undefined ? undefined : new Set(query.sessionIds);
      const imports = this.database.prepare(
        'select count(*) as total from sessions where parent_session = ? and deleted_at is null and created_at >= ?',
      );
      return rows
        .filter((row) => {
          if (filter !== undefined && !filter.has(row.session_id)) return false;
          if (query.deviceId !== undefined && row.device_id !== query.deviceId) return false;
          if (query.workspaceId !== undefined && row.workspace_id !== query.workspaceId) return false;
          return true;
        })
        .map((row) => {
          const childRow = imports.get(row.session_id, cutoff) as { total: number } | undefined;
          return {
            sessionId: row.session_id,
            deviceId: row.device_id ?? '',
            ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
            orphan: row.device_id === null,
            eventCount: row.events,
            replicaBytes: row.bytes,
            lastEventAt: row.last_time,
            expiresAt: row.last_time + days * DAY_MS,
            dependentShares: activeShareCountOf(this.database, row.session_id, now),
            activeImports: childRow?.total ?? 0,
          };
        });
    });
  }
}
