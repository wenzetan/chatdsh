/**
 * 右栏：会话内容与外壳承载的向导、继续、命令面板与只读副本。
 *
 * 在线的目标设备用 `/d/<deviceId>/` 的 iframe 承载内容，并通过经过校验的消息通道请求打开
 * 指定会话；设备离线时换成只读副本入口与只保留在本地的草稿输入。创建向导、继续确认与命令
 * 面板都是模态层：打开时约束焦点，Escape 关闭并回到打开它的控件。
 * @module @chatdsh/client-shell/main-view
 */

import type { CommandDescriptor } from './commands.ts';
import type { DirectoryListing } from './api.ts';
import type { ImportMode } from './estimate.ts';

/** 导航消息的协议版本。与导航契约一致。 */
const NAVIGATION_VERSION = 1;

/** 导航确认的等待时限，单位毫秒。与导航契约一致。 */
const NAVIGATION_TIMEOUT_MS = 5000;

/** 复制方式的中文名。 */
const IMPORT_MODE_LABELS: Readonly<Record<ImportMode, string>> = {
  'full-prefix': '完整历史',
  compressed: '压缩历史（工具输出换成摘要）',
};

/** 一次会话选择请求的结论。 */
export type NavigationOutcome =
  | { readonly outcome: 'selected' }
  | { readonly outcome: 'rejected'; readonly code: string }
  | { readonly outcome: 'timeout' };

/** 右栏承载的会话状态。 */
export interface SessionPaneInput {
  /** 会话标题。 */
  readonly title: string;
  /** 会话类型。 */
  readonly kind: 'work' | 'chat';
  /** 归属设备的显示标签。 */
  readonly deviceLabel: string;
  /** 归属设备标识。 */
  readonly deviceId: string;
  /** 工作目录。 */
  readonly cwd: string;
  /** 设备是否在线。 */
  readonly online: boolean;
  /** 会话标识。 */
  readonly sessionId: string;
  /** 可写时的说明。 */
  readonly note: string;
}

/** 只读副本面板的数据。 */
export interface ReadonlyPaneInput {
  /** 读取时刻的毫秒时间戳。 */
  readonly readAt: number;
  /** 副本里的事件条数。 */
  readonly eventCount: number;
  /** 最近的内容片段，按时间顺序。 */
  readonly excerpts: readonly string[];
  /** 副本缺失。 */
  readonly missing: boolean;
  /** 只读原因。 */
  readonly reason: string;
}

/** 创建向导的数据。 */
export interface CreateWizardInput {
  /** 可选设备。 */
  readonly devices: readonly { readonly id: string; readonly name: string; readonly online: boolean }[];
  /** 预选设备。 */
  readonly deviceId: string | undefined;
  /** 目录列举结果。 */
  readonly listing: DirectoryListing | undefined;
  /** 目录列举的失败原因。 */
  readonly listingError: string | undefined;
  /** 正在读取目录。 */
  readonly listingBusy: boolean;
  /** 提交中。 */
  readonly busy: boolean;
  /** 失败原因。 */
  readonly error: string | undefined;
  /** 已经创建但归属未登记成功的会话；给出时按钮变成重新登记归属。 */
  readonly createdSessionId?: string;
}

/** 创建向导提交的内容。 */
export interface CreateSubmit {
  readonly deviceId: string;
  readonly kind: 'work' | 'chat';
  readonly cwd: string;
  readonly title: string;
}

/** 继续确认的数据。 */
export interface ContinueDialogInput {
  /** 源会话标题。 */
  readonly sourceTitle: string;
  /** 源设备显示标签。 */
  readonly sourceDeviceLabel: string;
  /** 源设备标识。 */
  readonly sourceDeviceId: string;
  /** 源设备是否在线。 */
  readonly sourceOnline: boolean;
  /** 源会话标识。 */
  readonly sourceSessionId: string;
  /** 目标构建完成，可以复制。 */
  readonly estimate: {
    readonly eventCount: number;
    readonly charCount: number;
    readonly missingAttachmentIds: readonly string[];
    readonly compressionLoss: boolean;
    readonly sourceState: 'complete' | 'partial';
  } | undefined;
  /** 副本缺失时的拒绝原因。 */
  readonly estimateError: string | undefined;
  /** 当前复制方式。 */
  readonly importMode: ImportMode;
  /** 本机运行时是否可用。 */
  readonly localAvailable: boolean;
  /** 本机不可用的原因。 */
  readonly localReason: string | undefined;
  /** 本机目录列举结果。 */
  readonly listing: DirectoryListing | undefined;
  /** 本机目录列举失败原因。 */
  readonly listingError: string | undefined;
  /** 本机目录正在读取。 */
  readonly listingBusy: boolean;
  /** 提交中。 */
  readonly busy: boolean;
  /** 失败原因。 */
  readonly error: string | undefined;
}

/** 继续确认的提交内容。 */
export interface ContinueSubmit {
  readonly mode: 'local';
  readonly importMode: ImportMode;
  readonly cwd: string;
}

/** 命令面板的数据。 */
export interface PaletteInput {
  /** 全部命令。 */
  readonly commands: readonly CommandDescriptor[];
  /** 最近使用的命令标识。 */
  readonly recent: readonly string[];
  /** 打开面板前的焦点元素。 */
  readonly trigger: HTMLElement | undefined;
}

/** 右栏向外报告的动作。 */
export interface MainViewHandlers {
  /** 在远程继续。 */
  onContinueRemote(): void;
  /** 在本机继续（进入确认）。 */
  onContinueLocal(): void;
  /** 草稿输入。 */
  onDraftInput(text: string): void;
  /** 离线发送。 */
  onDraftSend(): void;
  /** 重试打开指定会话。 */
  onRetryNavigation(): void;
  /** 返回列表。 */
  onReturnList(): void;
  /** 创建向导更换设备。 */
  onCreateDeviceChange(deviceId: string): void;
  /** 创建向导打开目录。 */
  onCreateDirectoryOpen(path: string): void;
  /** 创建向导刷新目录。 */
  onCreateDirectoryRefresh(): void;
  /** 创建向导提交。 */
  onCreateSubmit(input: CreateSubmit): void;
  /** 创建向导取消。 */
  onCreateCancel(): void;
  /** 继续确认更换复制方式。 */
  onContinueModeChange(mode: ImportMode): void;
  /** 继续确认打开本机目录。 */
  onContinueDirectoryOpen(path: string): void;
  /** 继续确认提交。 */
  onContinueSubmit(input: ContinueSubmit): void;
  /** 继续确认取消。 */
  onContinueCancel(): void;
  /** 命令面板执行。 */
  onPaletteRun(command: CommandDescriptor): void;
  /** 命令面板关闭。 */
  onPaletteClose(): void;
}

/** 焦点可聚焦元素的选择器。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 在容器内约束焦点循环。
 * @param container - 容器。
 * @param event - 键盘事件。
 */
function trapTab(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * 建一个元素并设置文本。
 * @param tag - 标签名。
 * @param className - 类名。
 * @param text - 文本。
 * @returns 元素。
 */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

/** 创建向导。 */
class CreateWizard {
  private readonly handlers: MainViewHandlers;
  private readonly backdrop: HTMLElement;
  private readonly box: HTMLElement;
  private readonly deviceSelect: HTMLSelectElement;
  private readonly kindSelect: HTMLSelectElement;
  private readonly cwdInput: HTMLInputElement;
  private readonly titleInput: HTMLInputElement;
  private readonly listingBox: HTMLElement;
  private readonly listingNote: HTMLElement;
  private readonly error: HTMLElement;
  private readonly recovery: HTMLElement;
  private readonly createButton: HTMLButtonElement;
  private readonly trigger: HTMLElement | undefined;

  /**
   * @param handlers - 动作。
   * @param trigger - 打开向导的控件。
   */
  constructor(handlers: MainViewHandlers, trigger: HTMLElement | undefined) {
    this.handlers = handlers;
    this.trigger = trigger;
    this.backdrop = element('div', 'shell-dialog-backdrop');
    this.box = element('div', 'shell-dialog');
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-modal', 'true');
    this.box.setAttribute('aria-labelledby', 'shell-create-title');

    const heading = element('h2', 'shell-dialog-title', '新建会话');
    heading.id = 'shell-create-title';

    const deviceLabel = element('label', 'shell-field', '设备');
    this.deviceSelect = element('select', 'shell-create-device');
    deviceLabel.append(this.deviceSelect);

    const kindLabel = element('label', 'shell-field', '类型');
    this.kindSelect = element('select', 'shell-create-kind');
    for (const [value, text] of [
      ['work', '工作会话（需要工作目录）'],
      ['chat', '聊天会话'],
    ] as const) {
      const option = element('option', '', text);
      option.value = value;
      this.kindSelect.append(option);
    }
    kindLabel.append(this.kindSelect);

    const cwdLabel = element('label', 'shell-field', '工作目录');
    this.cwdInput = element('input', 'shell-create-cwd');
    this.cwdInput.type = 'text';
    this.cwdInput.placeholder = '/绝对路径';
    this.cwdInput.id = 'shell-create-cwd';
    const cwdHint = element('p', 'shell-hint', '先选设备再浏览该设备目录，或直接填写绝对路径。');
    cwdLabel.append(this.cwdInput, cwdHint);

    const titleLabel = element('label', 'shell-field', '标题（可选，最多 200 字符）');
    this.titleInput = element('input', 'shell-create-title-input');
    this.titleInput.type = 'text';
    this.titleInput.maxLength = 200;
    titleLabel.append(this.titleInput);

    const listingHead = element('div', 'shell-listing-head');
    const listingTitle = element('p', 'shell-listing-title', '设备目录');
    const listingRefresh = element('button', 'shell-action shell-listing-refresh', '刷新目录');
    listingRefresh.type = 'button';
    listingHead.append(listingTitle, listingRefresh);
    this.listingNote = element('p', 'shell-hint');
    this.listingBox = element('div', 'shell-listing');

    this.error = element('p', 'shell-error');
    this.error.setAttribute('role', 'alert');
    this.recovery = element('p', 'shell-hint shell-recovery');
    this.recovery.setAttribute('role', 'status');
    this.recovery.hidden = true;

    const buttons = element('div', 'shell-dialog-buttons');
    const cancel = element('button', 'shell-action shell-create-cancel', '返回列表');
    cancel.type = 'button';
    this.createButton = element('button', 'shell-action shell-create-submit', '创建');
    this.createButton.type = 'button';
    buttons.append(cancel, this.createButton);

    this.box.append(
      heading,
      deviceLabel,
      kindLabel,
      cwdLabel,
      titleLabel,
      listingHead,
      this.listingNote,
      this.listingBox,
      this.recovery,
      this.error,
      buttons
    );
    this.backdrop.append(this.box);

    this.deviceSelect.addEventListener('change', () => this.handlers.onCreateDeviceChange(this.deviceSelect.value));
    listingRefresh.addEventListener('click', () => this.handlers.onCreateDirectoryRefresh());
    cancel.addEventListener('click', () => this.handlers.onCreateCancel());
    this.createButton.addEventListener('click', () => this.submit());
    this.box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.handlers.onCreateCancel();
        return;
      }
      trapTab(this.box, event);
    });
  }

  /** 根元素。 */
  get element(): HTMLElement {
    return this.backdrop;
  }

  /** 提交。 */
  private submit(): void {
    const deviceId = this.deviceSelect.value;
    const kind = this.kindSelect.value === 'chat' ? 'chat' : 'work';
    const cwd = this.cwdInput.value.trim();
    const title = this.titleInput.value.trim();
    if (kind === 'work' && cwd === '') {
      this.setError('工作会话必须填写工作目录。');
      this.cwdInput.setAttribute('aria-invalid', 'true');
      this.cwdInput.focus();
      return;
    }
    this.cwdInput.removeAttribute('aria-invalid');
    this.handlers.onCreateSubmit({ deviceId, kind, cwd, title });
  }

  /**
   * 写失败原因。
   * @param message - 原因。
   */
  setError(message: string): void {
    this.error.textContent = message;
  }

  /**
   * 渲染。
   * @param input - 数据。
   */
  render(input: CreateWizardInput): void {
    this.deviceSelect.replaceChildren(
      ...input.devices.map((device) => {
        const option = element('option', '', device.online ? device.name : `${device.name}（离线）`);
        option.value = device.id;
        option.disabled = !device.online;
        return option;
      })
    );
    if (input.deviceId !== undefined) this.deviceSelect.value = input.deviceId;
    const created = input.createdSessionId;
    this.createButton.disabled = input.busy || this.deviceSelect.value === '';
    this.createButton.textContent =
      created === undefined ? (input.busy ? '创建中…' : '创建') : input.busy ? '登记中…' : '重新登记归属';
    this.recovery.hidden = created === undefined;
    this.recovery.textContent =
      created === undefined
        ? ''
        : `会话已创建：${created}。再次提交只重新登记归属，不会新建会话。`;
    this.error.textContent = input.error ?? '';
    this.error.hidden = input.error === undefined;
    this.cwdInput.disabled = input.busy;
    this.kindSelect.disabled = input.busy;
    this.titleInput.disabled = input.busy;
    this.deviceSelect.disabled = input.busy;
    this.renderListing(input);
  }

  /**
   * 渲染目录列举。
   * @param input - 数据。
   */
  private renderListing(input: CreateWizardInput): void {
    this.listingBox.replaceChildren();
    if (input.listingError !== undefined) {
      this.listingNote.textContent = input.listingError;
      return;
    }
    const listing = input.listing;
    if (listing === undefined) {
      this.listingNote.textContent = input.listingBusy ? '正在读取目录…' : '尚未读取目录。';
      return;
    }
    this.listingNote.textContent = listing.truncated
      ? `当前位置：${listing.path}（目录过多，只列出前一部分）`
      : `当前位置：${listing.path}`;
    const crumbs = element('div', 'shell-crumbs');
    for (const crumb of listing.crumbs) {
      const button = element('button', 'shell-crumb', crumb.name === '' ? '/' : crumb.name);
      button.type = 'button';
      button.dataset['path'] = crumb.path;
      button.addEventListener('click', () => this.handlers.onCreateDirectoryOpen(crumb.path));
      crumbs.append(button);
    }
    this.listingBox.append(crumbs);
    const entries = element('ul', 'shell-listing-entries');
    entries.setAttribute('aria-label', '目录内容');
    for (const entry of listing.entries) {
      const item = element('li', '');
      const button = element('button', 'shell-listing-entry', entry.hidden ? `${entry.name}（隐藏）` : entry.name);
      button.type = 'button';
      button.dataset['path'] = entry.path;
      button.addEventListener('click', () => {
        this.cwdInput.value = entry.path;
        this.handlers.onCreateDirectoryOpen(entry.path);
      });
      item.append(button);
      entries.append(item);
    }
    this.listingBox.append(entries);
  }

  /** 关闭并恢复焦点。 */
  close(): void {
    this.backdrop.remove();
    this.trigger?.focus();
  }

  /** 把焦点放到第一个可操作控件。 */
  focusFirst(): void {
    const kind = this.kindSelect;
    kind.focus();
  }

  /**
   * 填入工作目录。
   * @param path - 目录路径。
   */
  setCwd(path: string): void {
    this.cwdInput.value = path;
  }
}

/** 继续确认。 */
class ContinueDialog {
  private readonly handlers: MainViewHandlers;
  private readonly backdrop: HTMLElement;
  private readonly box: HTMLElement;
  private readonly source: HTMLElement;
  private readonly estimateBox: HTMLElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly cwdInput: HTMLInputElement;
  private readonly listingBox: HTMLElement;
  private readonly listingNote: HTMLElement;
  private readonly error: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly remoteButton: HTMLButtonElement;
  private readonly remoteNote: HTMLElement;
  private readonly localBox: HTMLElement;
  private readonly localReason: HTMLElement;
  private readonly trigger: HTMLElement | undefined;

  /**
   * @param handlers - 动作。
   * @param trigger - 打开确认的控件。
   */
  constructor(handlers: MainViewHandlers, trigger: HTMLElement | undefined) {
    this.handlers = handlers;
    this.trigger = trigger;
    this.backdrop = element('div', 'shell-dialog-backdrop');
    this.box = element('div', 'shell-dialog');
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-modal', 'true');
    this.box.setAttribute('aria-labelledby', 'shell-continue-title');

    const heading = element('h2', 'shell-dialog-title', '继续会话');
    heading.id = 'shell-continue-title';
    this.source = element('p', 'shell-hint');
    this.estimateBox = element('div', 'shell-estimate');
    this.estimateBox.setAttribute('aria-live', 'polite');

    const remoteBox = element('section', 'shell-continue-section');
    const remoteTitle = element('h3', '', '在远程继续');
    this.remoteNote = element('p', 'shell-hint');
    this.remoteButton = element('button', 'shell-action shell-continue-remote-confirm', '在远程继续');
    this.remoteButton.type = 'button';
    this.remoteButton.addEventListener('click', () => this.handlers.onContinueRemote());
    remoteBox.append(remoteTitle, this.remoteNote, this.remoteButton);

    this.localBox = element('section', 'shell-continue-section');
    const localTitle = element('h3', '', '在本机继续');
    const localNote = element('p', 'shell-hint', '在本机运行时新建一条会话，新会话保存源会话作为血缘来源。');
    const modeLabel = element('label', 'shell-field', '复制方式');
    this.modeSelect = element('select', 'shell-continue-mode');
    for (const mode of ['full-prefix', 'compressed'] as const) {
      const option = element('option', '', IMPORT_MODE_LABELS[mode]);
      option.value = mode;
      this.modeSelect.append(option);
    }
    modeLabel.append(this.modeSelect);
    const cwdLabel = element('label', 'shell-field', '本机工作目录');
    this.cwdInput = element('input', 'shell-continue-cwd');
    this.cwdInput.type = 'text';
    this.cwdInput.placeholder = '/绝对路径';
    cwdLabel.append(this.cwdInput);
    const listingHead = element('div', 'shell-listing-head');
    const listingTitle = element('p', 'shell-listing-title', '本机目录');
    const listingRefresh = element('button', 'shell-action shell-listing-refresh', '刷新目录');
    listingRefresh.type = 'button';
    listingRefresh.addEventListener('click', () => this.handlers.onContinueDirectoryOpen(this.cwdInput.value.trim()));
    listingHead.append(listingTitle, listingRefresh);
    this.listingNote = element('p', 'shell-hint');
    this.listingBox = element('div', 'shell-listing');
    this.submitButton = element('button', 'shell-action shell-continue-submit', '在本机继续');
    this.submitButton.type = 'button';
    this.submitButton.addEventListener('click', () => {
      const cwd = this.cwdInput.value.trim();
      if (cwd === '') {
        this.setError('请选择或填写本机目录。');
        this.cwdInput.focus();
        return;
      }
      this.handlers.onContinueSubmit({
        mode: 'local',
        importMode: this.modeSelect.value === 'compressed' ? 'compressed' : 'full-prefix',
        cwd,
      });
    });
    this.modeSelect.addEventListener('change', () =>
      this.handlers.onContinueModeChange(this.modeSelect.value === 'compressed' ? 'compressed' : 'full-prefix')
    );
    this.localReason = element('p', 'shell-hint');
    this.localReason.hidden = true;
    this.localBox.append(
      localTitle,
      localNote,
      this.localReason,
      modeLabel,
      cwdLabel,
      listingHead,
      this.listingNote,
      this.listingBox,
      this.submitButton
    );

    this.error = element('p', 'shell-error');
    this.error.setAttribute('role', 'alert');

    const buttons = element('div', 'shell-dialog-buttons');
    const cancel = element('button', 'shell-action shell-continue-cancel', '返回');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.handlers.onContinueCancel());
    buttons.append(cancel);

    this.box.append(heading, this.source, this.estimateBox, remoteBox, this.localBox, this.error, buttons);
    this.backdrop.append(this.box);
    this.box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.handlers.onContinueCancel();
        return;
      }
      trapTab(this.box, event);
    });
  }

  /** 根元素。 */
  get element(): HTMLElement {
    return this.backdrop;
  }

  /**
   * 写失败原因。
   * @param message - 原因。
   */
  setError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = message === '';
  }

  /**
   * 渲染。
   * @param input - 数据。
   */
  render(input: ContinueDialogInput): void {
    this.source.textContent = `源会话：${input.sourceTitle} · ${input.sourceDeviceLabel}${
      input.sourceOnline ? '' : '（离线，使用控制平面副本）'
    }`;
    this.estimateBox.replaceChildren();
    if (input.estimate === undefined) {
      this.estimateBox.append(
        element('p', 'shell-error', input.estimateError ?? '正在读取副本并计算预估…')
      );
    } else {
      const rows: [string, string][] = [
        ['复制事件', `${String(input.estimate.eventCount)} 条`],
        ['复制字符', `${String(input.estimate.charCount)} 字符`],
        [
          '附件',
          input.estimate.missingAttachmentIds.length === 0
            ? '全部可用'
            : `${String(input.estimate.missingAttachmentIds.length)} 个需要源设备`,
        ],
        ['压缩损失', input.estimate.compressionLoss ? '会丢失工具输出原文' : '无'],
        ['副本状态', input.estimate.sourceState === 'complete' ? '完整' : '部分（源设备离线）'],
      ];
      const list = element('dl', 'shell-estimate-list');
      for (const [key, value] of rows) {
        list.append(element('dt', '', key), element('dd', '', value));
      }
      this.estimateBox.append(list);
    }
    this.remoteNote.textContent = input.sourceOnline
      ? '在源设备上打开原会话，会话编号不变。'
      : '源设备离线：远程继续不可用，可以从控制平面副本在本机新建分支。';
    this.remoteButton.disabled = !input.sourceOnline;

    this.modeSelect.value = input.importMode;
    this.localBox.dataset['available'] = input.localAvailable ? 'true' : 'false';
    this.localReason.hidden = input.localAvailable;
    this.localReason.textContent = input.localAvailable ? '' : (input.localReason ?? '本机运行时不可用');
    this.modeSelect.disabled = !input.localAvailable || input.busy;
    this.cwdInput.disabled = !input.localAvailable || input.busy;
    this.submitButton.disabled = !input.localAvailable || input.busy || input.estimate === undefined;
    this.submitButton.textContent = input.busy ? '正在本机继续…' : '在本机继续';
    this.error.textContent = input.error ?? '';
    this.error.hidden = input.error === undefined;
    this.renderListing(input);
  }

  /**
   * 渲染本机目录。
   * @param input - 数据。
   */
  private renderListing(input: ContinueDialogInput): void {
    this.listingBox.replaceChildren();
    if (input.listingError !== undefined) {
      this.listingNote.textContent = input.listingError;
      return;
    }
    const listing = input.listing;
    if (listing === undefined) {
      this.listingNote.textContent = input.listingBusy ? '正在读取本机目录…' : '尚未读取本机目录。';
      return;
    }
    this.listingNote.textContent = `当前位置：${listing.path}`;
    const entries = element('ul', 'shell-listing-entries');
    entries.setAttribute('aria-label', '本机目录内容');
    for (const entry of listing.entries) {
      const item = element('li', '');
      const button = element('button', 'shell-listing-entry', entry.name);
      button.type = 'button';
      button.addEventListener('click', () => {
        this.cwdInput.value = entry.path;
        this.handlers.onContinueDirectoryOpen(entry.path);
      });
      item.append(button);
      entries.append(item);
    }
    this.listingBox.append(entries);
  }

  /** 关闭并恢复焦点。 */
  close(): void {
    this.backdrop.remove();
    this.trigger?.focus();
  }

  /** 把焦点放到源会话说明上。 */
  focusFirst(): void {
    const target = this.box.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  }

  /**
   * 填入本机目录。
   * @param path - 目录路径。
   */
  setCwd(path: string): void {
    this.cwdInput.value = path;
  }
}

/** 命令面板。 */
class CommandPalette {
  private readonly handlers: MainViewHandlers;
  private readonly backdrop: HTMLElement;
  private readonly box: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly listBox: HTMLElement;
  private readonly empty: HTMLElement;
  private commands: readonly CommandDescriptor[] = [];
  private matches: readonly CommandDescriptor[] = [];
  private index = -1;
  private trigger: HTMLElement | undefined;

  /**
   * @param handlers - 动作。
   */
  constructor(handlers: MainViewHandlers) {
    this.handlers = handlers;
    this.backdrop = element('div', 'shell-dialog-backdrop shell-palette-backdrop');
    this.box = element('div', 'shell-dialog shell-palette');
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-modal', 'true');
    this.box.setAttribute('aria-labelledby', 'shell-palette-title');
    const heading = element('h2', 'shell-dialog-title', '搜索与命令');
    heading.id = 'shell-palette-title';
    const label = element('label', 'shell-visually-hidden', '搜索命令');
    label.htmlFor = 'shell-palette-input';
    this.input = element('input', 'shell-palette-input');
    this.input.id = 'shell-palette-input';
    this.input.type = 'text';
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', 'shell-palette-list');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.listBox = element('ul', 'shell-palette-list');
    this.listBox.id = 'shell-palette-list';
    this.listBox.setAttribute('role', 'listbox');
    this.listBox.setAttribute('aria-labelledby', 'shell-palette-title');
    this.empty = element('p', 'shell-hint shell-palette-empty');
    this.empty.hidden = true;
    const hint = element('p', 'shell-hint', '方向键选择，Enter 执行，Escape 关闭。');
    this.box.append(heading, label, this.input, this.listBox, this.empty, hint);
    this.backdrop.append(this.box);

    this.input.addEventListener('input', () => this.refilter());
    this.box.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.backdrop.addEventListener('mousedown', (event) => {
      if (event.target === this.backdrop) this.handlers.onPaletteClose();
    });
  }

  /** 根元素。 */
  get element(): HTMLElement {
    return this.backdrop;
  }

  /**
   * 键盘处理。
   * @param event - 键盘事件。
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.handlers.onPaletteClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = this.matches[this.index];
      if (selected !== undefined) this.handlers.onPaletteRun(selected);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (this.matches.length === 0) return;
      const next =
        event.key === 'ArrowDown'
          ? (this.index + 1) % this.matches.length
          : event.key === 'ArrowUp'
            ? (this.index - 1 + this.matches.length) % this.matches.length
            : event.key === 'Home'
              ? 0
              : this.matches.length - 1;
      this.index = next;
      this.paintSelection();
      return;
    }
    trapTab(this.box, event);
  }

  /**
   * 重新过滤并渲染。
   */
  private refilter(): void {
    const needle = this.input.value.trim().toLowerCase();
    this.matches = this.commands.filter((command) => {
      if (needle === '') return true;
      return [command.name, command.group, command.description ?? ''].join('\n').toLowerCase().includes(needle);
    });
    this.index = this.matches.length === 0 ? -1 : 0;
    this.renderList();
    this.paintSelection();
    this.empty.hidden = this.matches.length > 0;
    this.empty.textContent = this.matches.length === 0 ? '没有匹配的命令，按 Escape 关闭后重试。' : '';
  }

  /**
   * 渲染列表。
   */
  private renderList(): void {
    this.listBox.replaceChildren(
      ...this.matches.map((command, position) => {
        const item = element('li', 'shell-palette-item');
        item.setAttribute('role', 'option');
        item.id = `shell-palette-option-${String(position)}`;
        item.setAttribute('aria-selected', 'false');
        item.dataset['commandId'] = command.id;
        if (command.enabled) {
          item.tabIndex = -1;
        } else {
          item.setAttribute('aria-disabled', 'true');
        }
        const name = element('span', 'shell-palette-name', command.name);
        const group = element('span', 'shell-palette-group', command.group);
        item.append(name, group);
        if (command.shortcut !== undefined) item.append(element('span', 'shell-palette-shortcut', command.shortcut));
        if (!command.enabled && command.disabledReason !== undefined) {
          item.append(element('span', 'shell-palette-reason', command.disabledReason));
        }
        item.addEventListener('click', () => {
          if (!command.enabled) return;
          this.handlers.onPaletteRun(command);
        });
        return item;
      })
    );
  }

  /** 标出当前选中项。 */
  private paintSelection(): void {
    const items = [...this.listBox.querySelectorAll<HTMLElement>('[role="option"]')];
    items.forEach((item, position) => {
      const selected = position === this.index;
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      item.classList.toggle('shell-palette-item-selected', selected);
    });
    const active = items[this.index];
    if (active !== undefined) {
      this.input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * 打开面板。
   * @param input - 数据。
   */
  open(input: PaletteInput): void {
    this.commands = input.commands;
    this.trigger = input.trigger;
    this.input.value = '';
    this.refilter();
    this.backdrop.hidden = false;
  }

  /** 关闭并恢复焦点。 */
  close(): void {
    this.backdrop.hidden = true;
    this.trigger?.focus();
    this.trigger = undefined;
  }

  /** 把焦点放到搜索框。 */
  focus(): void {
    this.input.focus();
  }
}

/** 右栏视图。 */
export class ShellMainView {
  /** 主区域根元素。 */
  readonly element: HTMLElement;

  private readonly handlers: MainViewHandlers;
  private readonly actionBar: HTMLElement;
  private readonly remoteButton: HTMLButtonElement;
  private readonly localButton: HTMLButtonElement;
  private readonly actionNote: HTMLElement;
  private readonly content: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private readonly frameNote: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly placeholder: HTMLElement;
  private readonly readonlyPanel: HTMLElement;
  private readonly readonlyBody: HTMLElement;
  private readonly draftPanel: HTMLElement;
  private readonly draftInput: HTMLTextAreaElement;
  private readonly draftStatus: HTMLElement;
  private readonly draftSend: HTMLButtonElement;
  private readonly statusPanel: HTMLElement;
  private readonly settingsPanel: HTMLElement;
  private readonly diagnosticsPanel: HTMLElement;
  private readonly errorPanel: HTMLElement;
  private readonly overlay: HTMLElement;
  private createWizard: CreateWizard | undefined;
  private continueDialog: ContinueDialog | undefined;
  private palette: CommandPalette | undefined;
  private pendingNavigation:
    | { readonly requestId: string; readonly settle: (outcome: NavigationOutcome) => void }
    | undefined;

  /**
   * @param handlers - 动作。
   */
  constructor(handlers: MainViewHandlers) {
    this.handlers = handlers;
    const main = element('main', 'shell-frame');
    main.id = 'shell-main';
    main.tabIndex = -1;
    this.element = main;

    this.actionBar = element('div', 'shell-actions');
    this.remoteButton = element('button', 'shell-action shell-continue-remote', '在远程继续');
    this.remoteButton.type = 'button';
    this.remoteButton.addEventListener('click', () => this.handlers.onContinueRemote());
    this.localButton = element('button', 'shell-action shell-continue-local', '在本机继续');
    this.localButton.type = 'button';
    this.localButton.addEventListener('click', () => this.handlers.onContinueLocal());
    this.actionNote = element('span', 'shell-action-note');
    this.actionBar.append(this.remoteButton, this.localButton, this.actionNote);
    this.actionBar.hidden = true;

    this.placeholder = element('p', 'shell-placeholder', '从左边选一条会话');
    this.statusPanel = element('div', 'shell-status-panel');
    this.statusPanel.setAttribute('role', 'status');
    this.statusPanel.setAttribute('aria-live', 'polite');
    this.statusPanel.hidden = true;

    this.content = element('div', 'shell-content');
    this.frame = document.createElement('iframe');
    this.frame.className = 'shell-iframe';
    this.frame.title = '会话内容';
    this.frame.hidden = true;
    this.frame.addEventListener('load', () => {
      this.frame.dataset['loaded'] = 'true';
    });
    this.frameNote = element('p', 'shell-frame-note');
    this.frameNote.setAttribute('role', 'status');
    this.frameNote.hidden = true;
    this.retryButton = element('button', 'shell-action shell-retry-navigation', '重试打开会话');
    this.retryButton.type = 'button';
    this.retryButton.hidden = true;
    this.retryButton.addEventListener('click', () => this.handlers.onRetryNavigation());

    this.readonlyPanel = element('section', 'shell-readonly');
    this.readonlyPanel.hidden = true;
    this.readonlyPanel.setAttribute('aria-label', '只读副本');
    this.readonlyBody = element('div', 'shell-readonly-body');

    this.draftPanel = element('section', 'shell-draft');
    this.draftPanel.hidden = true;
    this.draftPanel.setAttribute('aria-label', '草稿');
    const draftLabel = element('label', 'shell-field', '继续输入（离线时只保存在本机）');
    this.draftInput = element('textarea', 'shell-draft-input');
    this.draftInput.rows = 3;
    this.draftInput.id = 'shell-draft-input';
    draftLabel.append(this.draftInput);
    const draftActions = element('div', 'shell-draft-actions');
    this.draftStatus = element('span', 'shell-draft-status');
    this.draftSend = element('button', 'shell-action shell-draft-send', '发送');
    this.draftSend.type = 'button';
    this.draftSend.addEventListener('click', () => this.handlers.onDraftSend());
    draftActions.append(this.draftStatus, this.draftSend);
    this.draftPanel.append(draftLabel, draftActions);
    this.draftInput.addEventListener('input', () => this.handlers.onDraftInput(this.draftInput.value));

    this.content.append(
      this.frameNote,
      this.retryButton,
      this.frame,
      this.readonlyPanel,
      this.draftPanel,
      this.statusPanel,
      this.placeholder
    );
    this.readonlyPanel.append(this.readonlyBody);

    this.settingsPanel = element('section', 'shell-page');
    this.settingsPanel.hidden = true;
    this.diagnosticsPanel = element('section', 'shell-page');
    this.diagnosticsPanel.hidden = true;
    this.errorPanel = element('section', 'shell-page shell-route-error');
    this.errorPanel.hidden = true;
    this.overlay = element('div', 'shell-overlays');

    main.append(this.actionBar, this.content, this.settingsPanel, this.diagnosticsPanel, this.errorPanel, this.overlay);

    window.addEventListener('message', (event) => this.onFrameMessage(event));
  }

  /**
   * 处理来自内容端的选择确认。
   * @param event - 消息事件。
   */
  private onFrameMessage(event: MessageEvent): void {
    const pending = this.pendingNavigation;
    if (pending === undefined) return;
    if (event.source !== this.frame.contentWindow) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data as Record<string, unknown> | undefined;
    if (typeof data !== 'object' || data === null) return;
    const outcome = data['outcome'];
    const requestId = data['requestId'];
    if (typeof requestId !== 'string' || requestId !== pending.requestId) return;
    this.pendingNavigation = undefined;
    if (outcome === 'selected') {
      this.frameNote.textContent = '';
      this.frameNote.hidden = true;
      this.retryButton.hidden = true;
      pending.settle({ outcome: 'selected' });
      return;
    }
    if (outcome === 'rejected') {
      const code = typeof data['code'] === 'string' ? data['code'] : 'navigation-rejected';
      this.frameNote.textContent = `打开会话被拒绝：${code}`;
      this.frameNote.hidden = false;
      this.retryButton.hidden = false;
      pending.settle({ outcome: 'rejected', code });
    }
  }

  /**
   * 等内容端页面装载完成。
   *
   * 页面尚未装载时消息会落到 `about:blank`，内容端收不到；这里等到 `load` 或导航时限。
   * @returns 页面已经装载时为真。
   */
  private async waitForFrame(): Promise<boolean> {
    if (this.frame.dataset['loaded'] === 'true') return true;
    return await new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        window.clearTimeout(timer);
        this.frame.removeEventListener('load', onLoad);
        resolve(value);
      };
      const onLoad = (): void => finish(true);
      const timer = window.setTimeout(() => finish(this.frame.dataset['loaded'] === 'true'), NAVIGATION_TIMEOUT_MS);
      this.frame.addEventListener('load', onLoad);
    });
  }

  /**
   * 请求内容端打开指定会话。
   *
   * 消息携带协议版本、请求标识、目标设备与会话；确认必须来自同一个 iframe、同源，并回报
   * 同一个请求标识。没有确认时按超时处理，界面提供重试。
   * @param deviceId - 目标设备。
   * @param sessionId - 目标会话。
   * @returns 结论；超时表示内容端没有确认。
   */
  async requestSessionSelection(deviceId: string, sessionId: string): Promise<NavigationOutcome> {
    if (!(await this.waitForFrame())) return { outcome: 'timeout' };
    const frameWindow = this.frame.contentWindow;
    if (frameWindow === null) return { outcome: 'timeout' };
    this.pendingNavigation?.settle({ outcome: 'timeout' });
    this.pendingNavigation = undefined;
    const requestId = crypto.randomUUID();
    this.frameNote.textContent = '正在打开指定会话…';
    this.frameNote.hidden = false;
    this.retryButton.hidden = true;
    const message = { action: 'navigate', version: NAVIGATION_VERSION, requestId, deviceId, sessionId };
    const outcome = await new Promise<NavigationOutcome>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.pendingNavigation?.requestId !== requestId) return;
        this.pendingNavigation = undefined;
        this.frameNote.textContent = '内容端没有确认打开指定会话。';
        this.retryButton.hidden = false;
        resolve({ outcome: 'timeout' });
      }, NAVIGATION_TIMEOUT_MS);
      this.pendingNavigation = {
        requestId,
        settle: (settled) => {
          window.clearTimeout(timer);
          resolve(settled);
        },
      };
      // 先登记等待再发消息：确认可能在同一个任务里就回来。
      frameWindow.postMessage(message, window.location.origin);
    });
    return outcome;
  }

  /**
   * 渲染选中会话所在的右栏。
   * @param input - 会话数据。
   */
  renderSession(input: SessionPaneInput): void {
    this.actionBar.hidden = false;
    this.placeholder.hidden = true;
    this.statusPanel.hidden = true;
    this.settingsPanel.hidden = true;
    this.diagnosticsPanel.hidden = true;
    this.errorPanel.hidden = true;
    this.remoteButton.disabled = false;
    this.localButton.disabled = false;
    this.actionNote.textContent = input.note;
    this.frame.title = `会话：${input.title} · ${input.deviceLabel}`;
    this.frame.setAttribute('aria-label', this.frame.title);
    if (input.online) {
      const src = `/d/${encodeURIComponent(input.deviceId)}/`;
      if (this.frame.getAttribute('src') !== src) {
        this.frame.dataset['loaded'] = 'false';
        this.frame.setAttribute('src', src);
      }
      this.frame.hidden = false;
      this.readonlyPanel.hidden = true;
      this.draftPanel.hidden = true;
      return;
    }
    this.frame.removeAttribute('src');
    this.frame.dataset['loaded'] = 'false';
    this.frame.hidden = true;
    this.frameNote.hidden = true;
    this.retryButton.hidden = true;
    this.draftPanel.hidden = false;
  }

  /**
   * 渲染只读副本。
   * @param input - 副本数据。
   */
  renderReadonly(input: ReadonlyPaneInput): void {
    this.readonlyPanel.hidden = false;
    this.readonlyBody.replaceChildren();
    const heading = element('h2', 'shell-page-title', '只读副本');
    this.readonlyBody.append(heading);
    if (input.missing) {
      this.readonlyBody.append(
        element('p', 'shell-notice', '该会话没有保存可读内容：控制平面上没有副本。'),
        element('p', 'shell-hint', `原因：${input.reason}`)
      );
      return;
    }
    this.readonlyBody.append(
      element('p', 'shell-hint', `只读原因：${input.reason}`),
      element('p', 'shell-hint', `内容读取于 ${new Date(input.readAt).toLocaleString()}，共 ${String(input.eventCount)} 条事件。`)
    );
    const list = element('ol', 'shell-readonly-excerpts');
    for (const text of input.excerpts) {
      list.append(element('li', '', text));
    }
    this.readonlyBody.append(list);
    this.readonlyBody.append(
      element('p', 'shell-hint', '只读副本只显示最近的内容片段；完整内容与会话输入由会话界面提供。')
    );
  }

  /**
   * 写草稿文本与状态。
   * @param text - 文本。
   * @param status - 保存状态。
   */
  setDraft(text: string, status: string): void {
    if (this.draftInput.value !== text && document.activeElement !== this.draftInput) this.draftInput.value = text;
    this.draftStatus.textContent = status;
  }

  /**
   * 读草稿文本。
   * @returns 文本。
   */
  getDraftText(): string {
    return this.draftInput.value;
  }

  /**
   * 写离线发送的结果。
   * @param message - 说明。
   * @param tone - 语调。
   */
  setDraftMessage(message: string, tone: 'ok' | 'error'): void {
    this.draftStatus.textContent = message;
    this.draftStatus.className = tone === 'error' ? 'shell-draft-status shell-error' : 'shell-draft-status';
  }

  /**
   * 渲染设置区段页面。
   * @param section - 区段。
   * @param title - 区段中文名。
   */
  renderSettings(section: string, title: string): void {
    this.hideSessionPanes();
    this.settingsPanel.hidden = false;
    this.settingsPanel.replaceChildren(
      element('h2', 'shell-page-title', `设置：${title}`),
      element('p', 'shell-hint', `当前区段标识：${section}`),
      element('p', 'shell-hint', '该区段的具体表单由设置界面提供；外壳负责路由、深链接与返回列表。')
    );
    const back = element('button', 'shell-action shell-return-list', '返回会话列表');
    back.type = 'button';
    back.addEventListener('click', () => this.handlers.onReturnList());
    this.settingsPanel.append(back);
  }

  /**
   * 渲染公开快照入口。
   * @param token - 快照令牌。
   */
  renderShare(token: string): void {
    this.hideSessionPanes();
    const panel = this.settingsPanel;
    panel.hidden = false;
    panel.replaceChildren(
      element('h2', 'shell-page-title', '公开快照'),
      element('p', 'shell-hint', '公开快照是匿名只读页面，由控制平面直接渲染。'),
      element('p', 'shell-hint', `令牌：${token}`)
    );
    const link = element('a', 'shell-action', '打开公开快照');
    link.href = `/s/${encodeURIComponent(token)}`;
    link.rel = 'noreferrer';
    const back = element('button', 'shell-action shell-return-list', '返回会话列表');
    back.type = 'button';
    back.addEventListener('click', () => this.handlers.onReturnList());
    panel.append(link, back);
  }

  /**
   * 渲染诊断页面。
   * @param rows - 诊断项。
   */
  renderDiagnostics(rows: readonly [string, string][]): void {
    this.hideSessionPanes();
    this.diagnosticsPanel.hidden = false;
    this.diagnosticsPanel.replaceChildren(element('h2', 'shell-page-title', '诊断'));
    const list = element('dl', 'shell-estimate-list');
    for (const [key, value] of rows) {
      list.append(element('dt', '', key), element('dd', '', value));
    }
    this.diagnosticsPanel.append(
      list,
      element('p', 'shell-hint', '控制平面、设备连接与遥测状态的详细视图由诊断界面提供。')
    );
    const back = element('button', 'shell-action shell-return-list', '返回会话列表');
    back.type = 'button';
    back.addEventListener('click', () => this.handlers.onReturnList());
    this.diagnosticsPanel.append(back);
  }

  /**
   * 渲染路由错误。
   * @param message - 原因。
   */
  renderRouteError(message: string): void {
    this.hideSessionPanes();
    this.errorPanel.hidden = false;
    this.errorPanel.replaceChildren(
      element('h2', 'shell-page-title', '无法打开该地址'),
      element('p', 'shell-error', message),
      element('p', 'shell-hint', '地址里的对象不存在或路径不受支持。')
    );
    const back = element('button', 'shell-action shell-return-list', '返回会话列表');
    back.type = 'button';
    back.addEventListener('click', () => this.handlers.onReturnList());
    this.errorPanel.append(back);
    back.focus();
  }

  /** 隐藏全部内容面板。 */
  private hideSessionPanes(): void {
    this.actionBar.hidden = true;
    this.placeholder.hidden = true;
    this.frame.hidden = true;
    this.frameNote.hidden = true;
    this.retryButton.hidden = true;
    this.readonlyPanel.hidden = true;
    this.draftPanel.hidden = true;
    this.settingsPanel.hidden = true;
    this.diagnosticsPanel.hidden = true;
    this.errorPanel.hidden = true;
    this.statusPanel.hidden = true;
  }

  /**
   * 渲染等待状态。
   * @param message - 说明。
   */
  renderPending(message: string): void {
    this.hideSessionPanes();
    this.placeholder.hidden = true;
    this.statusPanel.hidden = false;
    this.statusPanel.textContent = message;
  }

  /**
   * 处理在远程继续按钮的可用性与说明。
   * @param enabled - 是否可用。
   * @param note - 说明。
   */
  setRemoteContinue(enabled: boolean, note: string): void {
    this.remoteButton.disabled = !enabled;
    this.remoteButton.title = note;
  }

  /**
   * 处理在本机继续按钮的可用性与说明。
   * @param enabled - 是否可用。
   * @param note - 说明。
   */
  setLocalContinue(enabled: boolean, note: string): void {
    this.localButton.disabled = !enabled;
    this.localButton.title = note;
  }

  /**
   * 打开创建向导。
   * @param input - 数据。
   */
  openCreateWizard(input: CreateWizardInput): void {
    this.createWizard?.close();
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.createWizard = new CreateWizard(this.handlers, trigger);
    this.overlay.append(this.createWizard.element);
    this.createWizard.render(input);
    this.createWizard.focusFirst();
  }

  /**
   * 更新创建向导。
   * @param input - 数据。
   */
  updateCreateWizard(input: CreateWizardInput): void {
    this.createWizard?.render(input);
  }

  /** 关闭创建向导。 */
  closeCreateWizard(): void {
    this.createWizard?.close();
    this.createWizard = undefined;
  }

  /**
   * 打开继续确认。
   * @param input - 数据。
   */
  openContinueDialog(input: ContinueDialogInput): void {
    this.continueDialog?.close();
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.continueDialog = new ContinueDialog(this.handlers, trigger);
    this.overlay.append(this.continueDialog.element);
    this.continueDialog.render(input);
    this.continueDialog.focusFirst();
  }

  /**
   * 更新继续确认。
   * @param input - 数据。
   */
  updateContinueDialog(input: ContinueDialogInput): void {
    this.continueDialog?.render(input);
  }

  /** 关闭继续确认。 */
  closeContinueDialog(): void {
    this.continueDialog?.close();
    this.continueDialog = undefined;
  }

  /**
   * 打开命令面板。
   * @param input - 数据。
   */
  openPalette(input: PaletteInput): void {
    if (this.palette === undefined) {
      this.palette = new CommandPalette(this.handlers);
      this.overlay.append(this.palette.element);
    }
    this.palette.open(input);
    this.palette.focus();
  }

  /** 关闭命令面板。 */
  closePalette(): void {
    this.palette?.close();
  }

  /** 命令面板是否打开。 */
  get paletteOpen(): boolean {
    return this.palette !== undefined && !this.palette.element.hidden;
  }

  /** 是否有模态层打开。 */
  get dialogOpen(): boolean {
    return this.createWizard !== undefined || this.continueDialog !== undefined;
  }

  /**
   * 把创建向导的工作目录填成目录浏览的当前位置。
   * @param path - 目录路径。
   */
  setCreateCwd(path: string): void {
    this.createWizard?.setCwd(path);
  }

  /**
   * 把继续确认的本机目录填成目录浏览的当前位置。
   * @param path - 目录路径。
   */
  setContinueCwd(path: string): void {
    this.continueDialog?.setCwd(path);
  }
}
