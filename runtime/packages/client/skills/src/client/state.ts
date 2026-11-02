/**
 * 技能面板的纯逻辑：字段标识、来源分组、检索请求与失败文案。
 *
 * 分组按内置、工作区、用户目录三类排列，每条技能只落在其中一个来源里。检索关键字的长度上限
 * 由宿主校验，界面把宿主的说明原样显示出来。
 * @module @chatdsh/client-skills/state
 */

import { SKILL_SOURCES, SOURCE_LABEL, SOURCE_NOTE, type SkillSourceKind } from '../index.ts';
import type { AssistantReference, SkillEntry, SkillSearchRequest } from './types.ts';

/** 表单字段的标识。 */
export const FIELD_IDS = {
  search: 'wp11-skill-search',
  source: 'wp11-skill-source',
} as const;

/** 客户端自己的失败码。 */
export const CLIENT_ERROR_CODES = {
  offline: 'client/offline',
  unavailable: 'client/unavailable',
} as const;

/** 一个来源分组。 */
export interface SkillGroup {
  readonly source: SkillSourceKind;
  readonly label: string;
  readonly note: string;
  readonly entries: readonly SkillEntry[];
  readonly enabled: number;
}

/**
 * 按来源把技能分成三组。
 * @param skills - 技能目录。
 * @returns 三个分组，顺序固定，空分组也保留。
 */
export function groupSkills(skills: readonly SkillEntry[]): SkillGroup[] {
  return SKILL_SOURCES.map((source) => {
    const entries = skills.filter((entry) => entry.source === source);
    return {
      source,
      label: SOURCE_LABEL[source],
      note: SOURCE_NOTE[source],
      entries,
      enabled: entries.filter((entry) => entry.enabled).length,
    };
  });
}

/**
 * 把检索表单折成请求。
 * @param text - 关键字原文。
 * @param source - 来源；全部来源为 `all`。
 * @returns 宿主检索请求；全部来源时不带 `source`。
 */
export function requestOf(text: string, source: SkillSourceKind | 'all'): SkillSearchRequest {
  const trimmed = text.trim();
  return {
    ...(trimmed === '' ? {} : { text: trimmed }),
    ...(source === 'all' ? {} : { source }),
  };
}

/** 界面文案：把失败对象折成一句说明。 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}

/**
 * 统计每条技能被哪些助手引用。
 * @param assistants - 助手名单；不可用时传 undefined。
 * @returns 技能标识到助手名称列表的映射；名单不可用时返回 undefined。
 */
export function referencesOf(assistants: readonly AssistantReference[] | undefined): Map<string, string[]> | undefined {
  if (assistants === undefined) return undefined;
  const out = new Map<string, string[]>();
  for (const assistant of assistants) {
    for (const skill of assistant.skills) {
      const names = out.get(skill) ?? [];
      names.push(assistant.name);
      out.set(skill, names);
    }
  }
  return out;
}

/**
 * 判断一个技能是否被选中停用。
 * @param entry - 技能目录里的一条。
 * @returns 目标状态：当前启用则返回 false，当前停用则返回 true。
 */
export function nextEnabledOf(entry: SkillEntry): boolean {
  return !entry.enabled;
}
