/**
 * `pg` 的加载面与连接池构造。
 *
 * 上游包名与最小结构类型收在这一个文件：其它模块只经这里的类型访问连接池与连接，
 * 不直接接触 `pg` 的导出形状。连接串只从配置取得，绝不写进日志、遥测属性或错误消息。
 * @module @chatdsh/core-session-persistence-postgres/pg
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 一行结果。 */
export type PgRow = Record<string, unknown>;

/** 一次查询的结果。 */
export interface PgQueryResult {
  /** 结果行。 */
  readonly rows: PgRow[];
  /** 受影响行数；部分语句不提供。 */
  readonly rowCount?: number | null;
}

/** 一个连接。 */
export interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  release(destroy?: boolean): void;
}

/** 连接池。 */
export interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

/** 连接池构造选项。 */
export interface PgPoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly application_name?: string;
}

/** `pg` 模块里用到的那部分。 */
interface PgModule {
  readonly Pool: new (options: PgPoolOptions) => PgPool;
}

/** 读取 `pg` 模块。加载失败就在构造路径之外原地抛出。 */
export function loadPg(): PgModule {
  return require('pg') as PgModule;
}

/** 连接串为空的配置拒绝构造连接池。 */
export function requireConnectionString(connectionString: string | undefined): string {
  const trimmed = connectionString?.trim() ?? '';
  if (trimmed === '') {
    throw new PostgresConfigurationError('Postgres 后端缺少连接串，拒绝构造连接池');
  }
  return trimmed;
}

/** 配置错误：连接串缺失或不可用。 */
export class PostgresConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresConfigurationError';
  }
}

/** 数据库不可达或连接在操作中终止。 */
export class PostgresUnavailableError extends Error {
  /** 底层错误的名称。 */
  readonly causeName: string;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PostgresUnavailableError';
    const cause = options.cause;
    this.causeName = cause instanceof Error ? cause.name : 'Error';
  }
}

/** 连接级错误的 SQLSTATE 与错误码集合。判定依据是 `pg` 给出的 `code` 字段。 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '53300',
]);

/** 取错误的 SQLSTATE 或系统错误码。 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** 判断错误是否代表连接不可用。 */
export function isConnectionError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /connection terminated|connection closed|client has encountered a connection error|not queryable|terminating connection/i.test(
    message,
  );
}

/** 把连接级错误包装成 {@link PostgresUnavailableError}，其它错误原样返回。 */
export function asPostgresError(error: unknown, operation: string): Error {
  if (error instanceof PostgresConfigurationError) return error;
  if (isConnectionError(error)) {
    return new PostgresUnavailableError(`Postgres 在${operation}时不可达`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** 把结果里的整数列转成数字；`pg` 对 `bigint` 返回字符串。 */
export function toNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Postgres 结果列 ${field} 不是安全整数：${String(value)}`);
}

/** 读取可空整数列。 */
export function toNullableNumber(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : toNumber(value, field);
}
