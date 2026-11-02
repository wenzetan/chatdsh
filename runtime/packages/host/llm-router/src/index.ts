/**
 * 模型路由器宿主插件。
 *
 * 把控制平面的模型入口注册成 DSH 的模型适配器：每条路由一个实例，`stream()` 入口先核对
 * 会话固定的模型，再做额度检查，最后转发到 `POST /chatdsh/gateway/llm`。会话的 provider
 * 与模型在首轮请求时写进存储，之后不再改变，换模型按 `revision-conflict` 拒绝；额度拒绝
 * 使用 `QUOTA` 错误码，调用方的重试按不可恢复失败处理。
 *
 * 每次请求一个 `chatdsh.llm.stream` span，失败补 `error.type` 与 `error.code`；额度拒绝
 * 另记 `chatdsh.llm.quota.rejected` 事件。用量与耗时进入 6.4 节登记的指标，用量另写入
 * 存储供重启后恢复额度读数。对外方法走 typert Remote：路由清单、额度读数、用量、路由
 * 选择与会话绑定。
 * @module @chatdsh/host-llm-router
 */

import {
  LlmAdapter,
  llmOf,
  Remote,
  schema as z,
  Service,
  sessionsOf,
  storageDomainOf,
  telemetryOf,
  TypertRemoteService,
  type Context,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type SessionId,
  type StreamChunk,
} from '@chatdsh/adapter';
import { ChatdshError, CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import { GatewayLlmAdapter } from './adapter.ts';
import { LlmRouterConfigError, resolveRouterRoute, type RouterRoute } from './config.ts';
import { LLM_ROUTER_DOMAIN, type ProviderUsageRecord, type SessionModelBinding } from './domain.ts';
import { UsageLedger, type LedgerTable, type UsageDelta, type UsageWriteFailure } from './ledger.ts';
import { createQuotaGuard, LlmQuotaError, type QuotaGuard, type QuotaReading } from './quota.ts';
import {
  maskEndpoint,
  normalizeEffort,
  normalizeModel,
  normalizeProvider,
  normalizeSelection,
  sameRouteSelection,
  type FixedSelection,
  type RouteSelectionInput,
} from './selection.ts';

export { GatewayLlmAdapter } from './adapter.ts';
export { probeRoute } from './probe.ts';
export type { ProbeResult } from './probe.ts';
export type { GatewayLlmAdapterOptions } from './adapter.ts';
export { LlmRouterConfigError, resolveRouterRoute } from './config.ts';
export type { RouterRoute, RouterRouteInput } from './config.ts';
export { LlmUpstreamError, mapUpstreamFailure } from './errors.ts';
export type { UpstreamFailureInput } from './errors.ts';
export { createQuotaGuard, LlmQuotaError } from './quota.ts';
export type { QuotaGuard, QuotaLimit, QuotaReading } from './quota.ts';
export { LLM_ROUTER_DOMAIN, bindingSchema, usageSchema } from './domain.ts';
export type { ProviderUsageRecord, SessionModelBinding } from './domain.ts';
export { UsageLedger } from './ledger.ts';
export type { UsageDelta, UsageWriteFailure } from './ledger.ts';
export { maskEndpoint, MODEL_LIMIT, normalizeSelection, sameRouteSelection } from './selection.ts';
export type { FixedSelection, RouteSelectionInput } from './selection.ts';

/** 插件名。 */
export const name = 'chatdsh-llm-router';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshLlmRouter';

/** 会话绑定的锁失败时写进 span 的结果值。 */
export const OUTCOME_LOCKED = 'session-model-locked';

/** 额度拒绝时写进 span 的结果值。 */
export const OUTCOME_QUOTA_REJECTED = 'quota-rejected';

/** 配置里的一条路由；入口地址在顶层统一给出。 */
export interface RouterRouteEntry {
  /** provider 路由标识，与控制平面注册的提供方一致。 */
  readonly provider: string;
  /** 该路由的额度上限。 */
  readonly limit?: number;
  /** 该路由启动时的已用额度。 */
  readonly used?: number;
}

/** 配置。 */
export interface LlmRouterConfig {
  /**
   * 模型入口地址；所有路由共用一个入口。入口按请求里的 provider 转发，因此一条
   * 路由器可以接管多个 provider。
   */
  readonly baseUrl?: string;
  /** 接管的路由列表；入口地址由 `baseUrl` 给出。 */
  readonly routes?: RouterRouteEntry[];
  /** 请求超时，单位毫秒。 */
  readonly requestTimeoutMs?: number;
}

/** 配置 schema。 */
export const Config: z<LlmRouterConfig> = z.object({
  baseUrl: z.string(),
  routes: z.array(z.object({
    provider: z.string(),
    limit: z.number(),
    used: z.number(),
  })).required(false),
  requestTimeoutMs: z.number(),
});

/** 一条路由的额度读数，带读取时刻。 */
export interface RouteQuotaReading extends Omit<QuotaReading, 'remaining'> {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 剩余额度；不限制时缺省。 */
  readonly remaining?: number;
  /** 读取时刻的毫秒时间戳。 */
  readonly measuredAt: number;
}

/** 一条路由的对外摘要。 */
export interface RouteSummary {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 掩掉凭据与查询串之后的入口地址。 */
  readonly endpoint: string;
  /** 模型运行时里是否已注册这条路由。 */
  readonly registered: boolean;
  /** 是否等于当前默认模型的路由。 */
  readonly default: boolean;
  /** 已绑定到这条路由的会话数。 */
  readonly sessions: number;
  /** 额度读数。 */
  readonly quota: RouteQuotaReading;
}

/** 一次路由选择的结果。 */
export interface RouteSelection extends FixedSelection {
  /** 选择的来源：调用方指定、默认模型或额度回退。 */
  readonly source: 'requested' | 'default' | 'fallback';
  /** 回退原因；选择来自调用方或默认模型时缺省。 */
  readonly fallbackReason?: 'quota-exhausted';
  /** 模型是否经 provider 发布的目录校验过；目录未发布时为 `false`。 */
  readonly catalogVerified: boolean;
}

/** 绑定一个会话模型时的输入。 */
export interface SessionBindingInput {
  /** 会话标识。 */
  readonly sessionId: string;
  /** provider 路由标识。 */
  readonly provider: string;
  /** 模型标识。 */
  readonly model: string;
  /** 推理强度；缺省表示沿用 provider 默认。 */
  readonly reasoningEffort?: string;
  /** 调用方读到的绑定版本；会话还没有绑定时为 0。 */
  readonly revision?: number;
}

/** 一次用量查询的结果。 */
export interface UsageReport {
  /** 每个 provider 的累计用量，按 provider 排序。 */
  readonly records: readonly ProviderUsageRecord[];
  /** 内存读数是否已经写进存储。 */
  readonly persisted: boolean;
  /** 最近一次写入失败的事实。 */
  readonly lastFailure?: UsageWriteFailure;
}

/** 用到的遥测面。 */
interface RouterTelemetry {
  startSpan(name: string, attributes?: Record<string, unknown>): {
    setAttribute(key: string, value: unknown): void;
    recordException(error: unknown): void;
    end(): void;
  };
  runSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
  histogram(name: string, options?: { unit?: string; description?: string }): { record(value: number, attributes?: Record<string, unknown>): void };
}

/** 默认模型服务的按名读取面。 */
interface DefaultModelFace {
  currentSelection(): { provider: string; model: string; reasoningEffort?: unknown };
}

/** 一条路由在服务里的运行时。 */
interface RouteRuntime {
  readonly route: RouterRoute;
  readonly guard: QuotaGuard;
  readonly inner: GatewayLlmAdapter;
}

/** 会话绑定表的读取面之后还要写入，单独收一个类型。 */
interface BindingTable {
  entries(): IterableIterator<[string, SessionModelBinding]>;
  put(key: string, value: SessionModelBinding): Promise<void>;
}

/** 请求路径要用的钩子：会话绑定、用量记账与失败上报。 */
interface RouterHooks {
  admit(options: GenerateOptions): Promise<void>;
  recordUsage(provider: string, delta: UsageDelta): Promise<UsageWriteFailure | undefined>;
  reportUsageFailure(failure: UsageWriteFailure): void;
}

/** 服务对外的一个动作名字。 */
type RouterAction = 'routes' | 'quota' | 'usage' | 'select' | 'bind' | 'session';

/**
 * 带遥测、会话绑定与额度事件的适配器包装。
 *
 * DSH 的 `stream()` 返回惰性流，请求在开始迭代时才发出；因此会话绑定核对、开始、结果、
 * 错误与耗时都记在一个 span 上，并在这里把额度拒绝、会话锁拒绝与其它失败分开。
 */
class RoutedAdapter extends LlmAdapter {
  private readonly inner: GatewayLlmAdapter;
  private readonly route: RouterRoute;
  private readonly telemetry: RouterTelemetry | undefined;
  private readonly hooks: RouterHooks;

  constructor(inner: GatewayLlmAdapter, route: RouterRoute, telemetry: RouterTelemetry | undefined, hooks: RouterHooks) {
    super();
    this.inner = inner;
    this.route = route;
    this.telemetry = telemetry;
    this.hooks = hooks;
  }

  /** 提供方元数据。 */
  override providerInfo(provider: string): LlmProviderInfo {
    return this.inner.providerInfo(provider);
  }

  /** 模型元数据。 */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.inner.resolveModel(provider, model);
  }

  /** 转发一次模型请求，并把结果记入遥测。 */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const source = this.inner.stream(options);
    const telemetry = this.telemetry;
    const hooks = this.hooks;
    const route = this.route;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        const span = telemetry?.startSpan('chatdsh.llm.stream', { provider: route.provider, model: options.model });
        const started = Date.now();
        let firstTokenAt: number | undefined;
        const delta: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
        try {
          // 会话模型在发出任何网络请求之前核对：固定之后换模型直接拒绝。
          await hooks.admit(options);
          for await (const chunk of source) {
            if (firstTokenAt === undefined && isVisible(chunk)) {
              firstTokenAt = Date.now();
              telemetry?.histogram('chatdsh_llm_first_token_seconds', { unit: 's', description: '首 token 延迟' })
                .record((firstTokenAt - started) / 1000, { provider: route.provider });
            }
            if (chunk.type === 'usage') {
              delta.inputTokens += chunk.usage.inputTokens;
              delta.outputTokens += chunk.usage.outputTokens;
              telemetry?.counter('chatdsh_llm_tokens_total', { description: '模型 token 计数' })
                .add(chunk.usage.inputTokens, { provider: route.provider, model: options.model, kind: 'input' });
              telemetry?.counter('chatdsh_llm_tokens_total', { description: '模型 token 计数' })
                .add(chunk.usage.outputTokens, { provider: route.provider, model: options.model, kind: 'output' });
            }
            yield chunk;
          }
          span?.setAttribute('outcome', 'ok');
          telemetry?.counter('chatdsh_llm_requests_total', { description: '模型请求数' })
            .add(1, { provider: route.provider, model: options.model, outcome: 'ok' });
        } catch (error) {
          const locked = isSessionLocked(error);
          const quota = error instanceof LlmQuotaError;
          const code = quota ? CHATDSH_ERROR_CODES.quotaExceeded : errorCodeOf(error);
          const outcome = locked ? OUTCOME_LOCKED : quota ? OUTCOME_QUOTA_REJECTED : 'failed';
          span?.setAttribute('outcome', outcome);
          span?.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
          span?.setAttribute('error.code', code);
          span?.recordException(error);
          telemetry?.counter('chatdsh_llm_requests_total', { description: '模型请求数' })
            .add(1, { provider: route.provider, model: options.model, outcome });
          if (quota) {
            telemetry?.event('chatdsh.llm.quota.rejected', {
              'error.code': CHATDSH_ERROR_CODES.quotaExceeded,
            });
          }
          if (locked) {
            telemetry?.event('chatdsh.runtime.model.provider.failed', {
              provider: route.provider,
              'error.type': error instanceof Error ? error.name : 'Unknown',
              'error.code': code,
            });
          }
          throw error;
        } finally {
          telemetry?.histogram('chatdsh_llm_request_duration_seconds', { unit: 's', description: '模型请求耗时' })
            .record((Date.now() - started) / 1000, { provider: route.provider });
          span?.end();
          // 上游报告过用量就说明这部分已经被计费，失败分支同样入账。
          if (delta.inputTokens > 0 || delta.outputTokens > 0) {
            const failure = await hooks.recordUsage(route.provider, delta);
            if (failure !== undefined) hooks.reportUsageFailure(failure);
          }
        }
      },
    };
  }
}

/** 是否为可见输出分块，用于首 token 计时。 */
function isVisible(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta';
}

/** 从异常取错误码。 */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'UNKNOWN';
}

/** 是否为会话模型锁定导致的拒绝。 */
function isSessionLocked(error: unknown): boolean {
  return error instanceof ChatdshError && error.details['reason'] === 'session-model-locked';
}

/**
 * 从配置得到路由清单。缺少入口地址、标识或额度形状不合法时在装配阶段就地抛出。
 * @param config - 路由器配置。
 * @returns 校验后的路由。
 */
function resolveRoutes(config: LlmRouterConfig): readonly RouterRoute[] {
  const routes = config.routes ?? [];
  const baseUrl = config.baseUrl;
  return routes.map((route) => {
    if (baseUrl === undefined || baseUrl === '') {
      throw new LlmRouterConfigError(`路由 ${route.provider} 缺少入口地址：配置里没有给出 baseUrl`);
    }
    return resolveRouterRoute({ ...route, baseUrl });
  });
}

/**
 * 模型路由器服务。
 *
 * 注册时把每条路由登记成模型适配器；服务销毁时适配器随之注销。会话绑定与用量落在
 * `llm_router_store` 存储域，重启后连同额度读数一起恢复。
 */
export class ChatdshLlmRouterService extends TypertRemoteService {
  /** 依赖的模型运行时、结构化存储与会话注册表。 */
  static inject = ['llm', 'storageDomain', 'sessions'];

  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  private readonly runtimes = new Map<string, RouteRuntime>();

  private readonly bindings = new Map<string, SessionModelBinding>();

  private ledger: UsageLedger | undefined;

  private bindingsTable: BindingTable | undefined;

  /** 写入链：会话绑定与用量记账串行执行，并发写入不会交错。 */
  private chain: Promise<unknown> = Promise.resolve();

  private readonly configured: readonly RouterRoute[];

  constructor(ctx: Context, private readonly config: LlmRouterConfig) {
    super(ctx, SERVICE_NAME);
    // 路由在构造时校验：缺入口地址、标识或额度形状不合法都在装配阶段就地失败。
    this.configured = resolveRoutes(config);
  }

  /** 打开存储域、读回会话绑定与用量、注册每条路由的适配器。 */
  async [Service.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(LLM_ROUTER_DOMAIN);
    const bindings = domain.table('bindings') as unknown as BindingTable;
    const usage = domain.table('usage') as unknown as LedgerTable;
    for (const [sessionId, record] of bindings.entries()) this.bindings.set(sessionId, record);
    this.bindingsTable = bindings;
    const ledger = new UsageLedger(() => usage);
    ledger.load();
    this.ledger = ledger;

    const telemetry = telemetryOf<RouterTelemetry>(this.ctx);
    const requestTimeoutMs = this.config.requestTimeoutMs ?? 120_000;
    for (const route of this.configured) {
      // 额度守卫的启动读数由部署基线与已持久化的用量共同给出。
      const persisted = ledger.get(route.provider);
      const used = route.used + (persisted === undefined ? 0 : persisted.inputTokens + persisted.outputTokens);
      const guard = createQuotaGuard({ limit: route.limit, used });
      const inner = new GatewayLlmAdapter({
        baseUrl: route.baseUrl,
        provider: route.provider,
        guard,
        requestTimeoutMs,
      });
      const adapter = new RoutedAdapter(inner, route, telemetry, {
        admit: (options) => this.admit(options),
        recordUsage: (provider, delta) => this.recordUsage(provider, delta),
        reportUsageFailure: (failure) => this.reportUsageFailure(failure),
      });
      const registration = llmOf(this.ctx).registerAdapter([route.provider], adapter);
      this.ctx.effect(() => registration, `chatdsh-llm-router:${route.provider}`);
      this.runtimes.set(route.provider, { route, guard, inner });
    }
  }

  /** 全部路由的摘要。 */
  @Remote('routes')
  routes(): RouteSummary[] {
    const defaults = this.defaultSelection();
    return [...this.runtimes.values()]
      .map((runtime) => ({
        provider: runtime.route.provider,
        endpoint: maskEndpoint(runtime.route.baseUrl),
        registered: this.registered(runtime.route.provider),
        default: defaults !== undefined && defaults.provider === runtime.route.provider,
        sessions: this.boundSessions(runtime.route.provider),
        quota: this.readingOf(runtime),
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  /** 一条路由的额度读数。 */
  @Remote('quota')
  async quota(provider: string): Promise<RouteQuotaReading> {
    const id = normalizeProvider(provider);
    return this.access('quota', id, async () => this.readingOf(this.requireRuntime(id)));
  }

  /** 累计用量。 */
  @Remote('usage')
  async usage(provider?: string): Promise<UsageReport> {
    const id = provider === undefined ? undefined : normalizeProvider(provider);
    return this.access('usage', id, async () => this.reportOf(id));
  }

  /** 为一个新建会话选择路由；额度不足时按默认模型回退。 */
  @Remote('select')
  async select(input: RouteSelectionInput): Promise<RouteSelection> {
    return this.access('select', input?.provider, async () => this.resolveSelection(input));
  }

  /** 固定一个会话的模型；绑定已有的模型按原样返回，换成别的模型按版本冲突拒绝。 */
  @Remote('bindSession')
  async bindSession(input: SessionBindingInput): Promise<SessionModelBinding> {
    return this.access('bind', input?.provider, async () => this.bindNow(input));
  }

  /** 读取一个会话固定的模型。 */
  @Remote('sessionModel')
  async sessionModel(sessionId: string): Promise<SessionModelBinding | undefined> {
    return this.access('session', undefined, async () => this.bindings.get(normalizeSessionId(sessionId)));
  }

  /** 模型运行时里是否已经注册这条路由。 */
  private registered(provider: string): boolean {
    return llmOf(this.ctx).listProviders().some((info) => info.id === provider);
  }

  /** 一条路由的额度读数。 */
  private readingOf(runtime: RouteRuntime): RouteQuotaReading {
    const reading = runtime.guard.reading();
    return { provider: runtime.route.provider, ...reading, measuredAt: Date.now() };
  }

  /** 已绑定到这条路由的会话数。 */
  private boundSessions(provider: string): number {
    let count = 0;
    for (const binding of this.bindings.values()) {
      if (binding.provider === provider) count += 1;
    }
    return count;
  }

  /** 取一条已配置的路由；没有时按目标不存在抛出。 */
  private requireRuntime(provider: string): RouteRuntime {
    const runtime = this.runtimes.get(provider);
    if (runtime === undefined) {
      throw new ChatdshError('object-not-found', '没有这条模型路由', { provider });
    }
    return runtime;
  }

  /** 读取默认模型选择；没有挂默认模型服务时返回 `undefined`。 */
  private defaultSelection(): FixedSelection | undefined {
    const service = this.ctx.reflect.get('agentDefaultModel') as DefaultModelFace | undefined;
    if (service === undefined) return undefined;
    const selection = service.currentSelection();
    const effort = selection.reasoningEffort === undefined ? undefined : String(selection.reasoningEffort);
    return {
      provider: selection.provider,
      model: selection.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
  }

  /** 核对一条选择：路由已注册，模型在 provider 发布的目录里。返回目录是否发布。 */
  private async assertSelectable(selection: FixedSelection): Promise<boolean> {
    this.requireRuntime(selection.provider);
    const runtime = llmOf(this.ctx);
    if (!runtime.listProviders().some((info) => info.id === selection.provider)) {
      throw new ChatdshError('request-invalid', '该 provider 的路由没有注册到模型运行时', { provider: selection.provider });
    }
    const advertised = await runtime.listModels(selection.provider);
    if (advertised.length === 0) return false;
    if (!advertised.some((model) => model.id === selection.model)) {
      throw new ChatdshError('request-invalid', '该模型不在 provider 发布的目录里', { provider: selection.provider });
    }
    return true;
  }

  /** 按默认模型给出回退选择；没有默认模型、默认路由不可用或与排除项相同时返回 `undefined`。 */
  private async fallbackSelection(exclude?: FixedSelection): Promise<{ selection: FixedSelection; catalogVerified: boolean } | undefined> {
    const defaults = this.defaultSelection();
    if (defaults === undefined) return undefined;
    if (exclude !== undefined && sameRouteSelection(defaults, exclude)) return undefined;
    const runtime = this.runtimes.get(defaults.provider);
    if (runtime === undefined) return undefined;
    if (!runtime.guard.reading().allowed) return undefined;
    const catalogVerified = await this.assertSelectable(defaults);
    return { selection: defaults, catalogVerified };
  }

  /** 解析一次路由选择。 */
  private async resolveSelection(input: RouteSelectionInput): Promise<RouteSelection> {
    const wanted = normalizeSelection(input);
    if (wanted.provider !== undefined && wanted.model !== undefined) {
      const requested: FixedSelection = {
        provider: wanted.provider,
        model: wanted.model,
        ...(wanted.reasoningEffort === undefined ? {} : { reasoningEffort: wanted.reasoningEffort }),
      };
      const catalogVerified = await this.assertSelectable(requested);
      if (this.requireRuntime(requested.provider).guard.reading().allowed) {
        return { ...requested, source: 'requested', catalogVerified };
      }
      const fallback = await this.fallbackSelection(requested);
      if (fallback === undefined) {
        throw new ChatdshError('quota-exceeded', '该路由的额度已用尽，且没有可回退的默认模型', {
          provider: requested.provider,
        });
      }
      return { ...fallback.selection, source: 'fallback', fallbackReason: 'quota-exhausted', catalogVerified: fallback.catalogVerified };
    }
    const fallback = await this.fallbackSelection();
    if (fallback === undefined) {
      throw new ChatdshError('request-invalid', '没有可用的默认模型，请显式给出 provider 与模型', {
        reason: 'default-model-missing',
      });
    }
    return { ...fallback.selection, source: 'default', catalogVerified: fallback.catalogVerified };
  }

  /** 绑定一个会话的模型。 */
  private async bindNow(input: SessionBindingInput): Promise<SessionModelBinding> {
    const sessionId = normalizeSessionId(input.sessionId);
    const provider = normalizeProvider(input.provider);
    const model = normalizeModel(input.model);
    const effort = input.reasoningEffort === undefined ? undefined : normalizeEffort(input.reasoningEffort);
    if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 0)) {
      throw new ChatdshError('request-invalid', 'revision 必须是非负整数');
    }
    if (sessionsOf(this.ctx).get(sessionId as SessionId) === undefined) {
      throw new ChatdshError('session-not-found', '会话不存在', { sessionId });
    }
    const selection: FixedSelection = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    return this.serialize(async () => {
      const current = this.bindings.get(sessionId);
      if (current !== undefined) {
        if (input.revision !== undefined && input.revision !== current.revision) {
          throw new ChatdshError('revision-conflict', '会话模型绑定的版本已过期', { revision: current.revision });
        }
        if (!sameRouteSelection(current, selection)) {
          throw new ChatdshError('revision-conflict', '会话模型已固定，不能再改', { revision: current.revision });
        }
        return current;
      }
      if (input.revision !== undefined && input.revision !== 0) {
        throw new ChatdshError('revision-conflict', '会话还没有模型绑定，期望版本为 0', { revision: 0 });
      }
      await this.assertSelectable(selection);
      const record: SessionModelBinding = {
        sessionId,
        provider,
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        revision: 1,
        boundAt: Date.now(),
      };
      await this.bindingTable().put(sessionId, record);
      this.bindings.set(sessionId, record);
      return record;
    });
  }

  /**
   * 请求路径上的会话绑定核对。
   *
   * 首轮普通对话请求写下一个会话的 provider 与模型；之后的请求必须与它一致。压缩与会话
   * 标题这类辅助调用不参与固定，它们常用另一档模型。没有会话标识的一次性调用照样放行。
   * @param options - DSH 的完整请求。
   */
  private async admit(options: GenerateOptions): Promise<void> {
    if (options.purpose !== undefined) return;
    if (options.sessionId === undefined) return;
    const sessionId = String(options.sessionId);
    const provider = options.provider;
    const model = options.model;
    const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort);
    const selection: FixedSelection = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    await this.serialize(async () => {
      const current = this.bindings.get(sessionId);
      if (current !== undefined) {
        if (!sameRouteSelection(current, selection)) {
          throw new ChatdshError('revision-conflict', '会话模型已固定，不能再改', {
            revision: current.revision,
            reason: 'session-model-locked',
            provider: current.provider,
          });
        }
        return;
      }
      const record: SessionModelBinding = {
        sessionId,
        provider,
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        revision: 1,
        boundAt: Date.now(),
      };
      await this.bindingTable().put(sessionId, record);
      this.bindings.set(sessionId, record);
    });
  }

  /** 累加一次请求的用量。 */
  private recordUsage(provider: string, delta: UsageDelta): Promise<UsageWriteFailure | undefined> {
    if (this.ledger === undefined) throw new ChatdshError('internal-error', '用量账本尚未就绪');
    return this.ledger.record(provider, delta);
  }

  /** 用量写入失败写一条带错误码的事件。 */
  private reportUsageFailure(failure: UsageWriteFailure): void {
    const telemetry = telemetryOf<RouterTelemetry>(this.ctx);
    telemetry?.event('chatdsh.runtime.model.provider.failed', {
      provider: failure.provider,
      'error.type': failure.errorType,
      'error.code': failure.errorCode,
    });
  }

  /** 用量报告。 */
  private reportOf(provider: string | undefined): UsageReport {
    if (this.ledger === undefined) throw new ChatdshError('internal-error', '用量账本尚未就绪');
    if (provider !== undefined) this.requireRuntime(provider);
    const records = provider === undefined ? this.ledger.all() : [this.ledger.get(provider)].filter(isRecord);
    const failure = this.ledger.lastFailure();
    return {
      records,
      persisted: failure === undefined,
      ...(failure === undefined ? {} : { lastFailure: failure }),
    };
  }

  /** 会话绑定表；存储域在初始化时打开。 */
  private bindingTable(): BindingTable {
    if (this.bindingsTable === undefined) throw new ChatdshError('internal-error', '模型路由的存储域尚未打开');
    return this.bindingsTable;
  }

  /** 把一次写入串到写入链上。前一次失败不阻断后一次。 */
  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.chain.then(body, body);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 跑一次带遥测的 Remote 动作：成功记 `outcome=ok`，失败记错误码与失败事件。
   * @param action - 动作名，写进 `rpc.method`。
   * @param provider - 动作涉及的路由；没有具体路由时缺省。
   * @param body - 动作本体。
   * @returns 动作结果。
   */
  private async access<T>(action: RouterAction, provider: string | undefined, body: () => Promise<T>): Promise<T> {
    const telemetry = telemetryOf<RouterTelemetry>(this.ctx);
    if (telemetry === undefined) return body();
    const method = `${SERVICE_NAME}/${action}`;
    const counter = telemetry.counter('chatdsh_remote_calls_total', { description: 'Remote 调用数' });
    return telemetry.runSpan('chatdsh.runtime.remote.call', { 'rpc.method': method }, async (span) => {
      try {
        const result = await body();
        span.setAttribute('outcome', 'ok');
        counter.add(1, { method, outcome: 'ok' });
        return result;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = error instanceof ChatdshError ? error.code : CHATDSH_ERROR_CODES.internalError;
        span.setAttribute('outcome', 'failed');
        counter.add(1, { method, outcome: 'failed', error_code: code, error_type: type });
        if (provider !== undefined) {
          telemetry.event('chatdsh.runtime.model.provider.failed', {
            provider,
            'error.type': type,
            'error.code': code,
          });
        }
        throw error;
      }
    });
  }
}

/** 过滤掉缺失的用量记录。 */
function isRecord(record: ProviderUsageRecord | undefined): record is ProviderUsageRecord {
  return record !== undefined;
}

/** 校验会话标识。 */
function normalizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ChatdshError('request-invalid', '会话标识不能为空');
  }
  return sessionId;
}

/**
 * 注册模型路由器。
 * @param ctx - 宿主上下文。
 * @param config - 入口地址、路由与超时。
 */
export function apply(ctx: Context, config: LlmRouterConfig): void {
  ctx.plugin(ChatdshLlmRouterService, config);
}
