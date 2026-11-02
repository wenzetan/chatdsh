/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板全部在浏览器侧，宿主侧的空实现让这个包出现在宿主名册里；浏览器产物由
 * `dsh.client` 声明与 `./client` 子路径提供。来源叫法与统计文案是纯函数，与浏览器侧共用
 * 同一份取值，便于单独验证。
 * @module @chatdsh/client-skills
 */

/** 设置页区段席位名，与浏览器侧共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 技能的来源分类，与宿主技能目录一致。 */
export type SkillSourceKind = 'builtin' | 'workspace' | 'user';

/** 全部来源，按界面上的分组顺序排列。 */
export const SKILL_SOURCES: readonly SkillSourceKind[] = ['builtin', 'workspace', 'user'];

/** 来源在界面上的叫法。 */
export const SOURCE_LABEL: Readonly<Record<SkillSourceKind, string>> = {
  builtin: '内置',
  workspace: '工作区',
  user: '用户目录',
};

/** 每个来源落在哪个目录，写进分组标题的说明。 */
export const SOURCE_NOTE: Readonly<Record<SkillSourceKind, string>> = {
  builtin: '随运行时安装的技能目录，停用后不再出现在技能目录里。',
  workspace: '来自项目目录的技能，按项目根发现。',
  user: '来自用户与自定义目录的技能，由技能提供方扫描得到。',
};

/** 检索关键字的长度上限，与宿主校验一致。 */
export const SKILL_QUERY_LIMIT = 120;

/** 技能数量统计的形状。 */
export interface SkillCatalogState {
  /** 技能总数。 */
  readonly total: number;
  /** 已启用数量。 */
  readonly enabled: number;
}

/**
 * 面板上的一行统计。
 * @param state - 数量统计。
 * @returns 面向用户的一句话。
 */
export function formatSkillSummary(state: SkillCatalogState): string {
  if (state.total === 0) return '还没有技能';
  return `${String(state.total)} 个技能，已启用 ${String(state.enabled)} 个`;
}

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
