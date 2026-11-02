import { buildRemoteContribution } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 项目面板的浏览器侧入口。
 *
 * 数据经 Remote 命名空间取得：`chatdshProjects` 由本插件挂载，`directoryPicker`、
 * `agentPresets` 与 `chatdshModelProviders` 由所在组合提供，按名读取，缺失时界面显示
 * 对应能力不可用。面板只通过 `ProjectsGateway` 访问数据，模块加载器与网络细节都收在
 * `createRemoteTransport` 里。
 * @module @chatdsh/client-projects
 */

import { Panel, Skeleton } from '@chatdsh/core-ui-kit';

import { createProjectsGateway, createRemoteTransport, type RemoteNamespace } from './gateway.ts';
import { ProjectsPanel } from './panel.tsx';
import { createPanelTelemetry } from './telemetry.ts';
import type { ProjectsGateway } from './types.ts';

/** 侧栏席位名。 */
export const PANEL_SLOT = 'sidebar.panellist';

/** 面板在侧栏里的条目名。 */
export const PANEL_NAME = 'chatdsh.projects';

/** 浏览器侧依赖：只等席位服务与 Remote 服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote: { $mount(contribution: unknown): Promise<unknown> } & Record<string, unknown>;
  inject(keys: string[], callback: (scope: ClientFace) => void): unknown;
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; entry?: string }, Component: () => unknown): () => void;
}

/** 由 `apply` 装好的数据入口；席位组件在挂载时取用。 */
let panelGateway: ProjectsGateway | undefined;

/** 按名读取一个 Remote 命名空间；组合里没有它时返回 `undefined`。 */
function namespaceOf(remote: Record<string, unknown>, name: string): RemoteNamespace | undefined {
  const value = remote[name];
  if (typeof value !== 'object' || value === null) return undefined;
  return value as RemoteNamespace;
}

/** 侧栏条目：装载完成前显示等高的骨架，装载后是完整项目面板。 */
export function ProjectsEntry() {
  if (panelGateway === undefined) return <Panel title="项目"><Skeleton rows={2} /></Panel>;
  return <ProjectsPanel gateway={panelGateway} />;
}

/**
 * 注册侧栏面板。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  await ctx.remote.$mount(buildRemoteContribution('chatdshProjects', {
    'chatdshProjects/list': { parameters: [] },
    'chatdshProjects/get': { parameters: [{ name: 'path', kind: 'string' }] },
    'chatdshProjects/create': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshProjects/set': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshProjects/delete': { parameters: [{ name: 'path', kind: 'string' }] },
  }, z));

  panelGateway = createProjectsGateway({
    transport: createRemoteTransport((name) => namespaceOf(ctx.remote, name)),
    telemetry: createPanelTelemetry(),
  });

  await new Promise<void>((resolve) => {
    ctx.inject(['remote.chatdshProjects'], () => {
      resolve();
      return () => {};
    });
  });

  ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({
    name: PANEL_SLOT,
    id: `panel.${PANEL_NAME}`,
    entry: PANEL_NAME,
  }, ProjectsEntry));
}
