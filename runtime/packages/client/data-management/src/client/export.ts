/**
 * 导出当前视图。
 *
 * 导出文件按字段清单逐项构造：用量分类与三个维度、保留策略、清理预估与执行结果、只读副本、
 * 血缘、导入与分叉、删除收件箱。构造完成后统一检查内部游标字段，命中就地拒绝，因此导出文件
 * 与界面看到的内容一致，都不含副本序号、同步位置与内部标识。
 * @module @chatdsh/client-data-management/export
 */

import type { ContentScope, LineageNode } from '@chatdsh/core-contracts';
import { assertNoInternalCursor } from './cursor.ts';
import type {
  CleanupEstimateView,
  CleanupOutcome,
  DeletionInboxItem,
  ForkEstimateView,
  ForkOutcomeView,
  LineageChain,
  PermanentOutcomeView,
  PermanentScopeView,
  ReplicaState,
  RestoreResultView,
  RetentionPolicy,
  UsageReport,
} from './schemas.ts';

/** 导出文件里的一个来源分类。 */
export interface ExportCategory {
  readonly category: string;
  readonly bytes: number;
  readonly files: number;
}

/** 导出文件里的一行用量。 */
export interface ExportUsageRow {
  readonly dimension: string;
  readonly key: string;
  readonly sessionCount: number;
  readonly textReplicaBytes: number;
  readonly attachmentBytes: number;
  readonly lastActiveAt: number;
  readonly retentionDays: number;
}

/** 导出文件里的一次用量读数。 */
export interface ExportUsage {
  readonly measuredAt: number;
  readonly dataRoot: string;
  readonly deviceId: string;
  readonly retentionDays: number;
  readonly totalBytes: number;
  readonly fileCount: number;
  readonly replicaSource: string;
  readonly categories: readonly ExportCategory[];
  readonly rows: readonly ExportUsageRow[];
  readonly replica: {
    readonly sessions: number;
    readonly payloadBytes: number;
    readonly tableBytes: number;
    readonly databaseBytes: number;
  };
}

/** 导出文件里的清理对象。 */
export interface ExportCleanupObject {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly workspaceId?: string;
  readonly replicaBytes: number;
  readonly eventCount: number;
  readonly lastEventAt: number;
  readonly expiresAt: number;
  readonly dependentShares: number;
  readonly activeImports: number;
}

/** 导出文件里的清理预估。 */
export interface ExportCleanupEstimate {
  readonly estimateId: string;
  readonly objectCount: number;
  readonly reclaimableBytes: number;
  readonly retentionDays: number;
  readonly estimatedAt: number;
  readonly dependentShares: number;
  readonly activeImports: number;
  readonly objects: readonly ExportCleanupObject[];
}

/** 导出文件里的清理结果。 */
export interface ExportCleanupOutcome {
  readonly cleanupId: string;
  readonly estimatedBytes: number;
  readonly reclaimedBytes: number;
  readonly finishedAt: number;
  readonly removedSessions: number;
  readonly removedEvents: number;
  readonly dependencies: { readonly shares: number; readonly imports: number };
  readonly authoritativeLogsPreserved: true;
}

/** 导出文件里的内容范围。 */
export interface ExportScope {
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly eventCount: number;
  readonly charCount: number;
  readonly compressed: boolean;
  readonly attachmentsComplete: boolean;
}

/** 导出文件里的一个血缘节点。 */
export interface ExportLineageNode {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly cwd: string;
  readonly kind: string;
  readonly createdAt: number;
  readonly parentSession?: string;
  readonly inheritedScope?: ExportScope;
}

/** 导出文件里的血缘链。 */
export interface ExportLineage {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly depth: number;
  readonly ancestors: readonly ExportLineageNode[];
  readonly self: ExportLineageNode;
  readonly children: readonly ExportLineageNode[];
  readonly descendants: readonly ExportLineageNode[];
}

/** 导出文件里的只读副本状态。 */
export interface ExportReplica {
  readonly sessionId: string;
  readonly state: string;
  readonly source: string;
  readonly readOnlyReason?: string;
  readonly retentionDays: number;
  readonly missingAttachments: number;
  readonly readAt?: number;
  readonly scope?: ExportScope;
}

/** 导出文件里的分叉预估。 */
export interface ExportForkEstimate {
  readonly importMode: string;
  readonly scope: ExportScope;
  readonly eventCount: number;
  readonly charCount: number;
  readonly missingAttachmentIds: readonly string[];
  readonly compressionLoss: boolean;
}

/** 导出文件里的分叉结果。 */
export interface ExportForkOutcome {
  readonly sessionId: string;
  readonly parentSession: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly replayedToolCalls: 0;
  readonly replayedScheduledTasks: 0;
  readonly retainedScheduledTasks: number;
  readonly droppedToolCalls: number;
  readonly droppedToolResults: number;
}

/** 导出文件里的删除收件箱条目。 */
export interface ExportInboxItem {
  readonly sessionId: string;
  readonly title: string;
  readonly originDeviceId: string;
  readonly deletedAt: number;
  readonly retentionExpiresAt: number;
  readonly remainingDays: number;
  readonly bytes: number;
  readonly restorable: boolean;
  readonly hasShareDependency: boolean;
}

/** 导出文件里的永久删除范围。 */
export interface ExportPermanentScope {
  readonly sessionId: string;
  readonly objects: readonly string[];
  readonly dependentShares: number;
  readonly bytes: number;
  readonly dependencies: readonly { readonly kind: string; readonly label: string }[];
}

/** 导出文件里的永久删除结果。 */
export interface ExportPermanentOutcome {
  readonly sessionId: string;
  readonly deletedAt: number;
  readonly removedEvents: number;
  readonly removedShares: number;
  readonly removedReceipts: number;
  readonly releasedBytes: number;
  readonly dependencies: { readonly shares: number; readonly memoryGroups: number };
}

/** 导出文件里的删除收件箱。 */
export interface ExportInbox {
  readonly items: readonly ExportInboxItem[];
  readonly restored?: { readonly sessionId: string; readonly restoredAt: number; readonly scope: ExportScope };
  readonly rejectedCode?: string;
  readonly permanentScope?: ExportPermanentScope;
  readonly permanentOutcome?: ExportPermanentOutcome;
}

/** 一份导出文件。 */
export interface ExportDocument {
  readonly kind: 'chatdsh-data-management';
  readonly exportedAt: number;
  readonly retention?: { readonly days: number; readonly updatedAt?: number; readonly defaulted: boolean };
  readonly usage?: ExportUsage;
  readonly cleanup?: {
    readonly estimate?: ExportCleanupEstimate;
    readonly outcome?: ExportCleanupOutcome;
  };
  readonly replica?: ExportReplica;
  readonly lineage?: ExportLineage;
  readonly fork?: {
    readonly estimate?: ExportForkEstimate;
    readonly outcome?: ExportForkOutcome;
  };
  readonly inbox?: ExportInbox;
}

/** 导出的输入：界面当前已经读取到的视图。 */
export interface ExportInput {
  /** 导出时刻的毫秒时间戳。 */
  readonly exportedAt: number;
  readonly retention?: RetentionPolicy;
  readonly usage?: UsageReport;
  readonly cleanupEstimate?: CleanupEstimateView;
  readonly cleanupOutcome?: CleanupOutcome;
  readonly replica?: ReplicaState;
  readonly lineage?: LineageChain;
  readonly forkEstimate?: ForkEstimateView;
  readonly forkOutcome?: ForkOutcomeView;
  readonly inbox?: readonly DeletionInboxItem[];
  readonly restore?: RestoreResultView;
  readonly permanentScope?: PermanentScopeView;
  readonly permanentOutcome?: PermanentOutcomeView;
}

/** 复制一段内容范围。 */
function scopeOf(scope: ContentScope): ExportScope {
  return {
    turnFrom: scope.turnFrom,
    turnTo: scope.turnTo,
    eventCount: scope.eventCount,
    charCount: scope.charCount,
    compressed: scope.compressed,
    attachmentsComplete: scope.attachmentsComplete,
  };
}

/** 复制一个血缘节点。 */
function nodeOf(node: LineageNode): ExportLineageNode {
  return {
    sessionId: node.sessionId,
    deviceId: node.deviceId,
    cwd: node.cwd,
    kind: node.kind,
    createdAt: node.createdAt,
    ...(node.parentSession === undefined ? {} : { parentSession: node.parentSession }),
    ...(node.inheritedScope === undefined ? {} : { inheritedScope: scopeOf(node.inheritedScope) }),
  };
}

/**
 * 构造一份导出文件。
 *
 * 字段逐项复制，不整对象展开，因此上游多带的字段不会顺带写进导出文件。
 * @param input - 已经读取到的视图。
 * @returns 导出文件。
 * @throws DataCallError - 构造结果里出现内部游标字段。
 */
export function buildExportDocument(input: ExportInput): ExportDocument {
  const usage = input.usage;
  const estimate = input.cleanupEstimate;
  const outcome = input.cleanupOutcome;
  const document: ExportDocument = {
    kind: 'chatdsh-data-management',
    exportedAt: input.exportedAt,
    ...(input.retention === undefined
      ? {}
      : {
        retention: {
          days: input.retention.days,
          ...(input.retention.updatedAt === undefined ? {} : { updatedAt: input.retention.updatedAt }),
          defaulted: input.retention.defaulted,
        },
      }),
    ...(usage === undefined
      ? {}
      : {
        usage: {
          measuredAt: usage.measuredAt,
          dataRoot: usage.root,
          deviceId: usage.deviceId,
          retentionDays: usage.retentionDays,
          totalBytes: usage.totalBytes,
          fileCount: usage.fileCount,
          replicaSource: usage.replicaSource,
          categories: [
            { category: 'session', bytes: usage.buckets.session.bytes, files: usage.buckets.session.files },
            { category: 'replica', bytes: usage.buckets.replica.bytes, files: usage.buckets.replica.files },
            { category: 'attachment', bytes: usage.buckets.attachment.bytes, files: usage.buckets.attachment.files },
            { category: 'memory', bytes: usage.buckets.memory.bytes, files: usage.buckets.memory.files },
            { category: 'other', bytes: usage.buckets.other.bytes, files: usage.buckets.other.files },
          ],
          rows: usage.rows.map((row) => ({
            dimension: row.dimension,
            key: row.key,
            sessionCount: row.sessionCount,
            textReplicaBytes: row.textReplicaBytes,
            attachmentBytes: row.attachmentBytes,
            lastActiveAt: row.lastActiveAt,
            retentionDays: row.retentionDays,
          })),
          replica: {
            sessions: usage.replica.sessions,
            payloadBytes: usage.replica.payloadBytes,
            tableBytes: usage.replica.tableBytes,
            databaseBytes: usage.replica.databaseBytes,
          },
        },
      }),
    ...(estimate === undefined && outcome === undefined
      ? {}
      : {
        cleanup: {
          ...(estimate === undefined
            ? {}
            : {
              estimate: {
                estimateId: estimate.estimateId,
                objectCount: estimate.objectCount,
                reclaimableBytes: estimate.reclaimableBytes,
                retentionDays: estimate.retentionDays,
                estimatedAt: estimate.estimatedAt,
                dependentShares: estimate.dependentShares,
                activeImports: estimate.activeImports,
                objects: estimate.candidates.map((candidate) => ({
                  sessionId: candidate.sessionId,
                  deviceId: candidate.deviceId,
                  ...(candidate.workspaceId === undefined ? {} : { workspaceId: candidate.workspaceId }),
                  replicaBytes: candidate.replicaBytes,
                  eventCount: candidate.eventCount,
                  lastEventAt: candidate.lastEventAt,
                  expiresAt: candidate.expiresAt,
                  dependentShares: candidate.dependentShares,
                  activeImports: candidate.activeImports,
                })),
              },
            }),
          ...(outcome === undefined
            ? {}
            : {
              outcome: {
                cleanupId: outcome.cleanupId,
                estimatedBytes: outcome.estimatedBytes,
                reclaimedBytes: outcome.reclaimedBytes,
                finishedAt: outcome.finishedAt,
                removedSessions: outcome.removedSessions,
                removedEvents: outcome.removedEvents,
                dependencies: { shares: outcome.dependencies.shares, imports: outcome.dependencies.imports },
                authoritativeLogsPreserved: true,
              },
            }),
        },
      }),
    ...(input.replica === undefined
      ? {}
      : {
        replica: {
          sessionId: input.replica.sessionId,
          state: input.replica.replica.state,
          source: input.replica.source,
          ...(input.replica.readOnlyReason === undefined ? {} : { readOnlyReason: input.replica.readOnlyReason }),
          retentionDays: input.replica.retentionDays,
          missingAttachments: input.replica.missingAttachments,
          ...(input.replica.replica.readAt === undefined ? {} : { readAt: input.replica.replica.readAt }),
          ...(input.replica.replica.scope === undefined ? {} : { scope: scopeOf(input.replica.replica.scope) }),
        },
      }),
    ...(input.lineage === undefined
      ? {}
      : {
        lineage: {
          sessionId: input.lineage.sessionId,
          rootSessionId: input.lineage.rootSessionId,
          depth: input.lineage.depth,
          ancestors: input.lineage.ancestors.map(nodeOf),
          self: nodeOf(input.lineage.self),
          children: input.lineage.children.map(nodeOf),
          descendants: input.lineage.descendants.map(nodeOf),
        },
      }),
    ...(input.forkEstimate === undefined && input.forkOutcome === undefined
      ? {}
      : {
        fork: {
          ...(input.forkEstimate === undefined
            ? {}
            : {
              estimate: {
                importMode: input.forkEstimate.importMode,
                scope: scopeOf(input.forkEstimate.scope),
                eventCount: input.forkEstimate.eventCount,
                charCount: input.forkEstimate.charCount,
                missingAttachmentIds: [...input.forkEstimate.missingAttachmentIds],
                compressionLoss: input.forkEstimate.compressionLoss,
              },
            }),
          ...(input.forkOutcome === undefined
            ? {}
            : {
              outcome: {
                sessionId: input.forkOutcome.sessionId,
                parentSession: input.forkOutcome.parentSession,
                cwd: input.forkOutcome.cwd,
                createdAt: input.forkOutcome.createdAt,
                replayedToolCalls: 0,
                replayedScheduledTasks: 0,
                retainedScheduledTasks: input.forkOutcome.replay.retainedScheduledTasks,
                droppedToolCalls: input.forkOutcome.replay.droppedToolCalls,
                droppedToolResults: input.forkOutcome.replay.droppedToolResults,
              },
            }),
        },
      }),
    ...(input.inbox === undefined
      && input.restore === undefined
      && input.permanentScope === undefined
      && input.permanentOutcome === undefined
      ? {}
      : {
        inbox: {
          items: (input.inbox ?? []).map((item) => ({
            sessionId: item.sessionId,
            title: item.title,
            originDeviceId: item.originDeviceId,
            deletedAt: item.deletedAt,
            retentionExpiresAt: item.retentionExpiresAt,
            remainingDays: item.remainingDays,
            bytes: item.bytes,
            restorable: item.restorable,
            hasShareDependency: item.hasShareDependency,
          })),
          ...(input.restore === undefined
            ? {}
            : input.restore.outcome === 'restored'
              ? { restored: { sessionId: input.restore.sessionId, restoredAt: input.restore.restoredAt, scope: scopeOf(input.restore.scope) } }
              : { rejectedCode: input.restore.code }),
          ...(input.permanentScope === undefined
            ? {}
            : {
              permanentScope: {
                sessionId: input.permanentScope.sessionId,
                objects: [...input.permanentScope.objects],
                dependentShares: input.permanentScope.dependentShares,
                bytes: input.permanentScope.bytes,
                dependencies: input.permanentScope.dependencies.map((item) => ({ kind: item.kind, label: item.label })),
              },
            }),
          ...(input.permanentOutcome === undefined
            ? {}
            : {
              permanentOutcome: {
                sessionId: input.permanentOutcome.sessionId,
                deletedAt: input.permanentOutcome.deletedAt,
                removedEvents: input.permanentOutcome.removedEvents,
                removedShares: input.permanentOutcome.removedShares,
                removedReceipts: input.permanentOutcome.removedReceipts,
                releasedBytes: input.permanentOutcome.releasedBytes,
                dependencies: {
                  shares: input.permanentOutcome.dependencies.shares,
                  memoryGroups: input.permanentOutcome.dependencies.memoryGroups,
                },
              },
            }),
        },
      }),
  };
  assertNoInternalCursor(document, '导出文件');
  return document;
}

/**
 * 把导出文件转成文本。
 * @param document - 导出文件。
 * @returns 带缩进的 JSON 文本。
 */
export function exportText(document: ExportDocument): string {
  return JSON.stringify(document, undefined, 2);
}
