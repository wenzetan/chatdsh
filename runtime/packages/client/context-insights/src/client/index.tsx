/**
 * 上下文占用面板：比例、剩余、窗口来源与降级原因。
 *
 * 数据经宿主接口 `chatdshContextInsights` 取得。三档等级的文案在这里固定：七成以下正常，
 * 七成到九成提醒，九成以上标红。窗口来源与降级原因按宿主的读数原样显示，不把回落的窗口
 * 当成模型目录的真实读数。
 * @module @chatdsh/client-context-insights
 */

import { useEffect, useState } from 'react';
import { Button, List, Panel, ProgressBar, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

import { createContextGateway, InsightCallError, type ContextGateway, type ContextInsightView, type WindowReason } from './gateway.ts';

export { createContextGateway, InsightCallError } from './gateway.ts';
export type * from './gateway.ts';

/** 侧栏席位名。 */
export const PANEL_SLOT = 'sidebar.panellist';

/** 面板在侧栏里的条目名。 */
export const PANEL_NAME = 'chatdsh.context-insights';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots', 'remote'];

/** 由 `apply` 装好的数据入口；面板在挂载时取用。 */
let panelGateway: ContextGateway | undefined;

/** 取数据入口；没有装好时按同源接口现建一个。 */
function gatewayOf(): ContextGateway {
  panelGateway ??= createContextGateway();
  return panelGateway;
}

/** 浏览器侧上下文的可用面。 */
interface ClientFace {
  /** 当前会话标识，由宿主注入。 */
  readonly session?: { readonly id?: string };
}

/** 降级原因的用户说明。 */
export function formatWindowReason(reason: WindowReason | undefined): string | undefined {
  if (reason === 'catalog-unsupported') return '模型目录没有披露窗口，按部署配置的窗口计算';
  if (reason === 'no-session-model') return '会话还没有固定模型';
  if (reason === 'router-unavailable') return '模型路由服务未装载';
  if (reason === 'model-lookup-failed') return '读取模型元数据失败';
  return undefined;
}

/**
 * 面板上的一行文案。
 * @param insight - 洞察结果。
 * @returns 面向用户的一句话。
 */
export function formatInsight(insight: ContextInsightView): string {
  const percent = Math.round(insight.usedRatio * 100);
  if (insight.level === 'critical') return `上下文占用 ${String(percent)}%，接近上限`;
  if (insight.level === 'warn') return `上下文占用 ${String(percent)}%，建议压缩`;
  return `上下文占用 ${String(percent)}%`;
}

/** 窗口来源与降级原因。 */
export function formatWindow(insight: ContextInsightView): string {
  const source = insight.window.source === 'model-catalog' ? '模型目录' : '部署配置';
  const parts = [`窗口 ${String(insight.windowTokens)} token（来源：${source}）`];
  if (insight.window.degraded) {
    parts.push(`已降级：${formatWindowReason(insight.window.reason) ?? '宿主没有给出原因'}`);
  }
  if (insight.window.provider !== undefined) parts.push(`模型 ${insight.window.provider} / ${insight.window.model ?? '未披露'}`);
  return parts.join('；');
}

/** 一条占用的详细读数。 */
export function ContextDetail({ sessionId, insight }: { readonly sessionId: string; readonly insight: ContextInsightView }) {
  const tone = insight.level === 'critical' ? 'danger' : insight.level === 'warn' ? 'warn' : 'brand';
  return (
    <section aria-label={`会话 ${sessionId} 的上下文占用`} data-chdsh-context-detail={sessionId}>
      <ProgressBar ratio={insight.usedRatio} tone={tone} label="上下文占用" />
      <p>
        <StatusLine tone={insight.level === 'critical' ? 'danger' : 'muted'}>{formatInsight(insight)}</StatusLine>
      </p>
      <p data-chdsh-context-remaining>剩余 {String(insight.remainingTokens)} token；已用 {String(insight.usedTokens)} / 窗口 {String(insight.windowTokens)} token。</p>
      <p data-chdsh-context-window>{formatWindow(insight)}</p>
      <p data-chdsh-context-tokens>
        token 来源：{insight.tokensSource === 'usage-projection' ? '用量投影' : '不可用，已用量按零计算'}；会话事件 {String(insight.events)} 个。
      </p>
    </section>
  );
}

/** 带会话标识的完整面板；测试与设置页直接取用。 */
export function ContextInsightsPanel({ gateway, sessionId }: { readonly gateway?: ContextGateway; readonly sessionId?: string }) {
  const active = gateway ?? gatewayOf();
  const [insight, setInsight] = useState<ContextInsightView | undefined>(undefined);
  const [all, setAll] = useState<Record<string, ContextInsightView> | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (sessionId === undefined) {
      active.all().then(
        (value) => {
          if (!cancelled) setAll(value);
        },
        (failure: unknown) => {
          if (!cancelled) setFailed(failure instanceof InsightCallError ? `${failure.message}（${failure.code}）` : String(failure));
        },
      );
      return () => {
        cancelled = true;
      };
    }
    active.insight(sessionId).then(
      (value) => {
        if (!cancelled) setInsight(value);
      },
      (failure: unknown) => {
        if (!cancelled) setFailed(failure instanceof InsightCallError ? `${failure.message}（${failure.code}）` : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, reloadToken]);

  if (failed !== undefined) {
    return (
      <Panel title="上下文">
        <StatusLine tone="danger">上下文占用暂不可用：{failed}</StatusLine>
        <p><Button onClick={() => { setFailed(undefined); setReloadToken((token) => token + 1); }}>重新读取</Button></p>
      </Panel>
    );
  }
  if (sessionId === undefined) {
    if (all === undefined) return <Panel title="上下文"><Skeleton rows={2} /></Panel>;
    const entries = Object.entries(all);
    if (entries.length === 0) return <Panel title="上下文"><StatusLine>还没有会话可以统计占用。</StatusLine></Panel>;
    return (
      <Panel title="上下文" count={`${String(entries.length)} 个会话`}>
        <List>
          {entries.map(([id, value]) => (
            <Row
              key={id}
              dot={value.level === 'critical' ? 'danger' : value.level === 'warn' ? 'warn' : 'ok'}
              title={`会话 ${id}`}
              badge={<span>{Math.round(value.usedRatio * 100)}%</span>}
              meta={`${formatInsight(value)}；剩余 ${String(value.remainingTokens)} token；${formatWindow(value)}`}
            />
          ))}
        </List>
      </Panel>
    );
  }
  if (insight === undefined) return <Panel title="上下文"><Skeleton rows={2} /></Panel>;
  return (
    <Panel title="上下文" count={`${String(Math.round(insight.usedRatio * 100))}%`}>
      <ContextDetail sessionId={sessionId} insight={insight} />
    </Panel>
  );
}

/**
 * 读当前会话标识。
 *
 * 注入作用域只保证 remote 命名空间可用，`session` 属于别的注入作用域；直接读会抛
 * 「cannot get property without inject」。这里把缺失当成没有会话，面板降级为不可用。
 * @param face - 浏览器侧上下文。
 * @returns 当前会话标识；没有时为空。
 */
function currentSessionId(face: ClientFace | undefined): string | undefined {
  try {
    return face?.session?.id;
  } catch {
    return undefined;
  }
}

/** 应用装好的浏览器侧上下文；侧栏条目从这里读会话标识。 */
let clientFace: ClientFace | undefined;

/** 侧栏条目：当前会话的占用与来源；没有当前会话时列出全部会话的占用。 */
export function ContextInsightsEntry({ gateway }: { readonly gateway?: ContextGateway } = {}) {
  return <ContextInsightsPanel gateway={gateway ?? gatewayOf()} sessionId={currentSessionId(clientFace)} />;
}

/**
 * 注册侧栏面板。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace & { slots: ClientSlots }): void {
  clientFace = ctx;
  panelGateway = createContextGateway();
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
