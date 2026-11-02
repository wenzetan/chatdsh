/**
 * 备份保留策略与过期清理。
 *
 * 策略按设计固定为每日 7 套、每周 4 套、每月 12 套：同一天只保留最新一套，每周与每月各保留
 * 最新的一套；最新一套永远保留，避免所有备份都过期时把恢复手段一起清掉。清理按套删除整个
 * 备份目录，删除前重新读一次清单确认它就是计划的删除对象。
 * @module @chatdsh/gateway/backup/retention
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_ERROR_CODES, BackupError } from './errors.ts';
import { MANIFEST_FILENAME, readBackupManifest, type BackupRetentionPolicy } from './manifest.ts';
import { BACKUP_EVENTS, BACKUP_SPANS, BackupRecorder, type BackupTelemetry } from './telemetry.ts';

/** 保留策略。 */
export const BACKUP_RETENTION: BackupRetentionPolicy = {
  daily: 7,
  weekly: 4,
  monthly: 12,
  rpoHours: 24,
  restoreTargetMinutes: 30,
  schedule: '每天 03:00（部署 IANA 时区）生成一套，生成前核对剩余空间不少于预计备份的两倍',
};

/** 一套备份的摘要。 */
export interface BackupSetEntry {
  /** 备份套目录名。 */
  readonly name: string;
  /** 目录绝对路径。 */
  readonly path: string;
  /** 清单标识。 */
  readonly manifestId: string;
  /** 生成时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 明文字节数。 */
  readonly plaintextBytes: number;
  /** 命中的保留档位。 */
  readonly buckets: readonly ('daily' | 'weekly' | 'monthly')[];
}

/** 保留计划。 */
export interface RetentionPlan {
  /** 判定时刻。 */
  readonly now: number;
  /** 保留的备份套。 */
  readonly keep: readonly BackupSetEntry[];
  /** 计划删除的备份套。 */
  readonly prune: readonly BackupSetEntry[];
}

/**
 * 列出备份根下的全部备份套。
 * @param setsRoot - 存放各套备份的根目录。
 * @returns 备份套摘要，按生成时刻升序。
 */
export function listBackupSets(setsRoot: string): readonly BackupSetEntry[] {
  if (!existsSync(setsRoot)) {
    throw new BackupError(BACKUP_ERROR_CODES.manifestMissing, `备份根目录不存在：${setsRoot}`, {}, [
      '确认备份根目录，或先生成一套备份',
    ]);
  }
  const entries: BackupSetEntry[] = [];
  for (const name of readdirSync(setsRoot)) {
    const path = join(setsRoot, name);
    if (!statSync(path).isDirectory()) continue;
    if (!existsSync(join(path, MANIFEST_FILENAME))) continue;
    const manifest = readBackupManifest(path);
    entries.push({
      name,
      path,
      manifestId: manifest.manifestId,
      createdAt: manifest.createdAt,
      plaintextBytes: manifest.totals.plaintextBytes,
      buckets: [],
    });
  }
  return entries.sort((left, right) => left.createdAt - right.createdAt || (left.name < right.name ? -1 : 1));
}

/**
 * 按保留策略计算保留与删除。
 *
 * 每天的桶按部署时区以外的 UTC 日界划分：同一天（UTC）只留最新一套，同一个月只留最新一套；
 * 每周按 ISO 周划分。最新一套无论落在哪个档位都保留。
 * @param options - 备份根、判定时刻与策略。
 * @returns 保留计划。
 */
export function planRetention(options: {
  readonly setsRoot: string;
  readonly now?: number;
  readonly policy?: BackupRetentionPolicy;
}): RetentionPlan {
  const policy = options.policy ?? BACKUP_RETENTION;
  const now = options.now ?? Date.now();
  const sets = listBackupSets(options.setsRoot);
  if (sets.length === 0) return { now, keep: [], prune: [] };
  const newest = sets[sets.length - 1] as BackupSetEntry;
  const keep = new Set<string>([newest.name]);
  const buckets: Record<'daily' | 'weekly' | 'monthly', Map<string, BackupSetEntry>> = {
    daily: new Map(),
    weekly: new Map(),
    monthly: new Map(),
  };
  for (const set of sets) {
    collect(buckets.daily, dayKey(set.createdAt), set);
    collect(buckets.weekly, weekKey(set.createdAt), set);
    collect(buckets.monthly, monthKey(set.createdAt), set);
  }
  for (const [bucket, limit] of [['daily', policy.daily], ['weekly', policy.weekly], ['monthly', policy.monthly]] as const) {
    const ordered = [...buckets[bucket].values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, limit);
    for (const set of ordered) keep.add(set.name);
  }
  const annotated = sets.map((set) => ({
    ...set,
    buckets: (['daily', 'weekly', 'monthly'] as const).filter((bucket) => buckets[bucket].get(keyOf(bucket, set.createdAt))?.name === set.name),
  }));
  return {
    now,
    keep: annotated.filter((set) => keep.has(set.name)),
    prune: annotated.filter((set) => !keep.has(set.name)),
  };
}

/**
 * 执行清理：删除计划里的备份套。
 * @param options - 备份根、判定时刻与策略。
 * @returns 删除的套数与释放的明文字节数。
 */
export function pruneBackups(options: {
  readonly setsRoot: string;
  readonly now?: number;
  readonly policy?: BackupRetentionPolicy;
  readonly telemetry: BackupTelemetry;
}): Promise<{ readonly removed: number; readonly bytes: number }> {
  const recorder = new BackupRecorder(options.telemetry);
  return recorder.measure(
    BACKUP_SPANS.retention,
    'retention.prune',
    BACKUP_EVENTS.retentionPruned,
    {},
    async (span) => {
      const plan = planRetention(options);
      let bytes = 0;
      for (const set of plan.prune) {
        const manifest = readBackupManifest(set.path);
        if (manifest.manifestId !== set.manifestId) {
          throw new BackupError(BACKUP_ERROR_CODES.checkpointMismatch, `备份套 ${set.name} 的清单在清理前发生变化`);
        }
        rmSync(set.path, { recursive: true });
        bytes += set.plaintextBytes;
      }
      recorder.retained(plan.prune.length);
      recorder.bytes('retention.prune', bytes);
      span.setAttribute('objects', plan.prune.length);
      span.setAttribute('bytes', bytes);
      options.telemetry.event(BACKUP_EVENTS.retentionPruned, {
        action: 'retention.prune',
        outcome: 'ok',
        objects: plan.prune.length,
      });
      return { removed: plan.prune.length, bytes };
    },
  );
}

/** 把一个备份套放进档位，同档位保留较新的一套。 */
function collect(target: Map<string, BackupSetEntry>, key: string, set: BackupSetEntry): void {
  const current = target.get(key);
  if (current === undefined || current.createdAt < set.createdAt) target.set(key, set);
}

/** 取某档位的键。 */
function keyOf(bucket: 'daily' | 'weekly' | 'monthly', createdAt: number): string {
  if (bucket === 'daily') return dayKey(createdAt);
  if (bucket === 'weekly') return weekKey(createdAt);
  return monthKey(createdAt);
}

/** UTC 日键。 */
function dayKey(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

/** UTC 月键。 */
function monthKey(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 7);
}

/** ISO 周键。 */
function weekKey(createdAt: number): string {
  const date = new Date(createdAt);
  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  const target = new Date(Date.UTC(year, month, day));
  const weekDay = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - weekDay);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
