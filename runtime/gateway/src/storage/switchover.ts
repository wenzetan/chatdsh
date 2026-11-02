/**
 * 显式切换。
 *
 * 切换以验证报告为准：报告缺失、未通过或与迁移任务不一致时拒绝；通过时把已复制完成的
 * 目标原子地换到活动路径，并把源标记为只读。切换记录与任务状态在同一个事务里提交，同一
 * 任务换了另一份验证报告按冲突拒绝，重复调用按幂等返回既有结果。
 * @module @chatdsh/gateway/storage/switchover
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MigrationLock } from '../migrations/lock.ts';
import { STORAGE_ERROR_CODES, StorageError } from './errors.ts';
import type { MigrationJobStore } from './migration-job.ts';

/** 源对目标的一致性验证报告。 */
export interface MigrationVerificationReport {
  /** 任务标识。 */
  readonly jobId: string;
  /** 目标 schema 版本。 */
  readonly schemaVersion: number;
  /** 源的记录摘要。 */
  readonly sourceDigest: string;
  /** 目标的记录摘要。 */
  readonly targetDigest: string;
  /** 源的记录条数。 */
  readonly sourceRecords: number;
  /** 目标的记录条数。 */
  readonly targetRecords: number;
  /** 验证是否通过。 */
  readonly passed: boolean;
  /** 验证完成的毫秒时间戳。 */
  readonly verifiedAt: number;
}

/** 切换的遥测面。 */
export type MigrationSwitchTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter' | 'runSpanSync'>;

/** 切换输入。 */
export interface MigrationSwitchInput {
  /** 任务与切换记录存储。 */
  readonly store: MigrationJobStore;
  /** 迁移锁，切换期间持有。 */
  readonly lock: MigrationLock;
  /** 遥测出口。 */
  readonly telemetry: MigrationSwitchTelemetry;
  /** 任务标识。 */
  readonly jobId: string;
  /** 验证报告路径。 */
  readonly reportPath: string;
  /** 源数据路径。 */
  readonly sourcePath: string;
  /** 已复制完成的目标路径。 */
  readonly targetPath: string;
  /** 切换后的活动路径。 */
  readonly activePath: string;
  /** 源是否以只读方式打开；调用方按实际句柄给出。 */
  readonly sourceReadOnly: boolean;
  /** 时刻来源，缺省取系统时钟。 */
  readonly now?: () => number;
}

/** 切换结果。 */
export interface MigrationSwitchResult {
  /** 任务标识。 */
  readonly jobId: string;
  /** 切换后的活动路径。 */
  readonly activePath: string;
  /** 切换时刻的毫秒时间戳。 */
  readonly switchedAt: number;
  /** 本次调用是否真正执行了切换。 */
  readonly switched: boolean;
}

/**
 * 读取并校验验证报告。
 * @param reportPath - 报告文件路径。
 * @returns 报告与报告内容的 SHA-256 摘要。
 */
export function readVerificationReport(reportPath: string): {
  readonly report: MigrationVerificationReport;
  readonly digest: string;
} {
  let text: string;
  try {
    text = readFileSync(reportPath, 'utf8');
  } catch (error) {
    throw new StorageError(STORAGE_ERROR_CODES.verificationFailed, '验证报告不存在或不可读取，拒绝切换', {
      kind: 'report-missing',
      errno: errnoOf(error),
    });
  }
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StorageError(STORAGE_ERROR_CODES.verificationFailed, '验证报告不是合法的 JSON，拒绝切换', {
      kind: 'report-malformed',
    });
  }
  return { report: requireReport(parsed), digest };
}

/**
 * 原子写入验证报告。
 *
 * 报告先写临时文件并落盘，再改名到目标路径，最后落盘所在目录。
 * @param reportPath - 报告文件路径。
 * @param report - 报告内容。
 * @returns 报告内容的 SHA-256 摘要。
 */
export function writeVerificationReport(reportPath: string, report: MigrationVerificationReport): string {
  requireReport(report);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const temporary = `${reportPath}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, reportPath);
  fsyncDirectory(dirname(reportPath));
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 按验证报告执行显式切换。
 * @param input - 任务、报告、源与目标路径、源只读状态与遥测出口。
 * @returns 切换结果。
 */
export function switchToTarget(input: MigrationSwitchInput): MigrationSwitchResult {
  const now = input.now ?? Date.now;
  return input.telemetry.runSpanSync(
    'chatdsh.gateway.migration.switch',
    { outcome: 'attempted' },
    (span) => {
      try {
        const result = performSwitch(input, now);
        span.setAttribute('status', result.switched ? 'switched' : 'already-switched');
        span.setAttribute('count', result.switched ? 1 : 0);
        input.telemetry
          .counter('chatdsh_gateway_migration_switches_total', { description: '迁移显式切换结果' })
          .add(1, { outcome: result.switched ? 'switched' : 'already-switched' });
        return result;
      } catch (error) {
        const code = error instanceof StorageError ? error.code : STORAGE_ERROR_CODES.switchNotAllowed;
        span.setAttribute('status', 'rejected');
        span.setAttribute('count', 0);
        input.telemetry
          .counter('chatdsh_gateway_migration_switches_total', { description: '迁移显式切换结果' })
          .add(1, { outcome: 'rejected', 'error.code': code });
        input.telemetry.event('chatdsh.gateway.migration.switch.rejected', {
          outcome: 'rejected',
          'error.type': error instanceof Error ? error.name : 'Error',
          'error.code': code,
        });
        throw error;
      }
    },
  );
}

/** 校验报告、核对条件、执行切换并写入切换记录。 */
function performSwitch(input: MigrationSwitchInput, now: () => number): MigrationSwitchResult {
  const report = readVerificationReport(input.reportPath);
  const job = input.store.job(input.jobId);
  if (job === undefined) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, `迁移任务 ${input.jobId} 不存在，拒绝切换`, {
      kind: 'job-missing',
    });
  }
  if (report.report.jobId !== job.jobId) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, '验证报告属于另一个迁移任务，拒绝切换', {
      kind: 'report-mismatch',
    });
  }
  if (report.report.schemaVersion !== job.schemaVersion) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, '验证报告的目标 schema 版本与迁移任务不一致，拒绝切换', {
      kind: 'report-mismatch',
      count: report.report.schemaVersion,
    });
  }
  if (report.report.sourceDigest !== job.sourceDigest || report.report.targetDigest !== job.targetDigest) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, '验证报告的源或目标摘要与迁移任务不一致，拒绝切换', {
      kind: 'report-mismatch',
    });
  }
  if (report.report.sourceRecords !== report.report.targetRecords) {
    throw new StorageError(
      STORAGE_ERROR_CODES.verificationFailed,
      `验证报告的源记录 ${report.report.sourceRecords} 条与目标记录 ${report.report.targetRecords} 条不一致，拒绝切换`,
      { kind: 'record-count-mismatch', count: report.report.targetRecords },
    );
  }
  if (!report.report.passed) {
    throw new StorageError(STORAGE_ERROR_CODES.verificationFailed, '验证报告未通过，拒绝切换', {
      kind: 'report-not-passed',
    });
  }
  if (!input.sourceReadOnly) {
    throw new StorageError(STORAGE_ERROR_CODES.sourceNotReadOnly, '源数据不是以只读方式打开，拒绝切换', {
      kind: 'source-writable',
    });
  }

  const previous = input.store.switchRecord(input.jobId);
  if (previous !== undefined) {
    if (previous.reportDigest !== report.digest) {
      throw new StorageError(STORAGE_ERROR_CODES.switchConflict, '同一任务已按另一份验证报告完成切换', {
        kind: 'report-conflict',
      });
    }
    return {
      jobId: job.jobId,
      activePath: previous.activePath,
      switchedAt: previous.switchedAt,
      switched: false,
    };
  }
  if (job.state === 'switched') {
    throw new StorageError(STORAGE_ERROR_CODES.switchConflict, '迁移任务已标记为完成切换，但缺少切换记录', {
      kind: 'state-conflict',
    });
  }
  if (job.state !== 'copying' && job.state !== 'verified') {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, `迁移任务处于 ${job.state} 状态，拒绝切换`, {
      kind: 'state-not-switchable',
    });
  }

  const source = resolve(input.sourcePath);
  const target = resolve(input.targetPath);
  const active = resolve(input.activePath);
  if (target === source) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, '目标路径与源路径相同，拒绝切换', {
      kind: 'target-path-equals-source',
    });
  }
  if (active === source) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, '活动路径与源路径相同，拒绝覆盖源数据', {
      kind: 'active-path-equals-source',
    });
  }
  requirePreparedTarget(target);

  const holder = input.lock.acquire(
    { jobId: job.jobId, schemaVersion: job.schemaVersion, sourcePath: input.sourcePath },
    now(),
  );
  try {
    markSourceReadOnly(source);
    switchFiles(target, active, job.jobId);
    const switchedAt = now();
    input.store.transaction((tx) => {
      input.store.saveSwitch(tx, {
        jobId: job.jobId,
        reportDigest: report.digest,
        activePath: active,
        switchedAt,
      });
      input.store.save(tx, { ...job, state: 'switched' });
    });
    return { jobId: job.jobId, activePath: active, switchedAt, switched: true };
  } finally {
    input.lock.release(holder.lockId);
  }
}

/** 把源文件标记为只读并确认写入权限已经消失。 */
function markSourceReadOnly(sourcePath: string): void {
  try {
    chmodSync(sourcePath, 0o444);
  } catch (error) {
    throw new StorageError(STORAGE_ERROR_CODES.sourceNotReadOnly, '源数据标记为只读失败，拒绝切换', {
      kind: 'source-not-markable',
      errno: errnoOf(error),
    });
  }
  if ((statSync(sourcePath).mode & 0o222) !== 0) {
    throw new StorageError(STORAGE_ERROR_CODES.sourceNotReadOnly, '源数据文件仍然带有写入权限，拒绝完成切换', {
      kind: 'source-still-writable',
    });
  }
}

/** 核对目标文件已经就绪。 */
function requirePreparedTarget(targetPath: string): void {
  if (!existsSync(targetPath)) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, '目标文件不存在，拒绝切换', {
      kind: 'target-missing',
    });
  }
  if (!statSync(targetPath).isFile()) {
    throw new StorageError(STORAGE_ERROR_CODES.switchNotAllowed, '目标路径不是普通文件，拒绝切换', {
      kind: 'target-not-file',
    });
  }
}

/** 把目标换到活动路径；已有活动文件改名留档，不删除。 */
function switchFiles(targetPath: string, activePath: string, jobId: string): void {
  if (targetPath === activePath) return;
  if (existsSync(activePath)) renameSync(activePath, `${activePath}.superseded-${jobId}`);
  renameSync(targetPath, activePath);
  fsyncDirectory(dirname(activePath));
}

/** 落盘一个目录，保证改名在崩溃后可见。 */
function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** 校验报告字段。 */
function requireReport(parsed: unknown): MigrationVerificationReport {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StorageError(STORAGE_ERROR_CODES.verificationFailed, '验证报告不是 JSON 对象，拒绝切换', {
      kind: 'report-malformed',
    });
  }
  const candidate = parsed as Record<string, unknown>;
  for (const field of ['jobId', 'sourceDigest', 'targetDigest'] as const) {
    const value = candidate[field];
    if (typeof value !== 'string' || value === '') {
      throw new StorageError(STORAGE_ERROR_CODES.verificationFailed, `验证报告缺少字段 ${field}，拒绝切换`, {
        kind: 'report-malformed',
      });
    }
  }
  for (const field of ['schemaVersion', 'sourceRecords', 'targetRecords', 'verifiedAt'] as const) {
    const value = candidate[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new StorageError(STORAGE_ERROR_CODES.verificationFailed, `验证报告的 ${field} 不是非负整数，拒绝切换`, {
        kind: 'report-malformed',
      });
    }
  }
  if (typeof candidate.passed !== 'boolean') {
    throw new StorageError(STORAGE_ERROR_CODES.verificationFailed, '验证报告缺少通过状态，拒绝切换', {
      kind: 'report-malformed',
    });
  }
  return candidate as unknown as MigrationVerificationReport;
}

/** 取系统错误的 errno 名称。 */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}
