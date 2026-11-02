/**
 * 外壳的浏览器侧遥测。
 *
 * 上报走控制平面的同源中继 `POST /chatdsh/telemetry/browser`：载荷是 OTLP/HTTP JSON，端点按
 * 请求头 `x-chatdsh-signal` 分流。遥测关闭时端点返回 404，这里只落空一次，界面与业务结果
 * 不受影响。
 *
 * 只使用 `docs/telemetry.md` 第 6.5 节登记的浏览器客户端信号：
 * - `chatdsh.client.remote.call`：一次 Remote 或私有读取调用；
 * - `chatdsh.client.ui.action`：一次关键界面动作。
 * 事件与 span 的属性键限制在登记过的范围内，不记录路径、标题、检索词、令牌与响应原文。
 * @module @chatdsh/client-shell/telemetry
 */

/** 上报的同源中继端点。 */
const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继要求的来源校验头。 */
const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测规范里的 instrumentation scope。 */
const SCOPE = '@chatdsh/client-shell';

/** 待发送载荷的上限；超出后丢弃最旧的，保证队列不随使用量增长。 */
const PENDING_MAX = 64;

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 把一对键值编成 OTLP 属性。 */
function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** 资源属性：服务名、形态与产生信号的包。 */
function resource(): { attributes: OtlpAttribute[] } {
  return {
    attributes: [
      attribute('service.name', 'chatdsh-browser'),
      attribute('chatdsh.surface', 'browser'),
      attribute('chatdsh.component', SCOPE),
    ],
  };
}

/** 界面动作的结果。 */
export type ActionOutcome = 'ok' | 'failed' | 'rejected';

/** 外壳使用的遥测面。 */
export interface ShellTelemetry {
  /**
   * 记一次界面动作。
   * @param action - 动作名，取固定枚举。
   * @param outcome - 结果。
   */
  action(action: string, outcome: ActionOutcome): void;
  /**
   * 记录一次调用。
   * @param method - 方法名，取固定枚举。
   * @param work - 实际调用。
   * @returns 调用的结果。
   */
  remote<T>(method: string, work: () => Promise<T>): Promise<T>;
}

/** 遥测的依赖。 */
export interface ShellTelemetryOptions {
  /** 发请求的实现。 */
  readonly fetchImpl: typeof fetch;
  /** 生成随机十六进制标识的实现。 */
  readonly randomHex: (bytes: number) => string;
  /** 当前时刻的毫秒时间戳。 */
  readonly now: () => number;
}

/**
 * 建立遥测面。
 * @param options - 依赖。
 * @returns 遥测面。
 */
export function createShellTelemetry(options: ShellTelemetryOptions): ShellTelemetry {
  const { fetchImpl, randomHex: randomHexOf, now } = options;
  let pending = 0;

  /**
   * 把一份 OTLP 载荷交给中继。失败只落空本次上报，不改变业务结果。
   * @param signal - 载荷类型。
   * @param payload - OTLP/HTTP JSON 载荷。
   */
  const post = (signal: 'logs' | 'traces', payload: unknown): void => {
    if (pending >= PENDING_MAX) return;
    pending += 1;
    void fetchImpl(RELAY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-signal': signal, [CSRF_HEADER]: '1' },
      body: JSON.stringify(payload),
      keepalive: true,
    })
      .catch(() => undefined)
      .finally(() => {
        pending -= 1;
      });
  };

  return {
    action(action: string, outcome: ActionOutcome): void {
      post('logs', {
        resourceLogs: [
          {
            resource: resource(),
            scopeLogs: [
              {
                scope: { name: SCOPE },
                logRecords: [
                  {
                    timeUnixNano: String(now() * 1_000_000),
                    severityNumber: outcome === 'ok' ? 9 : 13,
                    severityText: outcome === 'ok' ? 'INFO' : 'WARN',
                    body: { stringValue: 'chatdsh.client.ui.action' },
                    attributes: [attribute('action', action), attribute('outcome', outcome)],
                  },
                ],
              },
            ],
          },
        ],
      });
    },

    async remote<T>(method: string, work: () => Promise<T>): Promise<T> {
      const startedAt = now();
      let outcome = 'ok';
      try {
        return await work();
      } catch (error) {
        outcome = 'failed';
        throw error;
      } finally {
        const endedAt = now();
        post('traces', {
          resourceSpans: [
            {
              resource: resource(),
              scopeSpans: [
                {
                  scope: { name: SCOPE },
                  spans: [
                    {
                      traceId: randomHexOf(16),
                      spanId: randomHexOf(8),
                      name: 'chatdsh.client.remote.call',
                      kind: 3,
                      startTimeUnixNano: String(startedAt * 1_000_000),
                      endTimeUnixNano: String(endedAt * 1_000_000),
                      status: { code: outcome === 'ok' ? 1 : 2 },
                      attributes: [attribute('rpc.method', method), attribute('outcome', outcome)],
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
    },
  };
}

/**
 * 生成随机十六进制标识。
 * @param bytes - 字节数。
 * @returns 十六进制写法。
 */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
