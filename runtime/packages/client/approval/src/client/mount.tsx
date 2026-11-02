/**
 * 审批界面的挂载入口。
 *
 * 与消息席位一样，这里只做三件事：把控制器状态渲染成元素、把样式注入一次、把刷新入口交给
 * 宿主。宿主（控制平面外壳或内容端）决定把这块界面放在会话里还是设置页里。
 * @module @chatdsh/client-approval/mount
 */

import { useSyncExternalStore, type ReactElement } from 'react';
import { UI_KIT_CSS } from '@chatdsh/core-ui-kit';
import { ApprovalController, type ApprovalControllerOptions, type ApprovalState } from './controller.ts';
import { ApprovalPanel } from './view.tsx';

/** 样式注入标记。 */
const STYLE_MARKER = 'data-chatdsh-approval';

/** 附加样式：卡片排版与只读编辑区。 */
const APPROVAL_CSS = `
[data-approval-panel] { display: grid; gap: 12px; }
[data-approval-panel] [data-focus-id]:focus-visible { outline: 2px solid var(--chatdsh-brand, #2b6cb0); outline-offset: 2px; }
[data-plan-text][disabled] { opacity: 0.7; cursor: not-allowed; }
[data-approval-card][data-actionable="false"] { opacity: 0.85; }
`;

/**
 * 注入样式，重复挂载只注入一次。
 * @param document - 文档对象。
 */
function injectStyles(document: Document): void {
  if (document.querySelector(`style[${STYLE_MARKER}]`) !== null) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = `${UI_KIT_CSS}\n${APPROVAL_CSS}`;
  document.head.append(style);
}

/** 界面元素。 */
function ApprovalRuntimeView({ controller }: { readonly controller: ApprovalController }): ReactElement {
  const state: ApprovalState = useSyncExternalStore<ApprovalState>(
    (listener) => controller.subscribe(listener),
    () => controller.state(),
  );
  return <ApprovalPanel controller={controller} state={state} />;
}

/** 挂载选项。 */
export interface MountOptions extends ApprovalControllerOptions {
  /** 面板标题，供宿主展示。 */
  readonly title?: string;
}

/** 挂载之后的运行时接口。 */
export interface ApprovalRuntime {
  /** 取控制器，供宿主派发动作与断言状态。 */
  controller(): ApprovalController;
  /** 取当前要渲染的元素。 */
  element(): ReactElement;
  /** 订阅元素变化。 */
  subscribe(listener: () => void): () => void;
  /** 重新取数。 */
  refresh(): Promise<void>;
  /** 释放运行时。 */
  dispose(): void;
}

/**
 * 挂载审批界面。
 * @param host - 承载元素。
 * @param options - 取数接口、客户端标识与本地存储。
 * @returns 运行时接口。
 */
export function createApprovalRuntime(host: HTMLElement, options: MountOptions): ApprovalRuntime {
  injectStyles(host.ownerDocument);
  const controller = new ApprovalController(options);
  const listeners = new Set<() => void>();
  return {
    controller(): ApprovalController {
      return controller;
    },
    element(): ReactElement {
      return <ApprovalRuntimeView controller={controller} />;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh(): Promise<void> {
      await controller.refresh();
    },
    dispose(): void {
      listeners.clear();
    },
  };
}
