/**
 * 恢复产物的读取与核对。
 *
 * 隔离恢复在恢复目录里写下两份文件：恢复报告记录实际恢复点与逐项核对结果，恢复门禁记录对外
 * 服务开关与待处置项。宿主侧在启动时先按固定形状读这两份文件，形状不符就地拒绝，绝不把残缺的
 * 恢复结果当作可用数据根。
 * @module @chatdsh/host-backup/artifact
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** 恢复报告文件名。 */
export const RESTORE_REPORT_FILENAME = 'restore-report.json';

/** 恢复门禁文件名。 */
export const RESTORE_GATE_FILENAME = 'restore-gate.json';

/** 恢复产物核对失败的原因码。 */
export const RESTORE_ARTIFACT_ERROR_CODES = {
  /** 恢复目录不存在。 */
  rootMissing: 'restore-root-missing',
  /** 恢复报告缺失。 */
  reportMissing: 'restore-report-missing',
  /** 恢复报告形状不合法。 */
  reportCorrupt: 'restore-report-corrupt',
  /** 恢复门禁缺失。 */
  gateMissing: 'restore-gate-missing',
  /** 恢复门禁形状不合法。 */
  gateCorrupt: 'restore-gate-corrupt',
  /** 恢复报告与门禁指向不同来源。 */
  artifactMismatch: 'restore-artifact-mismatch',
  /** 对外服务尚未放开。 */
  externalDisabled: 'restore-external-disabled',
  /** 待处置项没有逐项确认。 */
  dispositionIncomplete: 'restore-disposition-incomplete',
  /** 会话日志存在缺口。 */
  logGap: 'restore-log-gap',
  /** 恢复结果与当前软件不兼容。 */
  incompatible: 'restore-incompatible',
} as const;

/** 恢复产物核对失败的原因码取值。 */
export type RestoreArtifactErrorCode = (typeof RESTORE_ARTIFACT_ERROR_CODES)[keyof typeof RESTORE_ARTIFACT_ERROR_CODES];

/** 恢复产物核对错误。 */
export class RestoreArtifactError extends Error {
  /** 稳定的原因码。 */
  readonly code: RestoreArtifactErrorCode;
  /** 附加判定信息。 */
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(code: RestoreArtifactErrorCode, message: string, details: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = 'RestoreArtifactError';
    this.code = code;
    this.details = details;
  }
}

/** 恢复报告的 schema。 */
export const restoreReportSchema = z.object({
  manifestId: z.string().min(1),
  targetRoot: z.string().min(1),
  restoredAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  restorePoint: z.object({
    at: z.number().int().nonnegative(),
    iso: z.string().min(1),
    sessions: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
  items: z.object({
    manifest: z.object({
      objects: z.number().int().nonnegative(),
      plaintextBytes: z.number().int().nonnegative(),
      cipherBytes: z.number().int().nonnegative(),
    }),
    compatibility: z.object({
      compatible: z.literal(true),
      manifestVersion: z.number().int().nonnegative(),
      currentVersion: z.string().min(1),
      schemaVersion: z.number().int().nonnegative(),
    }),
    ownership: z.object({
      valid: z.literal(true),
      sessions: z.number().int().nonnegative(),
      devices: z.number().int().nonnegative(),
    }),
    continuity: z.object({
      valid: z.literal(true),
      sessions: z.number().int().nonnegative(),
      events: z.number().int().nonnegative(),
      maxSeq: z.number().int(),
    }),
    attachments: z.object({
      valid: z.literal(true),
      files: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    }),
    encryption: z.object({
      valid: z.literal(true),
      keyId: z.string().min(1),
      credentialRecords: z.number().int().nonnegative(),
      decrypted: z.number().int().nonnegative(),
    }),
  }),
  external: z.array(z.object({
    service: z.enum(['hindsight', 'hermes']),
    configured: z.boolean(),
    included: z.literal(false),
    reference: z.string().optional(),
    boundary: z.string().min(1),
  })),
  gate: z.object({
    gateVersion: z.number().int().nonnegative(),
    manifestId: z.string().min(1),
    restoredAt: z.number().int().nonnegative(),
    externalAutomation: z.enum(['disabled', 'enabled']),
    notificationSending: z.enum(['disabled', 'enabled']),
    dispositions: z.array(z.object({
      kind: z.enum(['device-token', 'push-subscription', 'automation', 'access-credential']),
      id: z.string().min(1),
      state: z.enum(['pending', 'settled']),
      action: z.enum(['rotate', 'revoke', 'reconfirm', 'unsubscribe', 'replace']).optional(),
    })),
    conditions: z.array(z.string()),
  }),
});

/** 恢复报告。 */
export type RestoreReport = z.infer<typeof restoreReportSchema>;

/** 一条待处置项。 */
export const restoreDispositionSchema = z.object({
  kind: z.enum(['device-token', 'push-subscription', 'automation', 'access-credential']),
  id: z.string().min(1),
  state: z.enum(['pending', 'settled']),
  action: z.enum(['rotate', 'revoke', 'reconfirm', 'unsubscribe', 'replace']).optional(),
});

/** 一条待处置项。 */
export type RestoreDisposition = z.infer<typeof restoreDispositionSchema>;

/** 恢复门禁的 schema。 */
export const restoreGateSchema = z.object({
  gateVersion: z.number().int().nonnegative(),
  manifestId: z.string().min(1),
  restoredAt: z.number().int().nonnegative(),
  externalAutomation: z.enum(['disabled', 'enabled']),
  notificationSending: z.enum(['disabled', 'enabled']),
  dispositions: z.array(restoreDispositionSchema),
  conditions: z.array(z.string()),
});

/** 恢复门禁。 */
export type RestoreGate = z.infer<typeof restoreGateSchema>;

/**
 * 读取恢复目录里的恢复报告。
 * @param restoredRoot - 恢复出来的数据根。
 * @returns 校验后的报告。
 */
export function readRestoreReport(restoredRoot: string): RestoreReport {
  const parsed = readJson(join(restoredRoot, RESTORE_REPORT_FILENAME), RESTORE_REPORT_FILENAME, RESTORE_ARTIFACT_ERROR_CODES.reportMissing);
  const result = restoreReportSchema.safeParse(parsed);
  if (!result.success) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.reportCorrupt, `恢复报告形状不合法：${result.error.message}`, {
      issues: result.error.issues.length,
    });
  }
  return result.data;
}

/**
 * 读取恢复目录里的恢复门禁。
 * @param restoredRoot - 恢复出来的数据根。
 * @returns 校验后的门禁。
 */
export function readRestoreGate(restoredRoot: string): RestoreGate {
  const parsed = readJson(join(restoredRoot, RESTORE_GATE_FILENAME), RESTORE_GATE_FILENAME, RESTORE_ARTIFACT_ERROR_CODES.gateMissing);
  const result = restoreGateSchema.safeParse(parsed);
  if (!result.success) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.gateCorrupt, `恢复门禁形状不合法：${result.error.message}`, {
      issues: result.error.issues.length,
    });
  }
  return result.data;
}

/**
 * 核对恢复报告与恢复门禁来自同一份备份。
 * @param report - 恢复报告。
 * @param gate - 恢复门禁。
 */
export function assertArtifactsAgree(report: RestoreReport, gate: RestoreGate): void {
  if (report.manifestId !== gate.manifestId) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.artifactMismatch, '恢复报告与恢复门禁指向不同的备份', {
      report: report.manifestId,
      gate: gate.manifestId,
    });
  }
  if (report.restoredAt !== gate.restoredAt) {
    throw new RestoreArtifactError(RESTORE_ARTIFACT_ERROR_CODES.artifactMismatch, '恢复报告与恢复门禁的恢复时刻不一致', {
      report: report.restoredAt,
      gate: gate.restoredAt,
    });
  }
}

/** 读一个 JSON 文件并给出稳定的失败原因。 */
function readJson(path: string, label: string, missingCode: RestoreArtifactErrorCode): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new RestoreArtifactError(missingCode, `恢复目录里没有${label}：${path}`, { errno });
  }
  return JSON.parse(text);
}
