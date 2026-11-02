/**
 * 会话增强客户端的浏览器侧遥测。
 *
 * 上报走控制平面的同源中继 `POST /chatdsh/telemetry/browser`，载荷是 OTLP/HTTP JSON，端点按
 * 请求头 `x-chatdsh-signal` 分流到日志、链路与指标三个出口。遥测关闭时端点返回 404，这里只
 * 落空本次上报，发送、流式、队列与命令的结果不受影响。
 *
 * 五条信号：
 * - `chatdsh.client.message.send`：一次发送动作，覆盖提交、确认与失败；
 * - `chatdsh.client.stream.consume`：一次跟随流的接收，覆盖帧数、片段数与终态；
 * - `chatdsh.client.queue.consume`：一次队列动作（编辑、删除、暂停、恢复、消费）；
 * - `chatdsh.client.command.run`：一次命令执行；
 * - `chatdsh.client.reference.invalidated`：一条引用失效；
 * 以及对应的失败事件与 `_total` 计数。
 *
 * 属性只放会话标识、设备标识、动作、结果、计数与长度；消息正文、工具参数与结果原文、引用
 * 名称、检索词与令牌一律不进入遥测。
 * @module @chatdsh/client-conversation/telemetry
 */

/** 上报的同源中继端点。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继要求的来源校验头。 */
export const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本包在遥测规范里的 instrumentation scope。 */
export const SCOPE = '@chatdsh/client-conversation';

/** 待发送载荷的上限；超出后丢弃最旧的，保证队列不随使用量增长。 */
const PENDING_MAX = 64;

/** 一次动作的结果。 */
export type ConversationOutcome =
  | 'ok'
  | 'rejected'
  | 'failed'
  | 'unconfirmed'
  | 'paused'
  | 'dropped'
  | 'stopped'
  | 'duplicate';

/** 一条 OTLP 属性的取值。 */
export interface OtlpAttributeValue {
  readonly stringValue?: string;
  readonly intValue?: string;
}

/** 一条 OTLP 属性。 */
export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpAttributeValue;
}

/** 一次发送动作的 span 记录。 */
export interface MessageSpanRecord {
  /** 目标会话。 */
  readonly sessionId: string;
  /** 目标设备。 */
  readonly deviceId: string;
  /** 发送模式：立即提交或在队列里排队。 */
  readonly mode: 'direct' | 'queued';
  /** 正文长度，字符数。 */
  readonly chars: number;
  /** 引用对象数量。 */
  readonly references: number;
  /** 附件数量。 */
  readonly attachments: number;
  /** 最终结果。 */
  readonly outcome: ConversationOutcome;
  /** 失败分类；成功时缺省。 */
  readonly errorType?: string;
  /** 失败原因码；成功时缺省。 */
  readonly errorCode?: string;
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 结束时刻的毫秒时间戳。 */
  readonly endedAt: number;
}

/** 一次跟随流接收的 span 记录。 */
export interface StreamSpanRecord {
  /** 会话。 */
  readonly sessionId: string;
  /** 设备。 */
  readonly deviceId: string;
  /** 收到的跟随帧数量。 */
  readonly frames: number;
  /** 收到的流式片段数量。 */
  readonly chunks: number;
  /** 丢弃的迟到片段数量。 */
  readonly lateChunks: number;
  /** 终态。 */
  readonly outcome: ConversationOutcome;
  /** 失败分类；成功时缺省。 */
  readonly errorType?: string;
  /** 失败原因码；成功时缺省。 */
  readonly errorCode?: string;
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 结束时刻的毫秒时间戳。 */
  readonly endedAt: number;
}

/** 一次队列动作的 span 记录。 */
export interface QueueSpanRecord {
  /** 会话。 */
  readonly sessionId: string;
  /** 动作：编辑、删除、暂停、恢复、消费。 */
  readonly action: QueueActionName;
  /** 本次动作涉及的条目数量。 */
  readonly count: number;
  /** 结果。 */
  readonly outcome: ConversationOutcome;
  /** 失败分类；成功时缺省。 */
  readonly errorType?: string;
  /** 失败原因码；成功时缺省。 */
  readonly errorCode?: string;
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 结束时刻的毫秒时间戳。 */
  readonly endedAt: number;
}

/** 队列动作名。 */
export type QueueActionName = 'edit' | 'remove' | 'pause' | 'resume' | 'consume' | 'enqueue';

/** 一次命令执行的 span 记录。 */
export interface CommandSpanRecord {
  /** 命令标识；不在遥测里记录命令名称之外的参数。 */
  readonly commandId: string;
  /** 结果。 */
  readonly outcome: ConversationOutcome;
  /** 失败分类；成功时缺省。 */
  readonly errorType?: string;
  /** 失败原因码；成功时缺省。 */
  readonly errorCode?: string;
  /** 开始时刻的毫秒时间戳。 */
  readonly startedAt: number;
  /** 结束时刻的毫秒时间戳。 */
  readonly endedAt: number;
}

/** 一条失败事件的记录。 */
export interface ConversationFailureRecord {
  /** 会话；命令面板等全局动作带空串。 */
  readonly sessionId: string;
  /** 设备；无关动作带空串。 */
  readonly deviceId: string;
  /** 动作名。 */
  readonly action: string;
  /** 结果类别。 */
  readonly outcome: ConversationOutcome;
  /** 失败分类。 */
  readonly errorType: string;
  /** 失败原因码。 */
  readonly errorCode: string;
}

/** 一条引用失效的记录。 */
export interface ReferenceChangeRecord {
  /** 会话。 */
  readonly sessionId: string;
  /** 动作：插入、移除、失效。 */
  readonly action: 'insert' | 'remove' | 'invalidate';
  /** 引用对象种类。 */
  readonly kind: string;
  /** 结果。 */
  readonly outcome: ConversationOutcome;
}

/** 计数指标的种类。 */
export type ConversationMetric =
  | 'chatdsh_client_message_sends_total'
  | 'chatdsh_client_stream_events_total'
  | 'chatdsh_client_queue_actions_total'
  | 'chatdsh_client_command_runs_total'
  | 'chatdsh_client_reference_changes_total';

/** 会话增强客户端使用的遥测面。 */
export interface ConversationTelemetry {
  /**
   * 记一次发送动作的 span。
   * @param record - 会话、设备、模式、长度与结果。
   */
  messageSpan(record: MessageSpanRecord): void;
  /**
   * 记一次跟随流接收的 span。
   * @param record - 会话、帧数、片段数与终态。
   */
  streamSpan(record: StreamSpanRecord): void;
  /**
   * 记一次队列动作的 span。
   * @param record - 会话、动作、条目数与结果。
   */
  queueSpan(record: QueueSpanRecord): void;
  /**
   * 记一次命令执行的 span。
   * @param record - 命令标识与结果。
   */
  commandSpan(record: CommandSpanRecord): void;
  /**
   * 记一次发送被拒绝或失败。
   * @param record - 会话、设备、动作与原因。
   */
  messageRejected(record: ConversationFailureRecord): void;
  /**
   * 记一次流式中断。
   * @param record - 会话、设备、动作与原因。
   */
  streamInterrupted(record: ConversationFailureRecord): void;
  /**
   * 记一次队列操作被拒绝。
   * @param record - 会话、动作与原因。
   */
  queueRejected(record: ConversationFailureRecord): void;
  /**
   * 记一次命令被拒绝。
   * @param record - 命令标识与原因。
   */
  commandRejected(record: ConversationFailureRecord): void;
  /**
   * 记一条引用失效。
   * @param record - 会话、动作、种类与结果。
   */
  referenceInvalidated(record: ReferenceChangeRecord): void;
  /**
   * 记一次计数。
   * @param metric - 指标名。
   * @param outcome - 结果。
   * @param extra - 额外属性键值，取登记过的枚举。
   */
  counted(metric: ConversationMetric, outcome: ConversationOutcome, extra?: Readonly<Record<string, string>>): void;
}

/** 遥测面的依赖。 */
export interface ConversationTelemetryOptions {
  /** 发请求的实现。 */
  readonly fetchImpl: typeof fetch;
  /** 生成随机十六进制标识的实现。 */
  readonly randomHex: (bytes: number) => string;
  /** 当前时刻的毫秒时间戳。 */
  readonly now: () => number;
  /** 上报端点；缺省用 {@link RELAY_PATH}。 */
  readonly relayPath?: string;
}

/**
 * 把一对键值编成字符串属性。
 * @param key - 属性键。
 * @param value - 属性值。
 * @returns OTLP 属性。
 */
function textAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/**
 * 把一对键值编成整数属性。
 * @param key - 属性键。
 * @param value - 属性值。
 * @returns OTLP 属性。
 */
function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

/** 资源属性：服务名、形态与产生信号的包。 */
function resource(): { readonly attributes: readonly OtlpAttribute[] } {
  return {
    attributes: [
      textAttribute('service.name', 'chatdsh-browser'),
      textAttribute('chatdsh.surface', 'browser'),
      textAttribute('chatdsh.component', SCOPE),
    ],
  };
}

/**
 * 建立一条 span 载荷。
 * @param name - span 名称。
 * @param attributes - span 属性。
 * @param startedAt - 开始时刻的毫秒时间戳。
 * @param endedAt - 结束时刻的毫秒时间戳。
 * @param ok - 结果是否为成功。
 * @param randomHexOf - 生成标识的实现。
 * @returns OTLP/HTTP JSON 载荷。
 */
function spanPayload(
  name: string,
  attributes: readonly OtlpAttribute[],
  startedAt: number,
  endedAt: number,
  ok: boolean,
  randomHexOf: (bytes: number) => string
): unknown {
  return {
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
                name,
                kind: 3,
                startTimeUnixNano: String(startedAt * 1_000_000),
                endTimeUnixNano: String(Math.max(startedAt, endedAt) * 1_000_000),
                status: { code: ok ? 1 : 2 },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * 建立一条事件载荷。
 * @param name - 事件名称。
 * @param attributes - 事件属性。
 * @param at - 发生时刻的毫秒时间戳。
 * @returns OTLP/HTTP JSON 载荷。
 */
function eventPayload(name: string, attributes: readonly OtlpAttribute[], at: number): unknown {
  return {
    resourceLogs: [
      {
        resource: resource(),
        scopeLogs: [
          {
            scope: { name: SCOPE },
            logRecords: [
              {
                timeUnixNano: String(at * 1_000_000),
                severityNumber: 13,
                severityText: 'WARN',
                body: { stringValue: name },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * 建立一次计数载荷。
 * @param metric - 指标名。
 * @param attributes - 数据点属性。
 * @param at - 发生时刻的毫秒时间戳。
 * @returns OTLP/HTTP JSON 载荷。
 */
function metricPayload(metric: string, attributes: readonly OtlpAttribute[], at: number): unknown {
  return {
    resourceMetrics: [
      {
        resource: resource(),
        scopeMetrics: [
          {
            scope: { name: SCOPE },
            metrics: [
              {
                name: metric,
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [{ asDouble: 1, timeUnixNano: String(at * 1_000_000), attributes }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * 建立遥测面。
 * @param options - 依赖。
 * @returns 遥测面。
 */
export function createConversationTelemetry(options: ConversationTelemetryOptions): ConversationTelemetry {
  const { fetchImpl, randomHex: randomHexOf, now } = options;
  const relayPath = options.relayPath ?? RELAY_PATH;
  let pending = 0;

  /**
   * 把一份载荷交给中继。失败只落空本次上报，不改变业务结果。
   * @param signal - 载荷类型。
   * @param payload - OTLP/HTTP JSON 载荷。
   */
  const post = (signal: 'logs' | 'traces' | 'metrics', payload: unknown): void => {
    if (pending >= PENDING_MAX) return;
    pending += 1;
    void fetchImpl(relayPath, {
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

  const failureAttributes = (record: ConversationFailureRecord): OtlpAttribute[] => [
    textAttribute('session.id', record.sessionId),
    textAttribute('deviceId', record.deviceId),
    textAttribute('action', record.action),
    textAttribute('outcome', record.outcome),
    textAttribute('error.type', record.errorType),
    textAttribute('error.code', record.errorCode),
  ];

  return {
    messageSpan(record: MessageSpanRecord): void {
      const attributes: OtlpAttribute[] = [
        textAttribute('session.id', record.sessionId),
        textAttribute('deviceId', record.deviceId),
        textAttribute('mode', record.mode),
        intAttribute('chars', record.chars),
        intAttribute('references', record.references),
        intAttribute('attachments', record.attachments),
        textAttribute('outcome', record.outcome),
      ];
      if (record.errorType !== undefined) attributes.push(textAttribute('error.type', record.errorType));
      if (record.errorCode !== undefined) attributes.push(textAttribute('error.code', record.errorCode));
      post('traces', spanPayload(
        'chatdsh.client.message.send', attributes, record.startedAt, record.endedAt,
        record.outcome === 'ok' || record.outcome === 'duplicate', randomHexOf
      ));
    },

    streamSpan(record: StreamSpanRecord): void {
      const attributes: OtlpAttribute[] = [
        textAttribute('session.id', record.sessionId),
        textAttribute('deviceId', record.deviceId),
        intAttribute('frames', record.frames),
        intAttribute('chunks', record.chunks),
        intAttribute('late.chunks', record.lateChunks),
        textAttribute('outcome', record.outcome),
      ];
      if (record.errorType !== undefined) attributes.push(textAttribute('error.type', record.errorType));
      if (record.errorCode !== undefined) attributes.push(textAttribute('error.code', record.errorCode));
      post('traces', spanPayload(
        'chatdsh.client.stream.consume', attributes, record.startedAt, record.endedAt,
        record.outcome === 'ok', randomHexOf
      ));
    },

    queueSpan(record: QueueSpanRecord): void {
      const attributes: OtlpAttribute[] = [
        textAttribute('session.id', record.sessionId),
        textAttribute('action', record.action),
        intAttribute('count', record.count),
        textAttribute('outcome', record.outcome),
      ];
      if (record.errorType !== undefined) attributes.push(textAttribute('error.type', record.errorType));
      if (record.errorCode !== undefined) attributes.push(textAttribute('error.code', record.errorCode));
      post('traces', spanPayload(
        'chatdsh.client.queue.consume', attributes, record.startedAt, record.endedAt,
        record.outcome === 'ok', randomHexOf
      ));
    },

    commandSpan(record: CommandSpanRecord): void {
      const attributes: OtlpAttribute[] = [
        textAttribute('command.id', record.commandId),
        textAttribute('outcome', record.outcome),
      ];
      if (record.errorType !== undefined) attributes.push(textAttribute('error.type', record.errorType));
      if (record.errorCode !== undefined) attributes.push(textAttribute('error.code', record.errorCode));
      post('traces', spanPayload(
        'chatdsh.client.command.run', attributes, record.startedAt, record.endedAt,
        record.outcome === 'ok', randomHexOf
      ));
    },

    messageRejected(record: ConversationFailureRecord): void {
      post('logs', eventPayload('chatdsh.client.message.rejected', failureAttributes(record), now()));
    },

    streamInterrupted(record: ConversationFailureRecord): void {
      post('logs', eventPayload('chatdsh.client.stream.interrupted', failureAttributes(record), now()));
    },

    queueRejected(record: ConversationFailureRecord): void {
      post('logs', eventPayload('chatdsh.client.queue.rejected', failureAttributes(record), now()));
    },

    commandRejected(record: ConversationFailureRecord): void {
      post('logs', eventPayload('chatdsh.client.command.rejected', failureAttributes(record), now()));
    },

    referenceInvalidated(record: ReferenceChangeRecord): void {
      post('logs', eventPayload('chatdsh.client.reference.invalidated', [
        textAttribute('session.id', record.sessionId),
        textAttribute('action', record.action),
        textAttribute('kind', record.kind),
        textAttribute('outcome', record.outcome),
      ], now()));
    },

    counted(metric: ConversationMetric, outcome: ConversationOutcome, extra?: Readonly<Record<string, string>>): void {
      const attributes: OtlpAttribute[] = [textAttribute('outcome', outcome)];
      for (const [key, value] of Object.entries(extra ?? {})) attributes.push(textAttribute(key, value));
      post('metrics', metricPayload(metric, attributes, now()));
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
