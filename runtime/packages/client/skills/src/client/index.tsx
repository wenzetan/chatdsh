import { buildRemoteContribution } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 技能面板的浏览器侧入口。
 *
 * 数据经 Remote 命名空间 `chatdshSkills` 取得：目录、数量统计、检索与启停都来自该服务。
 * 助手名单 `chatdshAssistants` 由助手插件提供，按名读取，缺失时引用一栏显示能力不可用。
 * @module @chatdsh/client-skills
 */

import { Panel, Skeleton } from '@chatdsh/core-ui-kit';

import { createRemoteTransport, createSkillsGateway, type RemoteNamespace } from './gateway.ts';
import { SkillsPanel } from './panel.tsx';
import { createPanelTelemetry } from './telemetry.ts';
import type { SkillsGateway } from './types.ts';

/** 设置页区段席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-skills';

/** 浏览器侧依赖：只等席位服务与 Remote 服务。 */
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
let panelGateway: SkillsGateway | undefined;

/** 按名读取一个 Remote 命名空间；组合里没有它时返回 `undefined`。 */
function namespaceOf(remote: Record<string, unknown>, name: string): RemoteNamespace | undefined {
  const value = remote[name];
  if (typeof value !== 'object' || value === null) return undefined;
  return value as RemoteNamespace;
}

/**
 * 设置页区段：装载完成前显示等高的骨架，装载后是完整技能面板。
 * @param props - 可选的测试与嵌入用数据入口。
 * @returns 区段内容。
 */
export function SkillsSection({ gateway }: { readonly gateway?: SkillsGateway } = {}) {
  const active = gateway ?? panelGateway;
  if (active === undefined) return <Panel title="技能"><Skeleton rows={3} /></Panel>;
  return <SkillsPanel gateway={active} />;
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  await ctx.remote.$mount(buildRemoteContribution('chatdshSkills', {
    'chatdshSkills/list': { parameters: [] },
    'chatdshSkills/catalog': { parameters: [] },
    'chatdshSkills/search': { parameters: [{ name: 'request', kind: 'json' }] },
    'chatdshSkills/toggle': { parameters: [{ name: 'id', kind: 'string' }, { name: 'enabled', kind: 'boolean' }] },
  }, z));

  panelGateway = createSkillsGateway({
    transport: createRemoteTransport((name) => namespaceOf(ctx.remote, name)),
    telemetry: createPanelTelemetry(),
  });

  await new Promise<void>((resolve) => {
    ctx.inject(['remote.chatdshSkills'], () => {
      resolve();
    });
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 47,
    label: () => '技能',
    locale: 'chatdsh.skills',
  }, SkillsSection));
}
