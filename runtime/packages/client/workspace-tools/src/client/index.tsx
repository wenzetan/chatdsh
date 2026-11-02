/**
 * 工作区工具的浏览器入口。
 *
 * 挂载 `chatdshAttachments` 与 `chatdshVoice` 两个 Remote 命名空间的贡献，并建立共用的
 * 数据入口。文件浏览直接使用宿主已有的 `workspaceFiles` 命名空间。面板组件导出给外壳，
 * 由外壳把右侧停靠席位与输入区接进来。
 * @module @chatdsh/client-workspace-tools/client
 */

import { buildRemoteContribution } from '@chatdsh/core-remote-client';
import { z } from 'zod';
import { createWorkspaceGateway } from '../gateway.ts';
import { createWorkspaceTelemetry } from '../telemetry.ts';
import { WorkspacePanel, type WorkspacePanelProps } from '../panel.tsx';
import type { RemoteEnvelope, RemoteNamespace, WorkspaceGateway } from '../types.ts';

export { AttachmentSection, FileBrowser, TerminalView, VoiceSection, WorkspacePanel } from '../panel.tsx';
export { WORKSPACE_CSS } from '../styles.ts';
export type { WorkspacePanelProps } from '../panel.tsx';

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: Readonly<Record<string, RemoteNamespace | undefined>>;
}

/** 浏览器侧依赖。 */
export const inject = ['slots', 'remote'];

let gateway: WorkspaceGateway | undefined;

/**
 * 取包装好的工作区数据入口。
 * @returns 数据入口；`apply` 之前为空。
 */
export function workspaceGateway(): WorkspaceGateway | undefined {
  return gateway;
}

/**
 * 右侧停靠栏的面板：把外壳提供的输入区与终端区域接进工作区面板。
 * @param props - 面板属性。
 * @returns 面板元素。
 */
export function WorkspaceToolsSection(props: WorkspacePanelProps) {
  return <WorkspacePanel {...props} />;
}

/**
 * 注册 Remote 贡献并建立数据入口。
 * @param ctx - 浏览器侧根上下文。
 */
export async function apply(ctx: ClientFace & {
  remote: { $mount(contribution: unknown): Promise<unknown> };
}): Promise<void> {
  await ctx.remote.$mount(buildRemoteContribution('chatdshAttachments', {
    'chatdshAttachments/limits': { parameters: [] },
    'chatdshAttachments/put': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshAttachments/read': { parameters: [{ name: 'id', kind: 'string' }] },
    'chatdshAttachments/context': { parameters: [{ name: 'ids', kind: 'json' }] },
  }, z));
  await ctx.remote.$mount(buildRemoteContribution('chatdshVoice', {
    'chatdshVoice/capability': { parameters: [] },
    'chatdshVoice/put': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshVoice/transcribe': { parameters: [{ name: 'id', kind: 'string' }, { name: 'options', kind: 'json' }] },
    'chatdshVoice/delete': { parameters: [{ name: 'id', kind: 'string' }] },
  }, z));

  const namespaceOf = (name: string): RemoteNamespace | undefined => ctx.remote[name];
  gateway = createWorkspaceGateway({
    transport: {
      async call(endpoint, args) {
        const separator = endpoint.indexOf('/');
        const service = endpoint.slice(0, separator);
        const method = endpoint.slice(separator + 1);
        const namespace = namespaceOf(service);
        if (namespace === undefined) {
          return { ok: false, error: { code: 'client/unavailable', message: `当前部署没有提供 ${service} 命名空间` } };
        }
        const invoke = namespace[method];
        if (typeof invoke !== 'function') {
          return { ok: false, error: { code: 'client/unavailable', message: `${service} 没有 ${method} 方法` } };
        }
        const envelope = await (invoke as (...input: unknown[]) => Promise<RemoteEnvelope>)(...args);
        return envelope;
      },
    },
    telemetry: createWorkspaceTelemetry(),
  });
}
