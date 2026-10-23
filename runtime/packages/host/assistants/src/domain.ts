/**
 * 自定义助手的存储域声明。
 *
 * 助手是「一个 preset 定义 + 展示元数据」的记录：preset 由注册表在启动时装配，
 * 记录本身落在结构化存储里，因此重启后助手仍在。
 * @module @chatdsh/host-assistants/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@chatdsh/adapter';

/** 一条自定义助手记录。 */
export interface AssistantRecord {
  /** 助手标识，同时是 preset id。 */
  readonly id: string;
  /** 展示名。 */
  readonly name: string;
  /** 展示说明。 */
  readonly description: string;
  /** 预设排序。 */
  readonly order: number;
  /** 助手的指令文本，注入为 persona 前缀。 */
  readonly instructions: string;
  /**
   * 工具档位；缺省按默认档位装配。
   *
   * 档位决定挂载哪些工具行与模型看到的形态，声明在 `@chatdsh/core-contracts` 的
   * `tool-tiers` 里。记录上不存具体行列表：档位演进时既有助手自动跟随。
   */
  readonly tier?: 'chat' | 'work' | 'full';
  /** 在档位之上额外追加的工具行 id；空表示只挂档位自带的那些。 */
  readonly tools: readonly string[];
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 最后修改时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 助手记录 schema。 */
export const assistantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  order: z.number().int(),
  instructions: z.string(),
  tier: z.enum(['chat', 'work', 'full']).optional(),
  tools: z.array(z.string()),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/** 存储域声明。域名同时是后端单元名，校验规则只允许小写字母、数字与下划线。 */
export const ASSISTANTS_DOMAIN = defineDomain({
  name: 'assistants_store',
  version: 1,
  tables: {
    assistants: domainTable<'assistant', AssistantRecord>(assistantSchema),
  },
});
