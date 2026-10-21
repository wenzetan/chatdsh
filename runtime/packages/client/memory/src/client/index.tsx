import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 记忆面板：展示记忆后端的状态与 bank 规则。
 *
 * 状态经 Remote 调用取得（服务名 `chatdshMemory`）。这个形态没有启用记忆时会话里没有该
 * 服务，面板据此显示「未启用」，与宿主侧的降级呈现保持一致。
 * @module @chatdsh/client-memory
 */

import { useEffect, useState } from 'react';

/** 后端状态。 */
interface MemoryStatus {
  readonly available: boolean;
  readonly endpoint: string;
  readonly maxTokens: number;
  readonly extraBanks: readonly string[];
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshMemory?: {
      status?: () => Promise<MemoryStatus>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-memory';

/** 浏览器侧依赖：只等席位服务，模块加载顺序由模块图自己保证。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/** 设置页区段。 */
function MemorySection() {
  const [status, setStatus] = useState<MemoryStatus | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = clientFace?.remote?.chatdshMemory?.status;
    if (load === undefined) {
      setMissing(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshMemory).then(
      (result) => {
        if (!cancelled) setStatus(unwrapRemoteResult(result));
      },
      () => {
        if (!cancelled) setMissing(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (missing) {
    return (
      <div style={{ fontSize: 13, opacity: 0.8 }}>
        <p style={{ margin: 0 }}>记忆未启用。</p>
        <p style={{ margin: '4px 0 0', opacity: 0.7 }}>启用方式：把记忆组合包加入 profile 的 bundles 列表，并部署记忆后端。</p>
      </div>
    );
  }
  if (status === undefined) return <p style={{ fontSize: 13, opacity: 0.7 }}>正在读取记忆状态…</p>;

  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: '0 0 4px', fontWeight: 600 }}>
        {status.available ? '记忆后端可用' : '记忆后端不可达'}
      </p>
      <p style={{ margin: 0, opacity: 0.7 }}>地址 {status.endpoint} · 单次召回上限 {status.maxTokens} 令牌</p>
      <p style={{ margin: '4px 0 0', opacity: 0.7 }}>
        {status.extraBanks.length === 0 ? '没有额外召回 bank' : `额外召回 bank：${status.extraBanks.join('、')}`}
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
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshMemory', {
    'chatdshMemory/status': { parameters: [] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshMemory'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 60,
    label: () => '记忆',
    locale: 'chatdsh.memory',
  }, MemorySection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
