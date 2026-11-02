/**
 * 恢复门禁的处置与放开。
 *
 * 恢复出来的数据根默认关闭外部自动化与通知发送：设备令牌已失效、推送订阅待确认、访问凭据待
 * 更换。每一类待处置项都要给出明确动作，全部处置完成之后才同时放开两个对外开关；缺项时给出
 * 缺的是哪一类哪一条，开关保持关闭。
 * @module @chatdsh/host-backup/gate
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  RESTORE_ARTIFACT_ERROR_CODES,
  RESTORE_GATE_FILENAME,
  RestoreArtifactError,
  type RestoreDisposition,
  type RestoreGate,
  type RestoreReport,
} from './artifact.ts';

/** 待处置项的动作。 */
export type DispositionAction = 'rotate' | 'revoke' | 'reconfirm' | 'unsubscribe' | 'replace';

/** 一类待处置项允许的动作。 */
export const DISPOSITION_ACTIONS: Readonly<Record<RestoreDisposition['kind'], readonly DispositionAction[]>> = {
  'device-token': ['rotate', 'revoke'],
  'push-subscription': ['reconfirm', 'unsubscribe'],
  automation: ['reconfirm', 'revoke'],
  'access-credential': ['replace'],
};

/** 一次处置选择。 */
export interface DispositionChoice {
  /** 处置种类。 */
  readonly kind: RestoreDisposition['kind'];
  /** 对象标识。 */
  readonly id: string;
  /** 动作。 */
  readonly action: DispositionAction;
}

/** 放开计划。 */
export interface ExternalReleasePlan {
  /** 处置之后的门禁。 */
  readonly gate: RestoreGate;
  /** 仍然缺的处置项，按 `种类:标识` 形式列出。 */
  readonly blockers: readonly string[];
  /** 两个对外开关是否都已放开。 */
  readonly released: boolean;
}

/** 对外服务面。 */
export type ExternalSurface = 'external-automation' | 'notification-sending';

/**
 * 列出仍然待处置的项。
 * @param gate - 恢复门禁。
 * @returns 待处置项。
 */
export function pendingDispositions(gate: RestoreGate): readonly RestoreDisposition[] {
  return gate.dispositions.filter((item) => item.state === 'pending');
}

/**
 * 按处置选择计算放开计划。
 * @param gate - 当前门禁。
 * @param choices - 处置选择。
 * @returns 新门禁、阻塞项与是否已放开。
 */
export function planExternalServiceRelease(
  gate: RestoreGate,
  choices: readonly DispositionChoice[],
): ExternalReleasePlan {
  const blockers: string[] = [];
  const settled: RestoreDisposition[] = [];
  for (const item of gate.dispositions) {
    const choice = choices.find((candidate) => candidate.kind === item.kind && candidate.id === item.id);
    if (choice === undefined) {
      blockers.push(`${item.kind}:${item.id}`);
      settled.push(item);
      continue;
    }
    if (!DISPOSITION_ACTIONS[item.kind].includes(choice.action)) {
      blockers.push(`${item.kind}:${item.id}:${choice.action}`);
      settled.push(item);
      continue;
    }
    settled.push({ kind: item.kind, id: item.id, state: 'settled', action: choice.action });
  }
  const released = blockers.length === 0;
  return {
    gate: {
      ...gate,
      externalAutomation: released ? 'enabled' : 'disabled',
      notificationSending: released ? 'enabled' : 'disabled',
      dispositions: settled,
    },
    blockers,
    released,
  };
}

/**
 * 放开对外服务；处置项缺项时就地拒绝并列出缺项。
 * @param gate - 当前门禁。
 * @param choices - 处置选择。
 * @returns 处置后的门禁。
 */
export function releaseExternalServices(gate: RestoreGate, choices: readonly DispositionChoice[]): RestoreGate {
  const plan = planExternalServiceRelease(gate, choices);
  if (!plan.released) {
    throw new RestoreArtifactError(
      RESTORE_ARTIFACT_ERROR_CODES.dispositionIncomplete,
      `还有 ${plan.blockers.length} 项恢复处置没有确认`,
      { missing: plan.blockers.length },
    );
  }
  return plan.gate;
}

/**
 * 判定某个对外服务面是否允许，未放开时就地拒绝。
 * @param gate - 恢复门禁。
 * @param surface - 对外服务面。
 */
export function assertExternalServiceAllowed(gate: RestoreGate, surface: ExternalSurface): void {
  const open = surface === 'external-automation' ? gate.externalAutomation : gate.notificationSending;
  if (open !== 'enabled') {
    throw new RestoreArtifactError(
      RESTORE_ARTIFACT_ERROR_CODES.externalDisabled,
      `${surface === 'external-automation' ? '外部自动化' : '通知发送'}在恢复端仍处于关闭状态`,
      { surface, pending: pendingDispositions(gate).length },
    );
  }
}

/**
 * 把处置结果写回恢复目录，权限 0600。
 * @param restoredRoot - 恢复出来的数据根。
 * @param gate - 处置后的门禁。
 */
export function writeRestoreGate(restoredRoot: string, gate: RestoreGate): void {
  const path = join(restoredRoot, RESTORE_GATE_FILENAME);
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(gate, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * 从恢复报告与门禁算出待处置摘要，供启动界面展示。
 * @param report - 恢复报告。
 * @param gate - 恢复门禁。
 * @returns 摘要。
 */
export function dispositionSummary(report: RestoreReport, gate: RestoreGate): {
  readonly deviceTokens: number;
  readonly pushSubscriptions: number;
  readonly automations: number;
  readonly accessCredentials: number;
  readonly pending: number;
  readonly externalAutomation: RestoreGate['externalAutomation'];
  readonly notificationSending: RestoreGate['notificationSending'];
  readonly restorePoint: string;
} {
  const pending = pendingDispositions(gate);
  return {
    deviceTokens: gate.dispositions.filter((item) => item.kind === 'device-token').length,
    pushSubscriptions: gate.dispositions.filter((item) => item.kind === 'push-subscription').length,
    automations: gate.dispositions.filter((item) => item.kind === 'automation').length,
    accessCredentials: gate.dispositions.filter((item) => item.kind === 'access-credential').length,
    pending: pending.length,
    externalAutomation: gate.externalAutomation,
    notificationSending: gate.notificationSending,
    restorePoint: report.restorePoint.iso,
  };
}
