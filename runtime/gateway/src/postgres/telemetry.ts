/**
 * 控制平面 Postgres 实现的遥测。
 *
 * 只经 `ctx.chatdshTelemetry` 或等价客户端记录：连接、写租约与迁移各一个 span，失败分支
 * 各一条事件，结果各一个计数。连接串、SQL 原文与记录正文一律不进属性。
 * @module @chatdsh/gateway/postgres/telemetry
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';

/** 本模块产生的信号名。 */
export const POSTGRES_SIGNALS = {
  /** 建立连接。 */
  connect: 'chatdsh.gateway.postgres.connect',
  /** 写租约的取得、续租与释放。 */
  lease: 'chatdsh.gateway.postgres.lease',
  /** 迁移与导入。 */
  migrate: 'chatdsh.gateway.postgres.migrate',
  /** 被拒绝或失败的动作。 */
  rejected: 'chatdsh.gateway.postgres.rejected',
  /** 连接结果计数。 */
  connectionsTotal: 'chatdsh_gateway_postgres_connections_total',
  /** 写租约结果计数。 */
  leasesTotal: 'chatdsh_gateway_postgres_leases_total',
  /** 迁移结果计数。 */
  migrationsTotal: 'chatdsh_gateway_postgres_migrations_total',
} as const;

/** 遥测出口里本模块用到的那部分。 */
export type PostgresTelemetry = Pick<ChatdshTelemetry, 'event' | 'counter' | 'runSpan' | 'runSpanSync'>;

/** 空实现。 */
export const NO_POSTGRES_TELEMETRY: PostgresTelemetry = {
  event: () => {},
  counter: () => ({ add: () => {} }),
  runSpan: async (_name, _attributes, fn) => fn({ setAttribute: () => {}, setAttributes: () => {}, recordException: () => {}, end: () => {} }),
  runSpanSync: (_name, _attributes, fn) => fn({ setAttribute: () => {}, setAttributes: () => {}, recordException: () => {}, end: () => {} }),
};

/** 把错误整理成属性。 */
export function errorAttributes(error: unknown): Record<string, string> {
  const name = error instanceof Error ? error.name : 'Error';
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : name;
  return { 'error.type': name, 'error.code': code };
}
