/**
 * 模型提供方面板的数据入口。
 *
 * 清单、额度、用量与默认模型都从宿主服务读取：`chatdshModelProviders` 给出提供方目录、每个
 * 提供方的模型清单、额度读数与累计用量，`agent-default-model` 命名空间持有默认 provider、
 * model 与推理强度。写入默认模型走宿主设置服务的 `settings/update`，带读到的版本，版本落后
 * 时按 `settings/conflict` 拒绝。
 * @module @chatdsh/client-model-provider/gateway
 */

/** 一次调用的参数表。 */
export type RemoteArgs = Readonly<Record<string, unknown>>;

/** 调用失败。 */
export class ModelCallError extends Error {
  /**
   * @param code - 稳定错误码。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ModelCallError';
  }
}

/** 一个提供方读数的形状。 */
export interface ProviderView {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 展示名。 */
  readonly displayName: string;
  /** 掩掉凭据与查询串的端点。 */
  readonly baseUrl: string;
  /** 路由是否已注册。 */
  readonly registered: boolean;
  /** 是否可用。 */
  readonly available: boolean;
  /** 凭据状态。 */
  readonly credential: { readonly env?: string; readonly configured: boolean };
  /** 部署配置声明的模型。 */
  readonly declaredModels: readonly string[];
}

/** 一个清单条目。 */
export interface ModelView {
  /** 模型标识。 */
  readonly id: string;
  /** 显示名称。 */
  readonly name: string;
  /** 上下文窗口。 */
  readonly contextWindow?: number;
  /** 上下文窗口来源。 */
  readonly contextSource: 'adapter' | 'unavailable';
  /** 推理强度。 */
  readonly reasoningEfforts?: readonly string[];
  /** 默认推理强度。 */
  readonly defaultReasoningEffort?: string;
}

/** 一个提供方的清单读数。 */
export interface CatalogView {
  /** provider。 */
  readonly provider: string;
  /** 来源。 */
  readonly source: 'adapter' | 'config' | 'unsupported';
  /** 条目。 */
  readonly models: readonly ModelView[];
  /** 来源不足的原因。 */
  readonly reason?: string;
}

/** 一个提供方的清单摘要。 */
export interface CatalogSummaryView {
  /** provider。 */
  readonly provider: string;
  /** 来源。 */
  readonly source: string;
  /** 条目数。 */
  readonly models: number;
  /** 来源不足的原因。 */
  readonly reason?: string;
}

/** 服务状态。 */
export interface StatusView {
  /** 是否有可用提供方。 */
  readonly available: boolean;
  /** 提供方数量。 */
  readonly providers: number;
  /** 状态。 */
  readonly state: 'ready' | 'degraded' | 'disabled' | 'read-failed';
  /** 成因。 */
  readonly reason?: string;
  /** 读取失败的 provider。 */
  readonly errorProvider?: string;
  /** 读取失败的错误码。 */
  readonly errorCode?: string;
  /** 每个提供方的清单摘要。 */
  readonly catalog: readonly CatalogSummaryView[];
  /** 默认模型。 */
  readonly default?: DefaultSelection;
  /** 默认模型来源。 */
  readonly defaultSource: string;
}

/** 默认模型选择。 */
export interface DefaultSelection {
  /** provider。 */
  readonly provider: string;
  /** 模型标识。 */
  readonly model: string;
  /** 推理强度。 */
  readonly reasoningEffort?: string;
}

/** 额度读数。 */
export interface QuotaView {
  /** provider。 */
  readonly provider: string;
  /** 是否可用。 */
  readonly state: 'available' | 'unsupported';
  /** 不可用的原因。 */
  readonly reason?: string;
  /** 上限。 */
  readonly limit?: number;
  /** 已用。 */
  readonly used?: number;
  /** 剩余。 */
  readonly remaining?: number;
  /** 现在是否允许请求。 */
  readonly allowed?: boolean;
  /** 读取时刻。 */
  readonly measuredAt?: number;
}

/** 用量读数。 */
export interface UsageView {
  /** provider。 */
  readonly provider: string;
  /** 输入 token。 */
  readonly inputTokens?: number;
  /** 输出 token。 */
  readonly outputTokens?: number;
  /** 请求数。 */
  readonly requests?: number;
  /** 更新时间。 */
  readonly updatedAt?: number;
  /** 是否已持久化。 */
  readonly persisted?: boolean;
}

/** 默认模型的写入结果。 */
export interface DefaultWriteResult {
  /** 写入后的版本。 */
  readonly revision: number;
}

/** 模型面板的数据入口。 */
export interface ModelProviderGateway {
  /** 读服务状态。 */
  status(): Promise<StatusView>;
  /** 读提供方目录。 */
  list(): Promise<readonly ProviderView[]>;
  /** 读一个提供方的模型清单。 */
  models(provider: string): Promise<CatalogView>;
  /** 读一个提供方的额度。 */
  quota(provider: string): Promise<QuotaView>;
  /** 读一个提供方的用量。 */
  usage(provider: string): Promise<UsageView>;
  /** 读默认模型。 */
  defaults(): Promise<{ readonly selection?: DefaultSelection; readonly source: string }>;
  /** 读默认模型命名空间的版本。 */
  defaultRevision(): Promise<number>;
  /**
   * 写默认模型。
   * @param selection - provider、model 与推理强度。
   * @param expectedRevision - 读到的版本。
   * @returns 写入后的版本。
   */
  saveDefault(selection: DefaultSelection, expectedRevision: number): Promise<DefaultWriteResult>;
}

/** 判一个取值是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取一个必填字符串。 */
function textOf(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ModelCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  return value;
}

/** 解析一个提供方。 */
function providerOf(value: unknown): ProviderView {
  if (!isRecord(value)) throw new ModelCallError('gateway/internal', '提供方条目的返回形状不符合约定');
  const credential = isRecord(value.credential) ? value.credential : {};
  return {
    provider: textOf(value.provider, '提供方标识'),
    displayName: textOf(value.displayName, '提供方展示名'),
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    registered: value.registered === true,
    available: value.available === true,
    credential: {
      configured: credential.configured === true,
      ...(typeof credential.env === 'string' ? { env: credential.env } : {}),
    },
    declaredModels: Array.isArray(value.declaredModels) ? value.declaredModels.map((item) => String(item)) : [],
  };
}

/** 解析一个模型条目。 */
function modelOf(value: unknown): ModelView {
  if (!isRecord(value)) throw new ModelCallError('gateway/internal', '模型条目的返回形状不符合约定');
  return {
    id: textOf(value.id, '模型标识'),
    name: typeof value.name === 'string' ? value.name : textOf(value.id, '模型标识'),
    contextSource: value.contextSource === 'adapter' ? 'adapter' : 'unavailable',
    ...(typeof value.contextWindow === 'number' ? { contextWindow: value.contextWindow } : {}),
    ...(Array.isArray(value.reasoningEfforts) ? { reasoningEfforts: value.reasoningEfforts.map((item) => String(item)) } : {}),
    ...(typeof value.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: value.defaultReasoningEffort } : {}),
  };
}

/** 解析默认模型。 */
function selectionOf(value: unknown): DefaultSelection | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
  };
}

/** 构造数据入口所需的依赖。 */
export interface ModelGatewayOptions {
  /** 发请求的实现。 */
  readonly fetchImpl?: typeof fetch;
  /** 端点前缀。 */
  readonly prefix?: string;
}

/**
 * 建立模型面板的数据入口。
 * @param options - 请求实现与前缀覆盖。
 * @returns 数据入口。
 */
export function createModelGateway(options: ModelGatewayOptions = {}): ModelProviderGateway {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const prefix = options.prefix ?? '/api/';
  let sequence = 0;
  const call = async <T>(endpoint: string, args: RemoteArgs): Promise<T> => {
    sequence += 1;
    const response = await fetchImpl(`${prefix}${endpoint}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `chatdsh-model-${String(sequence)}`,
        method: endpoint,
        payload: { args },
      }),
    });
    if (!response.ok) throw new ModelCallError('gateway/unreachable', `模型接口返回 ${String(response.status)}`);
    const body = (await response.json()) as {
      result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
    };
    const result = body.result;
    if (result === undefined) throw new ModelCallError('gateway/internal', '模型接口的应答缺少结果字段');
    if (result.ok !== true) throw new ModelCallError(result.error?.code ?? 'gateway/internal', result.error?.message ?? '模型调用失败');
    return result.value as T;
  };

  return {
    async status(): Promise<StatusView> {
      const value = await call<unknown>('chatdshModelProviders/status', {});
      if (!isRecord(value)) throw new ModelCallError('gateway/internal', '服务状态的返回形状不符合约定');
      return {
        available: value.available === true,
        providers: typeof value.providers === 'number' ? value.providers : 0,
        state: value.state === 'ready' || value.state === 'degraded' || value.state === 'read-failed' ? value.state : 'disabled',
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        ...(typeof value.errorProvider === 'string' ? { errorProvider: value.errorProvider } : {}),
        ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
        catalog: Array.isArray(value.catalog)
          ? value.catalog.filter(isRecord).map((entry) => ({
            provider: String(entry.provider ?? ''),
            source: String(entry.source ?? 'unsupported'),
            models: typeof entry.models === 'number' ? entry.models : 0,
            ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
          }))
          : [],
        ...(selectionOf(value.default) === undefined ? {} : { default: selectionOf(value.default) }),
        defaultSource: typeof value.defaultSource === 'string' ? value.defaultSource : 'unavailable',
      };
    },

    async list(): Promise<readonly ProviderView[]> {
      const value = await call<unknown>('chatdshModelProviders/list', {});
      if (!Array.isArray(value)) throw new ModelCallError('gateway/internal', '提供方列表的返回形状不符合约定');
      return value.map(providerOf);
    },

    async models(provider: string): Promise<CatalogView> {
      const value = await call<unknown>('chatdshModelProviders/models', { provider });
      if (!isRecord(value) || !Array.isArray(value.models)) throw new ModelCallError('gateway/internal', '模型清单的返回形状不符合约定');
      return {
        provider: textOf(value.provider, '清单所属提供方'),
        source: value.source === 'adapter' || value.source === 'config' ? value.source : 'unsupported',
        models: value.models.map(modelOf),
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      };
    },

    async quota(provider: string): Promise<QuotaView> {
      const value = await call<unknown>('chatdshModelProviders/quota', { provider });
      if (!isRecord(value)) throw new ModelCallError('gateway/internal', '额度读数的返回形状不符合约定');
      return {
        provider: textOf(value.provider, '额度所属提供方'),
        state: value.state === 'available' ? 'available' : 'unsupported',
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
        ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
        ...(typeof value.used === 'number' ? { used: value.used } : {}),
        ...(typeof value.remaining === 'number' ? { remaining: value.remaining } : {}),
        ...(typeof value.allowed === 'boolean' ? { allowed: value.allowed } : {}),
        ...(typeof value.measuredAt === 'number' ? { measuredAt: value.measuredAt } : {}),
      };
    },

    async usage(provider: string): Promise<UsageView> {
      const value = await call<unknown>('chatdshModelProviders/usage', { provider });
      if (!Array.isArray(value)) throw new ModelCallError('gateway/internal', '用量读数的返回形状不符合约定');
      const first = value.find((entry) => isRecord(entry) && entry.provider === provider);
      if (!isRecord(first)) return { provider };
      return {
        provider,
        ...(typeof first.inputTokens === 'number' ? { inputTokens: first.inputTokens } : {}),
        ...(typeof first.outputTokens === 'number' ? { outputTokens: first.outputTokens } : {}),
        ...(typeof first.requests === 'number' ? { requests: first.requests } : {}),
        ...(typeof first.updatedAt === 'number' ? { updatedAt: first.updatedAt } : {}),
        ...(typeof first.persisted === 'boolean' ? { persisted: first.persisted } : {}),
      };
    },

    async defaults(): Promise<{ readonly selection?: DefaultSelection; readonly source: string }> {
      const value = await call<unknown>('chatdshModelProviders/defaults', {});
      if (!isRecord(value)) throw new ModelCallError('gateway/internal', '默认模型的返回形状不符合约定');
      const selection = selectionOf(value.selection);
      return {
        ...(selection === undefined ? {} : { selection }),
        source: typeof value.source === 'string' ? value.source : 'unavailable',
      };
    },

    async defaultRevision(): Promise<number> {
      const value = await call<unknown>('settings/describe', {});
      if (!isRecord(value) || !Array.isArray(value.namespaces)) {
        throw new ModelCallError('gateway/internal', '设置描述的返回形状不符合约定');
      }
      const entry = value.namespaces.find((item) => isRecord(item) && item.ns === 'agent-default-model');
      return isRecord(entry) && typeof entry.revision === 'number' ? entry.revision : 0;
    },

    async saveDefault(selection: DefaultSelection, expectedRevision: number): Promise<DefaultWriteResult> {
      const patch: Record<string, unknown> = { provider: selection.provider, model: selection.model };
      if (selection.reasoningEffort !== undefined) patch.reasoningEffort = selection.reasoningEffort;
      const value = await call<unknown>('settings/update', {
        ns: 'agent-default-model',
        patch,
        expectedRevision,
      });
      if (!isRecord(value) || typeof value.revision !== 'number') {
        throw new ModelCallError('gateway/internal', '默认模型写入的返回形状不符合约定');
      }
      return { revision: value.revision };
    },
  };
}
