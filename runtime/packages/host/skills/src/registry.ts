/**
 * 技能目录的启用状态。
 *
 * 这一层是纯数据：技能来源由宿主的 `ctx.skills` 扫描得到，这里只维护「哪些启用」。
 * 目录不持久化，进程重启后按扫描结果重新全部启用；需要长期停用的技能由部署配置决定，
 * 这条边界避免把会话状态写进技能提供方自己的存储。
 * @module @chatdsh/host-skills/registry
 */

/** 技能的来源分类。 */
export type SkillSourceKind = 'builtin' | 'workspace' | 'user';

/** 一条技能。 */
export interface SkillEntry {
  /** 技能标识，取上游的技能名（kebab-case）。 */
  readonly id: string;
  /** 展示名。 */
  readonly name: string;
  /** 一句话说明。 */
  readonly description: string;
  /** 来源。 */
  readonly source: SkillSourceKind;
}

/** 目录状态。 */
export interface SkillCatalogState {
  /** 技能总数。 */
  readonly total: number;
  /** 已启用数量。 */
  readonly enabled: number;
}

/** 目录。 */
export interface SkillCatalog {
  /** 全部技能，按输入顺序。 */
  list(): SkillEntry[];
  /** 已启用的技能。 */
  enabled(): SkillEntry[];
  /** 启用一个技能。 */
  enable(id: string): void;
  /** 停用一个技能。 */
  disable(id: string): void;
  /** 设置启用状态并返回设置后的结果。 */
  toggle(id: string, enabled: boolean): { id: string; enabled: boolean };
  /** 数量统计。 */
  catalog(): SkillCatalogState;
}

/**
 * 建立一个技能目录。
 * @param entries - 宿主扫描到的技能。
 * @returns 目录。
 * @throws 标识重复时抛出。
 */
export function createSkillCatalog(entries: readonly SkillEntry[]): SkillCatalog {
  const slots = new Map<string, { entry: SkillEntry; enabled: boolean }>();
  for (const entry of entries) {
    if (slots.has(entry.id)) throw new Error(`技能标识重复：${entry.id}`);
    slots.set(entry.id, { entry, enabled: true });
  }

  function slotOf(id: string): { entry: SkillEntry; enabled: boolean } {
    const slot = slots.get(id);
    if (slot === undefined) throw new Error(`未知技能：${id}`);
    return slot;
  }

  return {
    list(): SkillEntry[] {
      return [...slots.values()].map((slot) => slot.entry);
    },

    enabled(): SkillEntry[] {
      return [...slots.values()].filter((slot) => slot.enabled).map((slot) => slot.entry);
    },

    enable(id: string): void {
      slotOf(id).enabled = true;
    },

    disable(id: string): void {
      slotOf(id).enabled = false;
    },

    toggle(id: string, enabled: boolean): { id: string; enabled: boolean } {
      slotOf(id).enabled = enabled;
      return { id, enabled };
    },

    catalog(): SkillCatalogState {
      const total = slots.size;
      const enabled = [...slots.values()].filter((slot) => slot.enabled).length;
      return { total, enabled };
    },
  };
}
