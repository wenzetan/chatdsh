/**
 * 资源限制、背压与容量报告的遥测出口。
 *
 * 拒绝与背压分支优先记录：每次拒绝写一条带 `error.type` 与 `error.code` 的事件，累计一个
 * 按资源种类分组的计数，并把实测值记进按字节或按毫秒的分布。当前连接数、在途任务数与排队
 * 深度用当前量上报。容量报告按场景记录耗时分布、常驻内存与文件描述符。
 *
 * 属性只放枚举、计数、尺寸与耗时；不写请求体原文、提示词、文件路径与凭据。
 * @module @chatdsh/gateway/resource-limits/telemetry
 */

import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';
import type { ResourceRejection, ResourceScope, ScenarioReport } from '@chatdsh/core-limits';

/** span 名称。 */
export const RESOURCE_SPANS = {
  /** 资源守卫判定一次尺寸或数量。 */
  guard: 'chatdsh.gateway.resource.guard',
  /** 公平调度与背压处理。 */
  backpressure: 'chatdsh.gateway.resource.backpressure',
  /** 容量报告的一个场景。 */
  capacity: 'chatdsh.gateway.capacity.report',
} as const;

/** 事件名称。 */
export const RESOURCE_EVENTS = {
  /** 资源超限或库存不足被拒绝。 */
  rejected: 'chatdsh.gateway.resource.rejected',
  /** 慢消费超过预算，目标被终止并给出续读入口。 */
  backpressureRejected: 'chatdsh.gateway.resource.backpressure.rejected',
  /** 容量场景测量完成。 */
  capacityScenario: 'chatdsh.gateway.capacity.scenario',
} as const;

/** 指标名称。 */
export const RESOURCE_METRICS = {
  /** 判定次数。 */
  checks: 'chatdsh_gateway_resource_checks_total',
  /** 拒绝次数。 */
  rejections: 'chatdsh_gateway_resource_rejections_total',
  /** 通过的负载字节分布。 */
  bytes: 'chatdsh_gateway_resource_bytes',
  /** 当前在途任务数。 */
  inflight: 'chatdsh_gateway_resource_inflight',
  /** 当前排队深度。 */
  queueDepth: 'chatdsh_gateway_resource_queue_depth',
  /** 当前事件流连接数。 */
  connections: 'chatdsh_gateway_resource_connections',
  /** 背压处理结果。 */
  backpressure: 'chatdsh_gateway_resource_backpressure_total',
  /** 背压时刻的在途字节分布。 */
  pendingBytes: 'chatdsh_gateway_resource_pending_bytes',
  /** 容量场景结果。 */
  capacityScenarios: 'chatdsh_gateway_capacity_scenarios_total',
  /** 容量场景耗时分布。 */
  capacityDuration: 'chatdsh_gateway_capacity_duration_seconds',
  /** 容量场景常驻内存分布。 */
  capacityRss: 'chatdsh_gateway_capacity_rss_bytes',
  /** 容量场景文件描述符分布。 */
  capacityFds: 'chatdsh_gateway_capacity_file_descriptors',
  /** 容量场景订阅计数分布。 */
  capacitySubscriptions: 'chatdsh_gateway_capacity_subscriptions',
} as const;

/** 遥测出口。未安装遥测时全部方法退化为空操作。 */
export class ResourceTelemetry {
  constructor(private readonly telemetry: ChatdshTelemetry | undefined) {}

  /** 遥测是否开启。 */
  get enabled(): boolean {
    return this.telemetry?.enabled === true;
  }

  /** 开始一个 span；未开启时为 `undefined`。 */
  start(name: string, attributes: Record<string, string | number | boolean>): TelemetrySpan | undefined {
    if (this.telemetry === undefined || !this.telemetry.enabled) return undefined;
    return this.telemetry.startSpan(name, attributes);
  }

  /**
   * 把一次拒绝写进 span。
   *
   * 只用登记过的属性键：字节额度写 `bytes`，数量额度写 `count`，时长额度写 `duration`。
   * @param span - 目标 span。
   * @param rejection - 拒绝描述。
   */
  markRejection(span: TelemetrySpan, rejection: ResourceRejection): void {
    span.setAttribute('kind', rejection.scope);
    span.setAttribute('outcome', 'rejected');
    span.setAttribute('error.type', 'resource');
    span.setAttribute('error.code', rejection.code);
    if (rejection.unit === 'bytes') span.setAttribute('bytes', rejection.observed);
    else if (rejection.unit === 'milliseconds') span.setAttribute('duration', rejection.observed);
    else span.setAttribute('count', rejection.observed);
  }

  /**
   * 记录一次守卫判定。
   * @param scope - 资源种类。
   * @param outcome - 通过或拒绝。
   * @param observed - 实测数值。
   */
  check(scope: ResourceScope, outcome: 'accepted' | 'rejected', observed: number): void {
    if (!this.enabled) return;
    this.telemetry?.counter(RESOURCE_METRICS.checks, { description: '资源额度判定次数' })
      .add(1, { kind: scope, outcome });
    if (outcome === 'accepted') {
      this.telemetry?.histogram(RESOURCE_METRICS.bytes, { unit: 'By', description: '通过额度判定的负载字节' })
        .record(observed, { kind: scope });
    }
  }

  /**
   * 记录一次拒绝。事件、计数与实测值一起写。
   * @param rejection - 拒绝描述。
   */
  rejected(rejection: ResourceRejection): void {
    if (!this.enabled) return;
    this.telemetry?.event(RESOURCE_EVENTS.rejected, {
      kind: rejection.scope,
      reason: rejection.entry,
      outcome: 'rejected',
      'error.type': 'resource',
      'error.code': rejection.code,
      ...(rejection.unit === 'bytes'
         ? { bytes: rejection.observed }
        : rejection.unit === 'milliseconds'
          ? { duration: rejection.observed }
          : { count: rejection.observed }),
    });
    this.telemetry?.counter(RESOURCE_METRICS.rejections, { description: '资源额度拒绝次数' })
      .add(1, { kind: rejection.scope, 'error.code': rejection.code });
  }

  /**
   * 记录一次背压处理。
   * @param scope - 资源种类。
   * @param outcome - 挂起、恢复或终止。
   * @param pendingBytes - 处理时的在途字节。
   */
  backpressure(scope: ResourceScope, outcome: 'suspended' | 'resumed' | 'terminated', pendingBytes: number): void {
    if (!this.enabled) return;
    this.telemetry?.counter(RESOURCE_METRICS.backpressure, { description: '背压处理结果' })
      .add(1, { kind: scope, outcome });
    this.telemetry?.histogram(RESOURCE_METRICS.pendingBytes, { unit: 'By', description: '背压时刻的在途字节' })
      .record(pendingBytes, { kind: scope, outcome });
  }

  /**
   * 记录一次背压终止的失败事件。
   * @param rejection - 终止原因。
   * @param servedItems - 已发送条数。
   */
  backpressureRejected(rejection: ResourceRejection, servedItems: number): void {
    if (!this.enabled) return;
    this.telemetry?.event(RESOURCE_EVENTS.backpressureRejected, {
      kind: rejection.scope,
      reason: rejection.entry,
      count: servedItems,
      outcome: 'rejected',
      'error.type': 'backpressure',
      'error.code': rejection.code,
    });
  }

  /** 记录当前在途任务数。 */
  gaugeInflight(kind: string, value: number): void {
    if (!this.enabled) return;
    this.telemetry?.gauge(RESOURCE_METRICS.inflight, { description: '当前在途任务数' }).record(value, { kind });
  }

  /** 记录当前排队深度。 */
  gaugeQueueDepth(kind: string, value: number): void {
    if (!this.enabled) return;
    this.telemetry?.gauge(RESOURCE_METRICS.queueDepth, { description: '当前排队深度' }).record(value, { kind });
  }

  /** 记录当前事件流连接数。 */
  gaugeConnections(value: number): void {
    if (!this.enabled) return;
    this.telemetry?.gauge(RESOURCE_METRICS.connections, { description: '当前事件流连接数' }).record(value);
  }

  /**
   * 记录一个容量场景报告。
   * @param report - 场景报告。
   */
  capacityScenario(report: ScenarioReport): void {
    if (!this.enabled) return;
    const attributes = { scene: report.scenario, outcome: report.passed ? 'passed' : 'breached' };
    const span = this.telemetry?.startSpan(RESOURCE_SPANS.capacity, attributes);
    if (span !== undefined) {
      span.setAttribute('count', report.distribution.count);
      span.setAttribute('duration', report.distribution.p95);
      span.setAttribute('bytes', report.process.rssPeakBytes);
      span.end();
    }
    this.telemetry?.counter(RESOURCE_METRICS.capacityScenarios, { description: '容量场景结果' }).add(1, attributes);
    const scene = { scene: report.scenario };
    for (const sample of report.samplesMs) {
      this.telemetry?.histogram(RESOURCE_METRICS.capacityDuration, { unit: 's', description: '容量场景耗时' })
        .record(sample / 1000, scene);
    }
    this.telemetry?.histogram(RESOURCE_METRICS.capacityRss, { unit: 'By', description: '容量场景常驻内存' })
      .record(report.process.rssPeakBytes, scene);
    this.telemetry?.histogram(RESOURCE_METRICS.capacityFds, { description: '容量场景文件描述符数' })
      .record(report.process.fileDescriptorPeak, scene);
    this.telemetry?.histogram(RESOURCE_METRICS.capacitySubscriptions, { description: '容量场景订阅计数' })
      .record(report.subscriptions.peak, scene);
    this.telemetry?.event(RESOURCE_EVENTS.capacityScenario, {
      scene: report.scenario,
      count: report.distribution.count,
      duration: report.distribution.p95,
      bytes: report.process.rssPeakBytes,
      outcome: report.passed ? 'passed' : 'breached',
    });
  }
}
