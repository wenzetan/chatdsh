/**
 * 迁移锁。
 *
 * 锁是目标目录下的一个独占文件，内容记录持有者信息：进程号、用户、获取时刻、心跳时刻与
 * 任务标识。持有进程被终止后，锁文件仍然存在，接手方按「进程已不在」「进程号被复用」
 * 「心跳过期」「内容无法解析」四种理由判定为残留，并显式回收后再获取。
 * @module @chatdsh/gateway/migrations/lock
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_ERROR_CODES, StorageError } from '../storage/errors.ts';

/** 锁文件名。 */
export const MIGRATION_LOCK_FILE = 'migration.lock';

/** 缺省的心跳过期时限，单位毫秒。 */
export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

/** 锁持有者信息。 */
export interface MigrationLockHolder {
  /** 本次获取的锁标识。 */
  readonly lockId: string;
  /** 持有进程号。 */
  readonly pid: number;
  /** 持有进程的用户号；取不到时为 -1。 */
  readonly uid: number;
  /** 获取时刻的毫秒时间戳。 */
  readonly acquiredAt: number;
  /** 最近一次心跳的毫秒时间戳。 */
  readonly heartbeatAt: number;
  /** 持有进程的启动刻度，用于识别进程号被复用；取不到时为空。 */
  readonly processStart: string | null;
  /** 持有进程的命令行。 */
  readonly command: string;
  /** 迁移任务标识。 */
  readonly jobId: string;
  /** 目标 schema 版本。 */
  readonly schemaVersion: number;
  /** 源路径。 */
  readonly sourcePath: string;
  /** 目标目录。 */
  readonly targetRoot: string;
}

/** 残留判定理由。 */
export type LockStaleReason = 'process-gone' | 'process-replaced' | 'heartbeat-expired' | 'malformed';

/** 锁的当前状态。 */
export interface MigrationLockState {
  /** 锁文件是否存在。 */
  readonly present: boolean;
  /** 解析出的持有者；内容无法解析时为空。 */
  readonly holder?: MigrationLockHolder;
  /** 是否判定为残留。 */
  readonly stale: boolean;
  /** 残留判定理由。 */
  readonly staleReasons: readonly LockStaleReason[];
}

/** 锁的遥测面。 */
export type MigrationLockTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter'>;

/** 获取锁时的输入。 */
export interface MigrationLockInput {
  /** 迁移任务标识。 */
  readonly jobId: string;
  /** 目标 schema 版本。 */
  readonly schemaVersion: number;
  /** 源路径。 */
  readonly sourcePath: string;
}

/** 迁移锁。 */
export class MigrationLock {
  /** 锁文件路径。 */
  readonly path: string;
  private readonly targetRoot: string;
  private readonly staleAfterMs: number;
  private readonly telemetry: MigrationLockTelemetry;

  constructor(options: {
    readonly targetRoot: string;
    readonly telemetry: MigrationLockTelemetry;
    readonly staleAfterMs?: number;
  }) {
    this.targetRoot = options.targetRoot;
    this.telemetry = options.telemetry;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_MS;
    this.path = join(options.targetRoot, MIGRATION_LOCK_FILE);
  }

  /**
   * 读取锁的当前状态。
   * @param now - 判定时刻，缺省取系统时钟。
   * @returns 锁状态。
   */
  inspect(now: number = Date.now()): MigrationLockState {
    if (!existsSync(this.path)) return { present: false, stale: false, staleReasons: [] };
    const holder = this.parse(readFileSync(this.path, 'utf8'));
    if (holder === undefined) return { present: true, stale: true, staleReasons: ['malformed'] };
    const staleReasons: LockStaleReason[] = [];
    if (!isProcessAlive(holder.pid)) {
      staleReasons.push('process-gone');
    } else if (holder.processStart !== null && processStartOf(holder.pid) !== holder.processStart) {
      staleReasons.push('process-replaced');
    }
    if (now - holder.heartbeatAt > this.staleAfterMs) staleReasons.push('heartbeat-expired');
    return { present: true, holder, stale: staleReasons.length > 0, staleReasons };
  }

  /**
   * 获取排他锁。
   *
   * 锁被仍然有效的持有者占用时抛出 `migration-lock-held`；锁是残留时抛出
   * `migration-lock-stale`，需要先显式回收。
   * @param input - 任务标识、目标版本与源路径。
   * @param now - 获取时刻，缺省取系统时钟。
   * @returns 本次获取的持有者信息。
   */
  acquire(input: MigrationLockInput, now: number = Date.now()): MigrationLockHolder {
    const state = this.inspect(now);
    if (state.present) {
      const holder = state.holder;
      const reason = state.stale
        ? STORAGE_ERROR_CODES.migrationLockStale
        : STORAGE_ERROR_CODES.migrationLockHeld;
      this.telemetry.counter('chatdsh_gateway_migration_locks_total', { description: '迁移锁的获取、回收与释放结果' })
        .add(1, { outcome: 'rejected', 'error.code': reason });
      this.telemetry.event('chatdsh.gateway.migration.lock.rejected', {
        outcome: 'rejected',
        'error.type': 'StorageError',
        'error.code': reason,
        kind: holder === undefined ? 'malformed' : state.staleReasons[0] ?? 'held',
        count: holder?.pid ?? 0,
      });
      throw new StorageError(reason, state.stale ? '迁移锁是残留锁，需要先回收' : '迁移锁被其他进程持有', {
        staleReasons: state.staleReasons.join(','),
        holderPid: holder?.pid ?? 0,
        holderJob: holder?.jobId ?? '',
      });
    }
    const holder: MigrationLockHolder = {
      lockId: randomUUID(),
      pid: process.pid,
      uid: typeof process.getuid === 'function' ? process.getuid() : -1,
      acquiredAt: now,
      heartbeatAt: now,
      processStart: processStartOf(process.pid),
      command: process.argv.join(' '),
      jobId: input.jobId,
      schemaVersion: input.schemaVersion,
      sourcePath: input.sourcePath,
      targetRoot: this.targetRoot,
    };
    const descriptor = openSync(this.path, 'wx', 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(holder, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.telemetry.counter('chatdsh_gateway_migration_locks_total', { description: '迁移锁的获取、回收与释放结果' })
      .add(1, { outcome: 'acquired' });
    return holder;
  }

  /**
   * 更新心跳。
   * @param lockId - 本次持有的锁标识。
   * @param now - 心跳时刻，缺省取系统时钟。
   * @returns 更新后的持有者信息。
   */
  heartbeat(lockId: string, now: number = Date.now()): MigrationLockHolder {
    const holder = this.requireHolder(lockId);
    const updated: MigrationLockHolder = { ...holder, heartbeatAt: now };
    const temporary = `${this.path}.tmp-${lockId}`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(updated, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.path);
    return updated;
  }

  /**
   * 释放锁。
   * @param lockId - 本次持有的锁标识。
   */
  release(lockId: string): void {
    this.requireHolder(lockId);
    unlinkSync(this.path);
    this.telemetry.counter('chatdsh_gateway_migration_locks_total', { description: '迁移锁的获取、回收与释放结果' })
      .add(1, { outcome: 'released' });
  }

  /**
   * 回收残留锁。
   *
   * 残留锁文件改名留档，证据不删除；返回被回收的持有者信息。
   * @param now - 回收时刻，缺省取系统时钟。
   * @returns 被回收的持有者；内容无法解析时给出空进程号。
   */
  reclaimStale(now: number = Date.now()): MigrationLockHolder {
    const state = this.inspect(now);
    if (!state.present) {
      throw new StorageError(STORAGE_ERROR_CODES.migrationLockMismatch, '没有可回收的迁移锁');
    }
    if (!state.stale) {
      throw new StorageError(STORAGE_ERROR_CODES.migrationLockHeld, '迁移锁仍由有效持有者占用，不能回收', {
        holderPid: state.holder?.pid ?? 0,
      });
    }
    const holder = state.holder ?? {
      lockId: 'malformed',
      pid: 0,
      uid: -1,
      acquiredAt: 0,
      heartbeatAt: 0,
      processStart: null,
      command: '',
      jobId: '',
      schemaVersion: 0,
      sourcePath: '',
      targetRoot: this.targetRoot,
    };
    renameSync(this.path, `${this.path}.stale-${holder.lockId}`);
    this.telemetry.counter('chatdsh_gateway_migration_locks_total', { description: '迁移锁的获取、回收与释放结果' })
      .add(1, { outcome: 'reclaimed' });
    this.telemetry.event('chatdsh.gateway.migration.lock.reclaimed', {
      outcome: 'reclaimed',
      kind: state.staleReasons[0] ?? 'unknown',
      count: state.staleReasons.length,
      attempt: holder.pid,
    });
    return holder;
  }

  private requireHolder(lockId: string): MigrationLockHolder {
    const state = this.inspect();
    if (!state.present || state.holder === undefined) {
      throw new StorageError(STORAGE_ERROR_CODES.migrationLockMismatch, '迁移锁不存在或内容无法解析');
    }
    if (state.holder.lockId !== lockId) {
      throw new StorageError(STORAGE_ERROR_CODES.migrationLockMismatch, '迁移锁已由其他任务持有', {
        holderJob: state.holder.jobId,
      });
    }
    return state.holder;
  }

  private parse(text: string): MigrationLockHolder | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const fields = ['lockId', 'jobId', 'sourcePath', 'targetRoot', 'command'] as const;
    if (fields.some((field) => typeof candidate[field] !== 'string')) return undefined;
    const numbers = ['pid', 'uid', 'acquiredAt', 'heartbeatAt', 'schemaVersion'] as const;
    if (numbers.some((field) => typeof candidate[field] !== 'number')) return undefined;
    if (candidate.processStart !== null && typeof candidate.processStart !== 'string') return undefined;
    return candidate as unknown as MigrationLockHolder;
  }
}

/**
 * 判断进程是否仍然存在。
 * @param pid - 进程号。
 * @returns 存在为 `true`；无权限探查其他用户的进程时按存在处理。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 读取进程启动刻度。
 * @param pid - 进程号。
 * @returns 启动刻度；进程不在或平台没有该文件时为空。
 */
function processStartOf(pid: number): string | null {
  const path = `/proc/${pid}/stat`;
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const fields = text.slice(end + 2).split(' ');
  return fields[19] ?? null;
}
