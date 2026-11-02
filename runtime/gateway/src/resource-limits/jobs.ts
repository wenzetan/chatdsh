/**
 * 资源限制服务的真实导出与备份任务。
 *
 * 导出走导出服务的完整生成路径，备份走一致性备份与加密清单的完整路径；两者都由调用方注入到
 * 有界受理里，因此并发与队列的额度作用在真实工作上。任务收到中止信号时先取消当前导出，备份
 * 在开始之前检查信号。
 * @module @chatdsh/gateway/resource-limits/jobs
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { createBackup } from '../backup/create.ts';
import { ExportService } from '../exports/service.ts';
import type { BackupJobOutcome, ExportJobOutcome } from './server.ts';

/** 一个导出范围。 */
export interface ResourceExportScope {
  /** 源会话标识。 */
  readonly sessionId: string;
  /** 起始回合。 */
  readonly turnFrom: number;
  /** 结束回合。 */
  readonly turnTo: number;
}

/** 任务工厂选项。 */
export interface ResourceJobOptions {
  /** 数据根，导出与备份都以它为源。 */
  readonly dataRoot: string;
  /** 控制平面数据库连接。 */
  readonly database: DatabaseSync;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /** 导出范围。 */
  readonly exportScope: ResourceExportScope;
  /** 备份主密钥文件路径；缺省取数据根下的 `backup-master.key`。 */
  readonly keyPath?: string;
}

/** 真实的导出与备份任务。 */
export interface ResourceJobs {
  /** 执行一次导出，等待生成完成。 */
  readonly export: (signal: AbortSignal) => Promise<ExportJobOutcome>;
  /** 执行一次备份，等待清单写完。 */
  readonly backup: (signal: AbortSignal) => Promise<BackupJobOutcome>;
}

/**
 * 建立导出与备份任务。
 * @param options - 数据根、数据库、遥测与导出范围。
 * @returns 两个可直接交给有界受理的任务函数。
 */
export function createResourceJobs(options: ResourceJobOptions): ResourceJobs {
  const exportsRoot = join(options.dataRoot, 'exports');
  mkdirSync(exportsRoot, { recursive: true });
  const service = new ExportService({
    database: options.database,
    telemetry: options.telemetry,
    dataRoot: options.dataRoot,
    exportsRoot,
    localDeviceId: 'local',
  });
  const keyPath = options.keyPath ?? join(options.dataRoot, 'backup-master.key');
  let backupSeq = 0;
  let exportSeq = 0;
  return {
    export: async (signal: AbortSignal) => {
      if (signal.aborted) throw new Error('导出在开始之前被取消');
      exportSeq += 1;
      const job = await service.create({
        operationId: `resource-export-${String(exportSeq)}-${String(Date.now())}`,
        requestDigest: `resource-export-${String(exportSeq)}`,
        scope: {
          source: { kind: 'session', sessionId: options.exportScope.sessionId },
          scope: {
            turnFrom: options.exportScope.turnFrom,
            turnTo: options.exportScope.turnTo,
            eventCount: 0,
            charCount: 0,
            compressed: false,
            attachmentsComplete: true,
          },
          format: 'markdown',
          includeToolReads: false,
          attachmentPolicy: 'available-only',
          timeDisplay: 'local',
          redaction: 'default',
          privateExport: false,
        },
      }, { deviceId: 'local', privateExport: false });
      const onAbort = (): void => {
        void service.cancel(job.jobId);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for (let attempt = 0; attempt < 3000; attempt += 1) {
          const state = await service.job(job.jobId);
          if (state !== undefined && (state.state === 'completed' || state.state === 'failed' || state.state === 'expired')) {
            if (state.state !== 'completed') throw new Error(`导出没有完成：${state.state}`);
            return { jobId: state.jobId, bytes: state.estimate.bytes };
          }
          await new Promise((settle) => setTimeout(settle, 5));
        }
        throw new Error('导出等待超时');
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    backup: async (signal: AbortSignal) => {
      if (signal.aborted) throw new Error('备份在开始之前被取消');
      backupSeq += 1;
      const result = await createBackup({
        sourceRoot: options.dataRoot,
        backupRoot: join(options.dataRoot, 'backups', `set-${String(backupSeq)}`),
        software: { version: '0.1.0' },
        keyPath,
        external: [],
        telemetry: options.telemetry,
      });
      return { objects: result.manifest.totals.objects, bytes: result.manifest.totals.cipherBytes };
    },
  };
}
