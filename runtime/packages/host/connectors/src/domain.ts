/**
 * 连接器的存储形状。
 *
 * 两张表分属两个存储域：连接器记录是用户配置，同步状态是派生物。分开存的原因有两层，
 * 一是同步状态的形状会随加载器变化，二是配置与同步必须能分别读出——「配置已保存、
 * 同步失败」是一种合法的双重状态。
 * @module @chatdsh/host-connectors/domain
 */

import { defineDomain, domainTable } from '@chatdsh/adapter';
import { z } from 'zod';

/** 连接器的传输方式。 */
export const TRANSPORTS = ['stdio', 'http'] as const;

/** 连接器的传输方式取值。 */
export type ConnectorTransport = (typeof TRANSPORTS)[number];

/** 一条连接器记录。 */
export interface ConnectorRecord {
  readonly id: string;
  /** 展示名，同时作为 MCP 条目的名字来源。 */
  readonly name: string;
  readonly transport: ConnectorTransport;
  /** stdio 方式下的可执行文件。 */
  readonly command?: string;
  /** stdio 方式下的参数。 */
  readonly args?: readonly string[];
  /** http 方式下的地址。 */
  readonly url?: string;
  /** 凭据所在的环境变量名；凭据本身不落库。 */
  readonly credentialEnv?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 同步状态的取值。同步中只是调用进行中的界面状态，不落盘。 */
export const SYNC_STATUSES = ['ok', 'failed'] as const;

/** 同步状态的取值类型。 */
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** 一条连接器的加载器同步状态。 */
export interface ConnectorSyncState {
  /** 连接器标识。 */
  readonly id: string;
  readonly status: SyncStatus;
  /** 本次同步为该连接器生成的行数。 */
  readonly rows: number;
  /** 失败时的错误类型。 */
  readonly errorType?: string;
  /** 失败时的错误码。 */
  readonly errorCode?: string;
  /** 记录时刻的毫秒时间戳。 */
  readonly at: number;
}

/** 连接器记录的 schema。 */
export const connectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(TRANSPORTS),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  credentialEnv: z.string().optional(),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/** 同步状态的 schema。 */
export const syncStateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(SYNC_STATUSES),
  rows: z.number().int().nonnegative(),
  errorType: z.string().optional(),
  errorCode: z.string().optional(),
  at: z.number().int().nonnegative(),
});

/** 存储域的名字，需满足小写与下划线的命名约束。 */
export const CONNECTORS_DOMAIN = defineDomain({
  name: 'connectors_store',
  version: 1,
  tables: {
    connectors: domainTable<'connectors', ConnectorRecord>(connectorSchema),
  },
});

/** 同步状态的存储域。 */
export const CONNECTORS_SYNC_DOMAIN = defineDomain({
  name: 'connectors_sync_store',
  version: 1,
  tables: {
    states: domainTable<'state', ConnectorSyncState>(syncStateSchema),
  },
});
