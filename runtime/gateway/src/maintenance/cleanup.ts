/**
 * 副本清理：按维度与保留期预估可释放字节，确认后删除副本并测量实际释放量。
 *
 * 预估列出对象、范围、可释放字节与依赖数，不删除任何东西；执行时按当前状态重新计算对象，
 * 依赖没有逐项确认就拒绝执行。实际释放量取数据库文件在清理前后的真实字节差（删除后回收空页），
 * 与磁盘占用一致。设备权威日志与工作区文件不参与这条路径，结果里明确写出它们被保留。
 *
 * 清理删的是控制平面副本（事件行、水位行、已读回执），分享记录保留；有有效分享或活动导入
 * 的对象需要显式确认影响。
 * @module @chatdsh/gateway/maintenance/cleanup
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  ChatdshError,
  CHATDSH_ERROR_CODES,
  cleanupEstimateSchema,
  cleanupResultSchema,
  type CleanupEstimate,
  type CleanupResult,
} from '@chatdsh/core-contracts';
import { assertNoInternalCursor } from './dto.ts';
import { databaseFileBytes } from './rows.ts';
import { RetentionPolicyStore, type RetentionCandidate } from './retention.ts';
import { DATA_SPANS, type DataTelemetry } from './telemetry.ts';

/** 预估里的一项对象。 */
export interface CleanupCandidate {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 归属设备；孤儿副本为空。 */
  readonly deviceId: string;
  /** 工作区标识。 */
  readonly workspaceId?: string;
  /** 副本载荷字节数。 */
  readonly replicaBytes: number;
  /** 副本事件条数。 */
  readonly eventCount: number;
  /** 最新事件时间。 */
  readonly lastEventAt: number;
  /** 到期时刻。 */
  readonly expiresAt: number;
  /** 依赖该副本的有效分享数。 */
  readonly dependentShares: number;
  /** 从该会话导入且尚未删除的子会话数。 */
  readonly activeImports: number;
}

/** 一次清理预估。 */
export interface CleanupEstimateView extends CleanupEstimate {
  /** 范围内逐项对象。 */
  readonly candidates: readonly CleanupCandidate[];
}

/** 一次清理执行的结果。 */
export interface CleanupOutcome extends CleanupResult {
  /** 删除的会话数。 */
  readonly removedSessions: number;
  /** 删除的事件行数。 */
  readonly removedEvents: number;
  /** 受影响的依赖计数。 */
  readonly dependencies: { readonly shares: number; readonly imports: number };
}

/** 预估的查询条件。 */
export interface CleanupEstimateQuery {
  /** 覆盖保留周期；缺省取已保存的策略。 */
  readonly retentionDays?: number;
  /** 只清理这些会话；缺省按到期对象。 */
  readonly sessionIds?: readonly string[];
  /** 只清理该设备的副本；缺省不限制。 */
  readonly deviceId?: string;
  /** 只清理该工作区的副本；缺省不限制。 */
  readonly workspaceId?: string;
  /** 判定时刻。 */
  readonly now?: number;
}

/** 执行的输入。 */
export interface CleanupExecuteInput {
  /** 预估标识。 */
  readonly estimateId: string;
  /** 依赖影响已逐项确认。 */
  readonly confirmDependencies?: boolean;
}

/** 一份已登记的预估。 */
interface StoredEstimate {
  readonly sessionIds: string[];
  readonly retentionDays: number;
  readonly estimatedBytes: number;
  readonly createdAt: number;
}

/** 已登记预估的有效期。 */
const ESTIMATE_TTL_MS = 30 * 60_000;

/** 把到期对象转成预估对象。 */
function candidateOf(candidate: RetentionCandidate): CleanupCandidate {
  return {
    sessionId: candidate.sessionId,
    deviceId: candidate.deviceId,
    ...(candidate.workspaceId === undefined ? {} : { workspaceId: candidate.workspaceId }),
    replicaBytes: candidate.replicaBytes,
    eventCount: candidate.eventCount,
    lastEventAt: candidate.lastEventAt,
    expiresAt: candidate.expiresAt,
    dependentShares: candidate.dependentShares,
    activeImports: candidate.activeImports,
  };
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

/** 副本清理服务。 */
export class ReplicaCleanup {
  readonly #estimates = new Map<string, StoredEstimate>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly retention: RetentionPolicyStore,
    private readonly telemetry: DataTelemetry,
  ) {}

  /**
   * 计算一次清理预估。
   * @param query - 保留周期、会话过滤与判定时刻。
   * @returns 预估与逐项对象。
   */
  async estimate(query: CleanupEstimateQuery = {}): Promise<CleanupEstimateView> {
    const now = query.now ?? Date.now();
    const policy = await this.retention.read();
    const retentionDays = query.retentionDays ?? policy.days;
    const candidates = (await this.retention.candidates({
      now,
      days: retentionDays,
      ...(query.sessionIds === undefined ? {} : { sessionIds: query.sessionIds }),
      ...(query.deviceId === undefined ? {} : { deviceId: query.deviceId }),
      ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
    })).map(candidateOf);
    const estimatedBytes = candidates.reduce((sum, candidate) => sum + candidate.replicaBytes, 0);
    const dependentShares = candidates.reduce((sum, candidate) => sum + candidate.dependentShares, 0);
    const activeImports = candidates.reduce((sum, candidate) => sum + candidate.activeImports, 0);
    const estimateId = randomUUID();
    this.#estimates.set(estimateId, {
      sessionIds: candidates.map((candidate) => candidate.sessionId),
      retentionDays,
      estimatedBytes,
      createdAt: now,
    });
    return this.telemetry.run(DATA_SPANS.cleanup, 'cleanup.estimate', { count: candidates.length, bytes: estimatedBytes }, async () => {
      const estimate = cleanupEstimateSchema.parse({
        estimateId,
        objectCount: candidates.length,
        reclaimableBytes: estimatedBytes,
        retentionDays,
        estimatedAt: now,
        dependentShares,
        activeImports,
      });
      const view = { ...estimate, candidates, retentionDays };
      assertNoInternalCursor(view, '清理预估');
      return view;
    });
  }

  /**
   * 执行一次清理。
   * @param input - 预估标识与依赖确认。
   * @returns 实际释放量与删除计数。
   * @throws ChatdshError - 预估不存在或已过期、依赖未确认、写入失败。
   */
  async execute(input: CleanupExecuteInput): Promise<CleanupOutcome> {
    const stored = this.#estimates.get(input.estimateId);
    if (stored === undefined || Date.now() - stored.createdAt > ESTIMATE_TTL_MS) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.objectNotFound, '清理预估不存在或已过期，请重新预估');
    }
    return this.telemetry.run(DATA_SPANS.cleanup, 'cleanup.execute', { count: stored.sessionIds.length, bytes: stored.estimatedBytes }, async () => {
      const now = Date.now();
      const current = await this.retention.candidates({ now, days: stored.retentionDays, sessionIds: stored.sessionIds });
      const dependentShares = current.reduce((sum, candidate) => sum + candidate.dependentShares, 0);
      const activeImports = current.reduce((sum, candidate) => sum + candidate.activeImports, 0);
      if ((dependentShares > 0 || activeImports > 0) && input.confirmDependencies !== true) {
        throw new ChatdshError(
          CHATDSH_ERROR_CODES.objectInUse,
          `范围内有 ${String(dependentShares)} 个有效分享与 ${String(activeImports)} 个活动导入，执行清理需要逐项确认影响`,
          { dependentShares, activeImports },
        );
      }
      const before = physicalBytes(this.database);
      const removeEvents = this.database.prepare('delete from replica_events where session_id = ?');
      const removeWatermark = this.database.prepare('delete from replica_watermarks where session_id = ?');
      const removeReceipts = this.database.prepare('delete from read_receipts where session_id = ?');
      let removedEvents = 0;
      this.database.exec('begin');
      try {
        for (const candidate of current) {
          removedEvents += Number(removeEvents.run(candidate.sessionId).changes);
          removeWatermark.run(candidate.sessionId);
          removeReceipts.run(candidate.sessionId);
        }
        this.database.exec('commit');
      } catch (error) {
        this.database.exec('rollback');
        throw new ChatdshError(
          CHATDSH_ERROR_CODES.internalError,
          `清理执行失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.database.exec('pragma wal_checkpoint(truncate)');
      this.database.exec('vacuum');
      const after = physicalBytes(this.database);
      const reclaimedBytes = Math.max(0, before - after);
      this.telemetry.reclaimed('cleanup.execute', reclaimedBytes);
      this.#estimates.delete(input.estimateId);
      const cleanupId = randomUUID();
      const result = cleanupResultSchema.parse({
        cleanupId,
        estimatedBytes: stored.estimatedBytes,
        reclaimedBytes,
        finishedAt: Date.now(),
        authoritativeLogsPreserved: true,
      });
      const outcome: CleanupOutcome = {
        ...result,
        removedSessions: current.length,
        removedEvents,
        dependencies: { shares: dependentShares, imports: activeImports },
      };
      assertNoInternalCursor(outcome, '清理结果');
      return outcome;
    });
  }
}
