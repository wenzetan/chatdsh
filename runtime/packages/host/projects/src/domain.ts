/**
 * 项目记录的存储域声明。
 *
 * 键是工作目录的规范化绝对路径，因此同一目录在两台设备上各自一份记录。记录带 `revision`：
 * 每次成功写入递增，写入方带上读到的版本，版本落后即拒绝，界面之间不会互相覆盖。
 * @module @chatdsh/host-projects/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@chatdsh/adapter';

/** 一条项目记录。 */
export interface ProjectRecord {
  /** 工作目录的规范化绝对路径，同时是表键。 */
  readonly path: string;
  /** 展示名原文；为空表示按目录末段显示。 */
  readonly title: string;
  /** 实际展示名：名称留空时取目录末段。 */
  readonly displayTitle: string;
  /** 注入会话上下文与工作区指令的项目说明。 */
  readonly instructions: string;
  /** 该项目新建会话时的默认模型引用，写法为 `provider/model`。 */
  readonly defaultModel?: string;
  /** 该项目新建会话时的默认助手标识，取值是已注册的预设标识。 */
  readonly defaultAssistant?: string;
  /** 写入版本，从 1 开始，每次成功写入递增。 */
  readonly revision: number;
  /** 最后修改时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 项目记录 schema。 */
export const projectSchema = z.object({
  path: z.string().min(1),
  title: z.string(),
  displayTitle: z.string().min(1),
  instructions: z.string(),
  defaultModel: z.string().optional(),
  defaultAssistant: z.string().optional(),
  revision: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
});

/** 存储域声明。域名只允许小写字母、数字与下划线。 */
export const PROJECTS_DOMAIN = defineDomain({
  name: 'projects_store',
  version: 2,
  tables: {
    projects: domainTable<'project', ProjectRecord>(projectSchema),
  },
});
