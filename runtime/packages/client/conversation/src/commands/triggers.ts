/**
 * 类型触发的识别与条目过滤。
 *
 * 输入区里的 `/` 触发命令面板，`@` 触发引用面板。触发字符必须落在一个新词的开头（文本起
 * 点、空白之后或标点之后），从触发字符到光标之间不能有空白，因此正文中间的斜杠与邮箱地址
 * 不会误触发。面板里的条目按分组显示，可以按名称、说明与分组过滤，并给出不可用原因。
 * @module @chatdsh/client-conversation/commands/triggers
 */

import type { ReferenceCandidate, ReferenceObjectKind } from '../references/references.ts';

/** 触发种类。 */
export const TRIGGER_KINDS = ['command', 'reference'] as const;

/** 触发种类取值。 */
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** 一次触发的匹配结果。 */
export interface TriggerMatch {
  readonly kind: TriggerKind;
  /** 触发字符在文本里的下标。 */
  readonly start: number;
  /** 光标位置，也就是查询文本的终点。 */
  readonly end: number;
  /** 触发字符到光标之间的查询文本。 */
  readonly query: string;
}

/**
 * 判断某个位置是否允许开始一个新词。
 * @param text - 完整文本。
 * @param index - 触发字符下标。
 * @returns 允许时为真。
 */
export function triggerStartsAt(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1]!;
  return before === ' ' || before === '\n' || before === '\t' || before === '，' || before === '。' || before === '；';
}

/**
 * 识别光标处的类型触发。
 * @param text - 输入区文本。
 * @param caret - 光标位置。
 * @returns 触发匹配；没有触发时返回 `undefined`。
 */
export function detectTrigger(text: string, caret: number): TriggerMatch | undefined {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) throw new Error('光标位置超出文本范围');
  let index = caret - 1;
  while (index >= 0) {
    const character = text[index]!;
    if (character === ' ' || character === '\n' || character === '\t') return undefined;
    if (character === '/' || character === '@') {
      if (!triggerStartsAt(text, index)) return undefined;
      return {
        kind: character === '/' ? 'command' : 'reference',
        start: index,
        end: caret,
        query: text.slice(index + 1, caret),
      };
    }
    index -= 1;
  }
  return undefined;
}

/** 触发面板里的一条条目。 */
export interface TriggerItem {
  readonly id: string;
  readonly kind: ReferenceObjectKind;
  readonly label: string;
  readonly description?: string;
  readonly group: string;
  readonly origin: 'local' | 'remote';
  /** 不可用原因；可用时缺省。 */
  readonly unavailableReason?: string;
}

/**
 * 把引用目录条目转成触发条目。
 * @param candidates - 目录条目。
 * @returns 触发条目。
 */
export function toTriggerItems(candidates: readonly ReferenceCandidate[]): TriggerItem[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    kind: candidate.kind,
    label: candidate.label,
    group: candidate.group,
    origin: candidate.origin,
    ...(candidate.description === undefined ? {} : { description: candidate.description }),
    ...(candidate.unavailableReason === undefined ? {} : { unavailableReason: candidate.unavailableReason }),
  }));
}

/**
 * 按查询文本过滤触发条目。
 *
 * 匹配名称、说明与分组，大小写不敏感；空查询返回全部条目并保持原顺序。
 * @param items - 触发条目。
 * @param query - 查询文本。
 * @returns 匹配的条目。
 */
export function filterTriggerItems(items: readonly TriggerItem[], query: string): TriggerItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) => {
    const haystack = [item.label, item.description ?? '', item.group].join('\n').toLowerCase();
    return haystack.includes(needle);
  });
}

/** 一组触发条目。 */
export interface TriggerGroup {
  readonly group: string;
  readonly items: readonly TriggerItem[];
}

/**
 * 按分组聚合触发条目，分组顺序按首次出现的位置。
 * @param items - 触发条目。
 * @returns 分组后的条目。
 */
export function groupTriggerItems(items: readonly TriggerItem[]): TriggerGroup[] {
  const groups = new Map<string, TriggerItem[]>();
  for (const item of items) {
    const existing = groups.get(item.group);
    if (existing === undefined) groups.set(item.group, [item]);
    else existing.push(item);
  }
  return [...groups.entries()].map(([group, grouped]) => ({ group, items: grouped }));
}

/**
 * 计算选中触发条目之后要写回的文本与光标位置。
 *
 * 触发字符到光标之间的查询文本被替换成引用标记，光标落在标记之后。
 * @param text - 当前文本。
 * @param match - 触发匹配。
 * @param token - 要写入的引用标记。
 * @returns 新文本与光标位置。
 */
export function applyTriggerSelection(
  text: string,
  match: TriggerMatch,
  token: string
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, match.start);
  const after = text.slice(match.end);
  const next = `${before}${token}${after}`;
  return { text: next, caret: before.length + token.length };
}
