/**
 * 模型清单的读取。
 *
 * 清单只有一个权威来源：模型运行时里那条路由的适配器。适配器发布目录时用它；适配器
 * 不发布时，部署配置里声明的模型作为第二来源，并在结果里写明目录未经适配器确认；
 * 两者都没有时报告不支持，不补任何猜测的模型标识。
 *
 * 上下文窗口与推理强度来自适配器对单个模型的解析，适配器没有披露时那两个字段缺省。
 * @module @chatdsh/host-model-provider/catalog
 */

import type { LlmModelInfo, LlmResolvedModelInfo } from '@chatdsh/adapter';

/** 清单来源。 */
export type CatalogSource = 'adapter' | 'config' | 'unsupported';

/** 清单不可用的原因。 */
export type CatalogReason = 'adapter-publishes-no-catalog';

/** 一个模型的元数据。 */
export interface ModelEntry {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 模型标识。 */
  readonly id: string;
  /** 选择器里显示的名称。 */
  readonly name: string;
  /** 与相近模型的区别说明。 */
  readonly description?: string;
  /** 上下文窗口；适配器没有披露时缺省。 */
  readonly contextWindow?: number;
  /** 上下文窗口的来源；适配器没有披露时为 `unavailable`。 */
  readonly contextSource: 'adapter' | 'unavailable';
  /** 可选的推理强度；适配器没有披露时缺省。 */
  readonly reasoningEfforts?: readonly string[];
  /** 默认推理强度；适配器没有披露时缺省。 */
  readonly defaultReasoningEffort?: string;
}

/** 一个 provider 的清单。 */
export interface ProviderCatalog {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 清单来源。 */
  readonly source: CatalogSource;
  /** 清单条目；不支持时为空表。 */
  readonly models: readonly ModelEntry[];
  /** 来源不足的原因。 */
  readonly reason?: CatalogReason;
  /** 读取时刻的毫秒时间戳。 */
  readonly readAt: number;
}

/** 读取清单用到的模型运行时能力。 */
export interface CatalogRuntime {
  /** 取一条路由发布的模型目录。 */
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  /** 解析单个模型的元数据。 */
  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo>;
}

/**
 * 读取一个 provider 的模型清单。
 * @param runtime - 模型运行时。
 * @param provider - provider 路由标识。
 * @param declared - 部署配置里声明的模型标识。
 * @returns 清单与来源。
 */
export async function readProviderCatalog(
  runtime: CatalogRuntime,
  provider: string,
  declared: readonly string[],
): Promise<ProviderCatalog> {
  const advertised = await runtime.listModels(provider);
  const readAt = Date.now();
  if (advertised.length > 0) {
    const models: ModelEntry[] = [];
    for (const info of advertised) {
      models.push(await entryOf(runtime, info));
    }
    return { provider, source: 'adapter', models, readAt };
  }
  if (declared.length > 0) {
    return {
      provider,
      source: 'config',
      models: declared.map((id) => ({ provider, id, name: id, contextSource: 'unavailable' })),
      reason: 'adapter-publishes-no-catalog',
      readAt,
    };
  }
  return { provider, source: 'unsupported', models: [], reason: 'adapter-publishes-no-catalog', readAt };
}

/** 由目录条目与单模型解析结果拼出一个清单条目。 */
async function entryOf(runtime: CatalogRuntime, info: LlmModelInfo): Promise<ModelEntry> {
  const detail = await runtime.resolveModelInfo(info.provider, info.id);
  const contextWindow = detail.context?.contextWindow;
  const reasoning = detail.reasoning;
  const efforts = reasoning === undefined ? undefined : reasoning.efforts.map((effort) => String(effort.id));
  const defaultEffort = reasoning === undefined || reasoning.defaultEffort === undefined
    ? undefined
    : String(reasoning.defaultEffort);
  return {
    provider: info.provider,
    id: info.id,
    name: info.name,
    ...(info.description === undefined ? {} : { description: info.description }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    contextSource: contextWindow === undefined ? 'unavailable' : 'adapter',
    ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort }),
  };
}
