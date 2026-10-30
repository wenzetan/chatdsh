/**
 * 上报：把运行时的会话事件推给控制平面，形成只读副本。
 *
 * 上报带事件本体：副本要承担跨设备浏览、会话导入与分享渲染，这三件事都需要事件的
 * 内容，只送定位信息不足以支撑。正文因此离开执行节点，副本是只读镜像而不是权威日志。
 * 上报是尽力而为的，控制平面不可达时保留缓冲并在下一轮重试；缓冲有上限，超出后
 * 丢弃并计入计数，不阻塞会话。
 * @module @chatdsh/host-push
 */

import {
  SESSION_EVENTS,
  schema as z,
  Service,
  sessionPersistenceOf,
  telemetryOf,
  type Context,
  type Session,
  type SessionEvent,
} from '@chatdsh/adapter';
import {
  NODE_HEADERS,
  type ChatdshTelemetry,
  type TelemetrySpan,
} from '@chatdsh/core-contracts';

/** 插件名。 */
export const name = 'chatdsh-push';

/** 服务名。 */
export const SERVICE_NAME = 'chatdshPush';

/** 缓冲上限：每个会话最多保留这么多条待上报事件。 */
export const BUFFER_LIMIT = 512;

/** 配置。 */
export interface PushConfig {
  /** 是否启用上报。 */
  enabled: boolean;
  /** 控制平面地址。 */
  gatewayUrl: string;
  /** 定期上报间隔。 */
  flushIntervalMs: number;
  /** 单批最多上报条数。 */
  batchSize: number;
  /** 本设备标识，控制平面据此区分来源。 */
  deviceId: string;
  /** 节点令牌，向控制平面证明设备身份；缺省取环境变量 `CHATDSH_NODE_TOKEN`。 */
  nodeToken?: string;
}

/** 配置 schema。 */
export const Config: z<PushConfig> = z.object({
  enabled: z.boolean().default(true),
  // 控制平面地址与本设备标识取设备形态的两个环境变量，与设备长连接同一处下发；
  // 都没有配置时退回本机默认端口。
  gatewayUrl: z.string().default(process.env.CHATDSH_CONTROL_URL ?? 'http://127.0.0.1:3170'),
  flushIntervalMs: z.number().default(2000),
  batchSize: z.number().default(64),
  deviceId: z.string().default(process.env.CHATDSH_DEVICE_ID ?? 'local'),
  nodeToken: z.string().default(process.env.CHATDSH_NODE_TOKEN ?? ''),
});

/** 上报给控制平面的单条事件，带事件本体。 */
interface EventEnvelope {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly bytes: number;
  readonly payload: unknown;
}

/**
 * 上报服务。
 *
 * 挂在 `session/event` 上收集事件，按间隔成批推送。事件本体随上报一起送出。
 */
export class ChatdshPushService extends Service {
  /** 会话持久化用于补齐：副本落后时从本地日志补发历史。 */
  static inject = ['sessionPersistence'];

  /** 配置 schema。 */
  static Config: z<PushConfig> = Config;

  private readonly pending = new Map<string, EventEnvelope[]>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private dropped = 0;

  constructor(ctx: Context, private readonly config: PushConfig) {
    super(ctx, SERVICE_NAME);
  }

  /** 开始监听会话事件并按间隔上报。 */
  async [Service.init](): Promise<void> {
    if (!this.config.enabled) return;
    this.ctx.on(SESSION_EVENTS.event, (session, event) => {
      this.enqueue(session.id, event);
    });
    this.ctx.on(SESSION_EVENTS.created, (session) => {
      void this.backfill(session);
    });
    this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    this.timer.unref();
  }

  /**
   * 补齐一个会话：读控制平面的副本水位，把本地日志里水位之后的事件补发上去。
   *
   * 只对已经有历史的对象生命周期起作用。新会话在 `session/created` 触发时还没落盘，
   * 它的 `firstLifecycleSeq` 为 0；恢复与分叉的会话才需要对齐副本。
   */
  private async backfill(session: Session): Promise<void> {
    if (session.firstLifecycleSeq === 0) return;
    const telemetry = telemetryOf<ChatdshTelemetry>(this.ctx);
    const run = async (): Promise<void> => {
      try {
        const response = await fetch(`${this.config.gatewayUrl}/chatdsh/gateway/replica?sessionId=${encodeURIComponent(session.id)}`);
        if (!response.ok) return;
        const payload = (await response.json()) as { watermark?: number | null };
        // 副本不存在时接口给 null，从 seq -1 的下一格也就是 0 开始补。
        const from = (payload.watermark ?? -1) + 1;
        const handle = await sessionPersistenceOf(this.ctx).open(session.id, 'read');
        try {
          let offset = from;
          for (;;) {
            const result = await handle.read(offset, 256);
            if (result.events.length === 0) break;
            for (const event of result.events) this.enqueue(session.id, event);
            offset += result.events.length;
            if (result.events.length < 256) break;
          }
        } finally {
          await handle.close();
        }
        await this.flush();
      } catch (error) {
        telemetry?.log('warn', 'replica backfill failed', {
          'session.id': session.id,
          'error.type': error instanceof Error ? error.name : 'Unknown',
        });
      }
    };

    if (telemetry === undefined) {
      await run();
      return;
    }
    await telemetry.runSpan('chatdsh.sync.event.push', {
      'session.id': session.id,
      seq: 0,
    }, async (span) => {
      await run();
      span.setAttribute('outcome', 'backfilled');
    });
  }

  /** 立即上报一轮，返回本次推送的会话数。 */
  async flush(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let pushed = 0;
    try {
      for (const [sessionId, events] of [...this.pending]) {
        const batch = events.slice(0, this.config.batchSize);
        if (batch.length === 0) {
          this.pending.delete(sessionId);
          continue;
        }
        const accepted = await this.push(sessionId, batch);
        if (accepted) {
          const rest = events.slice(batch.length);
          if (rest.length === 0) this.pending.delete(sessionId);
          else this.pending.set(sessionId, rest);
          pushed += 1;
        }
      }
    } finally {
      this.running = false;
    }
    return pushed;
  }

  /** 当前缓冲里待上报的条数，按会话汇总。 */
  pendingCount(): number {
    let total = 0;
    for (const events of this.pending.values()) total += events.length;
    return total;
  }

  /** 因缓冲上限而丢弃的条数。 */
  droppedCount(): number {
    return this.dropped;
  }

  private enqueue(sessionId: string, event: SessionEvent): void {
    const queue = this.pending.get(sessionId) ?? [];
    if (queue.length >= BUFFER_LIMIT) {
      this.dropped += 1;
      return;
    }
    queue.push({
      seq: event.seq,
      kind: event.type,
      time: event.time,
      bytes: Buffer.byteLength(JSON.stringify(event.data)),
      payload: event,
    });
    this.pending.set(sessionId, queue);
  }

  /**
   * 推送一批事件；成功返回真。
   *
   * 遥测出口按名读取而不是声明依赖：ACP 这类没有宿主平面遥测的形态里，上报仍然要能工作，
   * 只是不再产生 span。
   */
  private async push(sessionId: string, batch: readonly EventEnvelope[]): Promise<boolean> {
    const telemetry = this.ctx.reflect.get('chatdshTelemetry') as ChatdshTelemetry | undefined;
    if (telemetry === undefined) return this.send(sessionId, batch, undefined);
    return telemetry.runSpan('chatdsh.sync.event.push', {
      'session.id': sessionId,
      seq: batch[batch.length - 1]?.seq ?? 0,
    }, (span: TelemetrySpan) => this.send(sessionId, batch, span, telemetry));
  }

  /** 真正发出一次上报。 */
  private async send(
    sessionId: string,
    batch: readonly EventEnvelope[],
    span: TelemetrySpan | undefined,
    telemetry?: ChatdshTelemetry,
  ): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        [NODE_HEADERS.id]: this.config.deviceId,
      };
      const nodeToken = this.config.nodeToken ?? '';
      if (nodeToken !== '') headers.authorization = `Bearer ${nodeToken}`;
      const response = await fetch(`${this.config.gatewayUrl}/chatdsh/gateway/replica`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId, events: batch }),
      });
      if (!response.ok) {
        span?.setAttribute('outcome', 'rejected');
        telemetry?.event('chatdsh.sync.watermark', { 'session.id': sessionId, 'lag.events': this.pendingCount() });
        return false;
      }
      span?.setAttribute('outcome', 'pushed');
      return true;
    } catch (error) {
      span?.recordException(error);
      span?.setAttribute('outcome', 'unreachable');
      return false;
    }
  }
}

export { ChatdshPushService as default };
