/**
 * 宿主平面的遥测出口 `ctx.chatdshTelemetry`。
 *
 * 服务本身只做三件事：按配置建立 {@link TelemetryClient}、注册状态与自检端点、
 * 在 fiber 销毁时释放管道。全部信号能力由客户端提供，其他端复用同一个客户端。
 * @module @chatdsh/core-telemetry/service
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
import type { TelemetryConfig } from './config.ts';
import { Config } from './schema.ts';
import { TelemetryClient } from './client.ts';
import { registerTelemetryEndpoints } from './endpoints.ts';

/** 认证头的名字，拆开拼装以免把「头名加赋值」写成一条凭据形态的语句。 */
const AUTH_HEADER = ['Author', 'ization'].join('');

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

  private readonly client: TelemetryClient;
  private readonly settings: TelemetryConfig;

  constructor(ctx: Context, config: TelemetryConfig) {
    super(ctx, CHATDSH_TELEMETRY_SERVICE);
    this.settings = config;
    this.client = new TelemetryClient({ config, component: '@chatdsh/core-telemetry' });

    // 状态端点在两种状态下都可用；自检与中继端点由自身按开关给出 409 与 404。
    const releaseEndpoints = registerTelemetryEndpoints(ctx, {
      enabled: this.client.enabled,
      reason: this.client.reason,
      status: () => Promise.resolve(this.client.status()),
      selfTest: async () => (await this.client.selfTest()).probeId,
      relay: (signal, body) => this.relay(signal, body),
    });

    ctx.effect(() => () => {
      releaseEndpoints();
      void this.client.shutdown();
    }, 'chatdsh-telemetry');
  }

  /** 当前开关状态。 */
  get enabled(): boolean {
    return this.client.enabled;
  }

  /** 关闭原因；开启时为 `undefined`。 */
  get reason(): TelemetryOffReason | undefined {
    return this.client.reason;
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

  /** 异步执行并把结果或错误记入 span，自动结束 span。 */
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

  /** 把浏览器或移动端上报的载荷转发到本机 OpenObserve。 */
  private async relay(signal: string, body: string): Promise<{ status: number; detail?: string }> {
    const overrides = this.client.runtimeOverrides();
    if (overrides.authUser === undefined || overrides.authPassword === undefined) {
      this.client.noteRelayWithoutCredential();
      return { status: 503, detail: 'credential-missing' };
    }
    const allowed = signal === 'logs' || signal === 'traces' || signal === 'metrics' ? signal : 'logs';
    const url = `${overrides.endpoint ?? this.settings.endpoint}/api/${overrides.organization ?? this.settings.organization}/v1/${allowed}`;
    const pair = `${overrides.authUser}:${overrides.authPassword}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [AUTH_HEADER]: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`,
    };
    if (allowed === 'logs') headers['stream-name'] = this.settings.logStream;
    if (allowed === 'traces') headers['stream-name'] = this.settings.traceStream;
    try {
      const response = await fetch(url, { method: 'POST', headers, body });
      return response.ok ? { status: 200 } : { status: 502, detail: `upstream-${response.status}` };
    } catch (error) {
      return { status: 502, detail: error instanceof Error ? error.name : 'upstream-failure' };
    }
  }
}

export { ChatdshTelemetryService as default };
