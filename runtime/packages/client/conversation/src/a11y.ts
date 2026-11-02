/**
 * 会话界面的无障碍约定：实时播报、焦点管理与键盘覆盖。
 *
 * 读屏的实时播报按完成的语义片段与回合终态进行：流式片段进入缓冲，遇到句末标点、换行或
 * 缓冲上限才播报一次，因此逐 token 到达不会逐 token 打断读屏。播报可以被用户暂停，暂停
 * 期间只累积不播报，恢复后的下一次边界把累积内容一次播报。
 *
 * 焦点管理覆盖三件事：移除列表项后把焦点交给相邻项、模态面板把焦点约束在面板内、面板关闭
 * 后把焦点还给打开它的控件。键盘覆盖给出整屏的按键意图，避免同一个按键被两处处理。
 * @module @chatdsh/client-conversation/a11y
 */

/** 句末与分段标记：出现这些字符说明一个语义片段已经完成。 */
const SEGMENT_ENDINGS = new Set(['。', '！', '？', '；', '\n', '.', '!', '?', ';']);

/** 一条播报。 */
export interface Announcement {
  /** 播报文本。 */
  readonly text: string;
  /** 需要立即处理时为真，对应 `role=alert`。 */
  readonly urgent: boolean;
}

/** 实时播报器的依赖。 */
export interface LiveAnnouncerOptions {
  /** 缓冲上限：达到它时即使没有句末标点也播报一次，避免缓冲无界增长。 */
  readonly segmentChars?: number;
  /** 两次播报之间的最小间隔，单位毫秒。 */
  readonly throttleMs?: number;
  /** 当前时刻的毫秒时间戳。 */
  readonly now: () => number;
}

/** 实时播报器。 */
export class LiveAnnouncer {
  private buffer = '';
  private paused = false;
  private lastAt = Number.NEGATIVE_INFINITY;
  private current = '';
  private readonly segmentChars: number;
  private readonly throttleMs: number;
  private readonly now: () => number;

  /**
   * 建立播报器。
   * @param options - 缓冲上限、节流间隔与时钟。
   */
  constructor(options: LiveAnnouncerOptions) {
    this.segmentChars = options.segmentChars ?? 400;
    this.throttleMs = options.throttleMs ?? 700;
    this.now = options.now;
    if (!Number.isInteger(this.segmentChars) || this.segmentChars < 1) throw new Error('播报缓冲上限必须是正整数');
    if (!Number.isFinite(this.throttleMs) || this.throttleMs < 0) throw new Error('播报节流间隔不能为负');
  }

  /** 是否处于暂停状态。 */
  get isPaused(): boolean {
    return this.paused;
  }

  /** 当前已播报的文本，供断言与面板显示。 */
  get lastAnnounced(): string {
    return this.current;
  }

  /** 未播报的缓冲内容。 */
  get buffered(): string {
    return this.buffer;
  }

  /**
   * 暂停实时播报。暂停期间到达的片段只累积。
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * 恢复实时播报。恢复后不会立刻播报，等下一个语义边界一次播报累积内容。
   */
  resume(): void {
    this.paused = false;
  }

  /**
   * 推送一段流式文本。
   *
   * 未到语义边界时只累积并返回 `undefined`；到达边界且超过节流间隔时返回一条播报。
   * @param text - 本次到达的片段。
   * @returns 需要写入实时区域的内容；不需要播报时为 `undefined`。
   */
  push(text: string): Announcement | undefined {
    if (text === '') return undefined;
    this.buffer += text;
    if (this.paused) return undefined;
    const atBoundary = SEGMENT_ENDINGS.has(this.buffer.trimEnd().slice(-1));
    if (!atBoundary && this.buffer.length < this.segmentChars) return undefined;
    const now = this.now();
    if (now - this.lastAt < this.throttleMs) return undefined;
    return this.announce(this.buffer, false, now);
  }

  /**
   * 播报一次终态或立即处理的说明。
   *
   * 回合结束、停止确认与失败提示都走这里：即使缓冲里没有句末标点也一次播报完。
   * @param text - 要播报的文本。
   * @param urgent - 是否立即播报（`role=alert`）。
   * @returns 播报；没有可播报内容时为 `undefined`。
   */
  flush(text?: string, urgent = false): Announcement | undefined {
    const merged = text === undefined ? this.buffer : `${this.buffer}${text}`;
    if (merged.trim() === '') {
      this.buffer = '';
      return undefined;
    }
    if (this.paused) {
      this.buffer = merged;
      return undefined;
    }
    return this.announce(merged, urgent, this.now());
  }

  /**
   * 写入一条播报并清空缓冲。
   * @param text - 播报文本。
   * @param urgent - 是否立即播报。
   * @param at - 播报时刻。
   * @returns 播报。
   */
  private announce(text: string, urgent: boolean, at: number): Announcement {
    this.buffer = '';
    this.current = text.trim();
    this.lastAt = at;
    return { text: this.current, urgent };
  }
}

/**
 * 计算移除列表项之后的焦点目标。
 *
 * 优先交给下一项，其次上一项；列表空了返回 `undefined`，由调用方把焦点交给列表标题。
 * @param order - 移除前的完整顺序。
 * @param removedId - 被移除项的标识。
 * @returns 新的焦点目标标识。
 */
export function focusNeighborAfterRemove(order: readonly string[], removedId: string): string | undefined {
  const index = order.indexOf(removedId);
  if (index < 0) throw new Error(`被移除的条目不在列表里：${removedId}`);
  const next = order[index + 1];
  if (next !== undefined) return next;
  return order[index - 1];
}

/**
 * 取容器里可聚焦的元素，按文档顺序。
 * @param root - 容器。
 * @returns 可聚焦元素。
 */
export function tabbableWithin(root: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.hidden);
}

/**
 * 把 Tab 与 Shift+Tab 约束在模态面板内。
 * @param event - 键盘事件。
 * @param root - 模态面板根元素。
 */
export function trapFocus(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'target'>, root: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusable = tabbableWithin(root);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  const active = event.target instanceof HTMLElement ? event.target : undefined;
  if (event.shiftKey && (active === first || active === undefined)) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * 把焦点还给触发控件；元素已经不在文档里时退回到给定容器。
 * @param document - 文档对象。
 * @param id - 触发控件标识。
 * @param fallback - 退回到的容器。
 */
export function restoreFocus(document: Document, id: string, fallback?: HTMLElement): void {
  const target = document.getElementById(id);
  if (target !== null && typeof (target as HTMLElement).focus === 'function') {
    (target as HTMLElement).focus();
    return;
  }
  fallback?.focus();
}

/** 键盘事件里本模块关心的字段。 */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly target?: EventTarget | null;
}

/**
 * 判断按键是否来自可编辑控件。
 *
 * 可编辑控件里的普通字符键归输入区处理，全局快捷键只保留带修饰键的组合。
 * @param target - 事件目标。
 * @returns 目标可编辑时为真。
 */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}

/** 整屏的按键意图。 */
export type ConversationKeyIntent =
  | 'open-palette'
  | 'close-palette'
  | 'stop-run'
  | 'toggle-announcements'
  | 'focus-composer'
  | 'none';

/**
 * 判定整屏按键的意图。
 *
 * Ctrl/Cmd+K 打开命令面板；Escape 在面板打开时关闭面板，否则在有运行时发出停止意图；
 * Ctrl/Cmd+Shift+A 切换实时播报；Alt+Enter 把焦点移回输入区。
 * @param event - 键盘事件。
 * @param context - 面板是否打开、当前是否有运行。
 * @returns 按键意图。
 */
export function conversationKeyIntent(
  event: KeyEventLike,
  context: { readonly paletteOpen: boolean; readonly running: boolean }
): ConversationKeyIntent {
  const key = event.key;
  const modified = event.ctrlKey || event.metaKey;
  if (key.toLowerCase() === 'k' && modified && !event.altKey && !event.shiftKey) return 'open-palette';
  if (key.toLowerCase() === 'a' && modified && event.shiftKey && !event.altKey) return 'toggle-announcements';
  if (key === 'Enter' && event.altKey && !modified) return 'focus-composer';
  if (key === 'Escape') {
    if (event.isComposing === true || event.keyCode === 229) return 'none';
    if (context.paletteOpen) return 'close-palette';
    return context.running ? 'stop-run' : 'none';
  }
  return 'none';
}
