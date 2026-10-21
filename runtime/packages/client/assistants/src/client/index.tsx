import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 助手面板：把自定义助手列在设置页里。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshAssistants`）。每个助手在宿主侧挂成一个预设，
 * 面板只展示，不改变预设的选择状态。
 * @module @chatdsh/client-assistants
 */

import { useEffect, useState } from 'react';

/** 一条助手记录。 */
interface AssistantRecord {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshAssistants?: {
      list?: () => Promise<AssistantRecord[]>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-assistants';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/** 设置页区段。 */
function AssistantsSection() {
  const [assistants, setAssistants] = useState<AssistantRecord[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = clientFace?.remote?.chatdshAssistants?.list;
    if (load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshAssistants).then(
      (result) => {
        if (!cancelled) setAssistants(unwrapRemoteResult(result));
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <p style={{ fontSize: 13, opacity: 0.7 }}>助手列表暂不可用。</p>;
  if (assistants === undefined) return <p style={{ fontSize: 13, opacity: 0.7 }}>正在读取助手…</p>;
  if (assistants.length === 0) return <p style={{ fontSize: 13, opacity: 0.7 }}>还没有自定义助手。</p>;

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
      {assistants.map((record) => (
        <li key={record.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
          <div style={{ fontWeight: 600 }}>
            {record.name}
            {record.enabled ? '' : '（已停用）'}
          </div>
          <div style={{ opacity: 0.7 }}>{record.instructions.length === 0 ? '没有附加说明' : record.instructions}</div>
        </li>
      ))}
    </ul>
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
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshAssistants', {
    'chatdshAssistants/list': { parameters: [] },
    'chatdshAssistants/create': { parameters: [{ name: 'input', kind: 'json' }] },
    'chatdshAssistants/update': { parameters: [{ name: 'id', kind: 'string' }, { name: 'patch', kind: 'json' }] },
    'chatdshAssistants/delete': { parameters: [{ name: 'id', kind: 'string' }] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshAssistants'], (scope) => {
      clientFace = scope;
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

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
