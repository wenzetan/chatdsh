/**
 * 技能目录的启用状态。
 *
 * 这一层是纯数据：技能来源由宿主的 `ctx.skills` 扫描得到，这里只维护「哪些启用」。
 * 目录本身不落盘，启用与停用的决定由服务写成覆盖记录，重启后重新扫描再叠加覆盖，
 * 因此重启不会把已停用的技能重新打开。
 * @module @chatdsh/host-skills/registry
 */

import { ChatdshError } from '@chatdsh/core-contracts';

/** 技能的来源分类。 */
export const SKILL_SOURCES = ['builtin', 'workspace', 'user'] as const;

/** 技能的来源分类。 */
export type SkillSourceKind = (typeof SKILL_SOURCES)[number];

/** 技能目录的条数上限。 */
export const SKILL_LIMIT = 200;

/** 检索关键字的长度上限。 */
export const SKILL_QUERY_LIMIT = 120;

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
  /** 当前是否启用。 */
  readonly enabled: boolean;
}

/** 扫描得到的技能，不含启用状态。 */
export type SkillSeed = Omit<SkillEntry, 'enabled'>;

/** 一条显式的启用决定。 */
export interface SkillOverride {
  readonly id: string;
  readonly enabled: boolean;
}

/** 目录状态。 */
export interface SkillCatalogState {
  /** 技能总数。 */
  readonly total: number;
  /** 已启用数量。 */
  readonly enabled: number;
}

/** 检索请求。 */
export interface SkillSearchRequest {
  /** 关键字，按标识、名称与说明做不区分大小写的包含匹配。 */
  readonly text?: string;
  /** 只看某一个来源。 */
  readonly source?: SkillSourceKind;
}

/** 目录。 */
export interface SkillCatalog {
  /** 全部技能，按输入顺序，带当前启用状态。 */
  list(): SkillEntry[];
  /** 已启用的技能。 */
  enabled(): SkillEntry[];
  /** 启用一个技能。 */
  enable(id: string): void;
  /** 停用一个技能。 */
  disable(id: string): void;
  /** 设置启用状态并返回设置后的结果。 */
  toggle(id: string, enabled: boolean): { id: string; enabled: boolean };
  /** 只设置启用状态，不做参数校验的返回。 */
  setEnabled(id: string, enabled: boolean): void;
  /** 按关键字与来源检索，结果带启用状态。 */
  search(request: SkillSearchRequest): SkillEntry[];
  /** 标识是否在目录里。 */
  has(id: string): boolean;
  /** 叠加一批显式启用决定，未知标识被忽略。 */
  applyOverrides(overrides: readonly SkillOverride[]): void;
  /** 全部显式启用决定。 */
  overrides(): SkillOverride[];
  /** 数量统计。 */
  catalog(): SkillCatalogState;
}

/**
 * 建立一个技能目录。
 * @param seeds - 宿主扫描到的技能。
 * @returns 目录。
 * @throws {@link ChatdshError} 标识重复或条数超过上限时抛出。
 */
export function createSkillCatalog(seeds: readonly SkillSeed[]): SkillCatalog {
  if (seeds.length > SKILL_LIMIT) {
    throw new ChatdshError('request-invalid', `技能目录最多 ${SKILL_LIMIT} 条，实际扫描到 ${seeds.length} 条`);
  }
  const slots = new Map<string, { seed: SkillSeed; enabled: boolean }>();
  for (const seed of seeds) {
    if (slots.has(seed.id)) throw new ChatdshError('request-invalid', `技能标识重复：${seed.id}`);
    slots.set(seed.id, { seed, enabled: true });
  }
  const explicit = new Map<string, boolean>();

  function slotOf(id: string): { seed: SkillSeed; enabled: boolean } {
    const slot = slots.get(id);
    if (slot === undefined) throw new ChatdshError('object-not-found', `未知技能：${id}`);
    return slot;
  }

  return {
    list(): SkillEntry[] {
      return [...slots.values()].map((slot) => ({ ...slot.seed, enabled: slot.enabled }));
    },

    enabled(): SkillEntry[] {
      return [...slots.values()].filter((slot) => slot.enabled).map((slot) => ({ ...slot.seed, enabled: true }));
    },

    enable(id: string): void {
      const slot = slotOf(id);
      slot.enabled = true;
      explicit.set(id, true);
    },

    disable(id: string): void {
      const slot = slotOf(id);
      slot.enabled = false;
      explicit.set(id, false);
    },

    toggle(id: string, enabled: boolean): { id: string; enabled: boolean } {
      const slot = slotOf(id);
      slot.enabled = enabled;
      explicit.set(id, enabled);
      return { id, enabled };
    },

    setEnabled(id: string, enabled: boolean): void {
      const slot = slotOf(id);
      slot.enabled = enabled;
      explicit.set(id, enabled);
    },

    search(request: SkillSearchRequest): SkillEntry[] {
      if (request.source !== undefined && !SKILL_SOURCES.includes(request.source)) {
        throw new ChatdshError('request-invalid', `未知的技能来源：${String(request.source)}`);
      }
      const text = (request.text ?? '').trim().toLowerCase();
      if (text.length > SKILL_QUERY_LIMIT) {
        throw new ChatdshError('request-invalid', `检索关键字最多 ${SKILL_QUERY_LIMIT} 个字符`);
      }
      return [...slots.values()]
        .filter((slot) => request.source === undefined || slot.seed.source === request.source)
        .filter((slot) => text === ''
          || slot.seed.id.toLowerCase().includes(text)
          || slot.seed.name.toLowerCase().includes(text)
          || slot.seed.description.toLowerCase().includes(text))
        .map((slot) => ({ ...slot.seed, enabled: slot.enabled }));
    },

    has(id: string): boolean {
      return slots.has(id);
    },

    applyOverrides(overrides: readonly SkillOverride[]): void {
      for (const override of overrides) {
        const slot = slots.get(override.id);
        if (slot === undefined) continue;
        slot.enabled = override.enabled;
        explicit.set(override.id, override.enabled);
      }
    },

    overrides(): SkillOverride[] {
      return [...explicit].map(([id, enabled]) => ({ id, enabled }));
    },

    catalog(): SkillCatalogState {
      const total = slots.size;
      const enabled = [...slots.values()].filter((slot) => slot.enabled).length;
      return { total, enabled };
    },
  };
}
