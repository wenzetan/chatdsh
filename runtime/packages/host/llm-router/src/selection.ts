/**
 * 路由选择的形状校验与端点掩码。
 *
 * 这一层是纯函数：只检查 provider、模型与推理强度的写法，把端点里的凭据与查询串掩掉，
 * 不接触任何 DSH 服务，也不发起网络请求。路由是否注册、模型是否在目录里由服务层核对。
 * @module @chatdsh/host-llm-router/selection
 */

import { ChatdshError } from '@chatdsh/core-contracts';

/** provider 路由标识的形状：小写字母开头，只含小写字母、数字与连字符。 */
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 模型标识的长度上限。 */
export const MODEL_LIMIT = 200;

/** 推理强度标识的长度上限。 */
export const EFFORT_LIMIT = 64;

/** 调用方给出的路由选择；三项都可省略。 */
export interface RouteSelectionInput {
  /** provider 路由标识。 */
  readonly provider?: string;
  /** 模型标识。 */
  readonly model?: string;
  /** 推理强度标识。 */
  readonly reasoningEffort?: string;
}

/** 一次已经固定的 provider 与模型。 */
export interface FixedSelection {
  /** provider 路由标识。 */
  readonly provider: string;
  /** 模型标识。 */
  readonly model: string;
  /** 推理强度；缺省表示沿用 provider 默认。 */
  readonly reasoningEffort?: string;
}

/**
 * 校验路由选择的写法。
 *
 * provider 与 model 必须同时给出或者同时省略：只给一半的引用无法用于创建会话。
 * @param input - 调用方给出的选择。
 * @returns 规范化后的选择；省略的字段不出现在结果里。
 * @throws {@link ChatdshError} 写法不合法，错误码为 `request-invalid`。
 */
export function normalizeSelection(input: RouteSelectionInput): RouteSelectionInput {
  if (typeof input !== 'object' || input === null) {
    throw new ChatdshError('request-invalid', '路由选择必须是对象');
  }
  const provider = input.provider === undefined ? undefined : normalizeProvider(input.provider);
  const model = input.model === undefined ? undefined : normalizeModel(input.model);
  const reasoningEffort = input.reasoningEffort === undefined ? undefined : normalizeEffort(input.reasoningEffort);
  if ((provider === undefined) !== (model === undefined)) {
    throw new ChatdshError('request-invalid', 'provider 与 model 必须同时给出或者同时省略');
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/**
 * 校验一个 provider 路由标识。
 * @param provider - 调用方给出的标识。
 * @returns 原值。
 * @throws {@link ChatdshError} 写法不合法。
 */
export function normalizeProvider(provider: string): string {
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new ChatdshError('request-invalid', 'provider 只允许小写字母、数字与连字符', { provider: String(provider) });
  }
  return provider;
}

/**
 * 校验一个模型标识。
 * @param model - 调用方给出的模型标识。
 * @returns 原值。
 * @throws {@link ChatdshError} 写法不合法。
 */
export function normalizeModel(model: string): string {
  if (typeof model !== 'string' || model === '') {
    throw new ChatdshError('request-invalid', '模型标识不能为空');
  }
  if (model !== model.trim() || /\s/.test(model)) {
    throw new ChatdshError('request-invalid', '模型标识不能包含空白');
  }
  if (model.length > MODEL_LIMIT) {
    throw new ChatdshError('request-invalid', '模型标识超过长度上限', { limit: MODEL_LIMIT });
  }
  return model;
}

/**
 * 校验一个推理强度标识。
 * @param effort - 调用方给出的推理强度。
 * @returns 原值。
 * @throws {@link ChatdshError} 写法不合法。
 */
export function normalizeEffort(effort: string): string {
  if (typeof effort !== 'string' || effort === '') {
    throw new ChatdshError('request-invalid', '推理强度不能为空');
  }
  if (effort !== effort.trim() || /\s/.test(effort)) {
    throw new ChatdshError('request-invalid', '推理强度不能包含空白');
  }
  if (effort.length > EFFORT_LIMIT) {
    throw new ChatdshError('request-invalid', '推理强度超过长度上限', { limit: EFFORT_LIMIT });
  }
  return effort;
}

/**
 * 判断两个 provider 与模型是否相同。推理强度不参与比较：首轮之后固定的只有路由与模型。
 * @param left - 一个选择。
 * @param right - 另一个选择。
 * @returns 相同则为 `true`。
 */
export function sameRouteSelection(left: FixedSelection, right: FixedSelection): boolean {
  return left.provider === right.provider && left.model === right.model;
}

/**
 * 掩掉端点里的凭据与查询串。
 *
 * 提供方目录要显示端点的来源，凭据值不能出现在界面或日志里；查询串整体替换成固定掩码，
 * 因为查询串里常见的就是密钥。
 * @param endpoint - 已配置的端点地址。
 * @returns 可以展示的地址。
 */
export function maskEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const credentials = url.username === '' && url.password === '' ? '' : '***@';
  const query = url.search === '' ? '' : '?***';
  return `${url.protocol}//${credentials}${url.host}${url.pathname}${query}`;
}
