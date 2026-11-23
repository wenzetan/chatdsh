/**
 * 客户端契约共用的标量 schema 与解析依赖登记。
 *
 * 各域契约只声明字段，标量形状在这里统一定义，避免同类字段在不同文件里出现不同长度限制。
 * 本包不手写任何格式解析：JSON 与字段校验交给 zod，YAML 由设置同步使用 js-yaml 解析，
 * 两者都登记在 {@link PARSING_DEPENDENCIES}。
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

/** 操作标识的写法：128 位随机值的 base64url 或十六进制写法，长度 16 到 64。 */
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 操作标识。 */
export const operationIdSchema = z.string().regex(OPERATION_ID_PATTERN);

/** 请求摘要的写法：SHA-256 的十六进制。 */
export const REQUEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** 请求摘要。 */
export const requestDigestSchema = z.string().regex(REQUEST_DIGEST_PATTERN);

/** 分页游标：不透明字符串，内部编码不对外承诺。 */
export const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);

/** 支持的 IANA 时区名称。 */
const SUPPORTED_TIME_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

/** IANA 时区名称；`UTC` 单独列出，兼容不带地区的写法。 */
export const ianaTimeZoneSchema = z.string().refine(
  (value) => value === 'UTC' || SUPPORTED_TIME_ZONES.has(value),
  { message: '时区必须是 IANA 时区名称' },
);

/** 本日时刻的写法：24 小时制的 `HH:mm`。 */
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** 解析依赖的登记项。 */
export interface ParsingDependency {
  /** 被解析的格式。 */
  readonly format: 'json' | 'yaml' | 'timezone';
  /** 承担解析的成熟依赖或平台接口。 */
  readonly library: string;
  /** 实施该解析的模块。 */
  readonly owner: string;
  /** 实施状态；`pending` 表示该依赖尚未加入工作区。 */
  readonly status: 'implemented' | 'pending';
}

/**
 * 解析依赖登记。
 *
 * 契约只声明字段形状与校验约束，实际解析全部交给表中登记的成熟依赖。
 */
export const PARSING_DEPENDENCIES: readonly ParsingDependency[] = [
  {
    format: 'json',
    library: 'zod',
    owner: '@chatdsh/core-contracts',
    status: 'implemented',
  },
  {
    format: 'yaml',
    library: 'js-yaml',
    owner: '@chatdsh/host-settings-sync',
    status: 'implemented',
  },
  {
    format: 'timezone',
    library: 'Intl.supportedValuesOf',
    owner: '@chatdsh/core-contracts',
    status: 'implemented',
  },
];
