import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 审批面板：展示还在等回答的审批。
 *
 * 数据来自宿主平面的审批投影（服务名 `chatdshApprovals`）。回答在会话里进行：审批卡片
 * 跟随会话出现，作答走审批应答链；这个面板回答的是「现在有没有在等、上一次结果是什么」，
 * 因此不提供作答按钮。
 * @module @chatdsh/client-approval
 */

import { useCallback, useEffect, useState } from 'react';

/** 一条待处理的审批。 */
interface PendingApproval {
  readonly id: string;
  /** 工具调用标识，作答时用它与运行时的等待表配对。 */
  readonly callId?: string;
  readonly toolName: string;
  readonly reason?: string;
  readonly askedAt: number;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshApprovals?: {
      pending?: () => Promise<PendingApproval[]>;
      answer?: (id: string, outcome: string) => Promise<boolean>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-approval';

/** 控制平面的推送通道。 */
export const EVENTS_PATH = '/chatdsh/gateway/events';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/** 设置页区段。 */
function ApprovalSection() {
  const [pending, setPending] = useState<PendingApproval[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    const load = clientFace?.remote?.chatdshApprovals?.pending;
    if (load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshApprovals).then(
      (result) => {
        setPending(unwrapRemoteResult(result));
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);

  useEffect(refresh, [refresh]);

  // 订阅控制平面的推送：别的设备作答之后，这一端的卡片应当跟着收敛。
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    const source = new EventSource(EVENTS_PATH);
    source.onmessage = (event: MessageEvent<string>) => {
      // 三类通知都意味着待处理列表可能变了：审批事件、已读水位、副本追加。
      const payload = event.data;
      if (payload.includes('approval') || payload.includes('"kind":"receipt"') || payload.includes('"kind":"replica"')) refresh();
    };
    return () => source.close();
  }, [refresh]);

  const answer = useCallback((item: PendingApproval, outcome: string) => {
    const send = clientFace?.remote?.chatdshApprovals?.answer;
    if (send === undefined) {
      setFailed(true);
      return;
    }
    // 作答的关联键是工具调用标识：审计事件里的 `id` 由运行时在提出问题时生成，
    // 请求方看不到它，运行时等待表里存的也是工具调用标识。
    const key = item.callId;
    if (key === undefined) {
      setFailed(true);
      return;
    }
    setBusy(item.id);
    send.call(clientFace?.remote?.chatdshApprovals, key, outcome).then(
      () => {
        setBusy(undefined);
        refresh();
      },
      () => {
        setBusy(undefined);
        setFailed(true);
      },
    );
  }, [refresh]);
  if (failed) return <p style={{ fontSize: 13, opacity: 0.7 }}>审批状态暂不可用。</p>;
  if (pending === undefined) return <p style={{ fontSize: 13, opacity: 0.7 }}>正在读取审批状态…</p>;
  if (pending.length === 0) return <p style={{ fontSize: 13, opacity: 0.7 }}>没有等待回答的审批。</p>;

  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: '0 0 8px', fontWeight: 600 }}>有 {pending.length} 条审批在等回答</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pending.map((item) => (
          <li key={item.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
            <div style={{ fontWeight: 600 }}>{item.toolName}</div>
            <div style={{ opacity: 0.7 }}>
              提出于 {new Date(item.askedAt).toISOString()}
              {item.reason === undefined ? '' : ` · ${item.reason}`}
            </div>
            <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
              <button type="button" disabled={busy === item.id} onClick={() => answer(item, 'allowed-once')} style={{ fontSize: 12 }}>
                本次允许
              </button>
              <button type="button" disabled={busy === item.id} onClick={() => answer(item, 'rejected')} style={{ fontSize: 12 }}>
                拒绝
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p style={{ margin: '8px 0 0', opacity: 0.6 }}>
        「本会话」与「始终」要改本会话的审批策略，在会话里用命令调整；这里只做单次决定。
      </p>
    </div>
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
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshApprovals', {
    'chatdshApprovals/answer': { parameters: [{ name: 'id', kind: 'string' }, { name: 'outcome', kind: 'string' }] },
    'chatdshApprovals/waiting': { parameters: [] },
    'chatdshApprovals/pending': { parameters: [] },
    'chatdshApprovals/stats': { parameters: [{ name: 'sessionId', kind: 'string' }] },
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
