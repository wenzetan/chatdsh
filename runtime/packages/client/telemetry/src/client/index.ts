/**
 * 浏览器侧遥测：采集未捕获错误并经同源端点上报。
 *
 * 浏览器不持有 OpenObserve 凭据，上报走运行时的中继端点；端点校验来源与请求头、限制批量与
 * 体积，转发时补上形态属性。采集在启动早期安装，界面还没就绪时发生的错误也能被记下。
 * @module @chatdsh/client-telemetry
 */

/** 中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 单批最多条数，与端点侧的限制一致。 */
export const BATCH_LIMIT = 64;

/** 单批最大字节数。 */
export const PAYLOAD_LIMIT = 256 * 1024;

/** 同源上报要求的请求头；跨站表单无法携带自定义头，因此它同时起到 CSRF 防护作用。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 一条待上报的错误记录。 */
export interface BrowserErrorRecord {
  readonly time: number;
  readonly message: string;
  readonly type: string;
  readonly code?: string;
}

/** 属性值的 OTLP 表示。 */
function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/**
 * 把错误记录编成 OTLP 日志载荷。
 * @param records - 待上报的记录。
 * @param component - 产生记录的客户端插件包名。
 * @returns OTLP/HTTP JSON 载荷。
 */
export function toOtlpPayload(records: readonly BrowserErrorRecord[], component = '@chatdsh/client-telemetry'): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [attribute('service.name', 'chatdsh-browser'), attribute('chatdsh.surface', 'browser')],
        },
        scopeLogs: [
          {
            scope: { name: component },
            logRecords: records.map((record) => ({
              timeUnixNano: String(record.time * 1_000_000),
              severityNumber: 17,
              severityText: 'ERROR',
              body: { stringValue: record.message },
              attributes: [
                attribute('chatdsh.surface', 'browser'),
                attribute('chatdsh.component', component),
                attribute('error.type', record.type),
                attribute('error.code', record.code ?? 'uncaught'),
              ],
            })),
          },
        ],
      },
    ],
  };
}

/** 一组记录编成的载荷是否超过单批体积上限。 */
export function payloadTooLarge(payload: unknown): boolean {
  return JSON.stringify(payload).length > PAYLOAD_LIMIT;
}

/** 上报队列。 */
class RelayQueue {
  private readonly pending: BrowserErrorRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly component: string) {}

  /** 入队一条记录，并在下一轮微任务后尝试发送。 */
  push(record: BrowserErrorRecord): void {
    if (this.pending.length >= BATCH_LIMIT) this.pending.shift();
    this.pending.push(record);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 500);
  }

  /** 立即发送当前队列。 */
  flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, BATCH_LIMIT);
    const payload = toOtlpPayload(batch, this.component);
    const body = JSON.stringify(payload);
    if (body.length > PAYLOAD_LIMIT) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(RELAY_PATH, new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch {
      // 信标发送不被支持时退回 fetch。
    }
    void fetch(RELAY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1', 'x-chatdsh-signal': 'logs' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  }
}

/**
 * 安装采集钩子。
 *
 * `inject` 为空：这个插件不依赖其它客户端模块，越早装上越好。
 * @param ctx - 客户端根上下文；本插件不从中取服务。
 */
export const inject: string[] = [];

export function apply(ctx: unknown): void {
  void ctx;
  if (typeof window === 'undefined') return;
  const queue = new RelayQueue('@chatdsh/client-telemetry');

  window.addEventListener('error', (event) => {
    const error = (event as ErrorEvent).error;
    queue.push({
      time: Date.now(),
      message: String((event as ErrorEvent).message ?? (error instanceof Error ? error.message : 'unknown error')).slice(0, 200),
      type: error instanceof Error ? error.name : 'Error',
      code: 'uncaught',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    queue.push({
      time: Date.now(),
      message: String(reason instanceof Error ? reason.message : reason).slice(0, 200),
      type: reason instanceof Error ? reason.name : 'UnhandledRejection',
      code: 'unhandledrejection',
    });
  });

  window.addEventListener('pagehide', () => queue.flush());
}
