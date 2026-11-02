/**
 * 审批客户端插件的浏览器入口。
 *
 * 设置页里的区段展示全部设备的待处理卡片、提问卡片、计划编辑区与统计；界面同时对外导出
 * 控制器、取数接口与挂载函数，控制平面外壳可以把同一块界面放进会话里。
 *
 * 身份按浏览器保存：客户端标识存在本地存储里，刷新之后还是同一个客户端，因此计划编辑租约与
 * 草稿在刷新后仍然归属同一侧。
 * @module @chatdsh/client-approval/client
 */

import { buildRemoteContribution } from '@chatdsh/core-remote-client';
import { Panel, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { ApprovalController } from './controller.ts';
import { createUiActionTelemetry } from './telemetry.ts';
import { remoteTransport, type RemoteNamespaceLike } from './transport.ts';
import { ApprovalPanel } from './view.tsx';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-approval';

/** 控制平面的推送通道。 */
export const EVENTS_PATH = '/chatdsh/gateway/events';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

/** 客户端标识的本地存储键。 */
const CLIENT_ID_KEY = 'chatdsh-approval.client-id';

/** 窗口标识的会话存储键。 */
const WINDOW_ID_KEY = 'chatdsh-approval.window-id';

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshApprovals?: RemoteNamespaceLike;
  };
}

let clientFace: ClientFace | undefined;

/**
 * 取一个稳定的浏览器侧标识。
 * @param storage - 存储面。
 * @param key - 键。
 * @returns 标识。
 */
function stableId(storage: Storage | undefined, key: string): string {
  if (storage === undefined) return `client-${Math.random().toString(36).slice(2, 10)}`;
  const existing = storage.getItem(key);
  if (existing !== null && existing !== '') return existing;
  const created = `client-${crypto.randomUUID()}`;
  storage.setItem(key, created);
  return created;
}

/** 设置页区段。 */
export function ApprovalSection() {
  const [controller, setController] = useState<ApprovalController | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    const namespace = clientFace?.remote?.chatdshApprovals;
    if (namespace === undefined) {
      setFailure('审批服务不可用');
      return undefined;
    }
    const storage = typeof window === 'undefined' ? undefined : window.localStorage;
    const created = new ApprovalController({
      transport: remoteTransport(namespace),
      clientId: stableId(storage, CLIENT_ID_KEY),
      clientLabel: '本浏览器',
      deviceId: 'local',
      windowId: stableId(typeof window === 'undefined' ? undefined : window.sessionStorage, WINDOW_ID_KEY),
      ...(storage === undefined ? {} : { storage }),
      telemetry: createUiActionTelemetry({ fetchImpl: fetch, now: () => Date.now() }),
      navigate: (sessionId) => {
        window.location.hash = `#/session/${encodeURIComponent(sessionId)}`;
      },
    });
    setController(created);
    void created.refresh();
    return () => {
      created.closeCard();
    };
  }, []);

  // 订阅控制平面的推送：别的设备作答之后，这一端的卡片应当跟着收敛。
  useEffect(() => {
    if (controller === undefined || typeof EventSource === 'undefined') return undefined;
    const source = new EventSource(EVENTS_PATH);
    source.onmessage = (event: MessageEvent<string>) => {
      const payload = event.data;
      if (payload.includes('approval') || payload.includes('"kind":"receipt"') || payload.includes('"kind":"replica"')) {
        void controller.refresh();
      }
    };
    return () => source.close();
  }, [controller]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (controller === undefined) return;
    const intent = controller.handleKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (intent !== 'none') event.preventDefault();
  }, [controller]);

  const view = useMemo(() => {
    if (controller === undefined) return undefined;
    return { controller };
  }, [controller]);

  if (failure !== undefined) return <StatusLine tone="danger">{failure}。</StatusLine>;
  if (view === undefined) {
    return (
      <Panel title="审批" subtitle="正在读取审批状态">
        <Skeleton rows={3} />
      </Panel>
    );
  }
  return (
    <div onKeyDown={onKeyDown}>
      <ApprovalSectionBody controller={view.controller} />
    </div>
  );
}

/**
 * 区段主体：把控制器状态渲染成面板。
 * @param props - 控制器。
 * @returns 面板元素。
 */
function ApprovalSectionBody({ controller }: { readonly controller: ApprovalController }): ReactElement {
  const [state, setState] = useState(controller.state());
  useEffect(() => controller.subscribe(() => setState(controller.state())), [controller]);
  return <ApprovalPanel controller={controller} state={state} />;
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  clientFace = ctx;
  const remoteHost = ctx as unknown as {
    remote: { $mount(contribution: unknown): Promise<unknown> };
    inject(keys: string[], callback: (scope: ClientFace) => void): unknown;
  };
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshApprovals', {
    'chatdshApprovals/pending': { parameters: [{ name: 'query', kind: 'json' }] },
    'chatdshApprovals/grouped': { parameters: [{ name: 'query', kind: 'json' }] },
    'chatdshApprovals/waiting': { parameters: [] },
    'chatdshApprovals/stats': { parameters: [{ name: 'sessionId', kind: 'string' }] },
    'chatdshApprovals/policies': { parameters: [] },
    'chatdshApprovals/clearPolicy': { parameters: [{ name: 'id', kind: 'string' }] },
    'chatdshApprovals/decide': { parameters: [{ name: 'request', kind: 'json' }] },
    'chatdshApprovals/answer': { parameters: [{ name: 'id', kind: 'string' }, { name: 'outcome', kind: 'string' }] },
    'chatdshApprovals/questions': { parameters: [] },
    'chatdshApprovals/answerQuestion': { parameters: [{ name: 'request', kind: 'json' }] },
    'chatdshApprovals/skipQuestion': { parameters: [{ name: 'request', kind: 'json' }] },
    'chatdshApprovals/takeover': { parameters: [{ name: 'request', kind: 'json' }] },
    'chatdshApprovals/savePlanDraft': { parameters: [{ name: 'request', kind: 'json' }] },
    'chatdshApprovals/submitPlan': { parameters: [{ name: 'request', kind: 'json' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshApprovals'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 65,
    label: () => '审批',
    locale: 'chatdsh.approval',
  }, ApprovalSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}

export * from './model.ts';
export * from './transport.ts';
export { ApprovalController, type ApprovalControllerOptions, type ApprovalState, type PlanEditorState, type QuestionDraft } from './controller.ts';
export { ApprovalPanel } from './view.tsx';
export { createApprovalRuntime, type ApprovalRuntime, type MountOptions } from './mount.tsx';
export { createUiActionTelemetry, UI_ACTION_EVENT, SCOPE as TELEMETRY_SCOPE } from './telemetry.ts';
