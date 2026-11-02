/**
 * 组合输入框：输入法组合、快捷键、草稿、字数与附件条目。
 *
 * 输入法组合期间不提交：组合开始时记下组合状态，组合过程中到达的文本只进临时缓冲，输入区
 * 正文保持不变；组合结束后才把缓冲写入正文并更新字数。因此组合中按 Enter 不会发送，也不
 * 会插入换行。
 *
 * 快捷键固定为 Enter 发送、Shift+Enter 换行、Escape 中断输入或请求停止。空白消息在没有已
 * 确认附件时不能发送；超过上限时给出当前长度与上限。草稿只保存文本、引用标识与已确认附件
 * 的元数据，发送成功之前不清除。
 * @module @chatdsh/client-conversation/composer/state
 */

import { triggerStartsAt } from '../commands/triggers.ts';
import {
  intersectsSpan,
  referenceToken,
  restoreReferences,
  toDraftReferences,
  validateReferences,
  type PersistedReference,
  type ReferenceCandidate,
  type ReferenceInvalidReason,
  type ReferenceObject,
  type ReferenceObjectKind,
} from '../references/references.ts';

/** 输入区的按键意图。 */
export const COMPOSER_INTENTS = ['send', 'newline', 'interrupt', 'trigger-command', 'trigger-reference', 'none'] as const;

/** 输入区按键意图取值。 */
export type ComposerIntent = (typeof COMPOSER_INTENTS)[number];

/** 附件条目的状态。 */
export const ATTACHMENT_STATES = ['uploading', 'uploaded', 'failed', 'cancelled', 'needs-reselect'] as const;

/** 附件条目状态取值。 */
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

/** 附件条目的状态说明。 */
export const ATTACHMENT_STATE_TEXT: Readonly<Record<AttachmentState, string>> = {
  uploading: '正在上传',
  uploaded: '已上传',
  failed: '上传失败',
  cancelled: '已取消',
  'needs-reselect': '需要重新选择',
};

/** 输入区里的一个附件条目。 */
export interface AttachmentSlot {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  /** 上传进度，取 0 到 1。 */
  readonly progress: number;
  readonly state: AttachmentState;
}

/** 输入区快照。 */
export interface ComposerSnapshot {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** 输入法是否处于组合状态。 */
  readonly composing: boolean;
  /** 组合中的临时文本；不进入正文。 */
  readonly compositionBuffer: string;
  readonly references: readonly ReferenceObject[];
  readonly attachments: readonly AttachmentSlot[];
  readonly maxLength: number;
  /** 草稿版本；保存成功后带上。 */
  readonly draftRevision?: number;
  /** 草稿写入失败原因。 */
  readonly draftFailure?: string;
}

/** 字数报告。 */
export interface LengthReport {
  readonly length: number;
  readonly max: number;
  readonly remaining: number;
  readonly exceeded: boolean;
}

/** 不能发送的原因。 */
export const SEND_BLOCKERS = ['empty', 'too-long', 'attachment-pending', 'reference-invalid'] as const;

/** 不能发送的原因取值。 */
export type SendBlocker = (typeof SEND_BLOCKERS)[number];

/** 不能发送原因的说明。 */
export const SEND_BLOCKER_TEXT: Readonly<Record<SendBlocker, string>> = {
  empty: '没有可以发送的内容',
  'too-long': '内容超过长度上限',
  'attachment-pending': '还有附件没有上传完成',
  'reference-invalid': '有引用失效，需要重新选择或移除',
};

/** 发送检查结论。 */
export interface SendCheck {
  readonly canSend: boolean;
  readonly blockers: readonly SendBlocker[];
  /** 第一条原因的说明。 */
  readonly reason?: string;
}

/** 键盘事件里本模块关心的字段。 */
export interface ComposerKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** 输入区的依赖。 */
export interface ComposerOptions {
  /** 长度上限，字符数。 */
  readonly maxLength?: number;
  /** 生成附件条目标识的实现。 */
  readonly createId?: () => string;
}

/** 默认长度上限。 */
export const DEFAULT_MAX_LENGTH = 8000;

/** 一条撤销记录。 */
interface HistoryEntry {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly references: readonly ReferenceObject[];
}

/**
 * 组合输入框的状态机。
 */
export class Composer {
  private text = '';
  private selectionStart = 0;
  private selectionEnd = 0;
  private composing = false;
  private compositionBuffer = '';
  private compositionAnchor: number | undefined;
  private references: ReferenceObject[] = [];
  private attachments: AttachmentSlot[] = [];
  private maxLength: number;
  private draftRevision: number | undefined;
  private draftFailure: string | undefined;
  private history: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly createId: () => string;
  private idCounter = 0;

  /**
   * 建立输入区。
   * @param options - 长度上限与标识生成。
   */
  constructor(options: ComposerOptions = {}) {
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    if (!Number.isInteger(this.maxLength) || this.maxLength < 1) throw new Error('长度上限必须是正整数');
    this.createId = options.createId ?? (() => `composer-${String((this.idCounter += 1))}`);
  }

  /** 当前快照。 */
  get state(): ComposerSnapshot {
    return {
      text: this.text,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
      composing: this.composing,
      compositionBuffer: this.compositionBuffer,
      references: [...this.references],
      attachments: [...this.attachments],
      maxLength: this.maxLength,
      ...(this.draftRevision === undefined ? {} : { draftRevision: this.draftRevision }),
      ...(this.draftFailure === undefined ? {} : { draftFailure: this.draftFailure }),
    };
  }

  /** 正文。 */
  get value(): string {
    return this.text;
  }

  /** 正文长度。 */
  get length(): number {
    return this.text.length;
  }

  /** 是否处于输入法组合状态。 */
  get isComposing(): boolean {
    return this.composing;
  }

  /**
   * 字数报告。
   * @returns 当前长度、上限、剩余与是否超限。
   */
  lengthReport(): LengthReport {
    return {
      length: this.text.length,
      max: this.maxLength,
      remaining: this.maxLength - this.text.length,
      exceeded: this.text.length > this.maxLength,
    };
  }

  /**
   * 设置光标或选区。
   * @param start - 选区起点。
   * @param end - 选区终点。
   */
  setSelection(start: number, end: number = start): void {
    if (start < 0 || end < start || end > this.text.length) throw new Error('选区超出正文范围');
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  /**
   * 输入法开始组合。
   */
  compositionStart(): void {
    this.composing = true;
    this.compositionBuffer = '';
    this.compositionAnchor = this.selectionStart;
  }

  /**
   * 输入法组合过程更新。
   *
   * 组合中的文本只进缓冲，正文与字数保持不变。
   * @param data - 组合中的文本。
   */
  compositionUpdate(data: string): void {
    if (!this.composing) throw new Error('没有开始的输入法组合');
    this.compositionBuffer = data;
  }

  /**
   * 输入法组合结束，把缓冲写入正文。
   * @param data - 组合结束时的文本；缺省用最近一次组合更新。
   */
  compositionEnd(data?: string): void {
    if (!this.composing) throw new Error('没有开始的输入法组合');
    const committed = data ?? this.compositionBuffer;
    this.composing = false;
    this.compositionBuffer = '';
    if (committed === '') return;
    const anchor = this.compositionAnchor ?? this.selectionStart;
    this.compositionAnchor = undefined;
    if (this.text.slice(anchor, anchor + committed.length) === committed) return;
    this.applyEdit(anchor, anchor, committed);
  }

  /**
   * 写入一段普通文本。
   * @param text - 要写入的文本。
   */
  insert(text: string): void {
    if (text === '') return;
    this.applyEdit(this.selectionStart, this.selectionEnd, text);
  }

  /**
   * 替换一段文本，并把光标放在替换内容之后。
   *
   * 类型触发选中条目之后用它把 `@查询` 或 `/查询` 换成引用标记或命令文本。
   * @param start - 替换起点。
   * @param end - 替换终点（不含）。
   * @param text - 替换内容。
   */
  replaceRange(start: number, end: number, text: string): void {
    if (start < 0 || end < start || end > this.text.length) throw new Error('替换区间超出正文范围');
    this.applyEdit(start, end, text);
  }

  /**
   * 判定一次按键的意图。
   *
   * 输入法组合期间（组合状态或事件自带 `isComposing`）Enter 与 Escape 一律不处理。
   * @param event - 键盘事件。
   * @returns 按键意图。
   */
  keyIntent(event: ComposerKeyEvent): ComposerIntent {
    const composing = this.composing || event.isComposing === true || event.keyCode === 229;
    if (composing) return 'none';
    if (event.key === 'Enter') {
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return 'newline';
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return 'send';
      return 'none';
    }
    if (event.key === 'Escape') return 'interrupt';
    if (event.ctrlKey || event.metaKey || event.altKey) return 'none';
    if (event.key === '/' && triggerStartsAt(this.text, this.selectionStart)) return 'trigger-command';
    if (event.key === '@' && triggerStartsAt(this.text, this.selectionStart)) return 'trigger-reference';
    return 'none';
  }

  /**
   * 判断能否发送，并给出全部不能发送的原因。
   * @returns 发送检查结论。
   */
  sendCheck(): SendCheck {
    const blockers: SendBlocker[] = [];
    if (this.text.trim() === '' && this.attachments.length === 0) blockers.push('empty');
    if (this.text.length > this.maxLength) blockers.push('too-long');
    if (this.attachments.some((slot) => slot.state === 'uploading' || slot.state === 'failed')) {
      blockers.push('attachment-pending');
    }
    if (this.references.some((reference) => !reference.available)) blockers.push('reference-invalid');
    const first = blockers[0];
    return {
      canSend: blockers.length === 0,
      blockers,
      ...(first === undefined ? {} : { reason: SEND_BLOCKER_TEXT[first] }),
    };
  }

  /**
   * 添加一个附件条目。
   *
   * 真实上传由工作区工具包提供，这里维护条目、进度与阻止发送的规则。
   * @param input - 文件名、媒体类型与字节数。
   * @returns 新建的条目。
   */
  attach(input: { readonly filename: string; readonly mimeType: string; readonly size: number }): AttachmentSlot {
    if (input.filename === '') throw new Error('附件文件名不能为空');
    if (!Number.isInteger(input.size) || input.size < 0) throw new Error('附件字节数必须是非负整数');
    const slot: AttachmentSlot = {
      id: this.createId(),
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      progress: 0,
      state: 'uploading',
    };
    this.attachments = [...this.attachments, slot];
    return slot;
  }

  /**
   * 更新附件条目的状态与进度。
   * @param id - 条目标识。
   * @param patch - 状态与进度。
   * @returns 更新后的条目。
   */
  updateAttachment(id: string, patch: { readonly state?: AttachmentState; readonly progress?: number }): AttachmentSlot {
    const index = this.attachments.findIndex((slot) => slot.id === id);
    if (index < 0) throw new Error(`附件条目不存在：${id}`);
    const current = this.attachments[index]!;
    const progress = patch.progress ?? current.progress;
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('上传进度必须落在 0 到 1 之间');
    const next: AttachmentSlot = {
      ...current,
      progress,
      state: patch.state ?? current.state,
    };
    this.attachments = [...this.attachments.slice(0, index), next, ...this.attachments.slice(index + 1)];
    return next;
  }

  /**
   * 移除一个附件条目。
   * @param id - 条目标识。
   */
  removeAttachment(id: string): void {
    const next = this.attachments.filter((slot) => slot.id !== id);
    if (next.length === this.attachments.length) throw new Error(`附件条目不存在：${id}`);
    this.attachments = next;
  }

  /**
   * 在光标处插入一个引用对象。
   * @param candidate - 目录条目。
   * @returns 插入的引用对象。
   */
  insertReference(candidate: ReferenceCandidate): ReferenceObject {
    if (candidate.unavailableReason !== undefined) {
      throw new Error(`引用对象不可用：${candidate.unavailableReason}`);
    }
    if (this.references.some((reference) => reference.id === candidate.id && reference.kind === candidate.kind)) {
      throw new Error(`引用对象已经在输入区里：${candidate.label}`);
    }
    const token = referenceToken(candidate.label);
    const start = this.selectionStart;
    this.applyEdit(start, this.selectionEnd, token);
    const reference: ReferenceObject = {
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      origin: candidate.origin,
      spanStart: start,
      spanEnd: start + token.length,
      available: true,
    };
    this.references = [...this.references, reference];
    return reference;
  }

  /**
   * 把类型触发的查询文本换成引用标记。
   *
   * 触发区间被替换成标记，标记范围与对象一起登记，因此退格能整条删除。
   * @param candidate - 目录条目。
   * @param trigger - 触发区间。
   * @returns 插入的引用对象。
   */
  insertReferenceForTrigger(
    candidate: ReferenceCandidate,
    trigger: { readonly start: number; readonly end: number }
  ): ReferenceObject {
    if (candidate.unavailableReason !== undefined) {
      throw new Error(`引用对象不可用：${candidate.unavailableReason}`);
    }
    if (this.references.some((reference) => reference.id === candidate.id && reference.kind === candidate.kind)) {
      throw new Error(`引用对象已经在输入区里：${candidate.label}`);
    }
    const token = referenceToken(candidate.label);
    this.applyEdit(trigger.start, trigger.end, token);
    const reference: ReferenceObject = {
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      origin: candidate.origin,
      spanStart: trigger.start,
      spanEnd: trigger.start + token.length,
      available: true,
    };
    this.references = [...this.references, reference];
    return reference;
  }

  /**
   * 移除一个引用对象，连同文本里的标记。
   * @param id - 引用对象标识。
   */
  removeReference(id: string): void {
    const reference = this.references.find((item) => item.id === id);
    if (reference === undefined) throw new Error(`引用对象不存在：${id}`);
    if (reference.spanStart >= 0 && reference.spanEnd >= 0) {
      this.applyEdit(reference.spanStart, reference.spanEnd, '', [id]);
      return;
    }
    this.references = this.references.filter((item) => item.id !== id);
  }

  /**
   * 按宿主给出的可用清单更新引用状态。
   * @param availability - 可用清单。
   * @returns 本次失效的引用对象。
   */
  invalidateReferences(
    availability: readonly { readonly kind: ReferenceObjectKind; readonly id: string; readonly reason?: ReferenceInvalidReason }[]
  ): readonly ReferenceObject[] {
    const result = validateReferences(this.references, availability);
    this.references = [...result.references];
    return result.invalidated;
  }

  /**
   * 删除光标前的一个字符；光标紧邻引用标记时整条对象一起删除。
   * @returns 是否删除了引用对象。
   */
  deleteBackward(): boolean {
    if (this.selectionStart !== this.selectionEnd) {
      this.applyEdit(this.selectionStart, this.selectionEnd, '');
      return false;
    }
    const caret = this.selectionStart;
    if (caret === 0) return false;
    const reference = this.references.find((item) => item.spanEnd === caret && item.spanStart >= 0);
    if (reference !== undefined) {
      this.applyEdit(reference.spanStart, reference.spanEnd, '', [reference.id]);
      return true;
    }
    const previous = this.previousCodePoint(caret);
    this.applyEdit(previous, caret, '');
    return false;
  }

  /**
   * 删除光标后的一个字符；光标紧邻引用标记时整条对象一起删除。
   * @returns 是否删除了引用对象。
   */
  deleteForward(): boolean {
    if (this.selectionStart !== this.selectionEnd) {
      this.applyEdit(this.selectionStart, this.selectionEnd, '');
      return false;
    }
    const caret = this.selectionStart;
    if (caret >= this.text.length) return false;
    const reference = this.references.find((item) => item.spanStart === caret);
    if (reference !== undefined) {
      this.applyEdit(reference.spanStart, reference.spanEnd, '', [reference.id]);
      return true;
    }
    const next = caret + 1;
    this.applyEdit(caret, next, '');
    return false;
  }

  /**
   * 撤销上一次修改，引用对象的边界一并恢复。
   * @returns 是否有可撤销的修改。
   */
  undo(): boolean {
    const entry = this.history.pop();
    if (entry === undefined) return false;
    this.redoStack.push({
      text: this.text,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
      references: [...this.references],
    });
    this.text = entry.text;
    this.selectionStart = entry.selectionStart;
    this.selectionEnd = entry.selectionEnd;
    this.references = [...entry.references];
    return true;
  }

  /**
   * 重做上一次撤销。
   * @returns 是否有可重做的修改。
   */
  redo(): boolean {
    const entry = this.redoStack.pop();
    if (entry === undefined) return false;
    this.history.push({
      text: this.text,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
      references: [...this.references],
    });
    this.text = entry.text;
    this.selectionStart = entry.selectionStart;
    this.selectionEnd = entry.selectionEnd;
    this.references = [...entry.references];
    return true;
  }

  /**
   * 清空正文、引用与附件。
   */
  clear(): void {
    this.applyEdit(0, this.text.length, '');
    this.references = [];
    this.attachments = [];
    this.draftRevision = undefined;
    this.draftFailure = undefined;
  }

  /**
   * 取要写入草稿的内容。
   *
   * 只包含文本、草稿契约允许的引用与已确认附件；记忆引用与未确认附件明确报告被丢弃。
   * @returns 草稿内容与被丢弃的条目。
   */
  snapshotForDraft(): {
    readonly text: string;
    readonly references: readonly PersistedReference[];
    readonly attachments: readonly { id: string; filename: string; mimeType: string; size: number; needsReselect: boolean }[];
    readonly dropped: readonly { readonly id: string; readonly kind: ReferenceObjectKind; readonly reason: string }[];
  } {
    const references = toDraftReferences(this.references);
    const attachments = this.attachments
      .filter((slot) => slot.state === 'uploaded' || slot.state === 'needs-reselect')
      .map((slot) => ({
        id: slot.id,
        filename: slot.filename,
        mimeType: slot.mimeType,
        size: slot.size,
        needsReselect: slot.state === 'needs-reselect',
      }));
    return {
      text: this.text,
      references: references.persisted,
      attachments,
      dropped: references.dropped,
    };
  }

  /**
   * 从草稿恢复输入区。
   * @param record - 草稿内容。
   * @returns 恢复后的引用对象与被丢弃的条目。
   */
  restoreDraft(record: {
    readonly text: string;
    readonly references: readonly PersistedReference[];
    readonly attachments: readonly {
      readonly id: string;
      readonly filename: string;
      readonly mimeType: string;
      readonly size: number;
      readonly needsReselect: boolean;
    }[];
  }): { readonly references: readonly ReferenceObject[]; readonly needsReselect: readonly string[] } {
    this.text = record.text;
    this.selectionStart = record.text.length;
    this.selectionEnd = record.text.length;
    this.references = restoreReferences(record.text, record.references);
    this.attachments = record.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      progress: attachment.needsReselect ? 0 : 1,
      state: attachment.needsReselect ? 'needs-reselect' : 'uploaded',
    }));
    this.history = [];
    this.redoStack = [];
    return {
      references: [...this.references],
      needsReselect: this.attachments.filter((slot) => slot.state === 'needs-reselect').map((slot) => slot.id),
    };
  }

  /**
   * 记录草稿写入结果。
   * @param outcome - 成功时给出版本，失败时给出原因。
   */
  markDraft(outcome: { readonly revision?: number; readonly failure?: string }): void {
    this.draftRevision = outcome.revision;
    this.draftFailure = outcome.failure;
  }

  /**
   * 发送成功后清空输入区与草稿状态。
   */
  clearAfterSend(): void {
    this.clear();
  }

  /**
   * 取光标前一个码点的起点。
   * @param caret - 光标位置。
   * @returns 前一个码点的起点。
   */
  private previousCodePoint(caret: number): number {
    const characters = [...this.text.slice(0, caret)];
    const last = characters.at(-1);
    return last === undefined ? 0 : caret - last.length;
  }

  /**
   * 应用一次文本修改，同时维护引用范围与撤销记录。
   * @param changeStart - 修改起点。
   * @param changeEnd - 修改终点（不含）。
   * @param inserted - 插入的文本。
   * @param forceRemove - 额外要移除的引用标识。
   */
  private applyEdit(changeStart: number, changeEnd: number, inserted: string, forceRemove: readonly string[] = []): void {
    this.history.push({
      text: this.text,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
      references: [...this.references],
    });
    this.redoStack = [];
    let start = changeStart;
    let end = changeEnd;
    const removed = new Set(forceRemove);
    if (end > start) {
      for (const reference of this.references) {
        if (intersectsSpan(reference, start, end)) removed.add(reference.id);
      }
    }
    for (const reference of this.references) {
      if (!removed.has(reference.id)) continue;
      if (reference.spanStart < 0 || reference.spanEnd < 0) continue;
      start = Math.min(start, reference.spanStart);
      end = Math.max(end, reference.spanEnd);
    }
    const removedLength = end - start;
    const delta = inserted.length - removedLength;
    this.text = `${this.text.slice(0, start)}${inserted}${this.text.slice(end)}`;
    this.references = this.references
      .filter((reference) => !removed.has(reference.id))
      .map((reference) => {
        if (reference.spanStart < 0 || reference.spanEnd < 0) return reference;
        if (reference.spanEnd <= start) return reference;
        if (reference.spanStart >= end) {
          return {
            ...reference,
            spanStart: reference.spanStart + delta,
            spanEnd: reference.spanEnd + delta,
          };
        }
        throw new Error('引用对象与修改区间重叠，调用方必须先移除该对象');
      });
    this.selectionStart = start + inserted.length;
    this.selectionEnd = this.selectionStart;
  }
}
