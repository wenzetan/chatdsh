import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 制品面板：把宿主平面记录的制品列在设置页里。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshArtifacts`），面板只读；写入走会话里的
 * `artifact_write` 工具。
 * @module @chatdsh/client-artifacts
 */

import { useEffect, useState } from 'react';
import { Badge, EmptyState, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

/** 一条制品记录。 */
interface ArtifactRecord {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly size: number;
  readonly version: number;
  readonly updatedAt: number;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshArtifacts?: {
      list?: () => Promise<ArtifactRecord[]>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-artifacts';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/** 设置页区段：制品列表，覆盖加载、空、失败三类状态。 */
export function ArtifactsSection() {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = clientFace?.remote?.chatdshArtifacts?.list;
    if (load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshArtifacts).then(
      (result) => {
        if (!cancelled) setArtifacts(unwrapRemoteResult(result));
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <Panel title="制品"><StatusLine tone="danger">制品列表暂不可用。</StatusLine></Panel>;
  if (artifacts === undefined) return <Panel title="制品"><Skeleton rows={3} /></Panel>;
  if (artifacts.length === 0) {
    return <Panel title="制品"><EmptyState>还没有制品。让会话里的工具写一个。</EmptyState></Panel>;
  }
  return (
    <Panel title="制品" count={`${artifacts.length}`}>
      <List>
        {artifacts.map((record) => (
          <Row
            key={record.id}
            title={record.title}
            badge={<Badge tone="neutral">{record.kind}</Badge>}
            meta={`${record.mimeType} · 第 ${record.version} 版 · ${record.size} 字节`}
          />
        ))}
      </List>
    </Panel>
  );
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
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshArtifacts', {
    'chatdshArtifacts/put': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshArtifacts/read': { parameters: [{ name: 'id', kind: 'string' }, { name: 'version', kind: 'number' }] },
    'chatdshArtifacts/list': { parameters: [{ name: 'sessionId', kind: 'string' }] },
    'chatdshArtifacts/versions': { parameters: [{ name: 'id', kind: 'string' }] },
    'chatdshArtifacts/delete': { parameters: [{ name: 'id', kind: 'string' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshArtifacts'], (scope) => {
      clientFace = scope;
      resolve();
    });
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
