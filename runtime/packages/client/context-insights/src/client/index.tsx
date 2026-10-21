/**
 * 上下文占用面板：在侧栏显示当前会话的占用比例。
 *
 * 数据经 Remote 调用取得（服务名 `chatdshContextInsights`）。三档等级的文案在这里固定：
 * 七成以下正常，七成到九成提醒，九成以上标红。
 * @module @chatdsh/client-context-insights
 */

import { useEffect, useState } from 'react';

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
export const inject = ['slots'];

let clientFace: ClientFace | undefined;

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

/** 侧栏条目。 */
function ContextInsightsEntry() {
  const [insight, setInsight] = useState<ContextInsight | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sessionId = clientFace?.session?.id;
    const load = clientFace?.remote?.chatdshContextInsights?.insight;
    if (sessionId === undefined || load === undefined) {
      setFailed(true);
      return;
    }
    load.call(clientFace?.remote?.chatdshContextInsights, sessionId).then(
      (state) => {
        if (!cancelled) setInsight(state);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const text = failed
    ? '上下文占用暂不可用'
    : insight === undefined
      ? '正在读取上下文占用…'
      : formatInsight(insight);

  return (
    <div style={{ padding: '8px 12px', fontSize: 13, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600 }}>上下文</div>
      <div style={{ opacity: insight?.level === 'critical' ? 1 : 0.7, color: insight?.level === 'critical' ? '#b42318' : undefined }}>{text}</div>
    </div>
  );
}

/**
 * 注册侧栏面板。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace & { slots: ClientSlots }): void {
  clientFace = ctx;
  ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({
    name: PANEL_SLOT,
    entry: PANEL_NAME,
  }, ContextInsightsEntry));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; entry?: string }, Component: () => unknown): () => void;
}
