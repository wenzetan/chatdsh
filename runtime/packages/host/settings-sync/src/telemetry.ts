/**
 * 设置同步的遥测出口。
 *
 * 全部信号名与属性键集中在文档第六节登记过的范围内：上报走写入 span，下发写 home 层时
 * 记一条 span，拒绝与失败各有一条事件，计数指标按结局取值。链路上下文写进发往控制平面的
 * 请求头，遥测关闭时这些调用退化为空操作，业务结果不变。
 * @module @chatdsh/host-settings-sync/telemetry
 */

import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';

/** 上报结局。 */
export type PushOutcome = 'pushed' | 'conflict' | 'rejected' | 'unreachable';

/** 下发结局。 */
export type ApplyOutcome = 'applied' | 'ignored' | 'rejected';

/**
 * 设置同步的遥测记录器。
 */
export class SettingsTelemetry {
  constructor(private readonly client: ChatdshTelemetry | undefined) {}

  /** 在写入 span 里执行一次上报。 */
  async push<T>(namespace: string, key: string, run: (span: TelemetrySpan | undefined) => Promise<T>): Promise<T> {
    if (this.client === undefined) return run(undefined);
    return this.client.runSpan('chatdsh.sync.settings.push', { namespace, key }, async (span) => {
      span.setAttribute('namespace', namespace);
      span.setAttribute('key', key);
      return run(span);
    });
  }

  /** 记录一次上报的结局与计数。 */
  pushOutcome(span: TelemetrySpan | undefined, outcome: PushOutcome): void {
    span?.setAttribute('outcome', outcome);
    this.client?.counter('chatdsh_sync_settings_pushes_total', { description: '设置上报结果' }).add(1, { outcome });
  }

  /** 在写 home 层的 span 里执行一次下发。 */
  async apply<T>(namespace: string, key: string, run: (span: TelemetrySpan | undefined) => Promise<T>): Promise<T> {
    if (this.client === undefined) return run(undefined);
    return this.client.runSpan('chatdsh.sync.settings.apply', { namespace, key }, async (span) => {
      span.setAttribute('namespace', namespace);
      span.setAttribute('key', key);
      return run(span);
    });
  }

  /** 记录一次下发的结局与计数。 */
  applyOutcome(span: TelemetrySpan | undefined, outcome: ApplyOutcome): void {
    span?.setAttribute('outcome', outcome);
    this.client?.counter('chatdsh_sync_settings_applies_total', { description: '设置下发结果' }).add(1, { outcome });
  }

  /** 记录一次被拒绝的分支：版本过期、字段越界、作用范围不符。 */
  rejected(code: string): void {
    this.client?.event('chatdsh.sync.settings.rejected', {
      outcome: 'rejected',
      'error.code': code,
    });
  }

  /** 记录一次失败：控制平面不可达、应答非法。 */
  failed(errorType: string): void {
    this.client?.event('chatdsh.sync.settings.failed', {
      outcome: 'failed',
      'error.type': errorType,
    });
  }

  /** 把当前链路上下文写进请求头。 */
  carrierOf(): Record<string, string> {
    if (this.client === undefined) return {};
    const carrier = this.client.inject({});
    const headers: Record<string, string> = {};
    if (carrier.traceparent !== undefined) headers.traceparent = carrier.traceparent;
    if (carrier.tracestate !== undefined) headers.tracestate = carrier.tracestate;
    return headers;
  }
}
