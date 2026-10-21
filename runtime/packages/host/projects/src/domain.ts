/**
 * 项目记录的存储域声明。键是工作区的绝对路径，因此同一目录在两台设备上各自一份记录。
 * @module @chatdsh/host-projects/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@chatdsh/adapter';

/** 一条项目记录。 */
export interface ProjectRecord {
  /** 工作目录的绝对路径，同时是表键。 */
  readonly path: string;
  /** 展示名；为空时界面用目录末段。 */
  readonly title: string;
  /** 注入会话上下文与工作区指令的项目说明。 */
  readonly instructions: string;
  /** 该项目新建会话时的默认模型路由名。 */
  readonly defaultModel?: string;
  /** 工作区是否共享；共享工作区的记忆写进组 bank。 */
  readonly shared?: boolean;
  /** 最后修改时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 项目记录 schema。 */
export const projectSchema = z.object({
  path: z.string().min(1),
  title: z.string(),
  instructions: z.string(),
  defaultModel: z.string().optional(),
  shared: z.boolean().optional(),
  updatedAt: z.number().int().nonnegative(),
});

/** 存储域声明。域名只允许小写字母、数字与下划线。 */
export const PROJECTS_DOMAIN = defineDomain({
  name: 'projects_store',
  version: 1,
  tables: {
    projects: domainTable<'project', ProjectRecord>(projectSchema),
  },
});
