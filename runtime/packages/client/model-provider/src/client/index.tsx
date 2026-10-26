import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 模型提供方面板：把宿主注册的模型提供方列在设置页里。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshModelProviders`），面板只读，不修改注册信息；
 * 提供方的增删由控制平面写入配置后重启运行时生效。
 * @module @chatdsh/client-model-provider
 */

import { useEffect, useState } from 'react';
import { EmptyState, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

/** 一条提供方注册信息。 */
interface ProviderRecord {
  readonly provider: string;
  readonly displayName: string;
  readonly baseUrl?: string;
}

/** 服务状态。 */
interface ProviderStatus {
  readonly available: boolean;
  readonly providers: number;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshModelProviders?: {
      list?: () => Promise<ProviderRecord[]>;
      status?: () => Promise<ProviderStatus>;
    };
  };
}

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-model-provider';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/**
 * 按数量给出面板上的一句话。
 * @param status - 服务状态。
 * @returns 面向用户的一句话。
 */
export function formatProviderSummary(status: ProviderStatus): string {
  if (!status.available) return '还没有模型提供方';
  return `${status.providers} 个模型提供方已注册`;
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
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshModelProviders', {
    'chatdshModelProviders/list': { parameters: [] },
    'chatdshModelProviders/status': { parameters: [] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshModelProviders'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 46,
    label: () => '模型提供方',
    locale: 'chatdsh.model-provider',
  }, ModelProviderSection));
}

/** 设置页区段：提供方列表，覆盖加载、空、失败三类状态。 */
export function ModelProviderSection() {
  const [providers, setProviders] = useState<ProviderRecord[] | undefined>(undefined);
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const remote = clientFace?.remote;
    const list = remote?.chatdshModelProviders?.list;
    const status = remote?.chatdshModelProviders?.status;
    if (list === undefined || status === undefined) {
      setFailed(true);
      return;
    }
    Promise.all([list.call(remote?.chatdshModelProviders), status.call(remote?.chatdshModelProviders)]).then(
      ([recordsResult, stateResult]) => {
        if (cancelled) return;
        setProviders(unwrapRemoteResult(recordsResult));
        setSummary(formatProviderSummary(unwrapRemoteResult(stateResult)));
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <Panel title="模型提供方"><StatusLine tone="danger">模型提供方状态暂不可用。</StatusLine></Panel>;
  if (summary === undefined || providers === undefined) return <Panel title="模型提供方"><Skeleton rows={2} /></Panel>;
  if (providers.length === 0) return <Panel title="模型提供方"><EmptyState>{summary}</EmptyState></Panel>;
  return (
    <Panel title="模型提供方" subtitle={summary} count={`${providers.length}`}>
      <List>
        {providers.map((record) => (
          <Row key={record.provider} title={record.displayName} meta={record.baseUrl === undefined ? record.provider : `${record.provider} · ${record.baseUrl}`} />
        ))}
      </List>
    </Panel>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
