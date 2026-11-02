/**
 * 备份、校验与恢复的遥测：动作 span、失败事件、计数与字节指标。
 *
 * 每个对外可观察的动作包在一个 span 里，覆盖结果、对象数与字节；失败分支把 `error.type`
 * 与 `error.code` 写进 span，补一条事件并计入失败计数。遥测出口由调用方注入，本模块不构造
 * exporter；遥测关闭时全部方法退化为直接执行，业务行为不依赖遥测是否开启。
 * @module @chatdsh/gateway/backup/telemetry
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { BackupError } from './errors.ts';

/** 备份与恢复的动作 span 名。 */
export const BACKUP_SPANS = {
  /** 生成备份。 */
  create: 'chatdsh.gateway.backup.create',
  /** 校验既有备份。 */
  verify: 'chatdsh.gateway.backup.verify',
  /** 隔离恢复。 */
  restore: 'chatdsh.gateway.backup.restore',
  /** 恢复后切换。 */
  switch: 'chatdsh.gateway.backup.switch',
  /** 保留策略执行。 */
  retention: 'chatdsh.gateway.backup.retention',
} as const;

/** 备份与恢复的动作 span 名取值。 */
export type BackupSpanName = (typeof BACKUP_SPANS)[keyof typeof BACKUP_SPANS];

/** 失败事件名。 */
export const BACKUP_EVENTS = {
  /** 生成备份失败。 */
  createRejected: 'chatdsh.gateway.backup.rejected',
  /** 校验失败。 */
  verifyRejected: 'chatdsh.gateway.backup.verify.rejected',
  /** 恢复失败。 */
  restoreRejected: 'chatdsh.gateway.backup.restore.rejected',
  /** 恢复完成。 */
  restoreCompleted: 'chatdsh.gateway.backup.restore.completed',
  /** 切换失败。 */
  switchRejected: 'chatdsh.gateway.backup.switch.rejected',
  /** 保留策略删除了过期备份。 */
  retentionPruned: 'chatdsh.gateway.backup.retention.pruned',
} as const;

/** 计数指标名。 */
export const BACKUP_METRICS = {
  /** 备份与恢复动作结果。 */
  operations: 'chatdsh_gateway_backup_operations_total',
  /** 处理的对象条数。 */
  objects: 'chatdsh_gateway_backup_objects_total',
  /** 处理的明文字节数。 */
  bytes: 'chatdsh_gateway_backup_bytes',
  /** 恢复耗时，单位秒。 */
  restoreDuration: 'chatdsh_gateway_restore_duration_seconds',
  /** 保留策略删除的备份套数。 */
  retention: 'chatdsh_gateway_backup_retention_total',
} as const;

/** 动作名，写入 span、事件与指标，便于按动作聚合。 */
export type BackupAction =
  | 'backup.create'
  | 'backup.verify'
  | 'restore.stage'
  | 'restore.verify'
  | 'restore.switch'
  | 'retention.plan'
  | 'retention.prune';

/** 一次动作的附加读数。 */
export interface BackupActionAttributes {
  /** 涉及对象数。 */
  readonly objects?: number;
  /** 涉及字节数。 */
  readonly bytes?: number;
  /** 数据域或种类。 */
  readonly domain?: string;
}

/** 备份遥测出口，只需要用到的方法。 */
export type BackupTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter' | 'histogram' | 'runSpan'>;

/**
 * 备份遥测记录器。
 *
 * 只使用注入的遥测出口，不自行构造 exporter，也不让遥测失败改变控制流。
 */
export class BackupRecorder {
  constructor(private readonly telemetry: BackupTelemetry) {}

  /**
   * 在一个动作 span 里执行，并记录结果计数。
   * @param spanName - span 名。
   * @param action - 动作名。
   * @param eventName - 失败时写入的事件名。
   * @param attributes - 附加对象数与字节。
   * @param body - 动作主体。
   * @returns 动作结果。
   */
  async measure<T>(
    spanName: BackupSpanName,
    action: BackupAction,
    eventName: string,
    attributes: BackupActionAttributes,
    body: (span: { setAttribute(key: string, value: string | number | boolean): void }) => Promise<T>,
  ): Promise<T> {
    const telemetry = this.telemetry;
    const counter = telemetry.counter(BACKUP_METRICS.operations, { description: '备份与恢复动作结果' });
    return telemetry.runSpan(spanName, {
      action,
      ...(attributes.objects === undefined ? {} : { objects: attributes.objects }),
      ...(attributes.bytes === undefined ? {} : { bytes: attributes.bytes }),
      ...(attributes.domain === undefined ? {} : { domain: attributes.domain }),
    }, async (span) => {
      try {
        const value = await body(span);
        span.setAttribute('outcome', 'ok');
        counter.add(1, { action, outcome: 'ok' });
        return value;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = error instanceof BackupError ? error.code : 'backup-unexpected';
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', type);
        span.setAttribute('error.code', code);
        telemetry.event(eventName, { action, outcome: 'failed', 'error.type': type, 'error.code': code });
        counter.add(1, { action, outcome: 'failed', 'error.code': code });
        throw error;
      }
    });
  }

  /** 记录一次处理的对象条数。 */
  objects(action: BackupAction, count: number): void {
    this.telemetry.counter(BACKUP_METRICS.objects, { description: '备份与恢复处理的对象条数' }).add(count, { action });
  }

  /** 记录一次处理的明文字节数。 */
  bytes(action: BackupAction, bytes: number): void {
    this.telemetry.histogram(BACKUP_METRICS.bytes, { description: '备份与恢复处理的明文字节', unit: 'By' }).record(bytes, { action });
  }

  /** 记录一次恢复耗时。 */
  restoreDuration(seconds: number, outcome: 'ok' | 'failed'): void {
    this.telemetry
      .histogram(BACKUP_METRICS.restoreDuration, { description: '隔离恢复耗时', unit: 's' })
      .record(seconds, { outcome });
  }

  /** 记录保留策略删除的备份套数。 */
  retained(removed: number): void {
    this.telemetry.counter(BACKUP_METRICS.retention, { description: '保留策略删除的备份套数' }).add(removed, {
      action: 'retention.prune',
    });
  }
}
