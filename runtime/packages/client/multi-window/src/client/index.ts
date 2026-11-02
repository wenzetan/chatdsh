/**
 * 第二窗口与分屏的浏览器入口。
 *
 * 一个窗口挂载一次：建立窗口登记、共用运行时、冲突登记与界面骨架。当前上下文来自深链接或
 * 本窗口上次的选择；草稿与拆分布局按窗口标识保存，因此两个窗口互不覆盖。窗口数量增加时
 * 共用运行时仍然只保持一条订阅，新增窗口从持连窗口接收帧。
 *
 * 发送、刷新与打开窗口都经过冲突登记：同一操作标识只写入一次，服务端版本高于本窗口读取
 * 的版本时给出冲突提示与刷新入口。
 * @module @chatdsh/client-multi-window/client
 */

import { ConflictBoard, openConflictBoard, type ConflictNotice } from '../conflicts/board.ts';
import { applySplitKey, clampRatio, decideSplitLayout, DEFAULT_SPLIT_RATIO, type SplitLayout } from '../split/geometry.ts';
import { readSplitRatio, writeSplitRatio } from '../split/memory.ts';
import { createWindowTelemetry, type WindowTelemetry } from '../telemetry.ts';
import { deepLinkPath, deepLinkUrl, parseDeepLink, sameWindowTarget, type WindowTarget } from '../window/deep-link.ts';
import {
  clearWindowDraft,
  draftStorageAvailable,
  readWindowDraft,
  writeWindowDraft,
  type DraftFailureReason,
  type WindowDraftIdentity,
} from '../window/drafts.ts';
import { clientIdentity, randomIdentifier, safeStorage, windowIdentity } from '../window/identifiers.ts';
import { openWindowRegistry, WindowRegistry } from '../window/registry.ts';
import { readWindowSelection, writeWindowSelection } from '../window/selection.ts';
import { openSharedRuntime, SharedRuntime, type RuntimeTransport, type SharedRuntimeRole, type SharedRuntimeState } from '../window/shared-runtime.ts';
import { createMultiWindowPanel, type ActivePane, MultiWindowPanel } from './panel.ts';
import { installMultiWindowStyles } from './styles.ts';

/** 一次对象读取的结果。 */
export interface ObjectSnapshot {
  /** 服务端版本。 */
  readonly revision: number;
  /** 对象正文。 */
  readonly text: string;
}

/** 一次发送的输入。 */
export interface SendInput {
  /** 目标上下文。 */
  readonly target: WindowTarget;
  /** 输入文本。 */
  readonly text: string;
  /** 操作标识，跨窗口复用时只写入一次。 */
  readonly operationId: string;
  /** 写入时基于的服务端版本。 */
  readonly baseRevision: number;
}

/** 一次发送的结果。 */
export interface SendResult {
  /** 写入后的服务端版本。 */
  readonly revision: number;
  /** 服务端结论；缺省按已写入处理。 */
  readonly outcome?: 'applied' | 'handled';
  /** 失败原因码。 */
  readonly code?: string;
}

/** 挂载参数。 */
export interface MultiWindowOptions {
  /** 初始上下文；缺省用本窗口上次的选择。 */
  readonly target?: WindowTarget;
  /** 会话标题；缺省按会话标识生成。 */
  readonly title?: string;
  /** 客户端标识；缺省从本地存储取。 */
  readonly clientId?: string;
  /** 窗口标识；缺省从会话存储取。 */
  readonly windowId?: string;
  /** 本地存储。 */
  readonly localStore?: Storage;
  /** 会话存储。 */
  readonly sessionStore?: Storage;
  /** 窗口登记通道。 */
  readonly registryChannel?: BroadcastChannel | null;
  /** 共用运行时通道。 */
  readonly runtimeChannel?: BroadcastChannel | null;
  /** 冲突登记通道。 */
  readonly conflictChannel?: BroadcastChannel | null;
  /** Web Locks 面。 */
  readonly locks?: LockManager | null;
  /** 真实订阅的建立方式。 */
  readonly transport: RuntimeTransport;
  /**
   * 读取对象内容与服务端版本。
   * @param target - 目标上下文。
   */
  readonly readObject: (target: WindowTarget) => Promise<ObjectSnapshot>;
  /**
   * 写入一次发送。
   * @param input - 发送输入。
   */
  readonly send: (input: SendInput) => Promise<SendResult>;
  /** 打开新窗口；缺省用浏览器的新标签页打开。 */
  readonly openWindow?: (url: string) => void;
  /** 遥测面；缺省建立浏览器侧的遥测面。 */
  readonly telemetry?: WindowTelemetry;
  /** 生成操作标识。 */
  readonly createOperationId?: () => string;
  /** 草稿写入的等待时间，单位毫秒。 */
  readonly draftDebounceMs?: number;
  /** 当前时刻的毫秒时间戳。 */
  readonly now?: () => number;
}

/** 挂载句柄。 */
export interface MultiWindowHandle {
  /** 本窗口标识。 */
  readonly windowId: string;
  /** 客户端标识。 */
  readonly clientId: string;
  /** 窗口登记。 */
  readonly registry: WindowRegistry;
  /** 共用运行时。 */
  readonly runtime: SharedRuntime;
  /** 冲突登记。 */
  readonly conflicts: ConflictBoard;
  /** 当前上下文。 */
  readonly target: WindowTarget;
  /** 当前布局。 */
  layout(): SplitLayout;
  /** 换成另一个上下文。 */
  navigate(target: WindowTarget, title?: string): void;
  /** 发送当前草稿。 */
  submit(): Promise<void>;
  /** 走刷新入口重新读取。 */
  refresh(): Promise<void>;
  /** 卸载。 */
  destroy(): void;
}

/** 草稿写入失败原因的说明。 */
const DRAFT_FAILURE_TEXT: Readonly<Record<DraftFailureReason, string>> = {
  'storage-full': '本地存储空间不足，草稿只在本次停留期间保留',
  'storage-unavailable': '本地存储不可用，草稿只在本次停留期间保留',
  'privacy-mode': '浏览器隐私模式禁止本地存储，草稿只在本次停留期间保留',
};

/** 消息行的保留条数。 */
const MESSAGE_LIMIT = 200;

/** 默认的草稿写入等待时间。 */
const DRAFT_DEBOUNCE_MS = 250;

/** 宽度测量失败时使用的兜底宽度，用于首次渲染。 */
const FALLBACK_WIDTH = 1200;

/** 分隔条宽度，与几何模块保持一致。 */
const SEPARATOR_WIDTH = 8;

/**
 * 把一帧压成一行消息。
 * @param frame - 帧内容。
 * @returns 消息行。
 */
export function frameLine(frame: unknown): string {
  if (typeof frame === 'string') return frame;
  if (typeof frame === 'object' && frame !== null) {
    const record = frame as Record<string, unknown>;
    const text = record['text'];
    if (typeof text === 'string' && text !== '') return text;
    const kind = record['kind'];
    if (typeof kind === 'string' && kind !== '') {
      const appended = record['appended'];
      return typeof appended === 'number' ? `${kind}（${String(appended)} 条）` : kind;
    }
  }
  return '更新';
}

/**
 * 建立对象键。
 * @param target - 上下文。
 * @returns 设备与会话组成的键。
 */
export function objectKeyOf(target: WindowTarget): string {
  return `${target.deviceId}:${target.sessionId}`;
}

/**
 * 启动第二窗口与分屏界面。
 * @param root - 容器元素。
 * @param options - 挂载参数。
 * @returns 挂载句柄。
 */
export function startMultiWindow(root: HTMLElement, options: MultiWindowOptions): MultiWindowHandle {
  const now = options.now ?? (() => Date.now());
  const localStore = options.localStore ?? safeStorage(() => window.localStorage);
  const sessionStore = options.sessionStore ?? safeStorage(() => window.sessionStorage);
  const clientId = options.clientId ?? clientIdentity(localStore, () => `client-${randomIdentifier()}`);
  const windowId = options.windowId ?? windowIdentity(sessionStore, () => `window-${randomIdentifier()}`);
  const telemetry = options.telemetry ?? createWindowTelemetry();
  const createOperationId = options.createOperationId ?? (() => `${windowId}-${randomIdentifier()}`);
  const draftDebounceMs = options.draftDebounceMs ?? DRAFT_DEBOUNCE_MS;
  const uninstallStyles = installMultiWindowStyles(document);

  const restored = readWindowSelection(sessionStore, windowId);
  const initialTarget = options.target ?? restored?.target;
  if (initialTarget === undefined) throw new Error('第二窗口需要初始上下文：深链接或本窗口上次的选择');
  const parsedInitial = parseDeepLink(deepLinkPath(initialTarget));
  if (!parsedInitial.ok) throw new Error(`初始上下文不合法：${parsedInitial.reason}`);
  let target: WindowTarget = parsedInitial.target;
  let title = options.title ?? `会话 ${target.sessionId.slice(0, 8)}`;

  const registry = openWindowRegistry({
    self: { windowId, clientId, target, title, openedAt: now() },
    ...(options.registryChannel === undefined ? {} : { channel: options.registryChannel }),
    now,
  });

  const runtime = openSharedRuntime(windowId, {
    transport: options.transport,
    ...(options.runtimeChannel === undefined ? {} : { channel: options.runtimeChannel }),
    ...(options.locks === undefined ? {} : { locks: options.locks }),
  });

  const conflicts = openConflictBoard({
    windowId,
    ...(options.conflictChannel === undefined ? {} : { channel: options.conflictChannel }),
    now,
  });

  const splitIdentity = { clientId, windowId, deviceId: target.deviceId };
  const measureWidth = (): number => {
    const measured = root.clientWidth;
    return measured > 0 ? measured : FALLBACK_WIDTH;
  };
  let width = measureWidth();
  let ratio = readSplitRatio(localStore, splitIdentity, width);
  let collapsed = false;
  let activePane: ActivePane = 'primary';
  const state = {
    messages: [] as string[],
    paneText: '',
    revision: 0,
    draftText: '',
    draftHint: '',
    conflict: undefined as ConflictNotice | undefined,
    runtimeRole: 'idle' as SharedRuntimeRole,
    runtimeState: 'closed' as SharedRuntimeState,
  };

  const layoutOf = (): SplitLayout => {
    const decided = decideSplitLayout(width, ratio);
    if (decided.mode === 'single' || !collapsed) return decided;
    return { ...decided, mode: 'single', primary: Math.max(width, 0), secondary: 0, separator: 0 };
  };

  const draftIdentity = (): WindowDraftIdentity => ({
    clientId,
    windowId,
    deviceId: target.deviceId,
    sessionId: target.sessionId,
  });

  const pushMessage = (line: string): void => {
    state.messages.push(line);
    if (state.messages.length > MESSAGE_LIMIT) state.messages.splice(0, state.messages.length - MESSAGE_LIMIT);
  };

  let panel: MultiWindowPanel;
  const render = (): void => {
    panel.render({
      windowId,
      target,
      title,
      tabs: registry.tabs(),
      messages: state.messages,
      paneText: state.paneText,
      layout: layoutOf(),
      activePane,
      draftText: state.draftText,
      draftHint: state.draftHint,
      runtimeRole: state.runtimeRole,
      runtimeState: state.runtimeState,
      conflict: state.conflict,
    });
  };

  const restoreDraft = (): void => {
    const record = readWindowDraft(localStore, draftIdentity());
    state.draftText = record?.text ?? '';
    if (record !== undefined) {
      state.draftHint = `已恢复本窗口草稿（版本 ${String(record.revision)}）`;
      return;
    }
    state.draftHint = draftStorageAvailable(localStore) ? '本窗口草稿为空' : DRAFT_FAILURE_TEXT['storage-unavailable'];
  };

  const persistDraft = (): void => {
    const result = writeWindowDraft(localStore, draftIdentity(), state.draftText, now());
    if (result.outcome === 'saved') {
      state.draftHint = `草稿已保存在本窗口（版本 ${String(result.revision)}）`;
    } else {
      state.draftHint = DRAFT_FAILURE_TEXT[result.reason];
      telemetry.failure('draft.save', { name: 'DraftStorageError', code: result.reason });
    }
    render();
  };

  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDraft = (): void => {
    if (draftTimer !== undefined) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      persistDraft();
    }, draftDebounceMs);
  };

  const persistSelection = (): void => {
    writeWindowSelection(sessionStore, windowId, target, 0, now());
  };

  const refreshObject = async (): Promise<void> => {
    try {
      const snapshot = await options.readObject(target);
      state.revision = snapshot.revision;
      state.paneText = snapshot.text;
      conflicts.observeObject(objectKeyOf(target), snapshot.revision);
      conflicts.dismiss(objectKeyOf(target));
      state.conflict = undefined;
      telemetry.command('object.refresh', 'ok');
      render();
    } catch (error) {
      telemetry.command('object.refresh', 'failed', error);
      telemetry.failure('object.refresh', error);
      state.draftHint = '刷新失败，本窗口内容与草稿保持不变';
      render();
      throw error;
    }
  };

  const submit = async (): Promise<void> => {
    const text = state.draftText.trim();
    if (text === '') {
      telemetry.command('message.send', 'rejected');
      state.draftHint = '输入内容为空，没有发送';
      render();
      return;
    }
    const operationId = createOperationId();
    const objectKey = objectKeyOf(target);
    const decision = conflicts.begin({ operationId, objectKey, windowId, baseRevision: state.revision, action: 'send' });
    if (!decision.accepted) {
      state.conflict = decision.notice;
      telemetry.command('message.send', 'conflict');
      render();
      return;
    }
    try {
      const result = await options.send({ target, text, operationId, baseRevision: state.revision });
      const outcome = result.outcome ?? 'applied';
      conflicts.settle(operationId, { outcome, revision: result.revision });
      if (outcome === 'handled') {
        state.conflict = conflicts.noticeOf(objectKey);
        telemetry.command('message.send', 'conflict');
        render();
        return;
      }
      state.revision = result.revision;
      conflicts.observeObject(objectKey, result.revision);
      pushMessage(`我：${text}`);
      state.draftText = '';
      clearWindowDraft(localStore, draftIdentity());
      state.draftHint = '已发送并写入服务端';
      telemetry.command('message.send', 'ok');
      render();
    } catch (error) {
      telemetry.command('message.send', 'failed', error);
      telemetry.failure('message.send', error);
      state.draftHint = '发送失败，本窗口草稿已保留';
      render();
    }
  };

  const openWindow = (): void => {
    if (!registry.canOpenMore()) {
      telemetry.command('window.open', 'rejected');
      telemetry.action('window.open', 'rejected');
      state.draftHint = '窗口数量已到上限，请先关闭一个窗口';
      render();
      return;
    }
    const next: WindowTarget = target.pane === undefined
      ? { sessionId: target.sessionId, deviceId: target.deviceId }
      : { sessionId: target.sessionId, deviceId: target.deviceId, pane: target.pane };
    const parsed = parseDeepLink(deepLinkPath(next), location.origin);
    if (!parsed.ok) {
      telemetry.command('window.open', 'rejected');
      telemetry.failure('window.open', { name: 'DeepLinkError', code: parsed.reason });
      state.draftHint = `新窗口地址不合法：${parsed.reason}`;
      render();
      return;
    }
    const url = deepLinkUrl(next, location.origin);
    try {
      if (options.openWindow === undefined) {
        if (window.open(url, '_blank', 'noopener') === null) throw new Error('新窗口被浏览器拦截');
      } else {
        options.openWindow(url);
      }
      telemetry.navigation(next, 'ok', 1);
      telemetry.command('window.open', 'ok');
      telemetry.action('window.open', 'ok');
      state.draftHint = `已在新窗口打开：${deepLinkPath(next)}`;
      render();
    } catch (error) {
      telemetry.navigation(next, 'failed', 1, error);
      telemetry.command('window.open', 'failed', error);
      telemetry.failure('window.open', error);
      state.draftHint = `新窗口没有打开：${error instanceof Error ? error.message : String(error)}`;
      render();
    }
  };

  const toggleSplit = (): void => {
    if (decideSplitLayout(width, ratio).mode === 'single') {
      telemetry.command('split.expand', 'rejected');
      telemetry.action('split.expand', 'rejected');
      state.draftHint = '当前宽度不足，两个面板并排需要各自 360px';
      render();
      return;
    }
    collapsed = !collapsed;
    telemetry.command(collapsed ? 'split.collapse' : 'split.expand', 'ok');
    telemetry.action(collapsed ? 'split.collapse' : 'split.expand', 'ok');
    render();
  };

  const resetSplit = (): void => {
    collapsed = false;
    activePane = 'primary';
    ratio = DEFAULT_SPLIT_RATIO;
    writeSplitRatio(localStore, splitIdentity, ratio);
    telemetry.command('split.reset', 'ok');
    telemetry.action('split.reset', 'ok');
    render();
  };

  const handleSeparatorKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      collapsed = true;
      activePane = 'primary';
      telemetry.command('split.collapse', 'ok');
      telemetry.action('split.collapse', 'ok');
      render();
      return;
    }
    const result = applySplitKey(ratio, event.key, { width, separator: SEPARATOR_WIDTH, shiftKey: event.shiftKey });
    if (result === undefined) return;
    event.preventDefault();
    ratio = result.ratio;
    collapsed = false;
    writeSplitRatio(localStore, splitIdentity, ratio);
    telemetry.command(`split.${result.action}`, 'ok');
    telemetry.action('split.keyboard', 'ok');
    render();
  };

  const handleDrag = (dragged: number, finished: boolean): void => {
    ratio = clampRatio(dragged, width, SEPARATOR_WIDTH);
    collapsed = false;
    if (finished) {
      writeSplitRatio(localStore, splitIdentity, ratio);
      telemetry.command('split.drag', 'ok');
      telemetry.action('split.drag', 'ok');
    }
    render();
  };

  panel = createMultiWindowPanel(root, {
    openWindow,
    toggleSplit,
    resetSplit,
    send: () => {
      void submit();
    },
    refresh: () => {
      void refreshObject().catch((error: unknown) => {
        telemetry.failure('conflict.refresh', error);
      });
    },
    dismissConflict: (objectKey) => {
      conflicts.dismiss(objectKey);
      state.conflict = undefined;
      render();
    },
    focusWindow: (peerId) => {
      const sent = registry.requestFocus(peerId);
      telemetry.command('window.focus', sent ? 'ok' : 'rejected');
      if (sent) telemetry.action('window.focus', 'ok');
    },
    compose: (text) => {
      state.draftText = text;
      scheduleDraft();
    },
    dragRatio: handleDrag,
    separatorKey: handleSeparatorKey,
    selectPane: (pane) => {
      activePane = pane;
      telemetry.command('split.select-pane', 'ok');
      render();
    },
  });

  registry.onChange(() => render());
  conflicts.onConflict((notice) => {
    state.conflict = notice;
    telemetry.action('conflict.shown', 'conflict');
    render();
  });
  conflicts.setRefreshHandler(async () => {
    await refreshObject();
  });
  runtime.onStatus((status) => {
    state.runtimeState = status;
    state.runtimeRole = runtime.role;
    render();
  });
  const unsubscribeFrames = runtime.subscribe((frame) => {
    pushMessage(frameLine(frame));
    render();
  });
  const resizeObserver = new ResizeObserver(() => {
    const measured = measureWidth();
    if (measured === width) return;
    width = measured;
    ratio = clampRatio(ratio, width, SEPARATOR_WIDTH);
    render();
  });
  resizeObserver.observe(root);

  registry.start();
  runtime.start();
  restoreDraft();
  persistSelection();
  render();
  telemetry.action('window.mount', 'ok');
  void refreshObject().catch((error: unknown) => {
    telemetry.failure('object.read', error);
    state.draftHint = '读取对象失败，刷新入口仍可用';
    render();
  });

  return {
    windowId,
    clientId,
    registry,
    runtime,
    conflicts,
    get target(): WindowTarget {
      return target;
    },
    layout: layoutOf,
    navigate(next: WindowTarget, nextTitle?: string): void {
      const parsed = parseDeepLink(deepLinkPath(next), location.origin);
      if (!parsed.ok) throw new Error(`上下文不合法：${parsed.reason}`);
      if (sameWindowTarget(parsed.target, target)) return;
      target = parsed.target;
      title = nextTitle ?? `会话 ${target.sessionId.slice(0, 8)}`;
      registry.update(target, title);
      persistSelection();
      restoreDraft();
      render();
    },
    submit,
    refresh: refreshObject,
    destroy(): void {
      if (draftTimer !== undefined) clearTimeout(draftTimer);
      unsubscribeFrames();
      resizeObserver.disconnect();
      conflicts.stop();
      runtime.stop();
      registry.stop();
      panel.destroy();
      uninstallStyles();
    },
  };
}
