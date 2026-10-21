/**
 * 记忆接入层。
 *
 * 这一层不持有记忆数据：存储由外部 Hindsight 服务承担，插件只做编排与规则——按工作区与
 * 会话类型算出该读写哪些 bank，按当前问题发起召回，按会话把内容写回。服务不可达时报不可用，
 * 记忆功能显示为未启用（Hindsight 不可达），不退回本地假记忆。
 * @module @chatdsh/host-memory
 */

import {
  AGENT_EVENTS,
  SESSION_EVENTS,
  Remote,
  schema as z,
  sessionPersistenceOf,
  systemPromptOf,
  telemetryOf,
  TypertRemoteService,
  type Context,
} from '@chatdsh/adapter';
import { createMemoryClient, type MemoryClient, type RecallOptions, type WriteOptions } from './client.ts';
import { banksFor, lastUserText, planTurnWrite, renderRecallSection, TurnWriteDeduper, type MemoryHit, type TurnMessage } from './rules.ts';

export { banksFor, composeTurnMemory, dedupeHits, lastUserText, planTurnWrite, renderRecallSection, TurnWriteDeduper } from './rules.ts';
export type { TurnMessage, TurnWritePlan } from './rules.ts';
export type { MemoryHit, MemoryScope } from './rules.ts';
export { MemoryUnavailableError } from './client.ts';
export type { RecallOptions, WriteOptions } from './client.ts';

/** 插件名。 */
export const name = 'chatdsh-memory';

/** 记忆运行时使用的服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshMemory';

/** 依赖：提示席位用于注入召回结果，会话持久化用于回合结束后读取日志。 */
export const inject = ['systemPrompt', 'sessionPersistence'];

/** 提示上下文席位的名字。 */
export const RECALL_CONTEXT_NAME = 'chatdsh-memory:recall';

/** 召回结果在提示里的排序位置：排在项目说明之后、工具说明之前。 */
export const RECALL_CONTEXT_ORDER = 20;

/** 提示席位的注册面。 */
interface PromptBound {
  context(spec: { name: string; order: number; interpolate: boolean; text: () => string }): () => void;
}

/** 一个 agent 在本插件看来需要的部分。 */
interface AgentLike {
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } };
  readonly ctx: { readonly systemPrompt: PromptBound };
}

/** 记忆后端的状态，供界面展示。 */
export interface MemoryStatus {
  /** 后端是否可达。 */
  readonly available: boolean;
  /** 服务地址，不含凭据。 */
  readonly endpoint: string;
  /** 单次召回的令牌上限。 */
  readonly maxTokens: number;
  /** 额外召回 bank 的优先级顺序。 */
  readonly extraBanks: readonly string[];
}

/** 配置。 */
export interface MemoryConfig {
  /** Hindsight 服务地址。 */
  hindsightUrl: string;
  /** 凭据所在的环境变量名；凭据本身不作为配置值保存。 */
  apiKeyEnv?: string;
  /** 单次召回的令牌上限。 */
  maxTokens: number;
  /** 单次请求的超时。 */
  requestTimeoutMs: number;
  /** bank 模板解算到别的 bank 时是否也写入自己的 bank。 */
  mirrorToOwnBank: boolean;
  /** 额外召回的 bank，按优先级追加。 */
  additionalBanks: string[];
}

/** 配置 schema。 */
export const Config: z<MemoryConfig> = z.object({
  hindsightUrl: z.string().default('http://127.0.0.1:8889'),
  apiKeyEnv: z.string(),
  maxTokens: z.number().default(1024),
  requestTimeoutMs: z.number().default(5000),
  mirrorToOwnBank: z.boolean().default(false),
  additionalBanks: z.array(z.string()).default([]),
});

/** 遥测面，只用到的部分。 */
interface MemoryTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>): Promise<T>;
  counter(name: string, options: { description: string }): { add(value: number, attributes?: Record<string, unknown>): void };
  histogram(name: string, options: { description: string; unit?: string }): { record(value: number, attributes?: Record<string, unknown>): void };
  event(name: string, attributes?: Record<string, unknown>): void;
}

/**
 * 记忆接入服务。
 *
 * 召回与写入都先确认服务可用；失败时记一条 `chatdsh.memory.degraded` 并把错误抛给调用方，
 * 由调用方决定如何呈现。这个服务不缓存召回结果，也不在内存里留一份副本。
 */
export class ChatdshMemoryService extends TypertRemoteService {
  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  /**
   * 依赖的服务。
   *
   * 这里必须写成静态字段：加载器按 `Service.inject` 解析依赖，模块级导出的 `inject`
   * 只对函数插件生效。写成模块级时实例拿不到 `ctx.sessionPersistence`，回合写入会在
   * 运行时抛「cannot get property without inject」。
   */
  static inject = ['systemPrompt', 'sessionPersistence'];

  private readonly client: MemoryClient;
  private readonly extraBanks: readonly string[];
  private readonly endpoint: string;
  private readonly maxTokens: number;
  /** 每个会话最近一次召回的结果，供提示席位同步读取。 */
  private readonly recalls = new Map<string, { hits: MemoryHit[]; at: number; query: string }>();
  /** 已经写过记忆的回合，避免重放或重复事件造成重复写入。 */
  private readonly writtenTurns = new TurnWriteDeduper();

  constructor(ctx: Context, config: MemoryConfig) {
    super(ctx, SERVICE_NAME);
    this.client = createMemoryClient(config, (operation, error) => this.reportFailure(operation, error));
    this.extraBanks = config.additionalBanks;
    this.endpoint = config.hindsightUrl;
    this.maxTokens = config.maxTokens;
  }

  /**
   * 挂上会话生命周期。
   *
   * 每新建一个 agent，就在它的作用域里注册一个提示席位，席位读该会话最近一次的召回结果；
   * 每步开始前按当前问题重新召回并覆盖这份结果。席位与 agent 同生共死，卸载时自动回收。
   */
  async [TypertRemoteService.init](): Promise<void> {
    this.ctx.on(AGENT_EVENTS.created, (payload) => {
      const agent = payload.agent;
      systemPromptOf(agent.ctx).context({
        name: RECALL_CONTEXT_NAME,
        order: RECALL_CONTEXT_ORDER,
        interpolate: false,
        text: () => renderRecallSection(this.recalls.get(agent.session.id)?.hits ?? []),
      });
      return undefined;
    });

    this.ctx.on(AGENT_EVENTS.preStep, async (payload, next) => {
      await this.refreshRecall(payload.agent, payload.messages);
      return next();
    });

    // 回合结束后把本回合的用户与助手消息写回记忆。写入是后台动作：失败只记降级事件，
    // 不改变回合结果，也不阻塞下一个回合。
    this.ctx.on(SESSION_EVENTS.event, (session, event) => {
      if (event.type === 'turn/end') void this.persistTurn(session, event.seq);
    });
  }

  /**
   * 把一个回合写进记忆。
   *
   * 回合内容从会话日志读：最后一条 `turn/start` 到本次 `turn/end` 之间的 user/message
   * 与 assistant/message。写入 bank 由 `banksFor` 决定，共享工作区写组 bank，私有工作区
   * 写账号 bank。同一个会话的同一回合只写一次。
   */
  private async persistTurn(session: { readonly id: string; readonly header: { readonly cwd?: string } }, endSeq: number): Promise<void> {
    const cwd = session.header.cwd ?? '';
    const turnKey = `${session.id}:${String(endSeq)}`;
    if (!this.writtenTurns.accept(turnKey)) return;
    try {
      const handle = await sessionPersistenceOf(this.ctx).open(session.id as never, 'read');
      let messages: TurnMessage[] = [];
      try {
        const result = await handle.read();
        const events = result.events;
        let start = 0;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const candidate = events[index];
          if (candidate !== undefined && candidate.type === 'turn/start') {
            start = index;
            break;
          }
        }
        for (const event of events.slice(start)) {
          if (event.type === 'user/message') {
            const content = event.data.content as readonly { type?: string; text?: string }[];
            const text = content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(' ').trim();
            if (text !== '') messages.push({ role: 'user', text });
          }
          if (event.type === 'assistant/message') {
            const content = event.data.message.content as readonly { type?: string; text?: string }[];
            const text = content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(' ').trim();
            if (text !== '') messages.push({ role: 'assistant', text });
          }
        }
      } finally {
        await handle.close();
      }
      const plan = planTurnWrite({ cwd, shared: this.workspaceShared(cwd), messages });
      if (plan === undefined) return;
      await this.write(plan.bank, { content: plan.content, context: 'turn-summary' });
    } catch {
      this.telemetry()?.event('chatdsh.memory.degraded', { operation: 'turn-write', reason: 'hindsight-unreachable' });
    }
  }

  /** 工作区是否标记为共享；项目插件未安装时按私有处理。 */
  private workspaceShared(cwd: string): boolean {
    if (cwd === '') return false;
    const projects = this.ctx.reflect.get('chatdshProjects') as { get?: (path: string) => { shared?: boolean } | undefined } | undefined;
    return projects?.get?.(cwd)?.shared === true;
  }

  /**
   * 按本步的问题重新召回。
   *
   * 失败时记一条降级事件并保留上一次结果：记忆是可选能力，它的后端不可达不应该让会话停下。
   */
  private async refreshRecall(agent: AgentLike, messages: readonly unknown[]): Promise<void> {
    const question = lastUserText(messages);
    if (question === '') return;
    // 同一回合内的连续工具调用不重复召回，用五秒的窗口界定「同一回合」：
    // 用户隔一会儿再问同一个问题时仍会重新召回，不因为文本相同就永远跳过。
    const previous = this.recalls.get(agent.session.id);
    if (previous !== undefined && previous.query === question && Date.now() - previous.at < 5_000) return;
    const cwd = agent.session.header.cwd ?? '';
    const banks = banksFor({ accountId: 'local', tenantId: 'default', memoryGroupId: cwd === '' ? undefined : cwd }).recall;
    try {
      const hits = await this.recall(banks, { query: question });
      this.recalls.set(agent.session.id, { hits, at: Date.now(), query: question });
    } catch {
      this.telemetry()?.event('chatdsh.memory.degraded', { operation: 'pre-step-recall', reason: 'hindsight-unreachable' });
    }
  }

  /** 后端状态：可用性与连接参数，不带凭据。 */
  @Remote('status')
  async status(): Promise<MemoryStatus> {
    return {
      available: await this.client.probe(),
      endpoint: this.endpoint,
      maxTokens: this.maxTokens,
      extraBanks: this.extraBanks,
    };
  }

  /** 服务是否可用。 */
  async probe(): Promise<boolean> {
    return this.client.probe();
  }

  /**
   * 召回：先查调用方给的 bank，再按优先级追加额外 bank，按文本去重合并。
   * @param banks - 该会话场景的主 bank，按顺序。
   * @param options - 查询与可选的标签过滤。
   * @returns 召回结果。
   */
  async recall(banks: readonly string[], options: RecallOptions) {
    const targets = [...banks, ...this.extraBanks.filter((bank) => !banks.includes(bank))];
    const telemetry = this.telemetry();
    const kind = banks.length > 1 ? 'workspace' : 'acct';
    if (telemetry === undefined) return this.client.recall(targets, options);

    const started = Date.now();
    return telemetry.runSpan('chatdsh.memory.recall', { 'bank.kind': kind }, async (span) => {
      try {
        const hits = await this.client.recall(targets, options);
        span.setAttribute('hits', hits.length);
        span.setAttribute('outcome', 'delivered');
        return hits;
      } catch (error) {
        span.setAttribute('hits', 0);
        span.setAttribute('outcome', 'unavailable');
        throw error;
      } finally {
        // 耗时是分布，不是累加量：累加计数器只能回答「总共花了多久」，
        // 回答不了「一次召回通常花多久」与「最慢的一次多慢」。
        telemetry.histogram('chatdsh_memory_recall_seconds', { description: '记忆召回耗时', unit: 's' })
          .record((Date.now() - started) / 1000, { bank_kind: kind });
      }
    });
  }

  /** 写入一条记忆。 */
  async write(bank: string, options: WriteOptions) {
    const telemetry = this.telemetry();
    if (telemetry === undefined) return this.client.write(bank, options);
    return telemetry.runSpan('chatdsh.memory.write', { 'bank.kind': bank.startsWith('t:') ? 'workspace' : 'acct' }, async (span) => {
      const result = await this.client.write(bank, options);
      span.setAttribute('outcome', 'delivered');
      return result;
    });
  }

  /** 失败分支：记一条降级事件并把错误交回调用方。 */
  private reportFailure(operation: string, error: unknown): void {
    this.telemetry()?.event('chatdsh.memory.degraded', {
      operation,
      reason: 'hindsight-unreachable',
      'error.type': error instanceof Error ? error.name : 'Unknown',
    });
  }

  /** 取遥测服务；没有安装遥测插件时为 undefined。 */
  private telemetry(): MemoryTelemetry | undefined {
    return telemetryOf<MemoryTelemetry>(this.ctx);
  }
}

export { ChatdshMemoryService as default };
