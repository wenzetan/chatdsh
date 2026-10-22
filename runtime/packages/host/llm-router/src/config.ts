/**
 * 路由器配置的校验与补全。
 *
 * 这一层是纯函数：只检查路由标识、入口地址与额度数值，不发起网络请求，也不接触 DSH
 * 服务。宿主插件在构造时对每条路由调用一次，失败即抛出；配置错误在装配阶段暴露。
 * @module @chatdsh/host-llm-router/config
 */

/** 路由标识的形状：小写字母开头，只含小写字母、数字与连字符。 */
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 入口地址必须是 http 或 https。 */
const BASE_URL_PATTERN = /^https?:\/\//;

/** 配置不合法。 */
export class LlmRouterConfigError extends Error {
  /** 固定错误码，供遥测与界面按码分支。 */
  readonly code = 'llm-router/invalid';

  constructor(message: string) {
    super(message);
    this.name = 'LlmRouterConfigError';
  }
}

/** 配置里的一条路由。 */
export interface RouterRouteInput {
  /** provider 路由标识，与控制平面注册的提供方一致。 */
  readonly provider: string;
  /** 控制平面的模型入口地址。 */
  readonly baseUrl: string;
  /** 该路由的额度上限。 */
  readonly limit?: number;
  /** 该路由启动时的已用额度。 */
  readonly used?: number;
}

/** 校验后的路由。 */
export interface RouterRoute {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 控制平面的模型入口地址。 */
  readonly baseUrl: string;
  /** 额度上限；缺省表示不限制。 */
  readonly limit?: number;
  /** 启动时的已用额度。 */
  readonly used: number;
}

/**
 * 校验一条路由。
 * @param input - 配置里的一条路由。
 * @returns 补全后的路由。
 * @throws {@link LlmRouterConfigError} 标识、地址或额度不合法。
 */
export function resolveRouterRoute(input: RouterRouteInput): RouterRoute {
  if (typeof input.provider !== 'string' || !PROVIDER_PATTERN.test(input.provider)) {
    throw new LlmRouterConfigError(`provider 不合法：${input.provider}，只允许小写字母、数字与连字符`);
  }
  if (typeof input.baseUrl !== 'string' || !BASE_URL_PATTERN.test(input.baseUrl)) {
    throw new LlmRouterConfigError(`baseUrl 不合法：${input.baseUrl}，必须以 http:// 或 https:// 开头`);
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 0)) {
    throw new LlmRouterConfigError(`limit 必须是非负整数：${input.limit}`);
  }
  if (input.used !== undefined && (!Number.isInteger(input.used) || input.used < 0)) {
    throw new LlmRouterConfigError(`used 必须是非负整数：${input.used}`);
  }
  return { provider: input.provider, baseUrl: input.baseUrl, limit: input.limit, used: input.used ?? 0 };
}
