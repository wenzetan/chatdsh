import { buildRemoteContribution, unwrapRemoteResult } from '@chatdsh/core-remote-client';
import { z } from 'zod';
/**
 * 上下文占用面板：在侧栏显示当前会话的占用比例。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshContextInsights`）。三档等级的文案在这里固定：
 * 七成以下正常，七成到九成提醒，九成以上标红。
 * @module @chatdsh/client-context-insights
 */

import { useEffect, useState } from 'react';
import { Panel, ProgressBar, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

/** 一条洞察结果。 */
interface ContextInsight {
  readonly usedRatio: number;
  readonly level: 'ok' | 'warn' | 'critical';
  readonly remainingTokens: number;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  readonly remote?: {
    readonly chatdshContextInsights?: {
      insight?: (sessionId: string) => Promise<ContextInsight>;
    };
  };
  /** 当前会话标识，由宿主注入。 */
  readonly session?: { readonly id?: string };
}

/** 侧栏席位名。 */
export const PANEL_SLOT = 'sidebar.panellist';

/** 面板在侧栏里的条目名。 */
export const PANEL_NAME = 'chatdsh.context-insights';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots', 'remote'];

let clientFace: ClientFace | undefined;

/**
 * 读当前会话标识。
 *
 * 注入作用域只保证 remote 命名空间可用，`session` 不是该作用域的服务；直接读会抛
 * 「cannot get property without inject」。这里把缺失当成没有会话，面板降级为不可用。
 */
function currentSessionId(): string | undefined {
  try {
    return clientFace?.session?.id;
  } catch {
    return undefined;
  }
}

/**
 * 面板上的一行文案。
 * @param insight - 洞察结果。
 * @returns 面向用户的一句话。
 */
export function formatInsight(insight: ContextInsight): string {
  const percent = Math.round(insight.usedRatio * 100);
  if (insight.level === 'critical') return `上下文占用 ${percent}%，接近上限`;
  if (insight.level === 'warn') return `上下文占用 ${percent}%，建议压缩`;
  return `上下文占用 ${percent}%`;
}

/** 侧栏条目：占用比例、进度条与一句话；覆盖加载与失败两类状态。 */
export function ContextInsightsEntry() {
  const [insight, setInsight] = useState<ContextInsight | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sessionId = currentSessionId();
    const load = clientFace?.remote?.chatdshContextInsights?.insight;
    if (sessionId === undefined || load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshContextInsights, sessionId).then(
      (result) => {
        if (!cancelled) setInsight(unwrapRemoteResult(result));
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
    return <Panel title="上下文"><StatusLine>上下文占用暂不可用。</StatusLine></Panel>;
  }
  if (insight === undefined) {
    return <Panel title="上下文"><Skeleton rows={1} /></Panel>;
  }
  const tone = insight.level === 'critical' ? 'danger' : insight.level === 'warn' ? 'warn' : 'brand';
  return (
    <Panel title="上下文" count={`${Math.round(insight.usedRatio * 100)}%`}>
      <ProgressBar ratio={insight.usedRatio} tone={tone} />
      <p style={{ margin: '8px 0 0' }}>
        <StatusLine tone={insight.level === 'critical' ? 'danger' : 'muted'}>{formatInsight(insight)}</StatusLine>
      </p>
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
  await remoteHost.remote.$mount(buildRemoteContribution('chatdshContextInsights', {
    'chatdshContextInsights/insight': { parameters: [{ name: 'sessionId', kind: 'string' }] },
    'chatdshContextInsights/all': { parameters: [] },
  }, z));
  await new Promise<void>((resolve) => {
    remoteHost.inject(['remote.chatdshContextInsights'], (scope) => {
      clientFace = scope;
      resolve();
    });
  });

  ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({
    name: PANEL_SLOT,
    id: `panel.${PANEL_NAME}`,
    entry: PANEL_NAME,
  }, ContextInsightsEntry));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; entry?: string }, Component: () => unknown): () => void;
}
