/**
 * 上报：把运行时的会话事件推给控制平面，形成只读副本。
 *
 * 上报带事件本体：副本要承担跨设备浏览、会话导入与分享渲染，这三件事都需要事件内容。
 * 事件先进入设备权威日志，由 {@link ReplicaContinuity} 登记持久补传意图再成批上报；
 * 正文始终从权威日志重新读取，因此进程重启、控制平面长时间不可达与超过内存上限的积压
 * 都不会丢内容。启动与每轮扫描覆盖全部已存储会话，包含未打开的冷会话。
 *
 * 这条通路只复制已提交日志，和用户离线消息发送没有任何共用队列。
 * @module @chatdsh/host-push
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_EVENTS,
  schema as z,
  Service,
  sessionPersistenceOf,
  telemetryOf,
  type Context,
} from '@chatdsh/adapter';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import {
  BATCH_BYTES,
  BATCH_LIMIT,
  RETRY_DELAYS_MS,
  ReplicaContinuity,
} from './continuity.ts';
import { ReplicaIntentStore } from './intents.ts';

/** 插件名。 */
export const name = 'chatdsh-push';

/** 服务名。 */
export const SERVICE_NAME = 'chatdshPush';

/** 补传意图的默认数据库路径。 */
export function defaultIntentPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'push', 'replica-intents.sqlite');
}

/** 配置。 */
export interface PushConfig {
  /** 是否启用上报。 */
  enabled: boolean;
  /** 控制平面地址。 */
  gatewayUrl: string;
  /** 定期扫描间隔。 */
  flushIntervalMs: number;
  /** 单批最多上报条数。 */
  batchSize: number;
  /** 单批最多正文字节数。 */
  batchBytes: number;
  /** 本设备标识，控制平面据此区分来源。 */
  deviceId: string;
  /** 节点令牌，向控制平面证明设备身份；缺省取环境变量 `CHATDSH_NODE_TOKEN`。 */
  nodeToken?: string;
  /** 补传意图数据库路径；缺省取 `$DSH_HOME/push/replica-intents.sqlite`。 */
  intentPath?: string;
}

/** 配置 schema。 */
export const Config: z<PushConfig> = z.object({
  enabled: z.boolean().default(true),
  // 控制平面地址与本设备标识取设备形态的两个环境变量，与设备长连接同一处下发；
  // 都没有配置时退回本机默认端口。
  gatewayUrl: z.string().default(process.env.CHATDSH_CONTROL_URL ?? 'http://127.0.0.1:3170'),
  flushIntervalMs: z.number().default(2000),
  batchSize: z.number().default(BATCH_LIMIT),
  batchBytes: z.number().default(BATCH_BYTES),
  deviceId: z.string().default(process.env.CHATDSH_DEVICE_ID ?? 'local'),
  nodeToken: z.string().default(process.env.CHATDSH_NODE_TOKEN ?? ''),
  intentPath: z.string().default(process.env.CHATDSH_PUSH_INTENT_DB ?? ''),
});

/**
 * 上报服务。
 *
 * 挂在 `session/event` 上登记补传意图，按间隔扫描全部会话并成批上报。控制平面不可达时
 * 意图与权威日志都保留，下一轮继续；令牌被拒绝时停止后续上报。
 */
export class ChatdshPushService extends Service {
  /** 会话持久化用于读取已提交日志。 */
  static inject = ['sessionPersistence'];

  /** 配置 schema。 */
  static Config: z<PushConfig> = Config;

  private runner: ReplicaContinuity | undefined;
  private intents: ReplicaIntentStore | undefined;
  private timer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private syncing = false;
  private failures = 0;

  constructor(ctx: Context, private readonly config: PushConfig) {
    super(ctx, SERVICE_NAME);
  }

  /** 建立补传引擎、登记事件监听并开始扫描。 */
  async [Service.init](): Promise<void> {
    if (!this.config.enabled) return;
    const configured = this.config.intentPath ?? '';
    const path = configured === '' ? defaultIntentPath() : configured;
    this.intents = new ReplicaIntentStore(path);
    this.runner = new ReplicaContinuity({
      persistence: sessionPersistenceOf(this.ctx),
      intents: this.intents,
      controlUrl: this.config.gatewayUrl,
      deviceId: this.config.deviceId,
      nodeToken: this.config.nodeToken ?? '',
      telemetry: telemetryOf<ChatdshTelemetry>(this.ctx),
      batchSize: this.config.batchSize,
      batchBytes: this.config.batchBytes,
    });
    this.ctx.on(SESSION_EVENTS.event, (session, event) => {
      this.runner?.noteEvent(session.id, Number(event.seq));
      this.schedule();
    });
    this.ctx.on(SESSION_EVENTS.created, (session) => {
      this.runner?.noteSession(session.id);
      this.schedule();
    });
    this.timer = setInterval(() => void this.tick(), this.config.flushIntervalMs);
    this.timer.unref();
    this.ctx.effect(() => () => this.stop(), `${name}/scan`);
    void this.startupScan();
  }

  /** 启动扫描：枚举全部已存储会话，包含未打开的冷会话。 */
  private async startupScan(): Promise<void> {
    const runner = this.runner;
    if (runner === undefined) return;
    try {
      await runner.scanAll();
    } catch (error) {
      this.telemetry()?.log('warn', 'replica startup scan failed', {
        'error.type': error instanceof Error ? error.name : 'Unknown',
      });
    }
    this.schedule();
  }

  /** 立即扫描全部会话，返回本轮同步的会话数。 */
  async flush(): Promise<number> {
    const runner = this.runner;
    if (runner === undefined) return 0;
    const results = await runner.scanAll();
    return results.length;
  }

  /** 仍有待补传事件的会话数。 */
  pendingSessions(): number {
    return this.intents?.pendingSessions().length ?? 0;
  }

  /** 停止扫描并释放意图库。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.intents?.close();
    this.intents = undefined;
    this.runner = undefined;
  }

  /** 一轮同步。 */
  private async tick(): Promise<void> {
    const runner = this.runner;
    if (runner === undefined || this.syncing) return;
    this.syncing = true;
    try {
      const results = await runner.syncPending();
      const failed = results.some((result) => result.outcome === 'unreachable');
      if (failed) this.scheduleRetry();
      else this.failures = 0;
    } catch (error) {
      this.telemetry()?.log('warn', 'replica sync failed', {
        'error.type': error instanceof Error ? error.name : 'Unknown',
      });
      this.scheduleRetry();
    } finally {
      this.syncing = false;
    }
  }

  /** 尽快安排一轮扫描。 */
  private schedule(): void {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.tick();
    }, 100);
    this.retryTimer.unref();
  }

  /** 按退避序列安排下一轮。 */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.failures, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0];
    this.failures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.tick();
    }, delay + Math.floor(Math.random() * 250));
    this.retryTimer.unref();
  }

  /** 遥测出口；没有宿主平面遥测时为空。 */
  private telemetry(): ChatdshTelemetry | undefined {
    return telemetryOf<ChatdshTelemetry>(this.ctx);
  }
}

export { ChatdshPushService as default };
