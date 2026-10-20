/**
 * 恢复适配：把控制平面的会话副本转成可交给会话创建的种子。
 *
 * 这一步只负责形状转换，不创建会话——创建与驱动属于宿主启动流程，插件在这里提供的是
 * 一次远端可调用的转换，便于上层在拿到副本之后立刻验证种子是否合法。
 * @module @chatdsh/plugin-import
 */

import {
  Remote,
  schema as sz,
  TypertRemoteService,
  type Context,
  type SessionEvent,
  type SessionId,
} from '@chatdsh/adapter';
import { buildSeed, type ReplicaRecord, type SessionSeedEvent } from './seed.ts';

export { buildSeed } from './seed.ts';
export type { ReplicaRecord, SessionSeedEvent } from './seed.ts';

/** 一次恢复所需的全部信息。 */
export interface RestoreInput {
  /** 新建会话的标识。 */
  readonly sessionId: string;
  /** 源会话标识，记进 `parentSession`。 */
  readonly sourceSessionId: string;
  /** 新会话的工作目录，取自当前设备。 */
  readonly cwd: string;
  /** 控制平面的副本记录。 */
  readonly records: ReplicaRecord[];
}

/** 插件名。 */
export const name = 'chatdsh-import';

/** 依赖：会话注册表（创建与恢复都要用到）。 */
export const inject = ['sessions'];

/** 配置。 */
export interface ImportConfig {
  /** 控制平面地址，供上层拉取副本使用。 */
  gatewayUrl: string;
}

/** 配置 schema。 */
export const Config: sz<ImportConfig> = sz.object({
  gatewayUrl: sz.string().default('http://127.0.0.1:3170'),
});

/** 需要的遥测面。 */
interface ImportTelemetry {
  runSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  /** 取得计数器句柄；句柄的 `add` 才真正累加计数。 */
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/**
 * 恢复服务。
 *
 * 远端只做一件事：把副本记录转成种子，并在形状不合法时就地抛出。
 */
export class ImportService extends TypertRemoteService {
  /** 配置 schema。 */
  static readonly Config = Config;

  constructor(ctx: Context, private readonly config: ImportConfig) {
    super(ctx, 'chatdshImport');
  }

  /** 取遥测客户端；关闭遥测时返回 undefined。 */
  private telemetry(): ImportTelemetry | undefined {
    return this.ctx.reflect.get('chatdshTelemetry') as ImportTelemetry | undefined;
  }

  /** 控制平面地址。 */
  @Remote('gatewayUrl')
  endpoint(): string {
    return this.config.gatewayUrl;
  }

  /** 把副本记录转成会话种子。 */
  @Remote('seedOf')
  async seedOf(records: ReplicaRecord[]): Promise<SessionSeedEvent[]> {
    const telemetry = this.telemetry();
    if (telemetry === undefined) return buildSeed(records);
    return telemetry.runSpan('chatdsh.import.seed', { 'records.count': records.length }, async (span) => {
      try {
        const seed = buildSeed(records);
        span.setAttribute('seed.count', seed.length);
        telemetry.counter('chatdsh_import_seed_total', { description: '会话种子构造次数' })
          .add(1, { outcome: 'ok' });
        return seed;
      } catch (error) {
        span.setAttribute('outcome', 'failed');
        telemetry.event('chatdsh.import.seed.failed', {
          'error.type': error instanceof Error ? error.name : 'Unknown',
          'records.count': records.length,
        });
        telemetry.counter('chatdsh_import_seed_total', { description: '会话种子构造次数' })
          .add(1, { outcome: 'failed' });
        throw error;
      }
    });
  }

  /**
   * 按控制平面的导入记录在本地建会话。
   *
   * 种子来自副本，`parentSession` 指向源会话；这两项一起构成架构文档要求的「在本地继续」。
   */
  @Remote('restore')
  restore(input: RestoreInput): string {
    const session = this.ctx.sessions.create(input.sessionId as SessionId, {
      seed: buildSeed(input.records) as unknown as readonly SessionEvent[],
      meta: {
        cwd: input.cwd,
        parentSession: input.sourceSessionId as SessionId,
        createdAt: Date.now(),
      },
    });
    return session.id;
  }
}

/** 注册服务。 */
export function apply(ctx: Context, config: ImportConfig): void {
  ctx.plugin(ImportService, config);
}
