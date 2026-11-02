/**
 * 模型提供方宿主插件。
 *
 * 在宿主平面持有模型提供方的注册信息：路由标识、展示名、端点、静态请求头与凭据变量名。
 * 构造时对每条配置调用一次校验，失败即抛出，让装配阶段就暴露配置错误。
 *
 * 清单、额度与用量都是对真实来源的查询：模型清单来自模型运行时里那条路由的适配器在
 * `listModels` 上发布的目录，适配器不发布时用部署配置声明的模型并写明来源，两者都没有时
 * 报告不支持；额度与用量来自 `@chatdsh/host-llm-router` 的额度守卫与用量账本，路由器没有
 * 装载时报告未启用。读取失败按错误码抛出，未启用按显式状态返回，两者不混为一谈。
 *
 * 对外方法走 typert Remote：客户端按 `chatdshModelProviders` 命名空间读取列表、状态、
 * 清单、额度与用量。
 * @module @chatdsh/host-model-provider
 */

import {
  llmOf,
  Remote,
  schema as z,
  telemetryOf,
  TypertRemoteService,
  type Context,
} from '@chatdsh/adapter';
import { ChatdshError, CHATDSH_ERROR_CODES, type ModelProviderInfo } from '@chatdsh/core-contracts';
import { readProviderCatalog, type CatalogRuntime, type CatalogSource, type ProviderCatalog } from './catalog.ts';
import {
  credentialOf,
  maskEndpoint,
  MODEL_PROVIDER_INVALID,
  resolveModelProvider,
  type ModelProviderInput,
  type ProviderCredential,
} from './client.ts';

export { GATEWAY_PROVIDER, MODEL_PROVIDER_INVALID, ModelProviderError, resolveModelProvider } from './client.ts';
export type { ModelProviderInput, ProviderCredential } from './client.ts';
export { readProviderCatalog } from './catalog.ts';
export type { CatalogReason, CatalogSource, ModelEntry, ProviderCatalog } from './catalog.ts';

/** 插件名。 */
export const name = 'chatdsh-model-provider';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshModelProviders';

/** 配置。 */
export interface ModelProviderConfig {
  /** 提供方列表。 */
  readonly providers: ModelProviderInput[];
}

/** 配置 schema。 */
export const Config: z<ModelProviderConfig> = z.object({
  providers: z.array(z.object({
    provider: z.string(),
    displayName: z.string(),
    baseUrl: z.string().required(false),
    headers: z.dict(z.string()).required(false),
    models: z.array(z.string()).required(false),
    apiKeyEnv: z.string().required(false),
  })).required(false),
});

/** 提供方目录里的一行。`baseUrl` 是掩掉凭据与查询串之后的地址。 */
export interface ModelProviderEntry extends ModelProviderInfo {
  /** 掩掉凭据与查询串之后的端点地址。 */
  readonly baseUrl: string;
  /** 模型运行时里是否已注册这条路由。 */
  readonly registered: boolean;
  /** 是否可以立即使用：路由已注册且凭据已就绪。 */
  readonly available: boolean;
  /** 凭据配置状态；只报变量名与是否设置。 */
  readonly credential: ProviderCredential;
  /** 部署配置里声明的模型标识。 */
  readonly declaredModels: readonly string[];
}

/** 服务状态。 */
export interface ModelProviderStatus {
  /** 是否至少有一个提供方可用。 */
  readonly available: boolean;
  /** 提供方数量。 */
  readonly providers: number;
  /** 目录、额度与清单的总体状态。 */
  readonly state: 'ready' | 'degraded' | 'disabled' | 'read-failed';
  /** 状态的成因。 */
  readonly reason?: 'no-providers' | 'route-unregistered' | 'credential-missing' | 'catalog-unsupported' | 'catalog-read-failed';
  /** 读取失败的 provider。 */
  readonly errorProvider?: string;
  /** 读取失败的错误码。 */
  readonly errorCode?: string;
  /** 每个提供方的清单来源与条目数。 */
  readonly catalog: readonly ProviderCatalogSummary[];
  /** 当前默认模型；没有挂默认模型服务时缺省。 */
  readonly default?: DefaultModelSelection;
  /** 默认模型的来源。 */
  readonly defaultSource: 'agent-default-model' | 'unavailable';
}

/** 一个提供方的清单摘要。 */
export interface ProviderCatalogSummary {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 清单来源。 */
  readonly source: CatalogSource;
  /** 条目数。 */
  readonly models: number;
  /** 来源不足的原因。 */
  readonly reason?: string;
}

/** 默认模型选择。 */
export interface DefaultModelSelection {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 模型标识。 */
  readonly model: string;
  /** 推理强度；缺省表示沿用 provider 默认。 */
  readonly reasoningEffort?: string;
}

/** 一个提供方的额度读数。 */
export interface ProviderQuota {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 读取结果：可用或未启用。 */
  readonly state: 'available' | 'unsupported';
  /** 未启用的原因。 */
  readonly reason?: 'router-unavailable' | 'route-unregistered';
  /** 额度上限；不限制时缺省。 */
  readonly limit?: number;
  /** 已用额度。 */
  readonly used?: number;
  /** 剩余额度；不限制时缺省。 */
  readonly remaining?: number;
  /** 现在是否允许发起请求。 */
  readonly allowed?: boolean;
  /** 读取时刻的毫秒时间戳。 */
  readonly measuredAt?: number;
}

/** 一个提供方的用量。 */
export interface ProviderUsage {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 读取结果：可用或未启用。 */
  readonly state: 'available' | 'unsupported';
  /** 未启用的原因。 */
  readonly reason?: 'router-unavailable' | 'route-unregistered';
  /** 累计输入 token。 */
  readonly inputTokens?: number;
  /** 累计输出 token。 */
  readonly outputTokens?: number;
  /** 累计请求数。 */
  readonly requests?: number;
  /** 最后写入时刻的毫秒时间戳。 */
  readonly updatedAt?: number;
  /** 用量是否已经写进存储。 */
  readonly persisted?: boolean;
}

/** 用到的遥测面。 */
interface ProviderTelemetry {
  runSpanSync<T>(name: string, attributes: Record<string, unknown>, body: (span: { setAttribute(key: string, value: unknown): void }) => T): T;
  runSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/** 默认模型服务的按名读取面。 */
interface DefaultModelFace {
  currentSelection(): { provider: string; model: string; reasoningEffort?: unknown };
}

/** 模型路由服务的按名读取面。 */
interface RouterFace {
  routes(): readonly { provider: string }[];
  quota(provider: string): Promise<{ limit?: number; used: number; remaining?: number; allowed: boolean; measuredAt: number }>;
  usage(provider?: string): Promise<{
    records: readonly { provider: string; inputTokens: number; outputTokens: number; requests: number; updatedAt: number }[];
    persisted: boolean;
  }>;
}

/** 服务对外的一个动作名字。 */
type ProviderAction = 'status' | 'models' | 'quota' | 'usage' | 'defaults';

/** 一条配置与其校验后的注册信息。 */
interface ProviderRegistration {
  /** 配置里的一条提供方。 */
  readonly input: ModelProviderInput;
  /** 校验并补全后的注册信息。 */
  readonly info: ModelProviderInfo;
}

/**
 * 模型提供方服务。
 *
 * 注册信息在构造时一次性校验并冻结；清单、额度与用量在每次查询时向真实来源读取。
 */
export class ChatdshModelProviderService extends TypertRemoteService {
  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  /** 依赖的服务：模型运行时。注册信息在构造时校验，清单与模型元数据从这里读取。 */
  static inject = ['llm'];

  private readonly providers: readonly ProviderRegistration[];

  constructor(ctx: Context, config: ModelProviderConfig) {
    super(ctx, SERVICE_NAME);
    const telemetry = telemetryOf<ProviderTelemetry>(ctx);
    this.providers = (config.providers ?? []).map((input) => ({ input, info: resolve(telemetry, input) }));
  }

  /** 列出全部提供方。注册状态在每次读取时向模型运行时核对。 */
  @Remote('list')
  list(): ModelProviderEntry[] {
    return this.providers.map((provider) => this.entryOf(provider));
  }

  /** 服务状态：清单来源、默认模型与读取结果。 */
  @Remote('status')
  async status(): Promise<ModelProviderStatus> {
    return this.access('status', undefined, async () => this.statusNow());
  }

  /** 一个提供方的模型清单。 */
  @Remote('models')
  async models(provider: string): Promise<ProviderCatalog> {
    return this.access('models', provider, async () => {
      const entry = this.requireEntry(provider);
      if (!entry.registered) {
        throw new ChatdshError('request-invalid', '该提供方的路由没有注册到模型运行时', {
          provider,
          reason: 'route-unregistered',
        });
      }
      return readProviderCatalog(this.catalogRuntime(), provider, entry.declaredModels);
    });
  }

  /** 一个提供方的额度读数。 */
  @Remote('quota')
  async quota(provider: string): Promise<ProviderQuota> {
    return this.access('quota', provider, async () => {
      this.requireEntry(provider);
      const router = this.router();
      if (router === undefined) return { provider, state: 'unsupported', reason: 'router-unavailable' };
      if (!this.hasRoute(router, provider)) return { provider, state: 'unsupported', reason: 'route-unregistered' };
      const reading = await router.quota(provider);
      return { provider, state: 'available', ...reading };
    });
  }

  /** 提供方的累计用量；省略 provider 时列出全部已配置的提供方。 */
  @Remote('usage')
  async usage(provider?: string): Promise<ProviderUsage[]> {
    return this.access('usage', provider, async () => {
      const targets = provider === undefined ? this.providers.map((candidate) => candidate.input.provider) : [provider];
      for (const id of targets) this.requireEntry(id);
      const router = this.router();
      if (router === undefined) {
        return targets.map((id) => ({ provider: id, state: 'unsupported', reason: 'router-unavailable' }));
      }
      const report = await router.usage(provider);
      return targets.map((id) => {
        if (!this.hasRoute(router, id)) return { provider: id, state: 'unsupported', reason: 'route-unregistered' };
        const record = report.records.find((candidate) => candidate.provider === id);
        return {
          provider: id,
          state: 'available',
          inputTokens: record?.inputTokens ?? 0,
          outputTokens: record?.outputTokens ?? 0,
          requests: record?.requests ?? 0,
          ...(record === undefined ? {} : { updatedAt: record.updatedAt }),
          persisted: report.persisted,
        };
      });
    });
  }

  /** 当前默认模型与它的来源。 */
  @Remote('defaults')
  async defaults(): Promise<{ selection?: DefaultModelSelection; source: 'agent-default-model' | 'unavailable' }> {
    return this.access('defaults', undefined, async () => {
      const selection = this.defaultSelection();
      return selection === undefined ? { source: 'unavailable' } : { selection, source: 'agent-default-model' };
    });
  }

  /** 汇总状态：逐个读取清单，读取失败按错误码报出来。 */
  private async statusNow(): Promise<ModelProviderStatus> {
    if (this.providers.length === 0) {
      return {
        available: false,
        providers: 0,
        state: 'disabled',
        reason: 'no-providers',
        catalog: [],
        defaultSource: 'unavailable',
      };
    }
    const entries = this.providers.map((provider) => this.entryOf(provider));
    const catalog: ProviderCatalogSummary[] = [];
    let error: { provider: string; code: string } | undefined;
    for (const entry of entries) {
      if (!entry.registered) {
        catalog.push({ provider: entry.provider, source: 'unsupported', models: 0, reason: 'route-unregistered' });
        continue;
      }
      try {
        const read = await readProviderCatalog(this.catalogRuntime(), entry.provider, entry.declaredModels);
        catalog.push({
          provider: entry.provider,
          source: read.source,
          models: read.models.length,
          ...(read.reason === undefined ? {} : { reason: read.reason }),
        });
      } catch (caught) {
        error ??= { provider: entry.provider, code: errorCodeOf(caught) };
        catalog.push({ provider: entry.provider, source: 'unsupported', models: 0, reason: 'catalog-read-failed' });
      }
    }
    const registered = entries.filter((entry) => entry.registered);
    const registeredCatalog = catalog.filter((summary) => registered.some((entry) => entry.provider === summary.provider));
    const credentialMissing = registered.every((entry) => !entry.credential.configured);
    const catalogUnsupported = registeredCatalog.every((summary) => summary.source === 'unsupported');
    const selection = this.defaultSelection();
    const state = error !== undefined
      ? 'read-failed'
      : registered.length === 0 || credentialMissing || catalogUnsupported
        ? 'degraded'
        : 'ready';
    const reason = state === 'read-failed'
      ? 'catalog-read-failed'
      : registered.length === 0
        ? 'route-unregistered'
        : credentialMissing
          ? 'credential-missing'
          : catalogUnsupported
            ? 'catalog-unsupported'
            : undefined;
    return {
      available: entries.some((entry) => entry.available),
      providers: entries.length,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(error === undefined ? {} : { errorProvider: error.provider, errorCode: error.code }),
      catalog,
      ...(selection === undefined ? {} : { default: selection }),
      defaultSource: selection === undefined ? 'unavailable' : 'agent-default-model',
    };
  }

  /** 由一条配置与它的注册信息算出目录里的一行。 */
  private entryOf(provider: ProviderRegistration): ModelProviderEntry {
    const registered = this.registered(provider.input.provider);
    const credential = credentialOf(provider.input);
    return {
      ...provider.info,
      baseUrl: maskEndpoint(provider.input.baseUrl),
      registered,
      available: registered && credential.configured,
      credential,
      declaredModels: provider.input.models ?? [],
    };
  }

  /** 模型运行时里是否已注册这条路由。 */
  private registered(provider: string): boolean {
    return llmOf(this.ctx).listProviders().some((info) => info.id === provider);
  }

  /** 取一条已配置的提供方；没有时按目标不存在抛出。 */
  private requireEntry(provider: string): ModelProviderEntry {
    const registration = this.providers.find((candidate) => candidate.input.provider === provider);
    if (registration === undefined) throw new ChatdshError('object-not-found', '没有这个模型提供方', { provider });
    return this.entryOf(registration);
  }

  /** 模型运行时的清单读取面。 */
  private catalogRuntime(): CatalogRuntime {
    return llmOf(this.ctx) as unknown as CatalogRuntime;
  }

  /** 按名读取模型路由服务；没有装载时返回 `undefined`。 */
  private router(): RouterFace | undefined {
    return this.ctx.reflect.get('chatdshLlmRouter') as RouterFace | undefined;
  }

  /** 路由服务里是否有这条 provider 的路由。 */
  private hasRoute(router: RouterFace, provider: string): boolean {
    return router.routes().some((route) => route.provider === provider);
  }

  /** 读取默认模型选择；没有挂默认模型服务时返回 `undefined`。 */
  private defaultSelection(): DefaultModelSelection | undefined {
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

  /**
   * 跑一次带遥测的 Remote 动作：成功记 `outcome=ok`，失败记错误码与失败事件。
   * @param action - 动作名，写进 `rpc.method`。
   * @param provider - 动作涉及的提供方；没有具体提供方时缺省。
   * @param body - 动作本体。
   * @returns 动作结果。
   */
  private async access<T>(action: ProviderAction, provider: string | undefined, body: () => Promise<T>): Promise<T> {
    const telemetry = telemetryOf<ProviderTelemetry>(this.ctx);
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
        const code = error instanceof ChatdshError ? error.code : errorCodeOf(error);
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

/** 构造提供方时做一次注册校验，并把失败写进遥测。 */
function resolve(telemetry: ProviderTelemetry | undefined, input: ModelProviderInput): ModelProviderInfo {
  if (telemetry === undefined) return resolveModelProvider(input);
  return telemetry.runSpanSync('chatdsh.runtime.model.provider.resolve', { provider: input.provider }, (span) => {
    const counter = telemetry.counter('chatdsh_model_provider_resolutions_total', { description: '模型提供方注册校验次数' });
    try {
      const info = resolveModelProvider(input);
      span.setAttribute('outcome', 'ok');
      counter.add(1, { provider: input.provider, outcome: 'ok' });
      return info;
    } catch (error) {
      span.setAttribute('outcome', 'failed');
      telemetry.event('chatdsh.runtime.model.provider.failed', {
        provider: input.provider,
        'error.type': error instanceof Error ? error.name : 'Unknown',
        'error.code': MODEL_PROVIDER_INVALID,
      });
      counter.add(1, { provider: input.provider, outcome: 'failed' });
      throw error;
    }
  });
}

/** 从异常取稳定错误码。 */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return CHATDSH_ERROR_CODES.internalError;
}

/** 注册服务。 */
export function apply(ctx: Context, config: ModelProviderConfig): void {
  ctx.plugin(ChatdshModelProviderService, config);
}

export default ChatdshModelProviderService;
