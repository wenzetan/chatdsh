/**
 * 助手面板的纯逻辑：字段标识、草稿校验、工具目录推导、装配行说明与失败文案。
 *
 * 这一层不接触网络与 React。工具目录从装配清单里的三档预设推导：档位预设就是本机真实装配
 * 的工具行清单，行上的条件说明这条行在哪些平台挂载。助手的附加工具只能从这里挑，宿主在保存
 * 时按同一份目录校验。
 * @module @chatdsh/client-assistants/state
 */

import {
  ASSISTANT_DESCRIPTION_LIMIT,
  ASSISTANT_INSTRUCTIONS_LIMIT,
  ASSISTANT_NAME_LIMIT,
  ASSISTANT_ORDER_RANGE,
  ASSISTANT_TIERS,
  COMMON_ROWS,
  DEFAULT_ASSISTANT_ORDER,
  TIER_DESCRIPTION,
  TIER_LABEL,
  TIER_PRESET_ID,
  type AssistantTier,
} from '../index.ts';
import type { AssistantInput, AssistantPatch, AssistantRecord, PresetGroup, PresetRow, SkillEntry } from './types.ts';

/** 表单字段的标识，错误摘要按这些标识跳转。 */
export const FIELD_IDS = {
  name: 'wp11-assistant-name',
  description: 'wp11-assistant-description',
  instructions: 'wp11-assistant-instructions',
  tier: 'wp11-assistant-tier',
  order: 'wp11-assistant-order',
  tools: 'wp11-assistant-tools',
  skills: 'wp11-assistant-skills',
} as const;

/** 宿主返回的错误码，界面按码给出对应说明。 */
export const ASSISTANT_ERROR_CODES = {
  /** 写入携带的版本落后于服务器。 */
  conflict: 'revision-conflict',
  /** 字段或目录校验不通过。 */
  invalid: 'request-invalid',
  /** 记录不存在。 */
  notFound: 'object-not-found',
} as const;

/** 客户端自己的失败码。 */
export const CLIENT_ERROR_CODES = {
  /** 控制平面不可达。 */
  offline: 'client/offline',
  /** 当前组合没有提供该命名空间或方法。 */
  unavailable: 'client/unavailable',
} as const;

/** 技能来源在引用面板上的叫法。 */
export const SKILL_SOURCE_LABEL: Readonly<Record<'builtin' | 'workspace' | 'user', string>> = {
  builtin: '内置技能',
  workspace: '工作区技能',
  user: '用户目录技能',
};

/** 表单草稿：全部字段以字符串保存，提交时再折算成写入输入。 */
export interface AssistantDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tier: AssistantTier;
  /** 附加工具行：不含档位自带的行。 */
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  /** 排序值按字符串保存，提交前解析成整数。 */
  readonly orderText: string;
}

/** 一条字段校验结果。 */
export interface FieldError {
  readonly fieldId: string;
  readonly message: string;
}

/** 工具目录里的一行。 */export interface ToolRowView {
  /** 行标识，与助手记录里的 `tools` 取值一致。 */
  readonly rowId: string;
  /** 装配用的包名。 */
  readonly moduleName: string;
  /** 哪些档位的装配结果里出现这一行。 */
  readonly tiers: readonly AssistantTier[];
  /** 当前部署里的启用状态：`conditional` 表示条件写在预设里、尚未评估。 */
  readonly enabled: boolean | 'conditional';
  /** 行上的平台条件原文。 */
  readonly condition?: string;
  /** 行根的运行状态，装配清单来自活动挂载时才有。 */
  readonly phase?: string | null;
}

/** 空草稿：默认工作档、默认排序值、没有附加工具与技能。 */
export const EMPTY_DRAFT: AssistantDraft = {
  name: '',
  description: '',
  instructions: '',
  tier: 'work',
  tools: [],
  skills: [],
  orderText: String(DEFAULT_ASSISTANT_ORDER),
};

/** 取档位；记录上缺省按工作档。 */
export function tierOf(record: AssistantRecord): AssistantTier {
  return record.tier ?? 'work';
}

/** 界面文案：档位名称。 */
export function tierLabelOf(tier: AssistantTier): string {
  return TIER_LABEL[tier];
}

/** 界面文案：档位的工具范围。 */
export function tierDescriptionOf(tier: AssistantTier): string {
  return TIER_DESCRIPTION[tier];
}

/** 界面文案：毫秒时间戳折成当地时间的日期与时分。 */
export function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 界面文案：装配行的运行状态。 */
export function describePhase(phase: string | null | undefined): string {
  switch (phase) {
    case 'active': return '已运行';
    case 'pending': return '等待装载';
    case 'loading': return '正在装载';
    case 'failed': return '装载失败';
    case 'unloading': return '正在卸载';
    default: return '未运行';
  }
}

/** 界面文案：启用状态。 */
export function describeEnablement(enabled: boolean | 'conditional'): string {
  if (enabled === 'conditional') return '条件装配';
  return enabled ? '参与装配' : '当前平台不装配';
}

/** 由记录生成草稿。 */
export function draftOfRecord(record: AssistantRecord): AssistantDraft {
  return {
    name: record.name,
    description: record.description,
    instructions: record.instructions,
    tier: tierOf(record),
    tools: [...record.tools],
    skills: [...record.skills],
    orderText: String(record.order),
  };
}

/** 取某个字段的校验结果。 */
export function errorFor(errors: readonly FieldError[], fieldId: string): string | undefined {
  return errors.find((entry) => entry.fieldId === fieldId)?.message;
}

/**
 * 把排序值原文解析成整数。
 * @param text - 表单里的排序值。
 * @returns 整数；写法不合法时返回 undefined。
 */
export function parseOrder(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return undefined;
  if (value < ASSISTANT_ORDER_RANGE.min || value > ASSISTANT_ORDER_RANGE.max) return undefined;
  return value;
}

/**
 * 校验一份草稿。
 *
 * 名称查空、长度与重名；说明与指令查长度；排序值查整数与范围；技能引用查目录（目录不可用时
 * 跳过这一项，由宿主最终校验）。附加工具只能从工具目录里选，选择界面已经过滤。
 * @param draft - 表单草稿。
 * @param others - 除本次提交这一条之外的现有记录。
 * @param skills - 技能目录；不可用时传 undefined。
 * @returns 字段错误列表，按表单顺序排列。
 */
export function validateDraft(draft: AssistantDraft, others: readonly AssistantRecord[], skills: readonly SkillEntry[] | undefined): FieldError[] {
  const errors: FieldError[] = [];
  const name = draft.name.trim();
  if (name === '') {
    errors.push({ fieldId: FIELD_IDS.name, message: '助手名称不能为空' });
  } else if (name.length > ASSISTANT_NAME_LIMIT) {
    errors.push({ fieldId: FIELD_IDS.name, message: `助手名称最多 ${String(ASSISTANT_NAME_LIMIT)} 个字符` });
  } else {
    const wanted = name.toLocaleLowerCase();
    const duplicated = others.find((record) => record.name.trim().toLocaleLowerCase() === wanted);
    if (duplicated !== undefined) {
      errors.push({ fieldId: FIELD_IDS.name, message: `助手名称 ${name} 已被占用` });
    }
  }

  if (draft.description.length > ASSISTANT_DESCRIPTION_LIMIT) {
    errors.push({ fieldId: FIELD_IDS.description, message: `助手说明最多 ${String(ASSISTANT_DESCRIPTION_LIMIT)} 个字符` });
  }
  if (draft.instructions.length > ASSISTANT_INSTRUCTIONS_LIMIT) {
    errors.push({ fieldId: FIELD_IDS.instructions, message: `助手指令最多 ${String(ASSISTANT_INSTRUCTIONS_LIMIT)} 个字符` });
  }
  if (parseOrder(draft.orderText) === undefined) {
    errors.push({
      fieldId: FIELD_IDS.order,
      message: `排序值必须是 ${String(ASSISTANT_ORDER_RANGE.min)} 到 ${String(ASSISTANT_ORDER_RANGE.max)} 之间的整数`,
    });
  }
  if (skills !== undefined) {
    const known = new Set(skills.map((skill) => skill.id));
    const missing = draft.skills.find((id) => !known.has(id));
    if (missing !== undefined) {
      errors.push({ fieldId: FIELD_IDS.skills, message: `技能 ${missing} 不在技能目录里，请重新选择` });
    }
  }
  return errors;
}

/** 把草稿折成新建输入。 */
export function inputOf(draft: AssistantDraft): AssistantInput {
  const order = parseOrder(draft.orderText);
  if (order === undefined) throw new Error('排序值必须先通过校验');
  return {
    name: draft.name.trim(),
    description: draft.description,
    instructions: draft.instructions,
    tier: draft.tier,
    tools: [...draft.tools],
    skills: [...draft.skills],
    order,
  };
}

/** 把草稿折成更新输入，带上调用方读到的版本。 */
export function patchOf(draft: AssistantDraft, record: AssistantRecord): AssistantPatch {
  return { ...inputOf(draft), revision: record.revision };
}

/**
 * 按宿主返回的说明定位到表单字段。
 * @param message - 宿主返回的失败说明。
 * @returns 字段标识；说明与字段无关时返回 undefined。
 */
export function fieldOfHostMessage(message: string): string | undefined {
  if (message.includes('名称') || message.includes('标识')) return FIELD_IDS.name;
  if (message.includes('说明')) return FIELD_IDS.description;
  if (message.includes('指令')) return FIELD_IDS.instructions;
  if (message.includes('排序')) return FIELD_IDS.order;
  if (message.includes('档位')) return FIELD_IDS.tier;
  return undefined;
}

/** 界面文案：把失败对象折成一句说明。 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}

/** 取失败对象上的错误码。 */
export function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * 从装配清单推导工具目录。
 *
 * 行来自三档预设的装配结果：同一行可以出现在多个档位里，档位自带的那些在这里合并成一条。
 * 人格、指令与时间上下文三行不属于工具，跳过；没有行标识的行同样跳过。
 * @param presets - 装配清单；不可用时传 undefined。
 * @returns 按行标识排序的工具目录。
 */
export function toolCatalogOf(presets: readonly PresetGroup[] | undefined): ToolRowView[] {
  if (presets === undefined) return [];
  const common = new Set(COMMON_ROWS);
  const rows = new Map<string, { moduleName: string; tiers: Set<AssistantTier>; enabled: boolean | 'conditional'; condition?: string; phase?: string | null }>();
  for (const tier of ASSISTANT_TIERS) {
    const group = presets.find((candidate) => candidate.id === TIER_PRESET_ID[tier]);
    if (group === undefined) continue;
    for (const row of group.rows) {
      if (row.entryId === null || common.has(row.entryId)) continue;
      collectRow(rows, row, tier);
    }
  }
  return [...rows.entries()]
    .map(([rowId, row]) => ({
      rowId,
      moduleName: row.moduleName,
      tiers: ASSISTANT_TIERS.filter((tier) => row.tiers.has(tier)),
      enabled: row.enabled,
      ...(row.condition === undefined ? {} : { condition: row.condition }),
      ...(row.phase === undefined ? {} : { phase: row.phase }),
    }))
    .sort((left, right) => left.rowId.localeCompare(right.rowId));
}

/** 把一行并进目录；同一行出现在多个档位时合并档位并保留条件。 */
function collectRow(
  rows: Map<string, { moduleName: string; tiers: Set<AssistantTier>; enabled: boolean | 'conditional'; condition?: string; phase?: string | null }>,
  row: PresetRow,
  tier: AssistantTier,
): void {
  const rowId = row.entryId;
  if (rowId === null) return;
  const existing = rows.get(rowId);
  if (existing === undefined) {
    rows.set(rowId, {
      moduleName: row.moduleName,
      tiers: new Set([tier]),
      enabled: row.enabled,
      ...(row.condition === undefined ? {} : { condition: row.condition }),
      ...(row.fiberPhase === undefined ? {} : { phase: row.fiberPhase }),
    });
    return;
  }
  existing.tiers.add(tier);
  if (row.condition !== undefined) existing.condition = row.condition;
  if (row.enabled === false) existing.enabled = false;
  if (row.fiberPhase !== undefined) existing.phase = row.fiberPhase;
}

/**
 * 取某个档位自带的工具行。
 * @param catalog - 工具目录。
 * @param tier - 档位。
 * @returns 该档位装配结果里出现的行。
 */
export function inherentRowsOf(catalog: readonly ToolRowView[], tier: AssistantTier): string[] {
  return catalog.filter((row) => row.tiers.includes(tier)).map((row) => row.rowId);
}

/**
 * 取某个预设的装配清单。
 * @param presets - 装配清单；不可用时传 undefined。
 * @param id - 预设标识，助手标识同时是预设标识。
 * @returns 该预设的清单；不在清单里时返回 undefined。
 */
export function presetGroupOf(presets: readonly PresetGroup[] | undefined, id: string): PresetGroup | undefined {
  return presets?.find((group) => group.id === id);
}
