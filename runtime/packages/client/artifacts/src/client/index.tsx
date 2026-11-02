import { buildRemoteContribution } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 制品面板的浏览器入口：把制品的列表、版本、读取与删除接到设置页席位。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshArtifacts`），面板只读展示内容；写入走会话里的
 * `artifact_write` 工具。删除只在这里发起，并且必须先看到删除范围再确认。
 * @module @chatdsh/client-artifacts
 */

import { createArtifactsGateway, createRemoteTransport, type RemoteNamespace } from './gateway.ts';
import { ArtifactsPanel } from './panel.tsx';
import { createPanelTelemetry } from './telemetry.ts';
import type { ArtifactsGateway } from './types.ts';

export { ArtifactsPanel } from './panel.tsx';
export { ArtifactPreview, ImageViewer, PreviewNotice, SandboxHtmlPreview, SvgPreview, TextPreview } from './viewers.tsx';
export type { ArtifactRecord, ArtifactVersionList, ArtifactsGateway } from './types.ts';

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: Readonly<Record<string, RemoteNamespace | undefined>>;
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-artifacts';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;
let gateway: ArtifactsGateway | undefined;

/**
 * 设置页区段：制品面板。
 *
 * 装配之前打开时停在加载状态；`apply` 完成后面板拿到数据入口。
 */
export function ArtifactsSection() {
  return <ArtifactsPanel gateway={gateway} />;
}

/**
 * 注册设置页区段并挂载 Remote 方法。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  clientFace = ctx;
  const remoteHost = ctx as unknown as {
    remote: { $mount(contribution: unknown): Promise<unknown> };
    inject(keys: string[], callback: (scope: ClientFace) => void): unknown;
  };
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshArtifacts', {
    'chatdshArtifacts/list': { parameters: [{ name: 'sessionId', kind: 'string' }] },
    'chatdshArtifacts/read': { parameters: [{ name: 'id', kind: 'string' }, { name: 'version', kind: 'number' }] },
    'chatdshArtifacts/versionList': { parameters: [{ name: 'id', kind: 'string' }] },
    'chatdshArtifacts/deleteScope': { parameters: [{ name: 'id', kind: 'string' }] },
    'chatdshArtifacts/delete': { parameters: [{ name: 'id', kind: 'string' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshArtifacts'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

  gateway = createArtifactsGateway({
    transport: createRemoteTransport((name) => clientFace?.remote?.[name]),
    telemetry: createPanelTelemetry(),
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 40,
    label: () => '制品',
    locale: 'chatdsh.artifacts',
  }, ArtifactsSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
