/**
 * 模型提供方注册信息的校验与补全。
 *
 * 这一层是纯函数：只检查路由标识、端点形状与凭据变量名，补上展示名，不发起网络请求，
 * 也不接触任何 DSH 服务。宿主插件在构造时对每个配置项调用一次，校验失败就地抛出。
 * @module @chatdsh/host-model-provider/client
 */

import type { ModelProviderInfo } from '@chatdsh/core-contracts';

/** 网关提供方的固定路由标识。 */
export const GATEWAY_PROVIDER = 'gateway';

/** 提供方标识的形状：小写字母开头，只含小写字母、数字与连字符。 */
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 端点必须是 http 或 https。 */
const BASE_URL_PATTERN = /^https?:\/\//;

/** 环境变量名的形状：大写字母、数字与下划线，且不以数字开头。 */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** 校验失败的错误码。 */
export const MODEL_PROVIDER_INVALID = 'model-provider/invalid';

/** 注册信息不合法。 */
export class ModelProviderError extends Error {
  /** 固定错误码，供遥测与界面按码分支。 */
  readonly code = MODEL_PROVIDER_INVALID;

  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

/** 配置里的一条提供方。 */
export interface ModelProviderInput {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 配置界面显示的提供方名称；省略时等于路由标识。 */
  readonly displayName?: string;
  /** 端点地址。 */
  readonly baseUrl: string;
  /** 静态请求头。 */
  readonly headers?: Record<string, string>;
  /** 已知的模型列表。 */
  readonly models?: string[];
  /** 凭据所在的环境变量名；只报名字与是否就绪，值不进入任何返回值。 */
  readonly apiKeyEnv?: string;
}

/** 一个提供方的凭据配置状态。 */
export interface ProviderCredential {
  /** 凭据所在的环境变量名；不需要凭据时缺省。 */
  readonly env?: string;
  /** 该变量是否已经就绪。 */
  readonly configured: boolean;
}

/**
 * 校验一条注册信息并补全展示名。
 * @param input - 配置里的一条提供方。
 * @returns 可交给模型注册表使用的注册信息。
 * @throws {@link ModelProviderError} 标识、端点或凭据变量名不合法。
 */
export function resolveModelProvider(input: ModelProviderInput): ModelProviderInfo {
  if (typeof input.provider !== 'string' || input.provider === '') {
    throw new ModelProviderError('缺少 provider：每个模型提供方必须给出路由标识');
  }
  if (!PROVIDER_PATTERN.test(input.provider)) {
    throw new ModelProviderError(`provider 不合法：${input.provider}，只允许小写字母、数字与连字符`);
  }
  if (typeof input.baseUrl !== 'string' || input.baseUrl === '') {
    throw new ModelProviderError(`缺少 baseUrl：provider ${input.provider} 必须给出端点`);
  }
  if (!BASE_URL_PATTERN.test(input.baseUrl)) {
    throw new ModelProviderError(`baseUrl 不合法：${input.baseUrl}，必须以 http:// 或 https:// 开头`);
  }
  if (input.apiKeyEnv !== undefined && (typeof input.apiKeyEnv !== 'string' || !ENV_NAME_PATTERN.test(input.apiKeyEnv))) {
    throw new ModelProviderError(`apiKeyEnv 不合法：${String(input.apiKeyEnv)}，只允许大写字母、数字与下划线`);
  }

  const info: {
    provider: string;
    displayName: string;
    baseUrl: string;
    headers?: Readonly<Record<string, string>>;
    models?: readonly string[];
  } = {
    provider: input.provider,
    displayName: input.displayName ?? input.provider,
    baseUrl: input.baseUrl,
  };
  if (input.headers !== undefined) info.headers = input.headers;
  if (input.models !== undefined) info.models = input.models;
  return info;
}

/**
 * 读取一条提供方的凭据状态。凭据值不进入返回值，只报告变量名与是否设置。
 * @param input - 配置里的一条提供方。
 * @param environment - 读取环境变量的函数，缺省为 `process.env`。
 * @returns 凭据配置状态。
 */
export function credentialOf(
  input: ModelProviderInput,
  environment: (name: string) => string | undefined = (name) => process.env[name],
): ProviderCredential {
  if (input.apiKeyEnv === undefined) return { configured: true };
  const value = environment(input.apiKeyEnv);
  return { env: input.apiKeyEnv, configured: value !== undefined && value !== '' };
}

/**
 * 掩掉端点里的凭据与查询串。界面显示的是来源，凭据值不能出现在界面或日志里。
 * @param endpoint - 已配置的端点地址。
 * @returns 可以展示的地址。
 */
export function maskEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const credentials = url.username === '' && url.password === '' ? '' : '***@';
  const query = url.search === '' ? '' : '?***';
  return `${url.protocol}//${credentials}${url.host}${url.pathname}${query}`;
}
