/**
 * 迁移任务执行。
 *
 * 复制期间持有迁移锁，每批完成后在同一个事务里写入检查点与任务位置；进程重启后从检查点
 * 记录的位置继续，任务或检查点的摘要与本次执行不一致时拒绝续传。锁在退出路径上一定释放。
 * @module @chatdsh/gateway/migrations/runner
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { STORAGE_ERROR_CODES, StorageError } from '../storage/errors.ts';
import type { MigrationJobStore } from '../storage/migration-job.ts';
import type { MigrationLock } from './lock.ts';

/** 一批复制的输入。 */
export interface MigrationCopyBatchInput {
  /** 任务标识。 */
  readonly jobId: string;
  /** 目标中最后一条记录的位置，空目标为 0。 */
  readonly position: number;
  /** 当前已确认的记录条数。 */
  readonly confirmed: number;
}

/** 一批复制的结果。 */
export interface MigrationCopyBatchResult {
  /** 本批在目标中的最后位置，必须大于输入的位置。 */
  readonly position: number;
  /** 本批写入目标的记录条数，必须是正数。 */
  readonly records: number;
  /** 本批源内容的摘要。 */
  readonly sourceDigest: string;
  /** 本批目标内容的摘要，必须与源摘要一致。 */
  readonly targetDigest: string;
}

/** 执行一批复制；没有更多数据时返回空。 */
export type MigrationCopyBatch = (input: MigrationCopyBatchInput) => MigrationCopyBatchResult | undefined;

/** 执行输入。 */
export interface MigrationRunInput {
  /** 任务标识。 */
  readonly jobId: string;
  /** 目标 schema 版本。 */
  readonly schemaVersion: number;
  /** 源摘要。 */
  readonly sourceDigest: string;
  /** 目标摘要。 */
  readonly targetDigest: string;
  /** 源数据路径，写入迁移锁。 */
  readonly sourcePath: string;
  /** 复制回调。 */
  readonly copy: MigrationCopyBatch;
}

/** 执行结果。 */
export interface MigrationRunResult {
  /** 任务标识。 */
  readonly jobId: string;
  /** 本次执行完成的批数。 */
  readonly batches: number;
  /** 检查点位置。 */
  readonly position: number;
  /** 已确认的记录条数。 */
  readonly confirmed: number;
}

/** 执行期的遥测面。 */
export type MigrationRunnerTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter' | 'runSpanSync'>;

/** 迁移任务执行器。 */
export class MigrationJobRunner {
  private readonly lock: MigrationLock;
  private readonly store: MigrationJobStore;
  private readonly telemetry: MigrationRunnerTelemetry;
  private readonly now: () => number;

  constructor(options: {
    /** 迁移锁。 */
    readonly lock: MigrationLock;
    /** 任务与检查点存储。 */
    readonly store: MigrationJobStore;
    /** 遥测出口。 */
    readonly telemetry: MigrationRunnerTelemetry;
    /** 时刻来源，缺省取系统时钟。 */
    readonly now?: () => number;
  }) {
    this.lock = options.lock;
    this.store = options.store;
    this.telemetry = options.telemetry;
    this.now = options.now ?? Date.now;
  }

  /**
   * 执行一次迁移复制。
   *
   * 任务记录的目标 schema 版本或摘要与本次执行不同、任务已完成切换时拒绝；每批摘要不一致、
   * 位置没有前进或没有写入记录时抛 `batch-digest-mismatch`，不写检查点。
   * @param input - 任务标识、版本、摘要、源路径与复制回调。
   * @returns 本次执行的结果。
   */
  run(input: MigrationRunInput): MigrationRunResult {
    return this.telemetry.runSpanSync(
      'chatdsh.gateway.migration.copy',
      { outcome: 'attempted' },
      (span) => {
        const holder = this.lock.acquire(
          { jobId: input.jobId, schemaVersion: input.schemaVersion, sourcePath: input.sourcePath },
          this.now(),
        );
        let batches = 0;
        try {
          const resumed = this.begin(input);
          let position = resumed.position;
          let confirmed = resumed.confirmed;
          for (;;) {
            const batch = input.copy({ jobId: input.jobId, position, confirmed });
            if (batch === undefined) break;
            requireBatch(batch, position);
            position = batch.position;
            confirmed += batch.records;
            batches += 1;
            this.store.transaction((tx) => {
              this.store.saveCheckpoint(tx, {
                jobId: input.jobId,
                sourceDigest: input.sourceDigest,
                targetDigest: input.targetDigest,
                confirmed,
                position,
                recordedAt: this.now(),
              });
              this.store.save(tx, {
                jobId: input.jobId,
                schemaVersion: input.schemaVersion,
                sourceDigest: input.sourceDigest,
                targetDigest: input.targetDigest,
                checkpoint: position,
                state: 'copying',
              });
            });
            this.lock.heartbeat(holder.lockId, this.now());
          }
          span.setAttribute('status', 'copied');
          span.setAttribute('count', batches);
          this.telemetry
            .counter('chatdsh_gateway_migration_batches_total', { description: '迁移复制批次结果' })
            .add(batches, { outcome: 'copied' });
          return { jobId: input.jobId, batches, position, confirmed };
        } catch (error) {
          const code = error instanceof StorageError ? error.code : STORAGE_ERROR_CODES.batchDigestMismatch;
          span.setAttribute('status', 'rejected');
          span.setAttribute('count', batches);
          this.telemetry
            .counter('chatdsh_gateway_migration_batches_total', { description: '迁移复制批次结果' })
            .add(1, { outcome: 'failed', 'error.code': code });
          this.telemetry.event('chatdsh.gateway.migration.copy.failed', {
            outcome: 'failed',
            'error.type': error instanceof Error ? error.name : 'Error',
            'error.code': code,
          });
          throw error;
        } finally {
          this.lock.release(holder.lockId);
        }
      },
    );
  }

  /** 核对既有任务记录与检查点，把任务置为复制中并返回继续位置。 */
  private begin(input: MigrationRunInput): { readonly position: number; readonly confirmed: number } {
    this.store.ensureTables();
    const existing = this.store.job(input.jobId);
    if (existing !== undefined) {
      if (existing.schemaVersion !== input.schemaVersion) {
        throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '迁移任务的目标 schema 版本与本次执行不一致，拒绝续传', {
          kind: 'version-mismatch',
          count: existing.schemaVersion,
        });
      }
      if (existing.sourceDigest !== input.sourceDigest || existing.targetDigest !== input.targetDigest) {
        throw new StorageError(STORAGE_ERROR_CODES.checkpointMismatch, '迁移任务的源或目标摘要与本次执行不一致，拒绝续传', {
          kind: 'digest-mismatch',
        });
      }
      if (existing.state === 'switched') {
        throw new StorageError(STORAGE_ERROR_CODES.switchConflict, '迁移任务已完成切换，不能继续复制', {
          kind: 'already-switched',
        });
      }
    }
    const checkpoint = this.store.checkpoint(input.jobId);
    const position = checkpoint?.position ?? 0;
    const confirmed = checkpoint?.confirmed ?? 0;
    this.store.transaction((tx) => {
      this.store.save(tx, {
        jobId: input.jobId,
        schemaVersion: input.schemaVersion,
        sourceDigest: input.sourceDigest,
        targetDigest: input.targetDigest,
        checkpoint: position,
        state: 'copying',
        ...(existing?.manifestRef === undefined ? {} : { manifestRef: existing.manifestRef }),
      });
    });
    return { position, confirmed };
  }
}

/** 核对一批复制结果。 */
function requireBatch(batch: MigrationCopyBatchResult, previousPosition: number): void {
  if (!Number.isSafeInteger(batch.position) || batch.position <= previousPosition) {
    throw new StorageError(STORAGE_ERROR_CODES.batchDigestMismatch, '本批复制的位置没有前进，拒绝写入检查点', {
      kind: 'position-not-advanced',
      count: previousPosition,
    });
  }
  if (!Number.isSafeInteger(batch.records) || batch.records <= 0) {
    throw new StorageError(STORAGE_ERROR_CODES.batchDigestMismatch, '本批复制没有写入记录，拒绝写入检查点', {
      kind: 'no-records',
    });
  }
  if (batch.sourceDigest === '' || batch.sourceDigest !== batch.targetDigest) {
    throw new StorageError(STORAGE_ERROR_CODES.batchDigestMismatch, '本批复制的结果摘要与源摘要不一致，拒绝写入检查点', {
      kind: 'digest-mismatch',
      count: batch.position,
    });
  }
}
