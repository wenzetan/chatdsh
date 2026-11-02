/**
 * 导出的遥测：动作 span、失败事件、计数指标与字节分布。
 *
 * 每个对外可观察的动作包在一个 span 里，覆盖结果、条数与字节；失败分支把 `error.type` 与
 * `error.code` 写进 span，并补一条 `chatdsh.gateway.export.rejected` 事件与失败计数。生成
 * 完成的真实字节数记进字节分布。遥测关闭时全部方法退化为直接执行，业务行为不依赖它。
 * @module @chatdsh/gateway/exports/telemetry
 */

import { ChatdshError, CHATDSH_ERROR_CODES, type ChatdshTelemetry, type TelemetrySpan } from '@chatdsh/core-contracts';
import { ExportError } from './types.ts';

/** 导出的动作 span 名。 */
export const EXPORT_SPANS = {
  /** 预估。 */
  estimate: 'chatdsh.gateway.export.estimate',
  /** 生成。 */
  generate: 'chatdsh.gateway.export.generate',
  /** 下载。 */
  download: 'chatdsh.gateway.export.download',
} as const;

/** 导出动作 span 名的取值。 */
export type ExportSpanName = (typeof EXPORT_SPANS)[keyof typeof EXPORT_SPANS];

/** 导出动作被拒绝或失败的事件名。 */
export const EXPORT_REJECTED_EVENT = 'chatdsh.gateway.export.rejected';

/** 导出动作计数指标。 */
export const EXPORT_OPERATIONS_METRIC = 'chatdsh_gateway_exports_total';

/** 导出文件字节分布指标。 */
export const EXPORT_BYTES_METRIC = 'chatdsh_gateway_export_bytes';

/** 导出动作名，写入 span 与指标。 */
export type ExportAction = 'estimate' | 'create' | 'cancel' | 'download' | 'print' | 'list';

/** 一次动作的附加读数。 */
export interface ExportActionAttributes {
  /** 涉及条目数。 */
  readonly count?: number;
  /** 涉及字节数。 */
  readonly bytes?: number;
  /** 导出格式。 */
  readonly format?: string;
  /** 范围里的回合数。 */
  readonly turns?: number;
}

/**
 * 导出的遥测包装。
 *
 * 只使用 `ctx.chatdshTelemetry` 或控制平面等价客户端的同名方法，不自行构造 exporter。
 */
export class ExportTelemetry {
  constructor(private readonly telemetry: ChatdshTelemetry | undefined) {}

  /** 当前是否开启遥测。 */
  get enabled(): boolean {
    return this.telemetry !== undefined;
  }

  /**
   * 在一个动作 span 里执行。
   * @param spanName - span 名。
   * @param action - 动作名。
   * @param attributes - 附加读数。
   * @param body - 动作主体。
   * @returns 动作结果。
   */
  async run<T>(
    spanName: ExportSpanName,
    action: ExportAction,
    attributes: ExportActionAttributes,
    body: (span: TelemetrySpan | undefined) => Promise<T>,
  ): Promise<T> {
    const telemetry = this.telemetry;
    if (telemetry === undefined) return body(undefined);
    const counter = telemetry.counter(EXPORT_OPERATIONS_METRIC, { description: '导出动作结果' });
    return telemetry.runSpan(spanName, {
      action,
      ...(attributes.count === undefined ? {} : { count: attributes.count }),
      ...(attributes.bytes === undefined ? {} : { bytes: attributes.bytes }),
      ...(attributes.format === undefined ? {} : { format: attributes.format }),
      ...(attributes.turns === undefined ? {} : { turns: attributes.turns }),
    }, async (span) => {
      try {
        const value = await body(span);
        span.setAttribute('outcome', 'ok');
        counter.add(1, { action, outcome: 'ok' });
        return value;
      } catch (error) {
        const type = error instanceof ExportError ? 'export' : error instanceof Error ? error.name : 'Unknown';
        const code = error instanceof ChatdshError
          ? error.code
          : error instanceof ExportError
            ? error.code
            : CHATDSH_ERROR_CODES.internalError;
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', type);
        span.setAttribute('error.code', code);
        telemetry.event(EXPORT_REJECTED_EVENT, { action, outcome: 'failed', 'error.type': type, 'error.code': code });
        counter.add(1, { action, outcome: 'failed' });
        throw error;
      }
    });
  }

  /**
   * 记录一次导出文件的真实字节数。
   * @param action - 动作名。
   * @param bytes - 字节数。
   * @param format - 导出格式。
   */
  fileBytes(action: ExportAction, bytes: number, format: string): void {
    this.telemetry?.histogram(EXPORT_BYTES_METRIC, { description: '导出文件字节数', unit: 'By' })
      .record(bytes, { action, format });
  }
}
