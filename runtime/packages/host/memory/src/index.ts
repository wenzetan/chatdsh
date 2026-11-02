/**
 * 记忆接入层。
 *
 * 这一层不持有记忆数据：存储由外部 Hindsight 服务承担，插件只做编排与规则——按工作区与
 * 会话类型算出该读写哪些 bank，按当前问题发起召回，按会话把内容写回。服务不可达时报不可用，
 * 记忆功能显示为未启用（Hindsight 不可达），不退回本地假记忆。
 * @module @chatdsh/host-memory
 */

import { z as zd } from 'zod';
import {
  AGENT_EVENTS,
  SESSION_EVENTS,
  Remote,
  createUserMessage,
  schema as z,
  llmOf,
  sessionPersistenceOf,
  telemetryOf,
  TypertRemoteService,
  type Context,
  type UserMessage,
} from '@chatdsh/adapter';
import {
  ChatdshError,
  chatdshErrorCodeSchema,
  epochMillisSchema,
  identifierSchema,
  MEMORY_MAX_TOKENS_RANGE,
  MEMORY_ACCOUNT_BANK,
  memoryRecallRequestSchema,
  memoryRecallResultSchema,
  memorySettingsViewSchema,
  memoryWorkspaceRefSchema,
  revisionSchema,
  type ChatdshErrorCode,
  type MemoryGroupSave,
  type MemoryRecallHit,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemorySettingsView,
  type MemoryWorkspaceRef,
  type MemoryWriteQueueView,
} from '@chatdsh/core-contracts';
import type { MemoryRecallMessageSource } from '@chatdsh/core-contracts';
import { createMemoryClient, type MemoryClient, type RecallOptions, type WriteOptions } from './client.ts';
import { MemoryGroupRegistry, type MemoryGroupRecord } from './groups.ts';
import { banksFor, collectSummaryText, composeSummaryPrompt, groupBankName, lastUserText, planTurnWrite, RecallSequenceDeduper, renderRecallSection, shouldRecall, summaryRequestOf, TurnWriteDeduper, type MemoryHit, type SummaryConfigLike, type TurnMessage } from './rules.ts';
import { searchMemory } from './search.ts';
import { MemoryStore } from './store.ts';
import { UnconfirmedWrites } from './unconfirmed.ts';
export { banksFor, collectSummaryText, composeSummaryPrompt, composeTurnMemory, dedupeHits, groupBankName, lastUserText, planTurnWrite, RecallSequenceDeduper, renderRecallSection, shouldRecall, summaryRequestOf, TurnWriteDeduper } from './rules.ts';
export type { SummaryConfigLike, SummaryPrompt, SummaryRequest, TurnMessage, TurnWritePlan } from './rules.ts';
export type { MemoryHit, MemoryScope } from './rules.ts';
export { MemoryUnavailableError } from './client.ts';
export type { RecallOptions, WriteOptions } from './client.ts';
export { GROUP_LIMIT, GROUPS_STORE, MemoryGroupRegistry, sameWorkspace } from './groups.ts';
export type { MemoryGroupRecord } from './groups.ts';
export { MemoryStore, memoryDataRoot } from './store.ts';
export { UnconfirmedWrites, WRITES_LIMIT, WRITES_STORE } from './unconfirmed.ts';
export { searchMemory } from './search.ts';
export type { MemoryRecallChannel, MemorySearchInput } from './search.ts';

/** 插件名。 */
export const name = 'chatdsh-memory';

/** 记忆运行时使用的服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshMemory';

/** 依赖：会话持久化用于回合结束后读取日志，模型运行时用于回合摘要。 */
export const inject = ['sessionPersistence', 'llm'];

/** 一个 agent 在本插件看来需要的部分。 */
interface AgentLike {
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } };
}

/**
 * 把召回结果包成一条用户消息。
 *
 * 消息的来源标识是 `memory-recall`，界面按它把这段内容显示成「相关记忆」。
 * @param hits - 召回结果。
 * @returns 冻结的用户消息。
 */
function createRecallMessage(hits: readonly MemoryHit[]): UserMessage {
  const source: MemoryRecallMessageSource = { kind: 'memory-recall' };
  return createUserMessage({
    content: [{ type: 'text', text: renderRecallSection(hits) }],
    source,
  });
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
  /** 摘要模型所属的提供方路由；缺省时使用规则抽取。 */
  summaryProvider?: string;
  /** 摘要模型标识；缺省时使用规则抽取。 */
  summaryModel?: string;
  /** 本机设备标识，用于把工作区解析到记忆组。 */
  deviceId: string;
}

/** 配置 schema。 */
export const Config: z<MemoryConfig> = z.object({
  hindsightUrl: z.string().default('http://127.0.0.1:8889'),
  apiKeyEnv: z.string(),
  maxTokens: z.number().default(1024),
  requestTimeoutMs: z.number().default(5000),
  mirrorToOwnBank: z.boolean().default(false),
  additionalBanks: z.array(z.string()).default([]),
  summaryProvider: z.string().required(false),
  summaryModel: z.string().required(false),
  deviceId: z.string().default('local'),
});

/**
 * 记忆组视图。
 *
 * `entryCount` 需要记忆服务提供 bank 统计接口才能读取；记忆服务当前没有这个接口，
 * 因此字段缺省表示统计查询未完成，界面不能把它显示成零条。
 */
export interface MemoryGroupView {
  /** 稳定的记忆组标识。 */
  readonly memoryGroupId: string;
  /** 可编辑的显示名。 */
  readonly displayName: string;
  /** 关联的工作区集合。 */
  readonly workspaces: readonly MemoryWorkspaceRef[];
  /** 组内条目数；缺省表示统计查询未完成。 */
  readonly entryCount?: number;
  /** 建立时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 最后修改时刻的毫秒时间戳。 */
  readonly updatedAt: number;
  /** 记录版本。 */
  readonly revision: number;
}

/** 状态文件的 schema：最近成功失败时刻与配置版本。 */
const settingsStateSchema = zd.object({
  revision: revisionSchema,
  maxTokens: zd.number().int(),
  extraBanks: zd.array(identifierSchema),
  deviceId: zd.string().min(1).max(200),
  lastSuccessAt: epochMillisSchema.optional(),
  lastFailureAt: epochMillisSchema.optional(),
  lastErrorCode: chatdshErrorCodeSchema.optional(),
});

/** 状态文件。 */
type SettingsState = zd.infer<typeof settingsStateSchema>;

/** 状态文件名。 */
const SETTINGS_STATE_STORE = 'memory-settings';

/** 状态文件的缺省值。 */
const EMPTY_STATE: SettingsState = { revision: 0, maxTokens: 0, extraBanks: [], deviceId: '' };

/**
 * 取异常的错误码。
 * @param error - 抛出的异常。
 * @returns 带错误码异常的错误码；其他异常按后端不可达处理。
 */
function errorCodeOf(error: unknown): ChatdshErrorCode {
  return error instanceof ChatdshError ? error.code : 'memory-backend-unreachable';
}

/**
 * 取异常的类型名。
 * @param error - 抛出的异常。
 * @returns 类型名；非异常取 `Unknown`。
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : 'Unknown';
}

/**
 * 把一条召回结果转成契约里的检索命中。
 * @param hit - 接入层的召回结果。
 * @returns 检索命中；相关性得分超出 0 到 1 时省略。
 */
function hitOf(hit: MemoryHit): MemoryRecallHit {
  if (hit.bank === undefined) throw new ChatdshError('memory-backend-unreachable', '召回结果缺少 bank 标识');
  const scored = hit.score !== undefined && hit.score >= 0 && hit.score <= 1;
  return {
    bank: hit.bank,
    text: hit.text,
    source: hit.id,
    ...(scored ? { score: hit.score } : {}),
  };
}

/**
 * 把记忆组记录转成视图。没有读取到条目数时不写这个字段。
 * @param record - 记忆组记录。
 * @returns 记忆组视图。
 */
function groupViewOf(record: MemoryGroupRecord): MemoryGroupView {
  return {
    memoryGroupId: record.memoryGroupId,
    displayName: record.displayName,
    workspaces: record.workspaces.map((workspace) => ({ deviceId: workspace.deviceId, path: workspace.path })),
    ...(record.entryCount === undefined ? {} : { entryCount: record.entryCount }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
  };
}

/**
 * 判断两组 bank 是否逐项相同。
 * @param left - 一组 bank。
 * @param right - 另一组 bank。
 * @returns 长度与每一项都相同时为 true。
 */
function sameBanks(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((bank, index) => bank === right[index]);
}

/** 遥测 span 用到的最小接口。 */
type SpanLike = { setAttribute(key: string, value: unknown): void };

/** 遥测面，只用到的部分。 */
interface MemoryTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: SpanLike) => Promise<T>): Promise<T>;
  counter(name: string, options: { description: string }): { add(value: number, attributes?: Record<string, unknown>): void };
  histogram(name: string, options: { description: string; unit?: string }): { record(value: number, attributes?: Record<string, unknown>): void };
  event(name: string, attributes?: Record<string, unknown>): void;
}

/**
 * 记忆接入服务。
 *
 * 召回与写入都先确认服务可用；失败时记一条 `chatdsh.memory.degraded` 并把错误抛给调用方，
 * 由调用方决定如何呈现。这个服务不缓存召回内容，只按会话记住上一次追加的召回编号序列。
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
  static inject = ['sessionPersistence', 'llm'];

  private readonly client: MemoryClient;
  private readonly extraBanks: readonly string[];
  private readonly endpoint: string;
  private readonly maxTokens: number;
  /** 本机设备标识，用于把工作区解析到记忆组。 */
  private readonly deviceId: string;
  /** 凭据环境变量名称；只用于展示配置状态，凭据值不进入任何视图。 */
  private readonly apiKeyEnv: string | undefined;
  /** 记忆组映射、未确认写入与状态记录的持久存储。 */
  private readonly store: MemoryStore;
  private readonly groups: MemoryGroupRegistry;
  private readonly writes: UnconfirmedWrites;
  /** 摘要请求的提供方与模型；两项都缺省时保持规则抽取。 */
  private readonly summaryConfig: SummaryConfigLike;
  /** 每个会话上一次追加的召回编号序列，用于避免同一批记忆重复进入历史。 */
  private readonly recalledSequences = new RecallSequenceDeduper();
  /** 已经写过记忆的回合，避免重放或重复事件造成重复写入。 */
  private readonly writtenTurns = new TurnWriteDeduper();

  constructor(ctx: Context, config: MemoryConfig) {
    super(ctx, SERVICE_NAME);
    if (config.maxTokens < MEMORY_MAX_TOKENS_RANGE.min || config.maxTokens > MEMORY_MAX_TOKENS_RANGE.max) {
      throw new ChatdshError('memory-limit-out-of-range', '召回令牌上限超出产品范围', { min: MEMORY_MAX_TOKENS_RANGE.min, max: MEMORY_MAX_TOKENS_RANGE.max });
    }
    this.client = createMemoryClient(config, (operation, error) => this.reportFailure(operation, error));
    this.extraBanks = config.additionalBanks;
    this.endpoint = config.hindsightUrl;
    this.maxTokens = config.maxTokens;
    this.deviceId = config.deviceId;
    this.apiKeyEnv = config.apiKeyEnv;
    this.store = new MemoryStore();
    this.groups = new MemoryGroupRegistry(this.store);
    this.writes = new UnconfirmedWrites(this.store);
    this.summaryConfig = { summaryProvider: config.summaryProvider, summaryModel: config.summaryModel };
  }

  /**
   * 挂上会话生命周期。
   *
   * 每步开始前按当前问题召回一次，命中就在本步进入的消息末尾追加一条用户消息，内容是
   * 该会话场景下 bank 里的记忆。追加只改本步进入的消息列表，已经进入历史的前缀保持不变。
   * 回合结束后把本回合写回记忆。
   */
  async [TypertRemoteService.init](): Promise<void> {
    // 配置在插件装载时取快照：生效值变化一次就递增一次状态版本，进行中的召回沿用旧快照。
    await this.store.mutate<SettingsState, void>(SETTINGS_STATE_STORE, settingsStateSchema, EMPTY_STATE, async (current) => {
      const changed = current.maxTokens !== this.maxTokens || current.deviceId !== this.deviceId || !sameBanks(current.extraBanks, this.extraBanks);
      if (!changed) return { result: undefined };
      return {
        value: { ...current, revision: current.revision + 1, maxTokens: this.maxTokens, extraBanks: [...this.extraBanks], deviceId: this.deviceId },
        result: undefined,
      };
    });

    this.ctx.on(AGENT_EVENTS.preStep, async (payload, next) => {
      const decision = await next();
      if (decision.kind === 'reject') return decision;
      if (!shouldRecall({ step: payload.step, messages: payload.messages })) return decision;
      const hits = await this.recallFor(payload.agent, payload.messages);
      if (hits.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, createRecallMessage(hits)] };
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
   * 与 assistant/message。写入一律落在 `acct`。同一个会话的同一回合只写一次。
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

      const summary = await this.summarizeTurn(messages);
      const plan = planTurnWrite({ cwd, messages, ...(summary === undefined ? {} : { content: summary }) });
      if (plan === undefined) return;
      await this.deliverTurnWrite(plan.bank, plan.content);
    } catch {
      this.telemetry()?.event('chatdsh.memory.degraded', { operation: 'turn-write', reason: 'hindsight-unreachable' });
    }
  }

  /**
   * 写一条回合记忆。
   *
   * 先登记未确认记录再交给适配层：成功即删除登记，失败保留记录并记下错误码。适配层没有
   * 客户端操作标识与写入查询，失败后不自动重放，等人工处理。
   * @param bank - 目标 bank。
   * @param content - 记忆内容。
   */
  private async deliverTurnWrite(bank: string, content: string): Promise<void> {
    const record = await this.writes.register({ bank, content, context: 'turn-summary' });
    try {
      await this.write(bank, { content, context: 'turn-summary' });
      await this.writes.delivered(record.id);
      this.telemetry()?.counter('chatdsh_memory_writes_total', { description: '记忆写入结果' }).add(1, { outcome: 'delivered' });
      await this.recordOutcome(true);
    } catch (error) {
      const code = errorCodeOf(error);
      await this.writes.failed(record.id, code);
      this.telemetry()?.event('chatdsh.memory.write.failed', { 'error.type': errorTypeOf(error), 'error.code': code, outcome: 'unconfirmed' });
      this.telemetry()?.counter('chatdsh_memory_writes_total', { description: '记忆写入结果' }).add(1, { outcome: 'unconfirmed' });
      await this.recordOutcome(false, code);
    }
  }

  /**
   * 用模型生成一条回合摘要。
   *
   * 未配置提供方与模型时返回 `undefined`，调用方使用规则抽取。配置后调用失败或
   * 模型没有输出文本时同样返回 `undefined`，并记一条 `chatdsh.memory.degraded`。
   */
  private async summarizeTurn(messages: readonly TurnMessage[]): Promise<string | undefined> {
    const prompt = composeSummaryPrompt(messages);
    if (prompt === undefined) return undefined;
    const request = summaryRequestOf(this.summaryConfig, prompt);
    if (request === undefined) return undefined;
    const call = async (): Promise<string | undefined> => {
      const chunks: unknown[] = [];
      for await (const chunk of llmOf(this.ctx).stream(request)) chunks.push(chunk);
      const text = collectSummaryText(chunks);
      return text === '' ? undefined : text;
    };
    const telemetry = this.telemetry();
    if (telemetry === undefined) {
      try {
        return await call();
      } catch {
        return undefined;
      }
    }
    return telemetry.runSpan('chatdsh.memory.summary', { 'model.provider': request.provider }, async (span) => {
      try {
        const text = await call();
        if (text === undefined) {
          span.setAttribute('outcome', 'empty');
          this.reportSummaryDegraded('summary-empty');
          return undefined;
        }
        span.setAttribute('outcome', 'delivered');
        span.setAttribute('chars', text.length);
        return text;
      } catch (error) {
        span.setAttribute('outcome', 'failed');
        this.reportSummaryDegraded('summary-failed', error);
        return undefined;
      }
    });
  }

  /** 记一条回合摘要降级事件；模型调用失败时带上错误类型。 */
  private reportSummaryDegraded(reason: string, error?: unknown): void {
    this.telemetry()?.event('chatdsh.memory.degraded', {
      operation: 'turn-summary',
      reason,
      ...(error === undefined ? {} : { 'error.type': error instanceof Error ? error.name : 'Unknown' }),
    });
  }

  /**
   * 按本步的问题召回。
   *
   * 失败时记一条降级事件并返回空结果：记忆是可选能力，它的后端不可达不应该让会话停下。
   * 召回结果的编号序列与上一次追加的相同就返回空结果，同一批记忆不重复进入历史。
   */
  private async recallFor(agent: AgentLike, messages: readonly unknown[]): Promise<readonly MemoryHit[]> {
    const question = lastUserText(messages);
    if (question === '') return [];
    const cwd = agent.session.header.cwd ?? '';
    // 工作区关联到记忆组时用组标识，未关联时沿用工作目录作为组标识。
    const group = cwd === '' ? undefined : await this.groups.resolve({ deviceId: this.deviceId, path: cwd });
    const banks = banksFor({ memoryGroupId: group?.memoryGroupId ?? (cwd === '' ? undefined : cwd) }).recall;
    let hits: readonly MemoryHit[];
    try {
      hits = await this.recall(banks, { query: question });
    } catch (error) {
      this.telemetry()?.event('chatdsh.memory.degraded', { operation: 'pre-step-recall', reason: 'hindsight-unreachable' });
      this.reportInjection('unavailable');
      await this.recordOutcome(false, errorCodeOf(error));
      return [];
    }
    await this.recordOutcome(true);
    if (hits.length === 0) {
      this.reportInjection('empty');
      return [];
    }
    if (!this.recalledSequences.accept(agent.session.id, hits.map((hit) => hit.id))) {
      this.reportInjection('repeat');
      return [];
    }
    this.reportInjection('appended');
    return hits;
  }

  /** 记一次召回注入的结果，按 outcome 聚合：追加、同一批重复、无命中、后端不可达。 */
  private reportInjection(outcome: string): void {
    this.telemetry()?.counter('chatdsh_memory_injections_total', { description: '记忆召回的注入结果' }).add(1, { outcome });
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
    return telemetry.runSpan('chatdsh.memory.write', { 'bank.kind': bank.startsWith('ws:') ? 'workspace' : 'acct' }, async (span) => {
      const result = await this.client.write(bank, options);
      span.setAttribute('outcome', 'delivered');
      return result;
    });
  }

  /**
   * 记忆状态视图。
   *
   * 状态按当前探活结果与最近一次后端动作的结果区分：探活成功是已启用可用，探活失败而
   * 最近一次读取超时是读取失败，其余探活失败是已启用不可达。地址与凭据环境变量名称只读
   * 展示，凭据值不进入视图。
   * @returns 记忆配置视图。
   */
  @Remote('settings')
  async settings(): Promise<MemorySettingsView> {
    const available = await this.client.probe();
    const state = await this.store.read(SETTINGS_STATE_STORE, settingsStateSchema, EMPTY_STATE);
    const readFailed = state.lastErrorCode === 'memory-recall-timeout';
    const view: MemorySettingsView = {
      enabled: true,
      state: available ? 'enabled-available' : readFailed ? 'read-failed' : 'enabled-unreachable',
      maxTokens: this.maxTokens,
      extraBanks: [...this.extraBanks],
      configSource: this.apiKeyEnv === undefined ? '插件配置行' : `插件配置行，凭据环境变量 ${this.apiKeyEnv}`,
      endpointConfigured: this.endpoint.trim() !== '',
      credentialEnvConfigured: this.apiKeyEnv !== undefined && (process.env[this.apiKeyEnv] ?? '') !== '',
      ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
      ...(state.lastFailureAt === undefined ? {} : { lastFailureAt: state.lastFailureAt }),
      ...(state.lastErrorCode === undefined ? {} : { lastErrorCode: state.lastErrorCode }),
      revision: state.revision,
    };
    return memorySettingsViewSchema.parse(view);
  }

  /**
   * 检索：按 bank 范围召回，按文本去重，截到条数上限。
   *
   * 后端失败返回 `degraded` 为真的结果并带错误码，界面据此显示降级，空结果只表示查询
   * 成功但没有命中。查询文本只保留在本次调用里。
   * @param request - 检索请求。
   * @returns 检索结果。
   */
  @Remote('search')
  async search(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
    const parsed = memoryRecallRequestSchema.safeParse(request);
    if (!parsed.success) throw new ChatdshError('request-invalid', '检索请求不合法');
    const banks = await this.banksForSearch(parsed.data.banks);
    const maxTokens = parsed.data.maxTokens ?? this.maxTokens;
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<MemoryRecallResult> => {
      try {
        const hits = await searchMemory({ channel: this.client, banks, text: parsed.data.text, limit: parsed.data.limit, maxTokens });
        span?.setAttribute('action', 'search');
        span?.setAttribute('hits', hits.length);
        span?.setAttribute('outcome', 'delivered');
        this.telemetry()?.counter('chatdsh_memory_searches_total', { description: '记忆检索结果' }).add(1, { outcome: 'delivered' });
        await this.recordOutcome(true);
        return memoryRecallResultSchema.parse({ hits: hits.map((hit) => hitOf(hit)), readAt: Date.now(), degraded: false });
      } catch (error) {
        const code = errorCodeOf(error);
        span?.setAttribute('hits', 0);
        span?.setAttribute('outcome', 'degraded');
        this.telemetry()?.event('chatdsh.memory.search.failed', { 'error.type': errorTypeOf(error), 'error.code': code, outcome: 'degraded' });
        this.telemetry()?.counter('chatdsh_memory_searches_total', { description: '记忆检索结果' }).add(1, { outcome: 'degraded' });
        await this.recordOutcome(false, code);
        return memoryRecallResultSchema.parse({ hits: [], readAt: Date.now(), degraded: true, code });
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.memory.search', {}, run);
  }

  /**
   * 记忆组列表。条目数需要记忆服务的统计接口，读取到之前视图里不出现这个字段。
   * @returns 记忆组视图。
   */
  @Remote('listGroups')
  async listGroups(): Promise<MemoryGroupView[]> {
    const records = await this.groups.list();
    return records.map((record) => groupViewOf(record));
  }

  /**
   * 保存记忆组。
   *
   * 新建时生成稳定标识；更新时用调用方给出的 `revision` 比较交换，版本不一致直接拒绝。
   * @param input - 保存请求。
   * @returns 保存后的记忆组视图。
   */
  @Remote('saveGroup')
  async saveGroup(input: MemoryGroupSave): Promise<MemoryGroupView> {
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<MemoryGroupView> => {
      try {
        const record = await this.groups.save(input);
        span?.setAttribute('action', 'save');
        span?.setAttribute('outcome', 'applied');
        this.telemetry()?.counter('chatdsh_memory_group_changes_total', { description: '记忆组变更' }).add(1, { action: 'save', outcome: 'applied' });
        return groupViewOf(record);
      } catch (error) {
        span?.setAttribute('action', 'save');
        span?.setAttribute('outcome', 'rejected');
        this.telemetry()?.event('chatdsh.memory.group.rejected', { 'error.type': errorTypeOf(error), 'error.code': errorCodeOf(error), outcome: 'rejected' });
        this.telemetry()?.counter('chatdsh_memory_group_changes_total', { description: '记忆组变更' }).add(1, { action: 'save', outcome: 'rejected' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.memory.group.save', {}, run);
  }

  /**
   * 解除一个工作区与记忆组的关联。解除最后一个工作区时删除该组，既有记忆保持原样。
   * @param memoryGroupId - 记忆组标识。
   * @param workspace - 工作区。
   * @param revision - 调用方看到的版本。
   * @returns 更新后的记忆组视图；整组被删除时为 `undefined`。
   */
  @Remote('detachWorkspace')
  async detachWorkspace(memoryGroupId: string, workspace: MemoryWorkspaceRef, revision: number): Promise<MemoryGroupView | undefined> {
    const target = this.parseWorkspace(memoryGroupId, workspace);
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<MemoryGroupView | undefined> => {
      try {
        const record = await this.groups.detach(target.memoryGroupId, target.workspace, revision);
        span?.setAttribute('action', 'detach');
        span?.setAttribute('outcome', 'applied');
        this.telemetry()?.counter('chatdsh_memory_group_changes_total', { description: '记忆组变更' }).add(1, { action: 'detach', outcome: 'applied' });
        return record === undefined ? undefined : groupViewOf(record);
      } catch (error) {
        span?.setAttribute('action', 'detach');
        span?.setAttribute('outcome', 'rejected');
        this.telemetry()?.event('chatdsh.memory.group.rejected', { 'error.type': errorTypeOf(error), 'error.code': errorCodeOf(error), outcome: 'rejected' });
        this.telemetry()?.counter('chatdsh_memory_group_changes_total', { description: '记忆组变更' }).add(1, { action: 'detach', outcome: 'rejected' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.memory.group.detach', {}, run);
  }

  /**
   * 删除一个记忆组映射。既有记忆保持原样。
   * @param memoryGroupId - 记忆组标识。
   * @param revision - 调用方看到的版本。
   * @returns 删除成功为 true。
   */
  @Remote('removeGroup')
  async removeGroup(memoryGroupId: string, revision: number): Promise<boolean> {
    const parsedId = identifierSchema.safeParse(memoryGroupId);
    if (!parsedId.success) throw new ChatdshError('request-invalid', '记忆组标识不合法');
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<boolean> => {
      try {
        const removed = await this.groups.remove(parsedId.data, revision);
        span?.setAttribute('action', 'remove');
        span?.setAttribute('outcome', 'applied');
        this.telemetry()?.counter('chatdsh_memory_group_changes_total', { description: '记忆组变更' }).add(1, { action: 'remove', outcome: 'applied' });
        return removed;
      } catch (error) {
        span?.setAttribute('action', 'remove');
        span?.setAttribute('outcome', 'rejected');
        this.telemetry()?.event('chatdsh.memory.group.rejected', { 'error.type': errorTypeOf(error), 'error.code': errorCodeOf(error), outcome: 'rejected' });
        this.telemetry()?.counter('chatdsh_memory_group_changes_total', { description: '记忆组变更' }).add(1, { action: 'remove', outcome: 'rejected' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.memory.group.detach', {}, run);
  }

  /**
   * 待写入与废弃记录的脱敏视图。只给数量、时间与错误码。
   * @returns 未确认写入记录视图。
   */
  @Remote('writeQueue')
  async writeQueue(): Promise<MemoryWriteQueueView> {
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<MemoryWriteQueueView> => {
      const view = await this.writes.view();
      span?.setAttribute('action', 'read');
      span?.setAttribute('outcome', 'delivered');
      this.telemetry()?.counter('chatdsh_memory_queue_actions_total', { description: '未确认写入记录的处理动作' }).add(1, { action: 'read', outcome: 'delivered' });
      return view;
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.memory.write.queue', {}, run);
  }

  /**
   * 丢弃一条未确认写入记录。
   * @param id - 记录标识。
   * @returns 记录存在且被丢弃时为 true。
   */
  @Remote('discardWrite')
  async discardWrite(id: string): Promise<boolean> {
    const telemetry = this.telemetry();
    const run = async (span?: SpanLike): Promise<boolean> => {
      try {
        const discarded = await this.writes.discard(id);
        span?.setAttribute('action', 'discard');
        span?.setAttribute('outcome', discarded ? 'applied' : 'skipped');
        this.telemetry()?.counter('chatdsh_memory_queue_actions_total', { description: '未确认写入记录的处理动作' }).add(1, { action: 'discard', outcome: discarded ? 'applied' : 'skipped' });
        return discarded;
      } catch (error) {
        span?.setAttribute('action', 'discard');
        span?.setAttribute('outcome', 'failed');
        this.telemetry()?.event('chatdsh.memory.queue.rejected', { 'error.type': errorTypeOf(error), 'error.code': errorCodeOf(error), outcome: 'failed' });
        this.telemetry()?.counter('chatdsh_memory_queue_actions_total', { description: '未确认写入记录的处理动作' }).add(1, { action: 'discard', outcome: 'failed' });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.memory.write.queue', {}, run);
  }

  /**
   * 算检索的 bank 范围。未指定时取共用 bank、各记忆组 bank 与额外 bank。
   * @param requested - 调用方指定的 bank；缺省时按配置汇总。
   * @returns 检索使用的 bank 范围。
   */
  private async banksForSearch(requested: readonly string[] | undefined): Promise<string[]> {
    const groups = await this.groups.list();
    const configured = [MEMORY_ACCOUNT_BANK, ...groups.map((group) => groupBankName(group.memoryGroupId)), ...this.extraBanks];
    if (requested === undefined) return [...new Set(configured)];
    const known = new Set(configured);
    for (const bank of requested) {
      if (!known.has(bank)) throw new ChatdshError('memory-bank-unknown', 'bank 未在配置里登记', { bank });
    }
    return [...requested];
  }

  /**
   * 校验解除关联的参数。
   * @param memoryGroupId - 记忆组标识。
   * @param workspace - 工作区。
   * @returns 校验后的参数。
   */
  private parseWorkspace(memoryGroupId: string, workspace: MemoryWorkspaceRef): { readonly memoryGroupId: string; readonly workspace: MemoryWorkspaceRef } {
    const parsedId = identifierSchema.safeParse(memoryGroupId);
    const parsedWorkspace = memoryWorkspaceRefSchema.safeParse(workspace);
    if (!parsedId.success || !parsedWorkspace.success) throw new ChatdshError('request-invalid', '记忆组解除关联的参数不合法');
    return { memoryGroupId: parsedId.data, workspace: parsedWorkspace.data };
  }

  /**
   * 记录一次后端动作的结果，供状态视图展示最近成功与失败时刻。
   * @param ok - 是否成功。
   * @param code - 失败时的错误码。
   */
  private async recordOutcome(ok: boolean, code?: ChatdshErrorCode): Promise<void> {
    const at = Date.now();
    await this.store.mutate<SettingsState, void>(SETTINGS_STATE_STORE, settingsStateSchema, EMPTY_STATE, async (current) => {
      const next: SettingsState = ok
        ? { ...current, lastSuccessAt: at }
        : { ...current, lastFailureAt: at, ...(code === undefined ? {} : { lastErrorCode: code }) };
      return { value: next, result: undefined };
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
