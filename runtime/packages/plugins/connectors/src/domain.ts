/**
 * 连接器的存储形状。
 * @module @chatdsh/plugin-connectors/domain
 */

import { defineDomain, domainTable } from '@chatdsh/adapter';
import { z } from 'zod';

/** 连接器的传输方式。 */
export const TRANSPORTS = ['stdio', 'http'] as const;

/** 一条连接器记录。 */
export interface ConnectorRecord {
  readonly id: string;
  /** 展示名，同时作为 MCP 条目的名字。 */
  readonly name: string;
  readonly transport: 'stdio' | 'http';
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

/** 存储域的名字，需满足小写与下划线的命名约束。 */
export const CONNECTORS_DOMAIN = defineDomain({
  name: 'connectors_store',
  version: 1,
  tables: {
    connectors: domainTable<'connectors', ConnectorRecord>(
      z.object({
        id: z.string(),
        name: z.string(),
        transport: z.enum(TRANSPORTS),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
        credentialEnv: z.string().optional(),
        enabled: z.boolean(),
        createdAt: z.number(),
        updatedAt: z.number(),
      }) as never,
    ),
  },
});
