import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 项目面板：把宿主平面的项目记录列在侧栏里。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshProjects`），面板本身不缓存、不改写记录；
 * 写入走会话里的 `project` 工具。席位由侧栏插件声明，本插件只往列表里追加一项。
 * @module @chatdsh/client-projects
 */

import { useEffect, useState } from 'react';

/** 一条项目记录。 */
interface ProjectRecord {
  readonly path: string;
  readonly title: string;
  readonly instructions: string;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshProjects?: {
      list?: () => Promise<ProjectRecord[]>;
    };
  };
}

/** 侧栏席位名。 */
export const PANEL_SLOT = 'sidebar.panellist';

/** 面板在侧栏里的条目名。 */
export const PANEL_NAME = 'chatdsh.projects';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/** 侧栏条目。 */
function ProjectsEntry() {
  const [projects, setProjects] = useState<ProjectRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = clientFace?.remote?.chatdshProjects?.list;
    if (load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshProjects).then(
      (result) => {
        if (!cancelled) setProjects(unwrapRemoteResult(result));
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const state = failed
    ? '项目列表暂不可用'
    : projects === undefined
      ? '正在读取项目…'
      : projects.length === 0
        ? '还没有项目'
        : `${projects.length} 个项目`;

  return (
    <div style={{ padding: '8px 12px', fontSize: 13, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600 }}>项目</div>
      <div style={{ opacity: 0.7 }}>{state}</div>
    </div>
  );
}

/**
 * 注册侧栏面板。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: ClientFace & { slots: ClientSlots }): Promise<void> {
  clientFace = ctx;
  const remoteHost = ctx as unknown as {
    remote: { $mount(contribution: unknown): Promise<unknown> };
    inject(keys: string[], callback: (scope: ClientFace) => void): unknown;
  };
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshProjects', {
    'chatdshProjects/list': { parameters: [] },
    'chatdshProjects/get': { parameters: [{ name: 'path', kind: 'string' }] },
    'chatdshProjects/set': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshProjects/delete': { parameters: [{ name: 'path', kind: 'string' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshProjects'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

  ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({
    name: PANEL_SLOT,
    id: `panel.${PANEL_NAME}`,
    entry: PANEL_NAME,
  }, ProjectsEntry));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; entry?: string }, Component: () => unknown): () => void;
}
