/**
 * 引用对象：种类、插入位置、失效标记与移除。
 *
 * 引用是输入区里的独立对象：文本里留下一个标记，对象本身带着稳定标识、种类与插入位置。删
 * 除落在标记范围内时整条对象一起删除；插入或删除其他文本时标记范围随之平移，所以移动光标
 * 与撤销之后对象边界仍然对得上。
 *
 * 失效由宿主给出的可用状态驱动：对象不在可用清单里就标记为失效，界面要求重新选择或移除，
 * 不静默删除。草稿只持久化草稿契约登记的五个种类；记忆条目的名称属于记忆查询内容，因此
 * 记忆引用不进入草稿，草稿恢复时明确报告被丢弃的条目。
 * @module @chatdsh/client-conversation/references/references
 */

import { REFERENCE_KINDS, type ReferenceKind as DraftReferenceKind } from '@chatdsh/core-contracts';

/** 引用对象的种类：草稿契约的五个种类加上记忆条目。 */
export const REFERENCE_OBJECT_KINDS = ['file', 'skill', 'subagent', 'session', 'command', 'memory'] as const;

/** 引用对象种类取值。 */
export type ReferenceObjectKind = (typeof REFERENCE_OBJECT_KINDS)[number];

/** 引用对象种类的展示文字。 */
export const REFERENCE_KIND_TEXT: Readonly<Record<ReferenceObjectKind, string>> = {
  file: '文件',
  skill: '技能',
  subagent: '子代理',
  session: '会话',
  command: '命令',
  memory: '记忆条目',
};

/** 引用失效的原因。 */
export const REFERENCE_INVALID_REASONS = ['deleted', 'forbidden', 'unreachable', 'stale'] as const;

/** 引用失效原因取值。 */
export type ReferenceInvalidReason = (typeof REFERENCE_INVALID_REASONS)[number];

/** 引用失效原因的展示文字。 */
export const REFERENCE_INVALID_TEXT: Readonly<Record<ReferenceInvalidReason, string>> = {
  deleted: '对象已删除',
  forbidden: '没有访问权限',
  unreachable: '源设备不可达',
  stale: '对象已变化',
};

/** 输入区里的一条引用对象。 */
export interface ReferenceObject {
  /** 稳定标识，同一对象在同一输入里只出现一次。 */
  readonly id: string;
  readonly kind: ReferenceObjectKind;
  /** 插入时展示的名称。 */
  readonly label: string;
  /** 对象来源：本机执行或远程执行。 */
  readonly origin: 'local' | 'remote';
  /** 标记在文本里的起点。 */
  readonly spanStart: number;
  /** 标记在文本里的终点（不含）。 */
  readonly spanEnd: number;
  /** 是否仍然可用。 */
  readonly available: boolean;
  /** 失效原因；可用时缺省。 */
  readonly invalidReason?: ReferenceInvalidReason;
}

/** 可引用的目录条目。 */
export interface ReferenceCandidate {
  readonly id: string;
  readonly kind: ReferenceObjectKind;
  readonly label: string;
  readonly description?: string;
  /** 分组名称，供触发面板分组显示。 */
  readonly group: string;
  readonly origin: 'local' | 'remote';
  /** 不可用原因；可用时缺省。 */
  readonly unavailableReason?: string;
}

/** 引用标记的文本形式。 */
export function referenceToken(label: string): string {
  if (label.trim() === '') throw new Error('引用名称不能为空');
  return `@${label}`;
}

/**
 * 判断草稿契约是否接受某个引用种类。
 * @param kind - 引用对象种类。
 * @returns 可以持久化时为真。
 */
export function isPersistableKind(kind: ReferenceObjectKind): kind is DraftReferenceKind {
  return (REFERENCE_KINDS as readonly string[]).includes(kind);
}

/** 草稿里的一条引用。 */
export interface PersistedReference {
  readonly kind: DraftReferenceKind;
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

/** 草稿持久化的结论。 */
export interface PersistReferencesResult {
  readonly persisted: readonly PersistedReference[];
  /** 没有进入草稿的条目与原因。 */
  readonly dropped: readonly { readonly id: string; readonly kind: ReferenceObjectKind; readonly reason: string }[];
}

/**
 * 把引用对象收敛成草稿允许的字段。
 * @param references - 输入区里的引用对象。
 * @returns 进入草稿的条目与被丢弃的条目。
 */
export function toDraftReferences(references: readonly ReferenceObject[]): PersistReferencesResult {
  const persisted: PersistedReference[] = [];
  const dropped: { id: string; kind: ReferenceObjectKind; reason: string }[] = [];
  for (const reference of references) {
    if (!isPersistableKind(reference.kind)) {
      dropped.push({ id: reference.id, kind: reference.kind, reason: 'memory-content-not-persisted' });
      continue;
    }
    persisted.push({
      kind: reference.kind,
      id: reference.id,
      label: reference.label,
      available: reference.available,
    });
  }
  return { persisted, dropped };
}

/**
 * 在文本里按顺序重新定位引用标记。
 *
 * 草稿只保存文本与引用标识，恢复时按标记出现顺序把范围算回来；找不到标记的条目视为失效并
 * 给出原因，交给用户处理。
 * @param text - 输入区文本。
 * @param persisted - 草稿里的引用条目。
 * @returns 引用对象；标记缺失的条目带失效原因。
 */
export function restoreReferences(text: string, persisted: readonly PersistedReference[]): ReferenceObject[] {
  const restored: ReferenceObject[] = [];
  let cursor = 0;
  for (const entry of persisted) {
    const token = referenceToken(entry.label);
    const index = text.indexOf(token, cursor);
    if (index < 0) {
      restored.push({
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        origin: 'local',
        spanStart: -1,
        spanEnd: -1,
        available: false,
        invalidReason: 'stale',
      });
      continue;
    }
    restored.push({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      origin: 'local',
      spanStart: index,
      spanEnd: index + token.length,
      available: entry.available,
    });
    cursor = index + token.length;
  }
  return restored;
}

/**
 * 按宿主给出的可用清单更新引用状态。
 *
 * 清单里没有的条目与宿主明确标记不可用的条目都变成失效，其余恢复为可用。
 * @param references - 当前引用对象。
 * @param availability - 宿主给出的可用清单。
 * @returns 更新后的引用对象与本次失效的条目。
 */
export function validateReferences(
  references: readonly ReferenceObject[],
  availability: readonly { readonly kind: ReferenceObjectKind; readonly id: string; readonly reason?: ReferenceInvalidReason }[]
): { readonly references: readonly ReferenceObject[]; readonly invalidated: readonly ReferenceObject[] } {
  const known = new Map(availability.map((entry) => [`${entry.kind}:${entry.id}`, entry] as const));
  const invalidated: ReferenceObject[] = [];
  const next = references.map((reference) => {
    const entry = known.get(`${reference.kind}:${reference.id}`);
    if (entry === undefined) {
      const updated: ReferenceObject = {
        ...reference,
        available: false,
        invalidReason: 'deleted',
      };
      invalidated.push(updated);
      return updated;
    }
    if (entry.reason !== undefined) {
      const updated: ReferenceObject = {
        ...reference,
        available: false,
        invalidReason: entry.reason,
      };
      invalidated.push(updated);
      return updated;
    }
    return { ...reference, available: true, invalidReason: undefined };
  });
  return { references: next, invalidated };
}

/**
 * 判断一个文本区间是否落在引用标记内。
 * @param reference - 引用对象。
 * @param start - 区间起点。
 * @param end - 区间终点。
 * @returns 相交时为真。
 */
export function intersectsSpan(reference: ReferenceObject, start: number, end: number): boolean {
  if (reference.spanStart < 0 || reference.spanEnd < 0) return false;
  return start < reference.spanEnd && end > reference.spanStart;
}

/**
 * 按文本变化平移引用标记的范围。
 *
 * 变化起点之前的对象整体后移；变化区间覆盖对象时该对象由调用方删除。
 * @param references - 当前引用对象。
 * @param changeStart - 变化起点。
 * @param changeEnd - 变化终点（不含）。
 * @param insertedLength - 插入的字符数。
 * @returns 平移后的引用对象。
 */
export function shiftSpans(
  references: readonly ReferenceObject[],
  changeStart: number,
  changeEnd: number,
  insertedLength: number
): ReferenceObject[] {
  const removed = changeEnd - changeStart;
  const delta = insertedLength - removed;
  return references.map((reference) => {
    if (reference.spanStart < 0 || reference.spanEnd < 0) return reference;
    if (reference.spanEnd <= changeStart) return reference;
    if (reference.spanStart >= changeEnd) {
      return {
        ...reference,
        spanStart: reference.spanStart + delta,
        spanEnd: reference.spanEnd + delta,
      };
    }
    throw new Error('引用对象与修改区间重叠，调用方必须先移除该对象');
  });
}

/**
 * 生成引用对象的展示说明。
 * @param reference - 引用对象。
 * @returns 可用时给出种类，失效时给出种类与原因。
 */
export function describeReference(reference: ReferenceObject): string {
  const kind = REFERENCE_KIND_TEXT[reference.kind];
  if (reference.available) return kind;
  const reason = reference.invalidReason === undefined ? '对象不可用' : REFERENCE_INVALID_TEXT[reference.invalidReason];
  return `${kind}失效：${reason}`;
}
