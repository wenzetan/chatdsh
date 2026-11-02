/**
 * 列表分页契约。
 *
 * 游标由服务端生成，编码内部结构不对外承诺；客户端只回传原值。列表上限与系统完成设计
 * 第九节一致：默认 50 条，最大 200 条。
 * @module @chatdsh/core-contracts/pagination
 */

import { z } from 'zod';
import { cursorSchema } from './primitives.ts';

/** 默认每页条数。 */
export const DEFAULT_PAGE_SIZE = 50;

/** 每页条数上限。 */
export const MAX_PAGE_SIZE = 200;

/** 列表排序方式。 */
export const LIST_ORDERS = ['created-desc', 'created-asc', 'updated-desc', 'title-asc'] as const;

/** 列表排序方式取值。 */
export type ListOrder = (typeof LIST_ORDERS)[number];

/** 列表查询参数。 */
export const listQuerySchema = z.object({
  /** 上一页返回的游标；首页缺省。 */
  cursor: cursorSchema.optional(),
  /** 每页条数。 */
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  /** 排序方式。 */
  order: z.enum(LIST_ORDERS).default('updated-desc'),
});

/** 列表查询参数。 */
export type ListQuery = z.infer<typeof listQuerySchema>;

/** 分页信息。 */
export const pageInfoSchema = z.object({
  /** 下一页游标；没有更多数据时缺省。 */
  nextCursor: cursorSchema.optional(),
  /** 是否还有更多数据。 */
  hasMore: z.boolean(),
});

/** 分页信息。 */
export type PageInfo = z.infer<typeof pageInfoSchema>;

/**
 * 组装一页列表的 schema。
 * @param item - 条目 schema。
 * @returns 带分页信息的列表 schema。
 */
export function pageSchemaOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: pageInfoSchema,
  });
}
