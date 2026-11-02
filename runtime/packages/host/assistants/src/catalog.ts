/**
 * 助手可以引用的工具行目录与字段校验。
 *
 * 工具行目录由 `@chatdsh/core-contracts` 的档位声明与适配层登记的上游行 id 合成：档位声明
 * 决定每个档位默认挂什么，额外的行只能从这份合并目录里挑，因此记录上不会出现无法装配的
 * 行 id。平台差异在这里收口：Windows 只挂 PowerShell，其余平台只挂 bash。
 * @module @chatdsh/host-assistants/catalog
 */

import { ChatdshError, CHATDSH_TOOL_TIERS, type ChatdshToolTierId } from '@chatdsh/core-contracts';
import { UPSTREAM_TOOL_ROWS } from '@chatdsh/adapter/upstream';

/** 助手名称的字符上限。 */
export const ASSISTANT_NAME_LIMIT = 80;

/** 助手指令的字符上限。 */
export const ASSISTANT_INSTRUCTIONS_LIMIT = 32_000;

/** 助手数量上限。达到上限后拒绝新建，不删除任何既有助手。 */
export const ASSISTANT_LIMIT = 128;

/** 助手说明的字符上限。 */
export const ASSISTANT_DESCRIPTION_LIMIT = 512;

/** 排序值允许的范围。 */
export const ASSISTANT_ORDER_RANGE = { min: -1_000_000, max: 1_000_000 } as const;

/**
 * 当前平台上应当挂载的下游工具行。
 *
 * 命令执行的两行按平台二选一：Windows 上挂 PowerShell，其余平台挂 bash。
 * @param rows - 候选行 id。
 * @returns 适用于当前平台的行 id。
 */
export function platformRows(rows: readonly string[]): readonly string[] {
  const hidden = process.platform === 'win32' ? 'tool-bash' : 'tool-pwsh';
  return rows.filter((row) => row !== hidden);
}

/**
 * 由行 id 取包名：自建行加 `@chatdsh/` 前缀，上游行查登记表。
 * @param row - 行 id。
 * @returns 包名。
 */
export function packageOfRow(row: string): string {
  if (row.startsWith('chatdsh-')) return `@chatdsh/${row.slice('chatdsh-'.length)}`;
  const upstream = UPSTREAM_TOOL_ROWS[row as keyof typeof UPSTREAM_TOOL_ROWS];
  if (upstream === undefined) throw new Error(`未登记的工具行：${row}`);
  return upstream;
}

/**
 * 合并后的可引用工具行目录：三档声明里出现过的行，按平台过滤，按行 id 排序。
 * @returns 可引用的行 id。
 */
export function selectableToolRows(): string[] {
  const rows = new Set<string>();
  for (const tier of CHATDSH_TOOL_TIERS) {
    for (const row of [...tier.upstreamRows, ...tier.chatdshRows]) rows.add(row);
  }
  return [...platformRows([...rows])].sort((left, right) => left.localeCompare(right));
}

/**
 * 校验工具档位标识。
 * @param tier - 调用方给出的档位；省略时返回默认档位。
 * @returns 校验后的档位。
 */
export function normalizeTier(tier: ChatdshToolTierId | undefined): ChatdshToolTierId | undefined {
  if (tier === undefined) return undefined;
  if (!CHATDSH_TOOL_TIERS.some((candidate) => candidate.id === tier)) {
    throw new ChatdshError('request-invalid', '工具档位不在允许的取值里', { tier });
  }
  return tier;
}

/**
 * 校验额外工具行引用，并去掉重复项。
 * @param tools - 调用方给出的行 id。
 * @returns 去重后的行 id，保留书写顺序。
 */
export function normalizeTools(tools: readonly string[] | undefined): string[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw new ChatdshError('request-invalid', '附加工具必须是行 id 的数组');
  const catalog = new Set(selectableToolRows());
  const out: string[] = [];
  for (const row of tools) {
    if (typeof row !== 'string' || row.trim() === '') {
      throw new ChatdshError('request-invalid', '附加工具的行 id 不能为空');
    }
    if (!catalog.has(row)) {
      throw new ChatdshError('request-invalid', '附加工具不在可装配目录里', { tool: row });
    }
    if (!out.includes(row)) out.push(row);
  }
  return out;
}

/**
 * 校验技能引用：每个标识都要在技能目录里。
 * @param skills - 调用方给出的技能标识。
 * @param available - 技能目录里的标识集合。
 * @returns 去重后的技能标识，保留书写顺序。
 */
export function normalizeSkills(skills: readonly string[] | undefined, available: ReadonlySet<string>): string[] | undefined {
  if (skills === undefined) return undefined;
  if (!Array.isArray(skills)) throw new ChatdshError('request-invalid', '技能引用必须是技能标识的数组');
  const out: string[] = [];
  for (const id of skills) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ChatdshError('request-invalid', '技能标识不能为空');
    }
    if (!available.has(id)) {
      throw new ChatdshError('request-invalid', '技能不在技能目录里', { skill: id });
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 校验助手名称：去空白后 1 到 80 个字符。
 * @param name - 调用方给出的名称。
 * @returns 去空白后的名称。
 */
export function normalizeName(name: string): string {
  if (typeof name !== 'string') throw new ChatdshError('request-invalid', '助手名称必须是字符串');
  const trimmed = name.trim();
  if (trimmed === '') throw new ChatdshError('request-invalid', '助手名称不能为空');
  if (trimmed.length > ASSISTANT_NAME_LIMIT) {
    throw new ChatdshError('request-invalid', '助手名称超过长度上限', { limit: ASSISTANT_NAME_LIMIT });
  }
  return trimmed;
}

/**
 * 校验助手说明。
 * @param description - 调用方给出的说明。
 * @returns 说明原文。
 */
export function normalizeDescription(description: string): string {
  if (typeof description !== 'string') throw new ChatdshError('request-invalid', '助手说明必须是字符串');
  if (description.length > ASSISTANT_DESCRIPTION_LIMIT) {
    throw new ChatdshError('request-invalid', '助手说明超过长度上限', { limit: ASSISTANT_DESCRIPTION_LIMIT });
  }
  return description;
}

/**
 * 校验助手指令。
 * @param instructions - 调用方给出的指令。
 * @returns 指令原文。
 */
export function normalizeInstructions(instructions: string): string {
  if (typeof instructions !== 'string') throw new ChatdshError('request-invalid', '助手指令必须是字符串');
  if (instructions.length > ASSISTANT_INSTRUCTIONS_LIMIT) {
    throw new ChatdshError('request-invalid', '助手指令超过长度上限', { limit: ASSISTANT_INSTRUCTIONS_LIMIT });
  }
  return instructions;
}

/**
 * 校验排序值。
 * @param order - 调用方给出的排序值。
 * @returns 校验后的排序值。
 */
export function normalizeOrder(order: number): number {
  if (!Number.isInteger(order) || order < ASSISTANT_ORDER_RANGE.min || order > ASSISTANT_ORDER_RANGE.max) {
    throw new ChatdshError('request-invalid', '排序值必须是整数且在允许范围内', { ...ASSISTANT_ORDER_RANGE });
  }
  return order;
}
