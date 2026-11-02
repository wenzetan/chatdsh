/**
 * 浏览器侧遥测：四端共用的统一客户端与同源中继出口。
 *
 * 方法面与 `@chatdsh/core-diagnostics/client` 完全一致：`event`、`log`、`counter`、
 * `histogram`、`gauge`、`startSpan`、`runSpan`、`runSpanSync`、`inject`、`extract`、
 * `withContext`、`currentTraceId`、`flush`、`shutdown`。浏览器不持有 OpenObserve 凭据、
 * 也不加载导出 SDK：记录编成 OTLP/HTTP JSON 经同源端点交给运行时转发。
 *
 * 开关由运行时的状态端点给出：关闭时不建队列、不起定时器、不发请求，也不生成或注入
 * `traceparent`。开关变化在进程内生效，无需重载页面。
 * @module @chatdsh/client-telemetry
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
  RelayTelemetryClient,
  RELAY_CSRF_HEADER,
  RELAY_FLUSH_INTERVAL_MS,
  RELAY_PATH,
  RELAY_SIGNAL_HEADER,
} from '@chatdsh/core-diagnostics/relay';

/** 中继端点。 */
export { RELAY_CSRF_HEADER, RELAY_FLUSH_INTERVAL_MS, RELAY_PATH, RELAY_SIGNAL_HEADER };

/** 运行时状态端点，客户端据此同步开关与关闭原因。 */
export const STATUS_PATH = '/chatdsh/telemetry/status';

/** 单批最多条数，与中继端点的限制一致。 */
export const BATCH_LIMIT = 64;

/** 单批最大字节数。 */
export const PAYLOAD_LIMIT = 256 * 1024;

/** 同源上报要求的请求头。 */
export const CSRF_HEADER = RELAY_CSRF_HEADER;

/** 浏览器侧客户端的构造输入。 */
export interface BrowserTelemetryOptions {
  /** 产生信号的包名，缺省为本插件。 */
  readonly component?: string;
  /** 产品版本。 */
  readonly version?: string;
  /** 部署环境。 */
  readonly environment?: string;
  /** 初始开关状态；拿到运行时状态之前保持关闭。 */
  readonly enabled?: boolean;
  /** 初始关闭原因。 */
  readonly reason?: TelemetryOffReason;
  /** 投递实现；缺省用全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
}

/** 状态端点的载荷形状。 */
interface StatusPayload {
  readonly enabled?: unknown;
  readonly reason?: unknown;
}

/**
 * 浏览器侧遥测出口。
 *
 * 开关状态以运行时状态端点为准：连接前保持关闭，拿到状态后按开关与关闭原因运行。
 */
export class BrowserTelemetry implements ChatdshTelemetry {
  /** 底层中继客户端。 */
  readonly client: RelayTelemetryClient;

  private readonly options: BrowserTelemetryOptions;
  private synced = false;

  constructor(options: BrowserTelemetryOptions = {}) {
    this.options = options;
    this.client = new RelayTelemetryClient({
      component: options.component ?? '@chatdsh/client-telemetry',
      surface: 'browser',
      enabled: options.enabled ?? false,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
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

  /**
   * 在进程内切换开关，供设置页与命令调用。
   * @param enabled - 目标状态。
   * @param reason - 关闭原因，关闭时必填。
   */
  setEnabled(enabled: boolean, reason?: TelemetryOffReason): void {
    this.client.setEnabled(enabled, reason);
  }

  /**
   * 读一次运行时状态，把开关与关闭原因同步到客户端。
   * @returns 同步完成后解析；状态端点不可达时保持关闭。
   */
  async connect(): Promise<void> {
    if (this.synced) return;
    this.synced = true;
    await this.refresh();
  }

  /**
   * 重新读一次运行时状态。设置页开关与命令切换后由界面调用。
   * @returns 同步完成后解析。
   */
  async refresh(): Promise<void> {
    const status = await this.readStatus();
    if (status === undefined) {
      this.client.setEnabled(false, 'settings');
      return;
    }
    if (status.enabled === true) {
      this.client.setEnabled(true);
      return;
    }
    this.client.setEnabled(false, isOffReason(status.reason) ? status.reason : 'settings');
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

  /** 停止上报并停掉定时器。 */
  shutdown(): Promise<void> {
    return this.client.shutdown();
  }

  /** 状态快照。 */
  status(): Record<string, unknown> {
    return this.client.status();
  }

  private async readStatus(): Promise<StatusPayload | undefined> {
    const implementation = this.options.fetchImpl ?? globalThis.fetch;
    if (implementation === undefined) return undefined;
    try {
      const response = await implementation(STATUS_PATH, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!response.ok) return undefined;
      return (await response.json()) as StatusPayload;
    } catch {
      return undefined;
    }
  }
}

/** 判断状态端点给出的是否为已知关闭原因。 */
function isOffReason(value: unknown): value is TelemetryOffReason {
  return value === 'env' || value === 'settings' || value === 'flag' || value === 'platform';
}

/** 一条未捕获错误的记录：只保留类型与固定码。 */
export interface BrowserErrorRecord {
  /** 错误类型，取 `Error`、`TypeError` 之类的构造名或固定枚举。 */
  readonly type: string;
  /** 固定错误码，取 `uncaught` 或 `unhandledrejection`。 */
  readonly code: string;
}

let current: BrowserTelemetry | undefined;

/**
 * 取得浏览器侧遥测出口；插件尚未安装时按关闭状态新建一个。
 * @returns 浏览器侧出口。
 */
export function browserTelemetry(): BrowserTelemetry {
  current ??= new BrowserTelemetry();
  return current;
}

/**
 * 记录一次未捕获错误：一条事件、一次计数。
 * @param telemetry - 浏览器侧出口。
 * @param record - 错误记录。
 */
export function recordBrowserError(telemetry: ChatdshTelemetry, record: BrowserErrorRecord): void {
  telemetry.event('chatdsh.client.error', { 'error.type': record.type, 'error.code': record.code });
  telemetry.counter('chatdsh_client_errors_total', { description: '前端未捕获错误数' }).add(1, { error_type: record.type });
}

/** 这个插件不依赖其它客户端模块：采集越早装上越好。 */
export const inject: string[] = [];

/**
 * 安装采集钩子：未捕获错误、未处理的拒绝、页面隐藏时的有界刷新。
 * @param ctx - 客户端根上下文；本插件不从中取服务。
 */
export function apply(ctx?: unknown): void {
  void ctx;
  if (typeof window === 'undefined') return;
  const telemetry = browserTelemetry();
  void telemetry.connect();

  window.addEventListener('error', (event) => {
    const error = (event as ErrorEvent).error;
    recordBrowserError(telemetry, {
      type: error instanceof Error ? error.name : 'Error',
      code: 'uncaught',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    recordBrowserError(telemetry, {
      type: reason instanceof Error ? reason.name : 'UnhandledRejection',
      code: 'unhandledrejection',
    });
  });

  window.addEventListener('pagehide', () => {
    void telemetry.flush(3000);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void telemetry.flush(3000);
  });
}
