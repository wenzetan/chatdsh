import { buildRemoteContribution } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 助手面板的浏览器侧入口。
 *
 * 数据经 Remote 命名空间 `chatdshAssistants` 取得；装配清单 `pluginInventory`、预设名册
 * `agentPresets` 与技能目录 `chatdshSkills` 由所在组合提供，按名读取，缺失时面板按来源显示
 * 能力不可用。模块加载器与网络细节收在 `createRemoteTransport` 里。
 * @module @chatdsh/client-assistants
 */

import { Panel, Skeleton } from '@chatdsh/core-ui-kit';

import { createAssistantsGateway, createRemoteTransport, type RemoteNamespace } from './gateway.ts';
import { AssistantsPanel } from './panel.tsx';
import { createPanelTelemetry } from './telemetry.ts';
import type { AssistantsGateway } from './types.ts';

/** 设置页区段席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-assistants';

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
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}

/** 由 `apply` 装好的数据入口；席位组件在挂载时取用。 */
let panelGateway: AssistantsGateway | undefined;

/** 按名读取一个 Remote 命名空间；组合里没有它时返回 `undefined`。 */
function namespaceOf(remote: Record<string, unknown>, name: string): RemoteNamespace | undefined {
  const value = remote[name];
  if (typeof value !== 'object' || value === null) return undefined;
  return value as RemoteNamespace;
}

/**
 * 设置页区段：装载完成前显示等高的骨架，装载后是完整助手面板。
 * @param props - 可选的测试与嵌入用数据入口。
 * @returns 区段内容。
 */
export function AssistantsSection({ gateway }: { readonly gateway?: AssistantsGateway } = {}) {
  const active = gateway ?? panelGateway;
  if (active === undefined) return <Panel title="助手"><Skeleton rows={3} /></Panel>;
  return <AssistantsPanel gateway={active} />;
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  await ctx.remote.$mount(buildRemoteContribution('chatdshAssistants', {
    'chatdshAssistants/list': { parameters: [] },
    'chatdshAssistants/create': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshAssistants/update': { parameters: [{ name: 'id', kind: 'string' }, { name: 'patch', kind: 'json' }] },
    'chatdshAssistants/delete': { parameters: [{ name: 'id', kind: 'string' }] },
  }, z));

  panelGateway = createAssistantsGateway({
    transport: createRemoteTransport((name) => namespaceOf(ctx.remote, name)),
    telemetry: createPanelTelemetry(),
  });

  await new Promise<void>((resolve) => {
    ctx.inject(['remote.chatdshAssistants'], () => {
      resolve();
    });
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 45,
    label: () => '助手',
    locale: 'chatdsh.assistants',
  }, AssistantsSection));
}
