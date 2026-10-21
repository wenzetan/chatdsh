/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板全部在浏览器侧，宿主侧的空实现让这个包出现在宿主名册里。统计文案是纯函数，
 * 与浏览器侧共用，便于单独验证。
 * @module @chatdsh/client-automation
 */

/** 设置页区段席位名，与浏览器侧共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 统计文案需要的最小记录形状。 */
export interface AutomationSummaryInput {
  readonly id: string;
  readonly enabled: boolean;
}

/**
 * 自动化列表的一句话统计。
 * @param records - 自动化记录。
 * @returns 面向用户的一句话。
 */
export function formatAutomationSummary(records: readonly AutomationSummaryInput[]): string {
  if (records.length === 0) return '还没有自动化';
  const enabled = records.filter((record) => record.enabled).length;
  return `${enabled}/${records.length} 个自动化已启用`;
}

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
