/**
 * 技能启用状态的存储形状。
 *
 * 只存「显式启用决定」：一条记录表示某个技能被明确设为启用或停用。扫描出来的技能
 * 默认启用，因此没有记录的技能按默认处理；重启后重新扫描再加盖这些决定，启用状态
 * 就能恢复。技能本身不存在时记录保留，等它重新出现时继续生效。
 * @module @chatdsh/host-skills/domain
 */

import { defineDomain, domainTable } from '@chatdsh/adapter';
import { z } from 'zod';

/** 一条启用决定。 */
export interface SkillOverrideRecord {
  /** 技能标识。 */
  readonly id: string;
  readonly enabled: boolean;
  /** 记录时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 启用决定的 schema。 */
export const skillOverrideSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});

/** 存储域声明。域名只允许小写字母、数字与下划线。 */
export const SKILLS_DOMAIN = defineDomain({
  name: 'skills_store',
  version: 1,
  tables: {
    overrides: domainTable<'override', SkillOverrideRecord>(skillOverrideSchema),
  },
});
