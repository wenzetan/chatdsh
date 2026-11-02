/**
 * 数据维护的遥测：动作 span、失败事件与计数指标。
 *
 * 每个对外可观察的动作都包在一个 span 里，覆盖结果、计数与字节；失败分支把 `error.type` 与
 * `error.code` 写进 span，并补一条 `chatdsh.gateway.data.rejected` 事件与失败计数。遥测关闭时
 * 全部方法退化为直接执行，业务行为不依赖遥测是否存在。
 * @module @chatdsh/gateway/maintenance/telemetry
 */

import { ChatdshError, CHATDSH_ERROR_CODES, type ChatdshTelemetry, type TelemetrySpan } from '@chatdsh/core-contracts';

/** 数据维护的动作 span 名。 */
export const DATA_SPANS = {
  /** 用量统计。 */
  usage: 'chatdsh.gateway.data.usage',
  /** 保留策略读写与到期候选。 */
  retention: 'chatdsh.gateway.data.retention',
  /** 清理预估与执行。 */
  cleanup: 'chatdsh.gateway.data.cleanup',
  /** 软删除、恢复与永久删除。 */
  deletion: 'chatdsh.gateway.data.deletion',
  /** 血缘查询。 */
  lineage: 'chatdsh.gateway.data.lineage',
} as const;

/** 数据维护动作 span 名的取值。 */
export type DataSpanName = (typeof DATA_SPANS)[keyof typeof DATA_SPANS];

/** 数据维护动作被拒绝或失败的事件名。 */
export const DATA_REJECTED_EVENT = 'chatdsh.gateway.data.rejected';

/** 数据维护动作计数指标。 */
export const DATA_OPERATIONS_METRIC = 'chatdsh_gateway_data_operations_total';

/** 实际释放字节的分布指标。 */
export const DATA_RECLAIMED_METRIC = 'chatdsh_gateway_data_reclaimed_bytes';

/** 数据维护的动作名，写入 span 与指标。 */
export type DataAction =
  | 'usage'
  | 'retention.read'
  | 'retention.write'
  | 'retention.candidates'
  | 'cleanup.estimate'
  | 'cleanup.execute'
  | 'delete.soft'
  | 'delete.inbox'
  | 'delete.restore'
  | 'delete.scope'
  | 'delete.permanent'
  | 'lineage.node'
  | 'lineage.chain';

/** 一次动作的附加读数。 */
export interface DataActionAttributes {
  /** 涉及对象数。 */
  readonly count?: number;
  /** 涉及字节数。 */
  readonly bytes?: number;
  /** 对象种类或维度取值。 */
  readonly kind?: string;
}

/**
 * 数据维护的遥测包装。
 *
 * 只使用 `ctx.chatdshTelemetry` 或控制平面等价客户端的同名方法，不自行构造 exporter。
 */
export class DataTelemetry {
  constructor(private readonly telemetry: ChatdshTelemetry | undefined) {}

  /** 当前是否开启遥测。 */
  get enabled(): boolean {
    return this.telemetry !== undefined;
  }

  /**
   * 在一个动作 span 里执行。
   * @param spanName - span 名。
   * @param action - 动作名。
   * @param attributes - 附加计数与字节。
   * @param body - 动作主体。
   * @returns 动作结果。
   */
  async run<T>(
    spanName: DataSpanName,
    action: DataAction,
    attributes: DataActionAttributes,
    body: (span: TelemetrySpan | undefined) => Promise<T>,
  ): Promise<T> {
    const telemetry = this.telemetry;
    if (telemetry === undefined) return body(undefined);
    const counter = telemetry.counter(DATA_OPERATIONS_METRIC, { description: '数据维护动作结果' });
    return telemetry.runSpan(spanName, {
      action,
      ...(attributes.count === undefined ? {} : { count: attributes.count }),
      ...(attributes.bytes === undefined ? {} : { bytes: attributes.bytes }),
      ...(attributes.kind === undefined ? {} : { kind: attributes.kind }),
    }, async (span) => {
      try {
        const value = await body(span);
        span.setAttribute('outcome', 'ok');
        counter.add(1, { action, outcome: 'ok' });
        return value;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = error instanceof ChatdshError ? error.code : CHATDSH_ERROR_CODES.internalError;
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', type);
        span.setAttribute('error.code', code);
        telemetry.event(DATA_REJECTED_EVENT, { action, outcome: 'failed', 'error.type': type, 'error.code': code });
        counter.add(1, { action, outcome: 'failed' });
        throw error;
      }
    });
  }

  /**
   * 记录一次实际释放的字节。
   * @param action - 动作名。
   * @param bytes - 实际释放的字节数。
   */
  reclaimed(action: DataAction, bytes: number): void {
    this.telemetry?.histogram(DATA_RECLAIMED_METRIC, { description: '数据维护实际释放字节', unit: 'By' })
      .record(bytes, { action });
  }
}
