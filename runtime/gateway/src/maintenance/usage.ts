/**
 * 用量统计：控制平面的副本读数、设备侧的真实字节清点与三个维度的聚合。
 *
 * 副本字节取自副本表：每会话的载荷字节与表的实际页占用是两组真实读数，数据库文件字节取页数
 * 乘页大小。设备侧的会话、附件、记忆与其他文件由 `@chatdsh/host-usage` 的真实文件系统清点
 * 给出，这一层把副本读数与归属索引一起交给它，并核对返回的每一行符合对外形状。
 *
 * 清点失败向上抛出，调用方拿到的是错误，界面因此显示读取失败。
 * @module @chatdsh/gateway/maintenance/usage
 */

import type { DatabaseSync } from 'node:sqlite';
import { ChatdshError, CHATDSH_ERROR_CODES, usageRowSchema, type UsageRow } from '@chatdsh/core-contracts';
import { assertNoInternalCursor } from './dto.ts';
import { databaseFileBytes, sessionRows, tablePageBytes } from './rows.ts';
import { DATA_SPANS, type DataTelemetry } from './telemetry.ts';

/** 副本里一个会话的读数。 */
export interface ReplicaSessionUsage {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 副本载荷的真实字节数。 */
  readonly bytes: number;
  /** 副本里最新事件的时间。 */
  readonly lastActiveAt: number;
  /** 副本里的事件条数。 */
  readonly eventCount: number;
}

/** 副本存储的物理读数。 */
export interface ReplicaStoreUsage {
  /** 有副本的会话数。 */
  readonly sessions: number;
  /** 全部副本载荷的字节数。 */
  readonly payloadBytes: number;
  /** 副本表与水位表的实际页占用字节。 */
  readonly tableBytes: number;
  /** 数据库文件字节数。 */
  readonly databaseBytes: number;
  /** 每会话读数。 */
  readonly perSession: readonly ReplicaSessionUsage[];
}

/** 设备侧清点的会话归属。 */
export interface UsageSessionRef {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 归属设备。 */
  readonly deviceId: string;
  /** 工作区标识。 */
  readonly workspaceId?: string;
  /** 会话记录的最近活动时刻。 */
  readonly lastActiveAt?: number;
}

/** 设备侧清点的附件归属。 */
export interface UsageAttachmentRef {
  /** 附件标识。 */
  readonly attachmentId: string;
  /** 附件所属的会话。 */
  readonly sessionId: string;
}

/** 设备侧清点的副本读数。 */
export interface UsageReplicaRef {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 副本载荷字节数。 */
  readonly bytes: number;
  /** 副本里最新事件的时间。 */
  readonly lastActiveAt: number;
}

/** 设备侧清点的输入形状，与 `@chatdsh/host-usage` 的 `StorageUsageInput` 一致。 */
export interface StorageMeasurementInput {
  /** 数据根。 */
  readonly root: string;
  /** 本机设备标识。 */
  readonly deviceId: string;
  /** 副本保留周期。 */
  readonly retentionDays: number;
  /** 会话归属。 */
  readonly sessions: readonly UsageSessionRef[];
  /** 附件归属。 */
  readonly attachments: readonly UsageAttachmentRef[];
  /** 副本读数。 */
  readonly replicas: readonly UsageReplicaRef[];
}

/** 设备侧清点的一行。 */
export interface StorageMeasurementRow {
  /** 维度。 */
  readonly dimension: 'device' | 'workspace' | 'session';
  /** 维度取值。 */
  readonly key: string;
  /** 会话数量。 */
  readonly sessionCount: number;
  /** 文本副本字节数。 */
  readonly textReplicaBytes: number;
  /** 附件空间字节数。 */
  readonly attachmentBytes: number;
  /** 最近活动时刻。 */
  readonly lastActiveAt: number;
  /** 副本保留周期。 */
  readonly retentionDays: number;
}

/** 设备侧清点的结果形状，与 `@chatdsh/host-usage` 的 `StorageUsageReport` 一致。 */
export interface StorageMeasurementReport {
  /** 数据根。 */
  readonly root: string;
  /** 本机设备标识。 */
  readonly deviceId: string;
  /** 清点时刻。 */
  readonly measuredAt: number;
  /** 数据根下全部文件的真实字节数。 */
  readonly totalBytes: number;
  /** 参与计数的文件个数。 */
  readonly fileCount: number;
  /** 按来源分类的读数。 */
  readonly buckets: Readonly<Record<string, { readonly bytes: number; readonly files: number }>>;
  /** 三个维度的用量行。 */
  readonly rows: readonly StorageMeasurementRow[];
  /** 副本来源。 */
  readonly replicaSource: 'measured' | 'absent';
}

/** 设备侧清点函数。 */
export type StorageMeasurement = (input: StorageMeasurementInput) => Promise<StorageMeasurementReport>;

/** 一次用量统计的请求。 */
export interface DataUsageRequest {
  /** 设备数据根的绝对路径。 */
  readonly root: string;
  /** 本机设备标识。 */
  readonly deviceId: string;
  /** 覆盖保留周期；缺省取已保存的策略。 */
  readonly retentionDays?: number;
  /** 附件的会话归属；缺失时附件字节只记在设备维度。 */
  readonly attachments?: readonly UsageAttachmentRef[];
}

/** 一次用量统计的结果。 */
export interface DataUsageReport {
  /** 清点时刻。 */
  readonly measuredAt: number;
  /** 数据根。 */
  readonly root: string;
  /** 本机设备标识。 */
  readonly deviceId: string;
  /** 本次使用的保留周期。 */
  readonly retentionDays: number;
  /** 数据根下全部文件的真实字节数。 */
  readonly totalBytes: number;
  /** 参与计数的文件个数。 */
  readonly fileCount: number;
  /** 按来源分类的读数。 */
  readonly buckets: Readonly<Record<string, { readonly bytes: number; readonly files: number }>>;
  /** 三个维度的用量行，每行都通过对外形状校验。 */
  readonly rows: readonly UsageRow[];
  /** 副本来源。 */
  readonly replicaSource: 'measured' | 'absent';
  /** 控制平面副本的物理读数。 */
  readonly replica: Omit<ReplicaStoreUsage, 'perSession'>;
}

/**
 * 统计控制平面副本的字节。
 * @param database - 控制平面数据库连接。
 * @returns 副本读数。
 */
export function replicaStoreUsage(database: DatabaseSync): ReplicaStoreUsage {
  const rows = database
    .prepare(`select session_id,
                     coalesce(sum(length(cast(payload as blob))), 0) as bytes,
                     max(time) as last_time,
                     count(*) as events
              from replica_events group by session_id order by session_id asc`)
    .all() as unknown as { session_id: string; bytes: number; last_time: number; events: number }[];
  const perSession: ReplicaSessionUsage[] = rows.map((row) => ({
    sessionId: row.session_id,
    bytes: row.bytes,
    lastActiveAt: row.last_time,
    eventCount: row.events,
  }));
  const pages = tablePageBytes(database);
  const tableBytes = (pages.get('replica_events') ?? 0) + (pages.get('replica_watermarks') ?? 0);
  return {
    sessions: perSession.length,
    payloadBytes: perSession.reduce((sum, item) => sum + item.bytes, 0),
    tableBytes,
    databaseBytes: databaseFileBytes(database),
    perSession,
  };
}

/**
 * 用量统计服务。
 *
 * 归属索引取自会话表，副本读数取自副本表，文件字节取自设备侧清点。三者一起构成一次完整读数。
 */
export class DataUsageService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly measure: StorageMeasurement,
    private readonly telemetry: DataTelemetry,
    private readonly retentionDays: () => Promise<number>,
  ) {}

  /**
   * 统计一次用量。
   * @param request - 数据根、设备标识与附件归属。
   * @returns 用量读数。
   */
  async report(request: DataUsageRequest): Promise<DataUsageReport> {
    if (typeof request.root !== 'string' || request.root.trim() === '') {
      throw new ChatdshError(CHATDSH_ERROR_CODES.requestInvalid, '统计用量需要设备数据根');
    }
    if (typeof request.deviceId !== 'string' || request.deviceId.trim() === '') {
      throw new ChatdshError(CHATDSH_ERROR_CODES.requestInvalid, '统计用量需要设备标识');
    }
    const days = request.retentionDays ?? await this.retentionDays();
    const replicas = replicaStoreUsage(this.database);
    return this.telemetry.run(DATA_SPANS.usage, 'usage', { kind: 'device' }, async () => {
      const sessions: UsageSessionRef[] = sessionRows(this.database).map((row) => ({
        sessionId: row.session_id,
        deviceId: row.device_id,
        ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
        lastActiveAt: row.created_at,
      }));
      const measured = await this.measure({
        root: request.root,
        deviceId: request.deviceId,
        retentionDays: days,
        sessions,
        attachments: request.attachments ?? [],
        replicas: replicas.perSession.map((item) => ({
          sessionId: item.sessionId,
          bytes: item.bytes,
          lastActiveAt: item.lastActiveAt,
        })),
      });
      const rows = measured.rows.map((row) => usageRowSchema.parse(row));
      const report: DataUsageReport = {
        measuredAt: measured.measuredAt,
        root: measured.root,
        deviceId: measured.deviceId,
        retentionDays: days,
        totalBytes: measured.totalBytes,
        fileCount: measured.fileCount,
        buckets: measured.buckets,
        rows,
        replicaSource: measured.replicaSource,
        replica: {
          sessions: replicas.sessions,
          payloadBytes: replicas.payloadBytes,
          tableBytes: replicas.tableBytes,
          databaseBytes: replicas.databaseBytes,
        },
      };
      assertNoInternalCursor(report, '用量读数');
      return report;
    });
  }
}
