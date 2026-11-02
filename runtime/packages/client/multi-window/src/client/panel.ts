/**
 * 窗口与分屏的界面骨架。
 *
 * 面板只负责把状态写成 DOM，并把用户操作交给控制器：标签列表、动作按钮、分隔条、冲突提示、
 * 会话区、右栏对象区与输入区都在这里建立。分隔条带 `role="separator"` 与可读标签，键盘
 * 事件由控制器判定，因此鼠标拖动与方向键走同一套状态。
 * @module @chatdsh/client-multi-window/panel
 */

import type { ConflictNotice } from '../conflicts/board.ts';
import { paneLabel, type WindowTarget } from '../window/deep-link.ts';
import type { WindowTab } from '../window/registry.ts';
import type { SharedRuntimeRole, SharedRuntimeState } from '../window/shared-runtime.ts';
import { ratioPercent, type SplitLayout } from '../split/geometry.ts';

/** 单栏时显示的面板。 */
export type ActivePane = 'primary' | 'secondary';

/** 面板状态。 */
export interface PanelState {
  /** 本窗口标识。 */
  readonly windowId: string;
  /** 本窗口上下文。 */
  readonly target: WindowTarget;
  /** 会话标题。 */
  readonly title: string;
  /** 标签列表。 */
  readonly tabs: readonly WindowTab[];
  /** 已收到的消息行。 */
  readonly messages: readonly string[];
  /** 右栏对象正文。 */
  readonly paneText: string;
  /** 分屏布局。 */
  readonly layout: SplitLayout;
  /** 单栏时显示的面板。 */
  readonly activePane: ActivePane;
  /** 草稿文本。 */
  readonly draftText: string;
  /** 草稿状态说明。 */
  readonly draftHint: string;
  /** 共用运行时角色。 */
  readonly runtimeRole: SharedRuntimeRole;
  /** 共用运行时状态。 */
  readonly runtimeState: SharedRuntimeState;
  /** 冲突提示。 */
  readonly conflict: ConflictNotice | undefined;
}

/** 面板交互回调。 */
export interface PanelHandlers {
  /** 在新窗口打开当前会话。 */
  openWindow(): void;
  /** 切换拆分与单栏。 */
  toggleSplit(): void;
  /** 恢复默认布局。 */
  resetSplit(): void;
  /** 发送草稿。 */
  send(): void;
  /** 按对象键刷新内容。 */
  refresh(objectKey: string): void;
  /** 撤掉冲突提示。 */
  dismissConflict(objectKey: string): void;
  /** 聚焦另一个窗口。 */
  focusWindow(windowId: string): void;
  /** 草稿文本变化。 */
  compose(text: string): void;
  /** 分隔条被拖动到某个比例；`finished` 表示这次拖动结束。 */
  dragRatio(ratio: number, finished: boolean): void;
  /** 分隔条上的按键。 */
  separatorKey(event: KeyboardEvent): void;
  /** 单栏时切换显示的面板。 */
  selectPane(pane: ActivePane): void;
}

/** 创建一个元素。 */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 界面骨架。
 */
export class MultiWindowPanel {
  private readonly root: HTMLElement;
  private readonly handlers: PanelHandlers;
  private readonly tabList: HTMLUListElement;
  private readonly openButton: HTMLButtonElement;
  private readonly splitButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly statusLine: HTMLSpanElement;
  private readonly conflictBar: HTMLDivElement;
  private readonly conflictText: HTMLSpanElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly dismissButton: HTMLButtonElement;
  private readonly body: HTMLDivElement;
  private readonly primary: HTMLElement;
  private readonly secondary: HTMLElement;
  private readonly separator: HTMLDivElement;
  private readonly sessionHead: HTMLSpanElement;
  private readonly paneHead: HTMLSpanElement;
  private readonly messages: HTMLUListElement;
  private readonly paneText: HTMLElement;
  private readonly composer: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly draftState: HTMLSpanElement;
  private readonly announcer: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private conflictKey: string | undefined;
  private dragging = false;

  /**
   * 建立界面骨架并挂到容器上。
   * @param root - 容器元素。
   * @param handlers - 交互回调。
   */
  constructor(root: HTMLElement, handlers: PanelHandlers) {
    this.root = root;
    this.handlers = handlers;
    root.textContent = '';
    root.classList.add('chatdsh-mw');
    root.setAttribute('data-chatdsh-multi-window', '');

    const bar = element('div', 'chatdsh-mw__bar');
    this.tabList = element('ul', 'chatdsh-mw__tabs');
    this.tabList.setAttribute('role', 'tablist');
    this.tabList.setAttribute('aria-label', '窗口标签');
    this.tabList.setAttribute('data-chatdsh-tabs', '');
    this.openButton = element('button', 'chatdsh-mw__button');
    this.openButton.type = 'button';
    this.openButton.textContent = '在新窗口打开当前会话';
    this.openButton.setAttribute('data-chatdsh-open-window', '');
    this.openButton.addEventListener('click', () => this.handlers.openWindow());
    this.splitButton = element('button', 'chatdsh-mw__button');
    this.splitButton.type = 'button';
    this.splitButton.textContent = '拆分预览面板';
    this.splitButton.setAttribute('data-chatdsh-toggle-split', '');
    this.splitButton.addEventListener('click', () => this.handlers.toggleSplit());
    this.resetButton = element('button', 'chatdsh-mw__button');
    this.resetButton.type = 'button';
    this.resetButton.textContent = '重置分隔';
    this.resetButton.setAttribute('data-chatdsh-reset-split', '');
    this.resetButton.addEventListener('click', () => this.handlers.resetSplit());
    this.statusLine = element('span', 'chatdsh-mw__status');
    this.statusLine.setAttribute('data-chatdsh-runtime-role', '');
    bar.append(this.tabList, this.openButton, this.splitButton, this.resetButton, this.statusLine);

    this.conflictBar = element('div', 'chatdsh-mw__conflict');
    this.conflictBar.setAttribute('data-chatdsh-conflict', '');
    this.conflictBar.setAttribute('role', 'alert');
    this.conflictBar.hidden = true;
    this.conflictText = element('span');
    this.conflictText.setAttribute('data-chatdsh-conflict-text', '');
    this.refreshButton = element('button', 'chatdsh-mw__button chatdsh-mw__button--primary');
    this.refreshButton.type = 'button';
    this.refreshButton.textContent = '刷新读取最新内容';
    this.refreshButton.setAttribute('data-chatdsh-conflict-refresh', '');
    this.refreshButton.addEventListener('click', () => {
      if (this.conflictKey !== undefined) this.handlers.refresh(this.conflictKey);
    });
    this.dismissButton = element('button', 'chatdsh-mw__button');
    this.dismissButton.type = 'button';
    this.dismissButton.textContent = '稍后处理';
    this.dismissButton.setAttribute('data-chatdsh-conflict-dismiss', '');
    this.dismissButton.addEventListener('click', () => {
      if (this.conflictKey !== undefined) this.handlers.dismissConflict(this.conflictKey);
    });
    this.conflictBar.append(this.conflictText, this.refreshButton, this.dismissButton);

    this.body = element('div', 'chatdsh-mw__body');
    this.body.setAttribute('data-chatdsh-split', '');
    this.body.setAttribute('data-mode', 'split');
    this.primary = element('section', 'chatdsh-mw__pane');
    this.primary.setAttribute('data-pane', 'primary');
    this.primary.setAttribute('data-focused', 'true');
    const primaryHead = element('div', 'chatdsh-mw__pane-head');
    this.sessionHead = element('span');
    this.sessionHead.setAttribute('data-chatdsh-session-head', '');
    primaryHead.append(this.sessionHead);
    this.messages = element('ul', 'chatdsh-mw__messages');
    this.messages.setAttribute('data-chatdsh-messages', '');
    const composerRow = element('div', 'chatdsh-mw__composer-row');
    this.composer = element('textarea', 'chatdsh-mw__composer');
    this.composer.setAttribute('data-chatdsh-composer', '');
    this.composer.setAttribute('aria-label', '本窗口输入');
    this.composer.rows = 2;
    this.composer.addEventListener('input', () => this.handlers.compose(this.composer.value));
    this.sendButton = element('button', 'chatdsh-mw__button chatdsh-mw__button--primary');
    this.sendButton.type = 'button';
    this.sendButton.textContent = '发送';
    this.sendButton.setAttribute('data-chatdsh-send', '');
    this.sendButton.addEventListener('click', () => this.handlers.send());
    composerRow.append(this.composer, this.sendButton);
    this.draftState = element('span', 'chatdsh-mw__hint');
    this.draftState.setAttribute('data-chatdsh-draft-state', '');
    this.draftState.setAttribute('role', 'status');
    this.primary.append(primaryHead, this.messages, composerRow, this.draftState);

    this.separator = element('div', 'chatdsh-mw__separator');
    this.separator.setAttribute('role', 'separator');
    this.separator.setAttribute('aria-orientation', 'vertical');
    this.separator.setAttribute('tabindex', '0');
    this.separator.setAttribute('data-chatdsh-separator', '');
    this.separator.setAttribute('aria-label', '分屏分隔条：方向键调整宽度，Home 收到最小，End 放到最大，回车恢复默认');
    this.separator.addEventListener('keydown', (event) => this.handlers.separatorKey(event));
    this.separator.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.separator.setPointerCapture(event.pointerId);
      this.separator.focus();
    });
    this.separator.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      const rect = this.body.getBoundingClientRect();
      this.handlers.dragRatio(this.ratioAt(event.clientX, rect.left, rect.width), false);
    });
    const endDrag = (event: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.separator.hasPointerCapture(event.pointerId)) this.separator.releasePointerCapture(event.pointerId);
      const rect = this.body.getBoundingClientRect();
      this.handlers.dragRatio(this.ratioAt(event.clientX, rect.left, rect.width), true);
    };
    this.separator.addEventListener('pointerup', endDrag);
    this.separator.addEventListener('pointercancel', endDrag);

    this.secondary = element('section', 'chatdsh-mw__pane');
    this.secondary.setAttribute('data-pane', 'secondary');
    this.secondary.setAttribute('data-hidden', 'false');
    const secondaryHead = element('div', 'chatdsh-mw__pane-head');
    this.paneHead = element('span');
    this.paneHead.setAttribute('data-chatdsh-pane-head', '');
    const paneSwitch = element('button', 'chatdsh-mw__button');
    paneSwitch.type = 'button';
    paneSwitch.textContent = '切换面板';
    paneSwitch.setAttribute('data-chatdsh-switch-pane', '');
    paneSwitch.addEventListener('click', () => this.handlers.selectPane(this.primary.getAttribute('data-hidden') === 'true' ? 'primary' : 'secondary'));
    secondaryHead.append(this.paneHead, paneSwitch);
    this.paneText = element('pre', 'chatdsh-mw__object');
    this.paneText.setAttribute('data-chatdsh-pane', '');
    this.secondary.append(secondaryHead, this.paneText);

    this.body.append(this.primary, this.separator, this.secondary);

    this.announcer = element('div', 'chatdsh-mw__sr');
    this.announcer.setAttribute('role', 'status');
    this.announcer.setAttribute('aria-live', 'polite');
    this.announcer.setAttribute('data-chatdsh-announce', '');

    this.hint = element('div', 'chatdsh-mw__hint');
    this.hint.setAttribute('data-chatdsh-hint', '');
    this.hint.textContent = '当前窗口只挂载选中的一台设备；两个会话同时阅读请使用第二窗口。';

    root.append(bar, this.conflictBar, this.body, this.hint, this.announcer);
  }

  /**
   * 按指针位置算比例。
   * @param clientX - 指针横向坐标。
   * @param left - 容器左边界。
   * @param width - 容器宽度。
   * @returns 比例。
   */
  private ratioAt(clientX: number, left: number, width: number): number {
    const available = width - 8;
    if (available <= 0) return 0.5;
    return Math.min(Math.max((clientX - left - 4) / available, 0), 1);
  }

  /** 取分隔条元素，供控制器注册与测量。 */
  get separatorElement(): HTMLElement {
    return this.separator;
  }

  /** 取容器元素。 */
  get bodyElement(): HTMLElement {
    return this.body;
  }

  /** 取输入区元素。 */
  get composerElement(): HTMLTextAreaElement {
    return this.composer;
  }

  /**
   * 让分隔条获得焦点。
   */
  focusSeparator(): void {
    this.separator.focus();
  }

  /**
   * 把状态写到界面上。
   * @param state - 面板状态。
   */
  render(state: PanelState): void {
    this.root.setAttribute('data-chatdsh-window-id', state.windowId);
    this.openButton.disabled = false;
    this.statusLine.textContent = state.runtimeRole === 'leader'
      ? `共用运行时：本窗口持连（${state.runtimeState}）`
      : `共用运行时：跟随窗口（${state.runtimeState}）`;
    this.renderTabs(state.tabs);
    this.renderConflict(state.conflict);
    this.sessionHead.textContent = `${state.title} · ${state.target.deviceId} · ${state.target.sessionId}`;
    this.paneHead.textContent = state.target.pane === undefined
      ? `预览（未选择对象）`
      : `${paneLabel(state.target.pane.kind)} · ${state.target.pane.id}`;
    this.renderMessages(state.messages);
    this.paneText.textContent = state.paneText;
    if (this.composer.value !== state.draftText) this.composer.value = state.draftText;
    this.draftState.textContent = state.draftHint;
    this.body.setAttribute('data-mode', state.layout.mode);
    this.body.setAttribute('data-split-ratio', state.layout.ratio.toFixed(4));
    this.separator.setAttribute('aria-valuemin', String(ratioPercent(state.layout.minRatio)));
    this.separator.setAttribute('aria-valuemax', String(ratioPercent(state.layout.maxRatio)));
    this.separator.setAttribute('aria-valuenow', String(ratioPercent(state.layout.ratio)));
    this.separator.setAttribute('aria-valuetext', `主栏占 ${String(ratioPercent(state.layout.ratio))}%`);
    const hiddenPrimary = state.layout.mode === 'single' && state.activePane === 'secondary';
    const hiddenSecondary = state.layout.mode === 'single' && state.activePane === 'primary';
    this.primary.setAttribute('data-hidden', hiddenPrimary ? 'true' : 'false');
    this.secondary.setAttribute('data-hidden', hiddenSecondary ? 'true' : 'false');
    this.primary.style.flex = state.layout.mode === 'split' ? `0 0 ${String(state.layout.primary)}px` : '1 1 auto';
    this.secondary.style.flex = state.layout.mode === 'split' ? '1 1 auto' : '1 1 auto';
    this.splitButton.textContent = state.layout.mode === 'split' ? '关闭拆分' : '拆分预览面板';
    this.secondary.setAttribute('data-pane-width', String(state.layout.secondary));
    this.primary.setAttribute('data-pane-width', String(state.layout.primary));
    this.secondary.setAttribute('data-focused', state.activePane === 'secondary' ? 'true' : 'false');
    this.announce(state);
  }

  /**
   * 写标签列表。
   * @param tabs - 标签。
   */
  private renderTabs(tabs: readonly WindowTab[]): void {
    this.tabList.textContent = '';
    for (const tab of tabs) {
      const item = element('li');
      const button = element('button', 'chatdsh-mw__tab', tab.current ? `${tab.title}（本窗口）` : tab.title);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.current ? 'true' : 'false');
      button.setAttribute('data-tab-window-id', tab.windowId);
      if (tab.current) button.setAttribute('data-tab-current', '');
      button.title = tab.description;
      button.addEventListener('click', () => this.handlers.focusWindow(tab.windowId));
      item.append(button);
      this.tabList.append(item);
    }
    this.tabList.setAttribute('data-tab-count', String(tabs.length));
  }

  /**
   * 写冲突提示。
   * @param notice - 提示；没有冲突时隐藏整条。
   */
  private renderConflict(notice: ConflictNotice | undefined): void {
    if (notice === undefined) {
      this.conflictBar.hidden = true;
      this.conflictKey = undefined;
      return;
    }
    this.conflictBar.hidden = false;
    this.conflictText.textContent = notice.message;
    this.refreshButton.textContent = notice.refreshLabel;
    this.conflictKey = notice.objectKey;
    this.conflictBar.setAttribute('data-conflict-kind', notice.kind);
  }

  /**
   * 写消息行。只在行数变化时重建，避免每次输入都重排。
   * @param messages - 消息行。
   */
  private renderMessages(messages: readonly string[]): void {
    const existing = this.messages.querySelectorAll('li');
    if (existing.length === messages.length) {
      for (let index = 0; index < messages.length; index += 1) {
        const line = existing[index];
        const text = messages[index] ?? '';
        if (line !== undefined && line.textContent !== text) line.textContent = text;
      }
      return;
    }
    this.messages.textContent = '';
    for (const text of messages) this.messages.append(element('li', undefined, text));
  }

  /**
   * 把布局变化与冲突写入读屏播报。
   * @param state - 面板状态。
   */
  private announce(state: PanelState): void {
    const parts: string[] = [];
    if (state.layout.mode === 'single') {
      parts.push(`当前为单栏，显示${state.activePane === 'primary' ? '会话' : '预览面板'}`);
    } else {
      parts.push(`分屏，主栏占 ${String(ratioPercent(state.layout.ratio))}%`);
    }
    if (state.conflict !== undefined) parts.push(state.conflict.message);
    const text = parts.join('；');
    if (this.announcer.textContent !== text) this.announcer.textContent = text;
  }

  /** 卸载界面。 */
  destroy(): void {
    this.root.textContent = '';
    this.root.classList.remove('chatdsh-mw');
    this.root.removeAttribute('data-chatdsh-multi-window');
    this.root.removeAttribute('data-chatdsh-window-id');
  }
}

/**
 * 创建一个面板。
 * @param root - 容器元素。
 * @param handlers - 交互回调。
 * @returns 面板。
 */
export function createMultiWindowPanel(root: HTMLElement, handlers: PanelHandlers): MultiWindowPanel {
  return new MultiWindowPanel(root, handlers);
}
