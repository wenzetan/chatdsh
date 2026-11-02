/**
 * 迁移预检查。
 *
 * 进入维护窗口之前按顺序核对源数据、源格式、目标目录权限、剩余空间与活动写者。每项失败
 * 都在发生位置抛出 `preflight-failed`，消息写明具体原因与数值；全部通过时返回本次核对的
 * 依据，供迁移任务记录与验证报告引用。
 * @module @chatdsh/gateway/storage/preflight
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MigrationLock } from '../migrations/lock.ts';
import { STORAGE_ERROR_CODES, StorageError } from './errors.ts';

/** 源数据的格式。 */
export type MigrationSourceFormat = 'sqlite' | 'jsonl';

/** 预检查项，按执行顺序排列。 */
export type MigrationPreflightCheck = 'source' | 'source-format' | 'target-directory' | 'disk-space' | 'active-writer';

/** 活动写者探测方式；`unsupported` 表示平台没有进程文件描述符目录，只完成了锁与日志文件探测。 */
export type MigrationWriterScan = 'procfs' | 'unsupported';

/** 预检查的遥测面。 */
export type MigrationPreflightTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter' | 'runSpan'>;

/** 预检查输入。 */
export interface MigrationPreflightInput {
  /** 源数据路径。 */
  readonly sourcePath: string;
  /** 源数据格式。 */
  readonly sourceFormat: MigrationSourceFormat;
  /** 目标目录，迁移期间的写入都落在它下面。 */
  readonly targetRoot: string;
  /** 调用方要求的最小剩余空间，单位字节。 */
  readonly requiredFreeBytes: number;
  /** 遥测出口。 */
  readonly telemetry: MigrationPreflightTelemetry;
}

/** 预检查报告。 */
export interface MigrationPreflightReport {
  /** 源数据路径。 */
  readonly sourcePath: string;
  /** 源数据格式。 */
  readonly sourceFormat: MigrationSourceFormat;
  /** 目标目录。 */
  readonly targetRoot: string;
  /** 源数据字节数。 */
  readonly sourceBytes: number;
  /** 核对时刻目标目录的剩余字节数。 */
  readonly freeBytes: number;
  /** 调用方要求的最小剩余字节数。 */
  readonly requiredFreeBytes: number;
  /** 活动写者探测方式。 */
  readonly writerScan: MigrationWriterScan;
  /** 已通过的检查项。 */
  readonly checks: readonly MigrationPreflightCheck[];
  /** JSONL 源校验通过的记录条数；SQLite 源不逐条计数，此处为空。 */
  readonly sourceRecords?: number;
}

/** SQLite 文件头魔数。 */
const SQLITE_MAGIC = 'SQLite format 3';

/** SQLite 文件头长度。 */
const SQLITE_HEADER_BYTES = 16;

/** 预检查探测文件的说明行。 */
const PROBE_CONTENT = 'chatdsh preflight probe\n';

/** 进程文件描述符目录。 */
const PROC_ROOT = '/proc';

/**
 * 执行迁移预检查。
 * @param input - 源与目标路径、源格式、剩余空间阈值与遥测出口。
 * @returns 通过时的预检查报告。
 */
export async function preflightMigration(input: MigrationPreflightInput): Promise<MigrationPreflightReport> {
  requireRequiredBytes(input.requiredFreeBytes);
  return input.telemetry.runSpan(
    'chatdsh.gateway.migration.preflight',
    { outcome: 'attempted' },
    async (span) => {
      const checks: MigrationPreflightCheck[] = [];
      try {
        const sourceBytes = requireSourceFile(input.sourcePath);
        checks.push('source');
        const sourceRecords = await requireSourceFormat(input.sourcePath, input.sourceFormat);
        checks.push('source-format');
        requireTargetDirectory(input.targetRoot);
        probeTargetWritable(input.targetRoot);
        checks.push('target-directory');
        const freeBytes = requireFreeSpace(input.targetRoot, input.requiredFreeBytes);
        checks.push('disk-space');
        const writerScan = requireNoActiveWriter(input);
        checks.push('active-writer');

        span.setAttribute('count', checks.length);
        span.setAttribute('status', 'passed');
        input.telemetry
          .counter('chatdsh_gateway_migration_preflights_total', { description: '迁移预检查结果' })
          .add(1, { outcome: 'passed' });
        return {
          sourcePath: input.sourcePath,
          sourceFormat: input.sourceFormat,
          targetRoot: input.targetRoot,
          sourceBytes,
          freeBytes,
          requiredFreeBytes: input.requiredFreeBytes,
          writerScan,
          checks,
          ...(sourceRecords === undefined ? {} : { sourceRecords }),
        };
      } catch (error) {
        const code = error instanceof StorageError ? error.code : STORAGE_ERROR_CODES.preflightFailed;
        span.setAttribute('status', 'rejected');
        span.setAttribute('count', checks.length);
        input.telemetry
          .counter('chatdsh_gateway_migration_preflights_total', { description: '迁移预检查结果' })
          .add(1, { outcome: 'rejected', 'error.code': code });
        input.telemetry.event('chatdsh.gateway.migration.preflight.rejected', {
          outcome: 'rejected',
          'error.type': error instanceof Error ? error.name : 'Error',
          'error.code': code,
        });
        throw error;
      }
    },
  );
}

/** 以预检查原因码拒绝。 */
function fail(
  check: MigrationPreflightCheck,
  message: string,
  details: Record<string, string | number | boolean> = {},
): never {
  throw new StorageError(STORAGE_ERROR_CODES.preflightFailed, message, { check, ...details });
}

/** 调用方给出的剩余空间阈值必须是非负整数。 */
function requireRequiredBytes(requiredFreeBytes: number): void {
  if (!Number.isSafeInteger(requiredFreeBytes) || requiredFreeBytes < 0) {
    throw new Error(`预检查要求的剩余空间必须是非负整数，实际 ${String(requiredFreeBytes)}`);
  }
}

/** 核对源文件存在、是普通文件并且能以只读方式打开，返回字节数。 */
function requireSourceFile(sourcePath: string): number {
  let info: Stats;
  try {
    info = statSync(sourcePath);
  } catch (error) {
    fail('source', '源数据文件不存在或不可访问，无法执行迁移预检查', { errno: errnoOf(error) });
  }
  if (!info.isFile()) fail('source', '源数据不是普通文件，无法执行迁移预检查');
  try {
    closeSync(openSync(sourcePath, 'r'));
  } catch (error) {
    fail('source', '源数据文件无法以只读方式打开，无法执行迁移预检查', { errno: errnoOf(error) });
  }
  return info.size;
}

/** 按声明的格式核对源数据，返回 JSONL 的记录条数。 */
async function requireSourceFormat(
  sourcePath: string,
  format: MigrationSourceFormat,
): Promise<number | undefined> {
  if (format === 'sqlite') {
    requireSqliteHeader(sourcePath);
    return undefined;
  }
  return requireJsonlRecords(sourcePath);
}

/** 核对 SQLite 文件头。 */
function requireSqliteHeader(sourcePath: string): void {
  const header = Buffer.alloc(SQLITE_HEADER_BYTES);
  const descriptor = openSync(sourcePath, 'r');
  let read: number;
  try {
    read = readSync(descriptor, header, 0, SQLITE_HEADER_BYTES, 0);
  } finally {
    closeSync(descriptor);
  }
  if (read < SQLITE_HEADER_BYTES || header.toString('utf8', 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) {
    fail('source-format', '源数据格式不合法：文件头不是 SQLite 数据库');
  }
}

/** 逐行核对 JSONL，返回记录条数。 */
async function requireJsonlRecords(sourcePath: string): Promise<number> {
  const stream = createReadStream(sourcePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      count += 1;
      requireJsonRecord(line, count);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return count;
}

/** 核对一行 JSONL 是非空行的 JSON 对象。 */
function requireJsonRecord(line: string, index: number): void {
  if (line.trim() === '') fail('source-format', `源数据格式不合法：第 ${index} 行为空行`, { count: index });
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail('source-format', `源数据格式不合法：第 ${index} 行不是合法 JSON`, { count: index });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('source-format', `源数据格式不合法：第 ${index} 行不是 JSON 对象`, { count: index });
  }
}

/** 核对目标目录存在并且是目录。 */
function requireTargetDirectory(targetRoot: string): void {
  let info: Stats;
  try {
    info = statSync(targetRoot);
  } catch (error) {
    fail('target-directory', '目标目录不存在或不可访问，无法执行迁移预检查', { errno: errnoOf(error) });
  }
  if (!info.isDirectory()) fail('target-directory', '目标路径不是目录，无法执行迁移预检查');
}

/** 在目标目录里真实创建、写入、落盘并删除一个探测文件。 */
function probeTargetWritable(targetRoot: string): void {
  const probe = join(targetRoot, `.chatdsh-preflight-${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(probe, 'wx', 0o600);
    try {
      writeSync(descriptor, PROBE_CONTENT);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    unlinkSync(probe);
  } catch (error) {
    fail('target-directory', '目标目录不可写：真实写入探测失败', { errno: errnoOf(error) });
  }
}

/** 核对目标目录的剩余空间满足调用方阈值，返回剩余字节数。 */
function requireFreeSpace(targetRoot: string, requiredFreeBytes: number): number {
  const stats = statfsSync(targetRoot);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (freeBytes < requiredFreeBytes) {
    fail(
      'disk-space',
      `目标目录剩余空间不足：剩余 ${freeBytes} 字节，至少需要 ${requiredFreeBytes} 字节`,
      { freeBytes, requiredBytes: requiredFreeBytes },
    );
  }
  return freeBytes;
}

/** 核对源数据没有活动写者，返回探测方式。 */
function requireNoActiveWriter(input: MigrationPreflightInput): MigrationWriterScan {
  const lock = new MigrationLock({ targetRoot: input.targetRoot, telemetry: input.telemetry });
  const state = lock.inspect();
  if (state.present && !state.stale) {
    fail('active-writer', `源数据存在活动写者：迁移锁由进程 ${state.holder?.pid ?? 0} 持有`, {
      holderPid: state.holder?.pid ?? 0,
    });
  }
  if (input.sourceFormat === 'sqlite') requireNoSqliteWriter(input.sourcePath);
  const scan = scanWriteHandles(input.sourcePath);
  if (scan.pids.length > 0) {
    fail('active-writer', `源数据存在活动写者：进程 ${scan.pids.join('、')} 以可写方式打开源文件`, {
      holders: scan.pids.length,
    });
  }
  return scan.scan;
}

/** 核对 SQLite 源没有未检查点的预写日志或未回滚的回滚日志。 */
function requireNoSqliteWriter(sourcePath: string): void {
  const sidecars: readonly (readonly [string, string])[] = [
    ['-wal', '预写日志'],
    ['-journal', '回滚日志'],
  ];
  for (const [suffix, label] of sidecars) {
    const sidecar = `${sourcePath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    if (statSync(sidecar).size === 0) continue;
    fail('active-writer', `源数据存在活动写者：存在未检查点的${label}文件`, { kind: suffix });
  }
}

/** 在进程文件描述符目录里找出以可写方式打开源文件的进程。 */
function scanWriteHandles(sourcePath: string): {
  readonly scan: MigrationWriterScan;
  readonly pids: readonly number[];
} {
  if (!existsSync(`${PROC_ROOT}/self/fd`)) return { scan: 'unsupported', pids: [] };
  const target = realpathSync(sourcePath);
  const pids: number[] = [];
  for (const entry of readdirSync(PROC_ROOT)) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const directory = `${PROC_ROOT}/${entry}/fd`;
    for (const handle of listHandles(directory)) {
      if (readHandleTarget(`${directory}/${handle}`) !== target) continue;
      if (holdsWriteFlags(`${PROC_ROOT}/${entry}/fdinfo/${handle}`)) pids.push(pid);
    }
  }
  return { scan: 'procfs', pids: pids.sort((left, right) => left - right) };
}

/** 列出进程的文件描述符；其他用户的进程目录不可读时跳过该进程。 */
function listHandles(directory: string): readonly string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** 读一个文件描述符指向的路径；句柄已关闭时为空串。 */
function readHandleTarget(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    return '';
  }
}

/** 判断一个文件描述符是否以可写方式打开。 */
function holdsWriteFlags(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const match = /flags:\s*([0-7]+)/.exec(text);
  if (match === null || match[1] === undefined) return false;
  return (Number.parseInt(match[1], 8) & 0o3) !== 0;
}

/** 取系统错误的 errno 名称。 */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}
