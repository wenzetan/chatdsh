/**
 * 宿主平面的遥测出口 `ctx.chatdshTelemetry`。
 *
 * 服务本身只做三件事：按配置建立 {@link TelemetryController}、注册状态、自检、诊断导出、
 * 运行期开关与上报中继五个端点、在 fiber 销毁时释放管道。全部信号能力由控制器提供，
 * 其他端复用同一个客户端。
 * @module @chatdsh/host-telemetry/service
 */

import { Service, schema as z, type Context } from '@chatdsh/adapter';
import {
  CHATDSH_TELEMETRY_SERVICE,
  type ChatdshTelemetry,
  type TelemetryAttributes,
  type TelemetryCarrier,
  type TelemetryCounter,
  type TelemetryGauge,
  type TelemetryHistogram,
  type TelemetryInstrumentOptions,
  type TelemetryLogLevel,
  type TelemetryOffReason,
  type TelemetrySpan,
} from '@chatdsh/core-contracts';
import type { TelemetryConfig } from '@chatdsh/core-diagnostics/config';
import type { TelemetryDiagnosticsExport } from '@chatdsh/core-diagnostics/client';
import { TelemetryController } from './controller.ts';
import { Config } from './schema.ts';
import { registerTelemetryEndpoints } from './endpoints.ts';

/**
 * 遥测出口。
 *
 * 需要 `otel`、`webServer`、`settings` 三个服务；缺少任一个时插件不激活，由加载器报告缺失项。
 */
export class ChatdshTelemetryService extends Service implements ChatdshTelemetry {
  /** 配置 schema。 */
  static Config: z<TelemetryConfig> = Config;

  /** 依赖的服务：传输证明、状态与自检端点、设置面。 */
  static inject = ['otel', 'webServer', 'settings'];

  private readonly controller: TelemetryController;

  constructor(ctx: Context, config: TelemetryConfig) {
    super(ctx, CHATDSH_TELEMETRY_SERVICE);
    const controller = new TelemetryController({ config, component: '@chatdsh/host-telemetry' });
    this.controller = controller;

    // 状态端点在两种状态下都可用；自检与中继端点由自身按开关给出 409 与 404。
    const releaseEndpoints = registerTelemetryEndpoints(ctx, {
      get enabled(): boolean {
        return controller.enabled;
      },
      get reason(): string | undefined {
        return controller.reason;
      },
      status: () => Promise.resolve(controller.status()),
      selfTest: async () => (await controller.selfTest()).probeId,
      diagnostics: async (limit?: number) => controller.diagnostics(limit) as unknown as Record<string, unknown>,
      setEnabled: async (enabled: boolean) => {
        await controller.setEnabled(enabled);
        return controller.status();
      },
      relay: (signal, body) => controller.relay(signal, body),
    });

    ctx.effect(() => () => {
      releaseEndpoints();
      void controller.shutdown();
    }, 'chatdsh-telemetry');
  }

  /** 当前开关状态。 */
  get enabled(): boolean {
    return this.controller.enabled;
  }

  /** 关闭原因；开启时为 `undefined`。 */
  get reason(): TelemetryOffReason | undefined {
    return this.controller.reason;
  }

  /** 全部关闭来源的判定结果。 */
  get sources(): Record<string, boolean> {
    return { ...this.controller.sources };
  }

  /** 记录一条结构化事件日志。 */
  event(name: string, attributes?: TelemetryAttributes, body?: string): void {
    this.controller.event(name, attributes, body);
  }

  /** 记录一条诊断日志。 */
  log(level: TelemetryLogLevel, message: string, attributes?: TelemetryAttributes): void {
    this.controller.log(level, message, attributes);
  }

  /** 取得计数器句柄。 */
  counter(name: string, options?: TelemetryInstrumentOptions): TelemetryCounter {
    return this.controller.counter(name, options);
  }

  /** 取得分布句柄。 */
  histogram(name: string, options?: TelemetryInstrumentOptions): TelemetryHistogram {
    return this.controller.histogram(name, options);
  }

  /** 取得当前量句柄。 */
  gauge(name: string, options?: TelemetryInstrumentOptions): TelemetryGauge {
    return this.controller.gauge(name, options);
  }

  /** 开始一个 span。 */
  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan {
    return this.controller.startSpan(name, attributes);
  }

  /** 异步执行并把结果或错误记入 span，自动结束 span。 */
  runSpan<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    return this.controller.runSpan(name, attributes, fn);
  }

  /** 同步版本。 */
  runSpanSync<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => T): T {
    return this.controller.runSpanSync(name, attributes, fn);
  }

  /** 把当前上下文写进载体。 */
  inject(carrier: TelemetryCarrier): TelemetryCarrier {
    return this.controller.inject(carrier);
  }

  /** 从载体还原父上下文。 */
  extract(carrier: TelemetryCarrier): TelemetryCarrier {
    return this.controller.extract(carrier);
  }

  /** 在还原出的上下文里执行。 */
  withContext<T>(carrier: TelemetryCarrier, fn: () => T): T {
    return this.controller.withContext(carrier, fn);
  }

  /** 当前 span 的 trace id。 */
  currentTraceId(): string | undefined {
    return this.controller.currentTraceId();
  }

  /** 有界刷新。 */
  flush(deadlineMs: number): Promise<void> {
    return this.controller.flush(deadlineMs);
  }

  /** 释放 exporter 与 HTTP 代理。 */
  shutdown(): Promise<void> {
    return this.controller.shutdown();
  }

  /** 状态快照：开关、全部关闭来源、端点、队列深度与丢弃计数。 */
  status(): Record<string, unknown> {
    return this.controller.status();
  }

  /** 诊断导出：脱敏后的最近事件与丢弃汇总。 */
  diagnostics(limit?: number): TelemetryDiagnosticsExport {
    return this.controller.diagnostics(limit);
  }

  /**
   * 重载配置：设置文件、设置页开关与命令写入后由宿主调用。
   * @param config - 新配置。
   * @returns 切换完成后解析。
   */
  applyConfig(config: TelemetryConfig): Promise<void> {
    return this.controller.applyConfig(config);
  }

  /**
   * 运行期切换开关。
   * @param enabled - 目标状态。
   * @returns 切换完成后解析。
   */
  setEnabled(enabled: boolean): Promise<void> {
    return this.controller.setEnabled(enabled);
  }

  /**
   * 重读环境变量并重新判定关闭来源。
   * @returns 切换完成后解析。
   */
  refresh(): Promise<void> {
    return this.controller.refresh();
  }
}

export { ChatdshTelemetryService as default };
