/**
 * 跨组件契约共用的基础标量 schema。
 *
 * 各域契约只声明字段，标量形状在这里统一定义，避免同类字段在不同文件里出现不同长度限制。
 * @module @chatdsh/core-contracts/primitives
 */

import { z } from 'zod';

/** 通用标识：非空且不超过 200 个字符的稳定字符串。 */
export const identifierSchema = z.string().min(1).max(200);

/** 展示名称：去空白后 1 到 80 个字符。 */
export const displayNameSchema = z.string().trim().min(1).max(80);

/** 毫秒时间戳，取非负整数。 */
export const epochMillisSchema = z.number().int().nonnegative();

/** 计数、条数与字节数，取非负整数。 */
export const countSchema = z.number().int().nonnegative();

/** revision：服务端每次成功写入后递增的整数。 */
export const revisionSchema = z.number().int().nonnegative();

/** 分页游标：不透明字符串，内部编码不对外承诺。 */
export const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
