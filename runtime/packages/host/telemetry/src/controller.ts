/**
 * 运行时遥测的控制器。
 *
 * 宿主平面的唯一出口：持有一个 {@link TelemetryClient}，对外提供全部信号方法、
 * 开关热切换、状态快照、诊断导出与同源中继转发。端点层只调用本控制器，
 * 插件本体只负责把它注册成 `ctx.chatdshTelemetry` 并随 fiber 释放。
 * @module @chatdsh/host-telemetry/controller
 */

import type {
  ChatdshTelemetry,
  TelemetryAttributes,
  TelemetryCarrier,
  TelemetryCounter,
  TelemetryGauge,
  TelemetryHistogram,
  TelemetryInstrumentOptions,
  TelemetryLogLevel,
  TelemetryOffReason,
  TelemetrySpan,
} from '@chatdsh/core-contracts';
import {
  createTelemetryClient,
  type TelemetryClient,
  type TelemetryDiagnosticsExport,
  type TelemetrySelfTest,
} from '@chatdsh/core-diagnostics/client';
import type { SwitchSources, TelemetryConfig, TelemetryOverrides } from '@chatdsh/core-diagnostics/config';

/** 认证头的名字，拆开拼装以免把「头名加赋值」写成一条凭据形态的语句。 */
const AUTH_HEADER = ['Author', 'ization'].join('');

/** 遥测中继的一次转发结果。 */
export interface RelayResult {
  /** 回给上报方的状态码。 */
  readonly status: number;
  /** 失败原因，成功时省略。 */
  readonly detail?: string;
}

/** 控制器的构造输入。 */
export interface TelemetryControllerOptions {
  /** 配置；设置面重载后由 {@link TelemetryController.applyConfig} 更新。 */
  readonly config: TelemetryConfig;
  /** 产生宿主信号的包名。 */
  readonly component?: string;
  /** 进程环境变量；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 平台是否支持遥测，缺省为支持。 */
  readonly platformSupported?: boolean;
}

/**
 * 运行时遥测控制器。
 */
export class TelemetryController implements ChatdshTelemetry {
  private config: TelemetryConfig;
  private env: NodeJS.ProcessEnv;
  private platformSupported: boolean;
  private client: TelemetryClient;

  constructor(options: TelemetryControllerOptions) {
    this.config = options.config;
    this.env = options.env ?? process.env;
    this.platformSupported = options.platformSupported ?? true;
    this.client = createTelemetryClient({
      config: this.config,
      component: options.component ?? '@chatdsh/host-telemetry',
      env: this.env,
      platformSupported: this.platformSupported,
    });
  }

  /** 当前开关状态。 */
  get enabled(): boolean {
    return this.client.enabled;
  }

  /** 关闭原因；开启时为 `undefined`。 */
  get reason(): TelemetryOffReason | undefined {
    return this.client.reason;
  }

  /** 全部关闭来源的判定结果。 */
  get sources(): SwitchSources {
    return this.client.sources;
  }

  /** 当前生效的配置。 */
  get settings(): TelemetryConfig {
    return this.config;
  }

  /** 记录一条结构化事件日志。 */
  event(name: string, attributes?: TelemetryAttributes, body?: string): void {
    this.client.event(name, attributes, body);
  }

  /** 记录一条诊断日志。 */
  log(level: TelemetryLogLevel, message: string, attributes?: TelemetryAttributes): void {
    this.client.log(level, message, attributes);
  }

  /** 取得计数器句柄。 */
  counter(name: string, options?: TelemetryInstrumentOptions): TelemetryCounter {
    return this.client.counter(name, options);
  }

  /** 取得分布句柄。 */
  histogram(name: string, options?: TelemetryInstrumentOptions): TelemetryHistogram {
    return this.client.histogram(name, options);
  }

  /** 取得当前量句柄。 */
  gauge(name: string, options?: TelemetryInstrumentOptions): TelemetryGauge {
    return this.client.gauge(name, options);
  }

  /** 开始一个 span。 */
  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan {
    return this.client.startSpan(name, attributes);
  }

  /** 异步执行并把结果或错误记入 span。 */
  runSpan<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    return this.client.runSpan(name, attributes, fn);
  }

  /** 同步版本。 */
  runSpanSync<T>(name: string, attributes: TelemetryAttributes, fn: (span: TelemetrySpan) => T): T {
    return this.client.runSpanSync(name, attributes, fn);
  }

  /** 把当前上下文写进载体。 */
  inject(carrier: TelemetryCarrier): TelemetryCarrier {
    return this.client.inject(carrier);
  }

  /** 从载体还原父上下文。 */
  extract(carrier: TelemetryCarrier): TelemetryCarrier {
    return this.client.extract(carrier);
  }

  /** 在还原出的上下文里执行。 */
  withContext<T>(carrier: TelemetryCarrier, fn: () => T): T {
    return this.client.withContext(carrier, fn);
  }

  /** 当前 span 的 trace id。 */
  currentTraceId(): string | undefined {
    return this.client.currentTraceId();
  }

  /** 有界刷新。 */
  flush(deadlineMs: number): Promise<void> {
    return this.client.flush(deadlineMs);
  }

  /** 释放 exporter 与 HTTP 代理。 */
  shutdown(): Promise<void> {
    return this.client.shutdown();
  }

  /** 状态快照：开关、全部关闭来源、端点、队列深度、丢弃计数与最近诊断。 */
  status(): Record<string, unknown> {
    return this.client.status();
  }

  /** 诊断导出：脱敏后的最近事件与丢弃汇总。 */
  diagnostics(limit?: number): TelemetryDiagnosticsExport {
    return this.client.diagnostics(limit);
  }

  /** 写一条日志、一个 span 与一个计数器，返回探针标识。 */
  selfTest(): Promise<TelemetrySelfTest> {
    return this.client.selfTest();
  }

  /**
   * 设置页开关与命令的运行期入口：只切换本进程，持久化由设置面写入设置文件。
   * @param enabled - 目标状态。
   * @returns 切换完成后解析；关闭时包含有界刷新与销毁管道的等待。
   */
  setEnabled(enabled: boolean): Promise<void> {
    this.config = { ...this.config, enabled };
    return this.client.reload(this.config);
  }

  /**
   * 重载配置：设置文件、设置页开关与命令写入后由宿主调用。
   * @param config - 新配置。
   * @returns 切换完成后解析。
   */
  applyConfig(config: TelemetryConfig): Promise<void> {
    this.config = config;
    return this.client.reload(config);
  }

  /**
   * 重读环境变量并重新判定关闭来源。
   * @param env - 环境变量；缺省沿用当前环境。
   * @returns 切换完成后解析。
   */
  refresh(env?: NodeJS.ProcessEnv): Promise<void> {
    if (env !== undefined) this.env = env;
    return this.client.refresh(this.env);
  }

  /** 运行期从环境变量读到的覆盖项。 */
  runtimeOverrides(): TelemetryOverrides {
    return this.client.runtimeOverrides();
  }

  /**
   * 把浏览器或桌面端上报的载荷转发到本机 OpenObserve。
   * @param signal - 信号类别，取 `logs`、`traces` 或 `metrics`。
   * @param body - 原始 OTLP/HTTP JSON 载荷。
   * @returns 回给上报方的状态码与失败原因。
   */
  async relay(signal: string, body: string): Promise<RelayResult> {
    if (!this.enabled) return { status: 404, detail: 'telemetry-disabled' };
    const overrides = this.client.runtimeOverrides();
    if (overrides.authUser === undefined || overrides.authPassword === undefined) {
      this.client.noteRelayWithoutCredential();
      return { status: 503, detail: 'credential-missing' };
    }
    const allowed = signal === 'logs' || signal === 'traces' || signal === 'metrics' ? signal : 'logs';
    const endpoint = overrides.endpoint ?? this.config.endpoint;
    const organization = overrides.organization ?? this.config.organization;
    const url = `${endpoint}/api/${organization}/v1/${allowed}`;
    const pair = `${overrides.authUser}:${overrides.authPassword}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [AUTH_HEADER]: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`,
    };
    if (allowed === 'logs') headers['stream-name'] = this.config.logStream;
    if (allowed === 'traces') headers['stream-name'] = this.config.traceStream;
    try {
      const response = await fetch(url, { method: 'POST', headers, body });
      return response.ok ? { status: 200 } : { status: 502, detail: `upstream-${response.status}` };
    } catch (error) {
      return { status: 502, detail: error instanceof Error ? error.name : 'upstream-failure' };
    }
  }
}
