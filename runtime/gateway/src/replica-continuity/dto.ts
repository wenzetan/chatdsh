/**
 * 副本的界面与导出视图。
 *
 * 连续前缀、内容摘要、保留代次与字节账本是副本的内部状态，用于补传、幂等与清理。
 * 界面与默认导出只拿到会话标识、归属设备、事件条数、字节数与更新时刻，避免把内部水位
 * 变成用户需要理解的概念。
 * @module @chatdsh/gateway/replica-continuity/dto
 */

import type { ReplicaCursorView } from './store.ts';

/** 内部字段名，这些字段不得出现在界面与导出视图里。 */
export const INTERNAL_REPLICA_FIELDS = [
  'continuousSeq',
  'continuous_seq',
  'digest',
  'retentionGeneration',
  'retention_generation',
  'bytesCommitted',
  'committedBytes',
  'retentionState',
] as const;

/** 界面与导出使用的一条副本摘要。 */
export interface ReplicaOverview {
  readonly sessionId: string;
  readonly deviceId: string | undefined;
  readonly eventCount: number;
  readonly bytes: number;
  readonly updatedAt: number;
}

/** 导出文件的一条副本摘要。 */
export interface ReplicaExportEntry {
  readonly sessionId: string;
  readonly deviceId: string | undefined;
  readonly eventCount: number;
  readonly bytes: number;
  readonly updatedAt: string;
}

/** 把内部状态映射成界面摘要。 */
export function replicaOverviewOf(view: ReplicaCursorView): ReplicaOverview {
  return {
    sessionId: view.sessionId,
    deviceId: view.deviceId,
    eventCount: view.eventCount,
    bytes: view.bytesCommitted,
    updatedAt: view.updatedAt,
  };
}

/** 把界面摘要映射成导出条目；时刻写成 ISO 字符串。 */
export function replicaExportOf(overview: ReplicaOverview): ReplicaExportEntry {
  return {
    sessionId: overview.sessionId,
    deviceId: overview.deviceId,
    eventCount: overview.eventCount,
    bytes: overview.bytes,
    updatedAt: new Date(overview.updatedAt).toISOString(),
  };
}
