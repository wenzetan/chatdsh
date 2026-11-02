/**
 * 会话席位的挂载入口。
 *
 * 席位把控制器状态渲染成会话界面：头部给出设备、目录、模型与执行来源，消息区呈现消息、工具
 * 卡片与轨迹，输入区处理组合输入与快捷键，队列面板处理待发送内容，命令面板与触发面板负责
 * 命令与引用。键盘事件在窗口层统一交给控制器，焦点在面板关闭、消息删除与新消息入口之后
 * 按状态里的目标恢复。
 *
 * 席位同时是设备内容端打开会话的实现：{@link ConversationSeat.openSession} 换成目标会话
 * 重新订阅，因此宿主导航桥把它的返回值当作导航回执。
 * @module @chatdsh/client-conversation/client/root
 */

import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { Button } from '@chatdsh/core-ui-kit';
import { trapFocus } from '../a11y.ts';
import { ComposerBox } from '../composer/view.tsx';
import { PaletteDialog, TriggerPanel } from '../commands/view.tsx';
import { QueuePanel } from '../queue/view.tsx';
import { MessageList, TracePanel, type MarkdownRenderer } from '../messages/view.tsx';
import { EXECUTION_SOURCE_TEXT } from '../messages/model.ts';
import { CONVERSATION_CSS } from '../styles.ts';
import type { CommandDescriptor } from '../commands/palette.ts';
import type { ReferenceCandidate } from '../references/references.ts';
import { ConversationController, type ConversationSeatOptions, type SeatState } from './controller.ts';

/** 挂载选项。 */
export interface MountOptions extends ConversationSeatOptions {
  /** 会话标题，用于头部与导航回执。 */
  readonly title?: string;
  /** 宿主的 Markdown 渲染器。 */
  readonly renderMarkdown?: MarkdownRenderer;
  /** 可引用的目录条目。 */
  readonly candidates?: readonly ReferenceCandidate[];
  /** 运行时命令。 */
  readonly runtimeCommands?: readonly CommandDescriptor[];
}

/** 会话席位的运行时接口。 */
export interface SeatRuntime {
  /** 打开指定会话，返回导航回执需要的结果。 */
  openSession(sessionId: string): Promise<{ readonly sessionId: string; readonly title: string }>;
  /** 取当前会话。 */
  currentSession(): string;
  /** 取控制器，供宿主读取状态与派发动作。 */
  controller(): ConversationController;
  /** 取当前要渲染的元素。 */
  element(): ReactElement;
  /** 订阅元素变化。 */
  subscribe(listener: () => void): () => void;
  /** 释放席位。 */
  dispose(): void;
}

/** 样式注入的标记属性。 */
const STYLE_MARKER = 'data-chatdsh-conversation';

/**
 * 注入会话区样式，重复挂载只注入一次。
 * @param document - 文档对象。
 */
function injectStyles(document: Document): void {
  if (document.querySelector(`style[${STYLE_MARKER}]`) !== null) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = CONVERSATION_CSS;
  document.head.append(style);
}

/**
 * 会话界面。
 * @param props - 控制器与选项。
 * @returns 界面元素。
 */
export function ConversationSeatView({ controller, options }: { readonly controller: ConversationController; readonly options: MountOptions }) {
  const state = useSyncExternalStore<SeatState>(
    (listener) => controller.subscribe(listener),
    () => controller.state()
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      controller.handleGlobalKey(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  useEffect(() => {
    const target = state.focusTarget;
    if (target === undefined) return;
    controller.takeFocusTarget();
    if (target === 'composer') {
      inputRef.current?.focus();
      return;
    }
    if (target === 'palette') {
      document.querySelector<HTMLInputElement>('[data-palette] input')?.focus();
      return;
    }
    if (target === 'messages-bottom') {
      const element = messagesRef.current;
      if (element !== null) element.scrollTop = element.scrollHeight;
      element?.focus();
      return;
    }
    if (target === 'queue') {
      queueRef.current?.focus();
      return;
    }
    if (target.startsWith('feedback:')) {
      const id = target.slice('feedback:'.length);
      const card = messagesRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      card?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [controller, state.focusTarget]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    controller.handleKeyDown(event);
  }, [controller]);

  const triggerPanelId = 'chatdsh-conv-trigger-listbox';

  return <div className="chdsh-conv" data-session-id={state.sessionId} data-device-id={state.deviceId}>
    <header className="chdsh-conv__header">
      <h1 className="chdsh-conv__title">{options.title ?? state.sessionId}</h1>
      <span className="chdsh-conv__meta">{state.deviceName}</span>
      {state.cwd === undefined ? null : <span className="chdsh-conv__meta">{state.cwd}</span>}
      {state.model === undefined ? null : <span className="chdsh-conv__meta">{state.model}</span>}
      <span className="chdsh-conv__meta" data-source>{EXECUTION_SOURCE_TEXT[state.source]}</span>
      <span className="chdsh-conv__meta" data-connection={state.stream.suspended ? 'suspended' : state.stream.status}>
        {state.stream.suspended ? '连接中断' : state.stream.status}
      </span>
      {state.deviceOnline ? null : <span className="chdsh-conv__hint chdsh-conv__hint--danger">目标设备离线</span>}
    </header>
    <MessageList
      messages={state.stream.messages}
      window={state.messageWindow}
      scrollRef={messagesRef}
      onScroll={() => {
        const element = messagesRef.current;
        if (element === null) return;
        controller.handleScroll({
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        });
      }}
      onShowNewMessages={() => controller.showNewMessages()}
      onLoadOlder={() => controller.loadOlder()}
      announcementsPaused={state.announcementsPaused}
      {...(state.announcement === undefined ? {} : { announcement: state.announcement })}
      {...(state.newMessages === undefined ? {} : { newMessages: state.newMessages })}
      handlers={{
        ...(options.renderMarkdown === undefined ? {} : { renderMarkdown: options.renderMarkdown }),
        feedbackOf: (messageId) => state.feedback.find((entry) => entry.messageId === messageId) ?? { messageId, status: 'idle' },
        onRate: (messageId, rating) => controller.feedbackRate(messageId, rating),
        onReason: (messageId, reason) => controller.feedbackReason(messageId, reason),
        onNote: (messageId, note) => controller.feedbackNote(messageId, note),
        onSubmitFeedback: (messageId) => {
          void controller.feedbackSubmit(messageId);
        },
        onCopy: (messageId) => {
          void controller.copyMessage(messageId).catch(() => undefined);
        },
        copiedAt: state.copiedAt,
        ...(state.copyFailure === undefined ? {} : { copyFailure: state.copyFailure }),
      }}
    />
    <TracePanel trace={state.stream.trace} />
    <section ref={queueRef} tabIndex={-1} aria-label="队列区域">
      <QueuePanel
        snapshot={state.queue}
        onEdit={(id, text) => controller.queueEdit(id, text)}
        onRemove={(id) => controller.queueRemove(id)}
        onPause={() => controller.queuePause()}
        onResume={() => {
          void controller.queueResume();
        }}
        onSendNext={() => {
          void controller.queueSendNext();
        }}
        {...(state.notice === undefined ? {} : { notice: state.notice })}
        {...(state.failure === undefined ? {} : { failure: state.failure })}
      />
    </section>
    <ComposerBox
      snapshot={state.composer}
      sendCheck={state.sendCheck}
      runState={state.run}
      inputRef={inputRef}
      onTextChange={(text, start, end) => controller.handleTextChange(text, start, end)}
      onSelectionChange={(start, end) => controller.handleSelectionChange(start, end)}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => controller.compositionStart()}
      onCompositionUpdate={(data) => controller.compositionUpdate(data)}
      onCompositionEnd={(data) => controller.compositionEnd(data)}
      onSend={() => {
        void controller.send();
      }}
      onStop={() => {
        void controller.stop();
      }}
      onRemoveAttachment={() => undefined}
      onRemoveReference={(id) => controller.removeReference(id)}
      onReselectReference={(kind) => controller.reselectReference(kind)}
      {...(state.notice === undefined ? {} : { notice: state.notice })}
      {...(state.failure === undefined ? {} : { failure: state.failure })}
    >
      {state.trigger === undefined
        ? null
        : <TriggerPanel
            id={triggerPanelId}
            kind={state.trigger.kind}
            query={state.trigger.query}
            groups={state.trigger.groups}
            {...(state.trigger.activeId === undefined ? {} : { activeId: state.trigger.activeId })}
            onSelect={(item) => controller.applyTrigger(item)}
          />}
    </ComposerBox>
    <PaletteDialog
      open={state.palette.open}
      levelLabel={state.palette.levelLabel}
      canGoBack={state.palette.canGoBack}
      query={state.palette.query}
      commands={state.palette.commands}
      {...(state.palette.activeId === undefined ? {} : { activeId: state.palette.activeId })}
      onQueryChange={(query) => controller.paletteSetQuery(query)}
      onSelect={(id) => {
        controller.paletteSetActive(id);
        void controller.paletteSelect();
      }}
      onActiveChange={(id) => controller.paletteSetActive(id)}
      onClose={() => controller.closePalette()}
      rootRef={paletteRef}
      onKeyDownCapture={(event) => {
        const root = paletteRef.current;
        if (root !== null) trapFocus(event, root);
      }}
    />
    <Button
      onClick={() => controller.dismissNotice()}
      style={state.notice === undefined && state.failure === undefined ? { display: 'none' } : undefined}
    >清除提示</Button>
  </div>;
}

/**
 * 建立会话席位的运行时。
 *
 * 渲染由宿主完成：宿主取 {@link SeatRuntime.element} 交给自己的 React 渲染器，元素变化时按
 * {@link SeatRuntime.subscribe} 的通知重绘。这样席位不绑定具体渲染入口，导航桥打开会话时
 * 只需调用 {@link SeatRuntime.openSession}。
 * @param host - 宿主元素，用于注入样式。
 * @param options - 会话、设备、端点与依赖。
 * @returns 席位运行时。
 */
export function createSeatRuntime(host: HTMLElement, options: MountOptions): SeatRuntime {
  injectStyles(host.ownerDocument);
  let current = options;
  let controller = new ConversationController(current);
  const listeners = new Set<() => void>();
  const start = () => {
    controller.setCandidates(current.candidates ?? []);
    controller.setRuntimeCommands(current.runtimeCommands ?? []);
    controller.start();
  };
  start();
  return {
    controller(): ConversationController {
      return controller;
    },
    element(): ReactElement {
      return <ConversationSeatView controller={controller} options={current} />;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async openSession(sessionId: string): Promise<{ readonly sessionId: string; readonly title: string }> {
      controller.dispose();
      current = { ...options, sessionId };
      controller = new ConversationController(current);
      start();
      for (const listener of listeners) listener();
      return { sessionId, title: current.title ?? sessionId };
    },
    currentSession(): string {
      return current.sessionId;
    },
    dispose(): void {
      controller.dispose();
      listeners.clear();
    },
  };
}
