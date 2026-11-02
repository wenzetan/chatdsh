/**
 * 恢复后的显式切换。
 *
 * 恢复写进全新目录之后，切换是另一个独立动作：切换计划列出阻塞项，切换本身要求用户明确确认，
 * 并以改名的方式处置现有根——现有根改名留档，恢复目录改名到正式位置，任何情况下都不覆盖既有
 * 数据。切换完成后在正式数据根里留一份切换记录。
 * @module @chatdsh/gateway/backup/switch
 */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';
import { writeJsonAtomic } from './files.ts';
import { RESTORE_REPORT_FILENAME } from './restore.ts';
import { BACKUP_EVENTS, BACKUP_SPANS, BackupRecorder, type BackupTelemetry } from './telemetry.ts';

/** 正式数据根里的切换记录文件名。 */
export const RESTORE_SWITCH_FILENAME = 'restore-switch.json';

/** 切换计划。 */
export interface RestoreSwitchPlan {
  /** 恢复出来的目录。 */
  readonly restoredRoot: string;
  /** 正式数据根。 */
  readonly liveRoot: string;
  /** 是否需要用户确认。 */
  readonly requiresConfirmation: true;
  /** 阻塞项。 */
  readonly blockers: readonly string[];
  /** 当前是否可以执行切换。 */
  readonly canActivate: boolean;
}

/** 切换确认。 */
export interface RestoreSwitchConfirmation {
  /** 用户已经确认切换。 */
  readonly confirmed: boolean;
  /** 用户同意把现有根改名留档。 */
  readonly vacateLiveRoot?: boolean;
}

/** 切换结果。 */
export interface RestoreSwitchResult {
  /** 正式数据根。 */
  readonly liveRoot: string;
  /** 切换时刻的毫秒时间戳。 */
  readonly activatedAt: number;
  /** 现有根的留档位置；原本不存在时为空。 */
  readonly previousRoot?: string;
  /** 切换记录路径。 */
  readonly markerPath: string;
}

/**
 * 计算切换计划。
 * @param options - 恢复目录与正式数据根。
 * @returns 计划。
 */
export function planRestoreSwitch(options: {
  readonly restoredRoot: string;
  readonly liveRoot: string;
}): RestoreSwitchPlan {
  const blockers: string[] = [];
  if (!existsSync(join(options.restoredRoot, RESTORE_REPORT_FILENAME))) {
    blockers.push('restore-incomplete');
  }
  if (existsSync(options.liveRoot)) blockers.push('live-root-present');
  return {
    restoredRoot: options.restoredRoot,
    liveRoot: options.liveRoot,
    requiresConfirmation: true,
    blockers,
    canActivate: blockers.length === 0,
  };
}

/**
 * 执行切换。
 *
 * 现有根按改名方式留档，恢复目录改名到正式位置；未确认、未同意处置现有根或恢复报告缺失时
 * 就地拒绝，现有根保持原样。
 * @param options - 恢复目录、正式数据根、确认与遥测。
 * @returns 切换结果。
 */
export function activateRestoredRoot(options: {
  readonly restoredRoot: string;
  readonly liveRoot: string;
  readonly confirmation: RestoreSwitchConfirmation;
  readonly telemetry: BackupTelemetry;
  readonly now?: number;
}): Promise<RestoreSwitchResult> {
  const recorder = new BackupRecorder(options.telemetry);
  return recorder.measure(
    BACKUP_SPANS.switch,
    'restore.switch',
    BACKUP_EVENTS.switchRejected,
    {},
    async (span) => {
      if (!options.confirmation.confirmed) {
        throw new BackupError(BACKUP_ERROR_CODES.restoreSwitchNotConfirmed, '切换未取得用户确认', {}, [
          '在界面上确认切换后重新执行',
          '确认之前可以继续在隔离目录里核对数据，现有数据根保持不动',
        ]);
      }
      if (!existsSync(join(options.restoredRoot, RESTORE_REPORT_FILENAME))) {
        throw new BackupError(BACKUP_ERROR_CODES.restoreTargetUnusable, `恢复目录里没有恢复报告：${options.restoredRoot}`);
      }
      const now = options.now ?? Date.now();
      let previousRoot: string | undefined;
      if (existsSync(options.liveRoot)) {
        if (options.confirmation.vacateLiveRoot !== true) {
          throw new BackupError(
            BACKUP_ERROR_CODES.restoreLiveRootPresent,
            `正式数据根已存在，切换前需要先处置它：${options.liveRoot}`,
            { liveRoot: options.liveRoot },
            ['确认把现有数据根改名留档后重新执行切换', '或先手工把现有数据根移到别处，再执行切换'],
          );
        }
        previousRoot = `${options.liveRoot}.pre-restore-${String(now)}`;
        renameSync(options.liveRoot, previousRoot);
      }
      renameSync(options.restoredRoot, options.liveRoot);
      const markerPath = join(options.liveRoot, RESTORE_SWITCH_FILENAME);
      writeJsonAtomic(markerPath, {
        activatedAt: now,
        activatedAtIso: new Date(now).toISOString(),
        liveRoot: options.liveRoot,
        restoredFrom: options.restoredRoot,
        ...(previousRoot === undefined ? {} : { previousRoot }),
      });
      span.setAttribute('outcome', 'activated');
      return {
        liveRoot: options.liveRoot,
        activatedAt: now,
        ...(previousRoot === undefined ? {} : { previousRoot }),
        markerPath,
      };
    },
  );
}
