/**
 * 模型提供方宿主插件。
 *
 * 在宿主平面持有模型提供方的注册信息：路由标识、展示名、端点与静态请求头。构造时对每条
 * 配置调用一次校验，失败即抛出，让装配阶段就暴露配置错误；运行期只读，不发起网络请求。
 *
 * 对外方法走 typert Remote：客户端按 `chatdshModelProviders` 命名空间读取列表与状态。
 * @module @chatdsh/host-model-provider
 */

import { Remote, schema as z, TypertRemoteService, telemetryOf, type Context } from '@chatdsh/adapter';
import type { ModelProviderInfo } from '@chatdsh/core-contracts';
import { MODEL_PROVIDER_INVALID, resolveModelProvider, type ModelProviderInput } from './client.ts';

export { GATEWAY_PROVIDER, MODEL_PROVIDER_INVALID, ModelProviderError, resolveModelProvider } from './client.ts';
export type { ModelProviderInput } from './client.ts';

/** 插件名。 */
export const name = 'chatdsh-model-provider';

/** 服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshModelProviders';

/** 服务状态。 */
export interface ModelProvidersStatus {
  /** 是否至少有一个提供方。 */
  readonly available: boolean;
  /** 提供方数量。 */
  readonly providers: number;
}

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
  })).required(false),
});

/** 用到的遥测面。 */
interface ProviderTelemetry {
  runSpanSync<T>(name: string, attributes: Record<string, unknown>, body: (span: { setAttribute(key: string, value: unknown): void }) => T): T;
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/**
 * 模型提供方服务。
 *
 * 注册信息在构造时一次性校验并冻结；后续读取不改变状态。
 */
export class ChatdshModelProviderService extends TypertRemoteService {
  /** 配置 schema，供加载器校验。 */
  static readonly Config = Config;

  /** 依赖的服务：模型运行时。注册信息在构造时校验，运行期只读。 */
  static inject = ['llm'];

  private readonly providers: readonly ModelProviderInfo[];

  constructor(ctx: Context, config: ModelProviderConfig) {
    super(ctx, SERVICE_NAME);
    const telemetry = telemetryOf<ProviderTelemetry>(ctx);
    this.providers = config.providers.map((input) => {
      if (telemetry === undefined) return resolveModelProvider(input);
      return telemetry.runSpanSync('chatdsh.runtime.model.provider.resolve', { provider: input.provider }, (span) => {
        try {
          const info = resolveModelProvider(input);
          span.setAttribute('outcome', 'ok');
          telemetry.counter('chatdsh_model_provider_resolutions_total', { description: '模型提供方注册校验次数' })
            .add(1, { provider: input.provider, outcome: 'ok' });
          return info;
        } catch (error) {
          span.setAttribute('outcome', 'failed');
          telemetry.event('chatdsh.runtime.model.provider.failed', {
            provider: input.provider,
            'error.type': error instanceof Error ? error.name : 'Unknown',
            'error.code': MODEL_PROVIDER_INVALID,
          });
          telemetry.counter('chatdsh_model_provider_resolutions_total', { description: '模型提供方注册校验次数' })
            .add(1, { provider: input.provider, outcome: 'failed' });
          throw error;
        }
      });
    });
  }

  /** 列出全部提供方。 */
  @Remote('list')
  list(): ModelProviderInfo[] {
    return [...this.providers];
  }

  /** 服务状态，供客户端面板显示。 */
  @Remote('status')
  status(): ModelProvidersStatus {
    return { available: this.providers.length > 0, providers: this.providers.length };
  }
}

/** 注册服务。 */
export function apply(ctx: Context, config: ModelProviderConfig): void {
  ctx.plugin(ChatdshModelProviderService, config);
}
