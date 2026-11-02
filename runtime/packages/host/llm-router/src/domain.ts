/**
 * 模型路由的存储域声明。
 *
 * 两张表：`bindings` 记录一个会话首轮使用的 provider 与模型，写入之后不再改变；`usage`
 * 记录每个 provider 累计的 token 用量与请求数，重启后用它恢复额度守卫的启动读数。
 *
 * 会话绑定带 `revision`：新建时从 1 开始，固定之后不再递增，任何尝试改写绑定的写入按
 * `revision-conflict` 拒绝。
 * @module @chatdsh/host-llm-router/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@chatdsh/adapter';

/** 一个会话固定的模型选择。 */
export interface SessionModelBinding {
  /** 会话标识，同时是表键。 */
  readonly sessionId: string;
  /** provider 路由标识。 */
  readonly provider: string;
  /** 该路由下的模型标识。 */
  readonly model: string;
  /** 首轮请求带上的推理强度；没有给出时缺省。 */
  readonly reasoningEffort?: string;
  /** 绑定版本；固定之后恒为 1。 */
  readonly revision: number;
  /** 绑定时刻的毫秒时间戳。 */
  readonly boundAt: number;
}

/** 一个 provider 的累计用量。 */
export interface ProviderUsageRecord {
  /** provider 路由标识，同时是表键。 */
  readonly provider: string;
  /** 累计输入 token。 */
  readonly inputTokens: number;
  /** 累计输出 token。 */
  readonly outputTokens: number;
  /** 累计请求数，只统计报告了用量的请求。 */
  readonly requests: number;
  /** 最后写入时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 会话绑定 schema。 */
export const bindingSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
  revision: z.number().int().positive(),
  boundAt: z.number().int().nonnegative(),
});

/** 用量记录 schema。 */
export const usageSchema = z.object({
  provider: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/** 存储域声明。域名只允许小写字母、数字与下划线。 */
export const LLM_ROUTER_DOMAIN = defineDomain({
  name: 'llm_router_store',
  version: 1,
  tables: {
    bindings: domainTable<'session-binding', SessionModelBinding>(bindingSchema),
    usage: domainTable<'provider-usage', ProviderUsageRecord>(usageSchema),
  },
});
