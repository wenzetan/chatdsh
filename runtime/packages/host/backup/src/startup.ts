/**
 * 启动恢复计划。
 *
 * 宿主在恢复出来的数据根上启动之前先算一次计划：恢复报告、恢复门禁与保留的清单要指向同一份
 * 备份，清单正文摘要要一致，非控制平面数据域的每个文件都要与清单的字节数及摘要一致，软件版本
 * 与 schema 要兼容，待处置项与对外服务开关要算清。计划给出两个判断：数据是否可用，以及对外
 * 服务是否允许——后者只有在设备令牌、推送订阅与访问凭据全部处置完成之后才为真。
 * @module @chatdsh/host-backup/startup
 */

import {
  RESTORE_ARTIFACT_ERROR_CODES,
  RestoreArtifactError,
  assertArtifactsAgree,
  readRestoreGate,
  readRestoreReport,
  type RestoreGate,
  type RestoreReport,
} from './artifact.ts';
import { dispositionSummary, pendingDispositions, type DispositionAction } from './gate.ts';
import { readRestoredManifest, verifyRestoredFiles, type BackupManifest, type RestoredFilesReport } from './manifest.ts';

/** 启动恢复计划的输入。 */
export interface StartupRestoreInput {
  /** 恢复出来的数据根。 */
  readonly restoredRoot: string;
  /** 当前软件版本。 */
  readonly currentVersion: string;
  /** 当前软件支持的 schema 版本。 */
  readonly supportedSchemaVersion: number;
}

/** 启动恢复计划。 */
export interface StartupRestorePlan {
  /** 恢复出来的数据根。 */
  readonly restoredRoot: string;
  /** 来源备份标识。 */
  readonly manifestId: string;
  /** 实际恢复点，ISO 时刻。 */
  readonly restorePoint: string;
  /** 版本兼容。 */
  readonly compatible: boolean;
  /** 保留的清单。 */
  readonly manifest: BackupManifest;
  /** 恢复报告。 */
  readonly report: RestoreReport;
  /** 恢复门禁。 */
  readonly gate: RestoreGate;
  /** 恢复出来的文件字节核对。 */
  readonly files: RestoredFilesReport;
  /** 控制平面副本上的事件连续性结果，取自恢复报告。 */
  readonly continuity: RestoreReport['items']['continuity'];
  /** 待处置摘要。 */
  readonly dispositions: ReturnType<typeof dispositionSummary>;
  /** 逐类待处置项的动作建议。 */
  readonly actions: Readonly<Record<RestoreReport['gate']['dispositions'][number]['kind'], readonly DispositionAction[]>>;
  /** 阻塞项。 */
  readonly blockers: readonly string[];
  /** 本地数据是否可用。 */
  readonly canServe: boolean;
  /** 对外服务是否允许。 */
  readonly canServeExternally: boolean;
}

/**
 * 计算启动恢复计划。
 * @param input - 恢复目录、当前版本与支持的 schema 版本。
 * @returns 计划。
 */
export async function planStartupAfterRestore(input: StartupRestoreInput): Promise<StartupRestorePlan> {
  const report = readRestoreReport(input.restoredRoot);
  const gate = readRestoreGate(input.restoredRoot);
  assertArtifactsAgree(report, gate);
  const manifest = readRestoredManifest(input.restoredRoot);
  if (manifest.manifestId !== report.manifestId) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.artifactMismatch, '恢复报告与保留的清单指向不同的备份', {
      report: report.manifestId,
      manifest: manifest.manifestId,
    });
  }
  const files = await verifyRestoredFiles(input.restoredRoot, manifest);
  const compatible = manifest.software.schemaVersion <= input.supportedSchemaVersion
    && majorOf(manifest.software.version) === majorOf(input.currentVersion)
    && report.items.compatibility.compatible;
  const pending = pendingDispositions(gate);
  const blockers: string[] = [];
  if (!compatible) blockers.push('version-incompatible');
  if (pending.length > 0) blockers.push(`dispositions-pending:${String(pending.length)}`);
  if (gate.externalAutomation !== 'enabled' || gate.notificationSending !== 'enabled') {
    blockers.push('external-services-disabled');
  }
  return {
    restoredRoot: input.restoredRoot,
    manifestId: report.manifestId,
    restorePoint: report.restorePoint.iso,
    compatible,
    manifest,
    report,
    gate,
    files,
    continuity: report.items.continuity,
    dispositions: dispositionSummary(report, gate),
    actions: {
      'device-token': ['rotate', 'revoke'],
      'push-subscription': ['reconfirm', 'unsubscribe'],
      automation: ['reconfirm', 'revoke'],
      'access-credential': ['replace'],
    },
    blockers,
    canServe: compatible,
    canServeExternally: compatible && pending.length === 0
      && gate.externalAutomation === 'enabled'
      && gate.notificationSending === 'enabled',
  };
}

/** 取版本的主版本号。 */
function majorOf(version: string): string {
  return version.split('.')[0] ?? '';
}
