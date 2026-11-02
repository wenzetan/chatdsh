/**
 * Postgres 协议客户端的加载面与错误分类。
 *
 * `pg` 由 `@chatdsh/core-session-persistence-postgres` 声明并安装，控制平面侧的 Postgres
 * 实现从那个包的清单所在位置解析同一个客户端，保证整套替换只装一份依赖。连接串只从配置
 * 取得，绝不写进日志、遥测属性或错误消息。
 * @module @chatdsh/gateway/postgres/pg-module
 */

import { createRequire } from 'node:module';

/** 一行查询结果。 */
export type PgRow = Record<string, unknown>;

/** 一次查询结果。 */
export interface PgResult {
  /** 结果行。 */
  readonly rows: PgRow[];
  /** 受影响行数。 */
  readonly rowCount: number | null;
}

/** 一条客户端连接。 */
export interface PgConnection {
  connect(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<PgResult>;
  end(): Promise<void>;
}

/** `pg` 模块里用到的那部分。 */
export interface PgModule {
  readonly Client: new (options: { connectionString: string; application_name?: string }) => PgConnection;
  /** 类型解析表；用 `setTypeParser` 把 `int8` 解析成数字，与 SQLite 的整数语义一致。 */
  readonly types: { setTypeParser(oid: number, parse: (value: string) => unknown): void };
}

/** 声明 `pg` 的包清单位置。 */
const PG_OWNER_MANIFEST = new URL(
  '../../../packages/core/session-persistence-postgres/package.json',
  import.meta.url,
);

/** 从声明方解析 `pg`；缺失时在原地抛出模块解析错误。 */
export function loadPg(): PgModule {
  const requireFromOwner = createRequire(PG_OWNER_MANIFEST);
  return requireFromOwner('pg') as PgModule;
}

/** 配置缺失或不可用。 */
export class PostgresConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresConfigError';
  }
}

/** 数据库不可达或连接在操作中终止。 */
export class PostgresUnavailableError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PostgresUnavailableError';
  }
}

/** 连接级错误的错误码。 */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/** 取错误的 SQLSTATE 或系统错误码。 */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** 判断错误是否代表连接不可用。 */
export function isConnectionFailure(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code !== undefined && CONNECTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /connection terminated|connection closed|not queryable|terminating connection|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|getaddrinfo/i.test(
    message,
  );
}

/** 把连接级错误包装成 {@link PostgresUnavailableError}。 */
export function asUnavailable(error: unknown, operation: string): Error {
  if (isConnectionFailure(error)) {
    return new PostgresUnavailableError(`Postgres 在${operation}时不可达`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** 把整数列转换成数字。 */
export function integerOf(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Postgres 结果列 ${field} 不是安全整数：${String(value)}`);
}

/** 读取可空整数列。 */
export function nullableIntegerOf(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : integerOf(value, field);
}
