/**
 * 容量报告的阈值登记与逐场景采样。
 *
 * 阈值取自系统完成设计第九节的验收门槛：静态外壳冷加载 p95≤2 秒、列表首屏 p95≤500 毫秒、
 * 已连接设备事件代理附加延迟 p95≤100 毫秒、大历史首段呈现 p95≤1 秒、控制平面常驻内存
 * ≤512 MiB、活动客户端常驻内存 ≤768 MiB、100 次设备切换后订阅回到基线且内存增长 ≤10%。
 * 阈值对象在构造记录器时必须已经冻结，场景与门槛的对应关系在建表时冻结，测量开始之后无法
 * 增删门槛或改写数值。
 * @module @chatdsh/core-limits/capacity
 */

import { summarize, type Distribution } from './stats.ts';
import { sampleProcess, type ProcessSample } from './sampling.ts';
import type { LimitUnit } from './policy.ts';

const MiB = 1024 * 1024;

/** 容量场景。 */
export type CapacityScenario =
  | 'cold-start'
  | 'shell-static'
  | 'business-activation'
  | 'long-session-pagination'
  | 'concurrent-streaming'
  | 'subscriptions'
  | 'over-limit-upload'
  | 'slow-consumer'
  | 'reconnect'
  | 'queue-recovery'
  | 'replica-catchup'
  | 'export-backup';

/** 全部分位与峰值口径。 */
export interface CapacityThresholds {
  /** 静态外壳冷加载的 p95 上限，毫秒。 */
  readonly staticShellColdLoadMs: number;
  /** 列表首屏的 p95 上限，毫秒。 */
  readonly listFirstScreenMs: number;
  /** 已连接设备事件代理附加延迟的 p95 上限，毫秒。 */
  readonly deviceEventAttachMs: number;
  /** 大历史首段呈现的 p95 上限，毫秒。 */
  readonly largeHistoryFirstSegmentMs: number;
  /** 控制平面常驻内存上限，字节。 */
  readonly controlPlaneRssBytes: number;
  /** 当前活动客户端常驻内存上限，字节。 */
  readonly activeClientRssBytes: number;
  /** 设备切换次数。 */
  readonly deviceSwitchCount: number;
  /** 切换之后常驻内存的增长比例上限。 */
  readonly rssGrowthRatio: number;
  /** 回收容差：文件描述符相对基线的允许增量，个。 */
  readonly fileDescriptorTolerance: number;
  /** 回收容差：订阅相对基线的允许增量，个。 */
  readonly subscriptionTolerance: number;
}

/** 登记在案的阈值。 */
export const CAPACITY_THRESHOLDS: CapacityThresholds = Object.freeze({
  staticShellColdLoadMs: 2000,
  listFirstScreenMs: 500,
  deviceEventAttachMs: 100,
  largeHistoryFirstSegmentMs: 1000,
  controlPlaneRssBytes: 512 * MiB,
  activeClientRssBytes: 768 * MiB,
  deviceSwitchCount: 100,
  rssGrowthRatio: 0.10,
  fileDescriptorTolerance: 8,
  subscriptionTolerance: 0,
});

/** 门槛比较口径。 */
export type GateMetric = 'p95Ms' | 'rssPeakBytes' | 'rssGrowthRatio' | 'fileDescriptorPeak' | 'subscriptionsFinal';

/** 一条门槛。 */
export interface CapacityGate {
  /** 适用场景。 */
  readonly scenario: CapacityScenario;
  /** 比较口径。 */
  readonly metric: GateMetric;
  /** 阈值键。 */
  readonly threshold: keyof CapacityThresholds;
  /** 单位。 */
  readonly unit: LimitUnit | 'ratio';
}

/** 场景与门槛的对应关系，测量之前固定。 */
export const SCENARIO_GATES: readonly CapacityGate[] = Object.freeze([
  { scenario: 'cold-start', metric: 'p95Ms', threshold: 'staticShellColdLoadMs', unit: 'milliseconds' },
  { scenario: 'shell-static', metric: 'p95Ms', threshold: 'staticShellColdLoadMs', unit: 'milliseconds' },
  { scenario: 'business-activation', metric: 'p95Ms', threshold: 'listFirstScreenMs', unit: 'milliseconds' },
  { scenario: 'long-session-pagination', metric: 'p95Ms', threshold: 'largeHistoryFirstSegmentMs', unit: 'milliseconds' },
  { scenario: 'concurrent-streaming', metric: 'rssPeakBytes', threshold: 'controlPlaneRssBytes', unit: 'bytes' },
  { scenario: 'subscriptions', metric: 'p95Ms', threshold: 'deviceEventAttachMs', unit: 'milliseconds' },
  { scenario: 'subscriptions', metric: 'subscriptionsFinal', threshold: 'subscriptionTolerance', unit: 'items' },
  { scenario: 'over-limit-upload', metric: 'rssPeakBytes', threshold: 'controlPlaneRssBytes', unit: 'bytes' },
  { scenario: 'slow-consumer', metric: 'p95Ms', threshold: 'deviceEventAttachMs', unit: 'milliseconds' },
  { scenario: 'reconnect', metric: 'rssGrowthRatio', threshold: 'rssGrowthRatio', unit: 'ratio' },
  { scenario: 'reconnect', metric: 'subscriptionsFinal', threshold: 'subscriptionTolerance', unit: 'items' },
  { scenario: 'queue-recovery', metric: 'rssPeakBytes', threshold: 'controlPlaneRssBytes', unit: 'bytes' },
  { scenario: 'replica-catchup', metric: 'rssPeakBytes', threshold: 'controlPlaneRssBytes', unit: 'bytes' },
  { scenario: 'export-backup', metric: 'rssPeakBytes', threshold: 'controlPlaneRssBytes', unit: 'bytes' },
]);

/** 一条门槛的判定结果。 */
export interface GateResult {
  /** 比较口径。 */
  readonly metric: GateMetric;
  /** 阈值键。 */
  readonly threshold: keyof CapacityThresholds;
  /** 阈值。 */
  readonly limit: number;
  /** 实测值。 */
  readonly observed: number;
  /** 是否满足。 */
  readonly passed: boolean;
}

/** 一个场景的完整报告。 */
export interface ScenarioReport {
  /** 场景。 */
  readonly scenario: CapacityScenario;
  /** 采样开始时刻。 */
  readonly startedAt: number;
  /** 采样结束时刻。 */
  readonly finishedAt: number;
  /** 原始耗时采样，毫秒。 */
  readonly samplesMs: readonly number[];
  /** 耗时分布。 */
  readonly distribution: Distribution;
  /** 进程采样。 */
  readonly process: {
    /** 基线常驻内存字节。 */
    readonly rssBaselineBytes: number;
    /** 常驻内存峰值字节。 */
    readonly rssPeakBytes: number;
    /** 堆已用峰值字节。 */
    readonly heapUsedPeakBytes: number;
    /** 基线文件描述符数。 */
    readonly fileDescriptorBaseline: number;
    /** 文件描述符峰值。 */
    readonly fileDescriptorPeak: number;
    /** 基线子进程数。 */
    readonly childProcessBaseline: number;
    /** 子进程峰值。 */
    readonly childProcessPeak: number;
  };
  /** 订阅计数。 */
  readonly subscriptions: {
    /** 基线。 */
    readonly baseline: number;
    /** 峰值。 */
    readonly peak: number;
    /** 结束值。 */
    readonly final: number;
  };
  /** 结论。 */
  readonly passed: boolean;
  /** 未满足的门槛。 */
  readonly breaches: readonly GateResult[];
}

/** 场景采会话。 */
export interface ScenarioSession {
  /** 场景名。 */
  readonly scenario: CapacityScenario;
  /** 记录一次耗时采样。 */
  sample(ms: number): void;
  /** 采样一次进程并更新峰值。 */
  observe(): void;
  /** 更新订阅计数。 */
  setSubscriptions(count: number): void;
  /** 结束采样并给出报告。 */
  finish(): ScenarioReport;
}

/** 记录器选项。 */
export interface CapacityRecorderOptions {
  /** 登记在案的阈值；必须是冻结对象。 */
  readonly thresholds?: CapacityThresholds;
  /** 时钟；缺省取 `Date.now`。 */
  readonly now?: () => number;
  /** 进程采样；缺省采样当前进程。测量独立进程时传入该进程的采样函数。 */
  readonly sample?: () => ProcessSample;
}

/** 容量记录器。 */
export class CapacityRecorder {
  private readonly thresholds: CapacityThresholds;
  private readonly now: () => number;
  private readonly sampler: () => ProcessSample;
  private readonly registeredAtMs: number;
  private readonly completed: ScenarioReport[] = [];

  constructor(options: CapacityRecorderOptions = {}) {
    const thresholds = options.thresholds ?? CAPACITY_THRESHOLDS;
    if (!Object.isFrozen(thresholds)) {
      throw new Error('容量阈值必须在测量之前登记并冻结，冻结之前不允许开始采样');
    }
    this.thresholds = thresholds;
    this.now = options.now ?? Date.now;
    this.sampler = options.sample ?? sampleProcess;
    this.registeredAtMs = this.now();
  }

  /** 阈值登记时刻。 */
  get registeredAt(): number {
    return this.registeredAtMs;
  }

  /** 登记在案的阈值。 */
  get thresholdsInEffect(): CapacityThresholds {
    return this.thresholds;
  }

  /**
   * 开始一个场景的采样。
   * @param scenario - 场景名。
   * @returns 采会话。
   */
  begin(scenario: CapacityScenario): ScenarioSession {
    const gates = SCENARIO_GATES.filter((gate) => gate.scenario === scenario);
    if (gates.length === 0) throw new Error(`场景没有登记门槛：${scenario}`);
    const baseline = this.sampler();
    const startedAt = this.now();
    const samples: number[] = [];
    let rssPeak = baseline.rssBytes;
    let heapPeak = baseline.heapUsedBytes;
    let fdPeak = baseline.fileDescriptors;
    let childPeak = baseline.childProcesses;
    let subscriptionsBaseline = 0;
    let subscriptionsPeak = 0;
    let subscriptionsFinal = 0;
    const self = this;
    return {
      scenario,
      sample(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`耗时采样必须是非负有限数：${String(ms)}`);
        samples.push(ms);
      },
      observe(): void {
        const current: ProcessSample = self.sampler();
        rssPeak = Math.max(rssPeak, current.rssBytes);
        heapPeak = Math.max(heapPeak, current.heapUsedBytes);
        fdPeak = Math.max(fdPeak, current.fileDescriptors);
        childPeak = Math.max(childPeak, current.childProcesses);
      },
      setSubscriptions(count: number): void {
        if (samples.length === 0) subscriptionsBaseline = count;
        subscriptionsPeak = Math.max(subscriptionsPeak, count);
        subscriptionsFinal = count;
      },
      finish(): ScenarioReport {
        if (samples.length === 0) throw new Error(`场景没有采样：${scenario}`);
        const distribution = summarize(samples);
        const growthRatio = baseline.rssBytes === 0
          ? 0
          : Math.max(0, (rssPeak - baseline.rssBytes) / baseline.rssBytes);
        const observedOf = (metric: GateMetric): number => {
          switch (metric) {
            case 'p95Ms': return distribution.p95;
            case 'rssPeakBytes': return rssPeak;
            case 'rssGrowthRatio': return growthRatio;
            case 'fileDescriptorPeak': return fdPeak - baseline.fileDescriptors;
            case 'subscriptionsFinal': return subscriptionsFinal;
          }
        };
        const results: GateResult[] = gates.map((gate) => {
          const limit = self.thresholds[gate.threshold];
          const observed = observedOf(gate.metric);
          return { metric: gate.metric, threshold: gate.threshold, limit, observed, passed: observed <= limit };
        });
        const breaches = results.filter((result) => !result.passed);
        const finishedAt = self.now();
        const report: ScenarioReport = {
          scenario,
          startedAt,
          finishedAt,
          samplesMs: [...samples],
          distribution,
          process: {
            rssBaselineBytes: baseline.rssBytes,
            rssPeakBytes: rssPeak,
            heapUsedPeakBytes: heapPeak,
            fileDescriptorBaseline: baseline.fileDescriptors,
            fileDescriptorPeak: fdPeak,
            childProcessBaseline: baseline.childProcesses,
            childProcessPeak: childPeak,
          },
          subscriptions: {
            baseline: subscriptionsBaseline,
            peak: subscriptionsPeak,
            final: subscriptionsFinal,
          },
          passed: breaches.length === 0,
          breaches,
        };
        self.completed.push(report);
        return report;
      },
    };
  }

  /** 已完成的场景报告。 */
  reports(): readonly ScenarioReport[] {
    return this.completed;
  }

  /** 是否全部场景通过。 */
  passed(): boolean {
    return this.completed.length > 0 && this.completed.every((report) => report.passed);
  }

  /**
   * 判定预估负载是否仍在安全资源预算内；超预算时抛出拒绝，验证不开始。
   * @param projectedRssBytes - 预估常驻内存字节数。
   * @param concurrency - 即将同时进行的会话或任务数。
   */
  assertSafeLoad(projectedRssBytes: number, concurrency: number): void {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`并发数必须是正整数：${String(concurrency)}`);
    }
    if (projectedRssBytes > this.thresholds.controlPlaneRssBytes) {
      const rejection = {
        code: 'resource-budget-exceeded' as const,
        status: 503,
        scope: 'control-plane-memory' as const,
        unit: 'bytes' as const,
        limit: this.thresholds.controlPlaneRssBytes,
        observed: projectedRssBytes,
        entry: 'later-retry' as const,
        guidance: '预估负载超过安全资源预算，停止本次验证并报告实际条件',
      };
      throw Object.assign(new Error(`${rejection.code}：预估 ${String(projectedRssBytes)} 字节`), { rejection });
    }
    if (concurrency > 100) {
      throw new Error(`并发数超过登记上限：${String(concurrency)}`);
    }
  }

  /** 当前文件描述符数，供回收断言使用。 */
  describeProcess(): { rssBytes: number; fileDescriptors: number; childProcesses: number } {
    const sample = this.sampler();
    return {
      rssBytes: sample.rssBytes,
      fileDescriptors: sample.fileDescriptors,
      childProcesses: sample.childProcesses,
    };
  }

  /** 采样一次当前文件描述符数。 */
  fileDescriptors(): number {
    return this.sampler().fileDescriptors;
  }
}
