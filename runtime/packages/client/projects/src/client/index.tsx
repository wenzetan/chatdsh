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
import { EmptyState, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

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

/** 侧栏条目：标题、计数与项目列表；覆盖加载、空、失败三类状态。 */
export function ProjectsEntry() {
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

  if (failed) {
    return <Panel title="项目"><StatusLine tone="danger">项目列表暂不可用。</StatusLine></Panel>;
  }
  if (projects === undefined) {
    return <Panel title="项目"><Skeleton rows={2} /></Panel>;
  }
  if (projects.length === 0) {
    return <Panel title="项目"><EmptyState>还没有项目。让会话里的 project 工具记录一个工作目录。</EmptyState></Panel>;
  }
  return (
    <Panel title="项目" count={`${projects.length}`}>
      <List>
        {projects.map((record) => (
          <Row key={record.path} title={record.title} meta={record.path} />
        ))}
      </List>
    </Panel>
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
