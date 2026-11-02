/**
 * 上下文占用面板的数据入口。
 *
 * `chatdshContextInsights` 给出每个会话的占用读数：已用与窗口的比例、剩余 token、窗口来源
 * 与降级原因。读数只读，不写回任何状态；会话不存在时宿主按 `session-not-found` 拒绝。
 * @module @chatdsh/client-context-insights/gateway
 */

/** 占用等级。 */
export type ContextLevel = 'ok' | 'warn' | 'critical';

/** 窗口来源。 */
export type WindowSource = 'model-catalog' | 'config';

/** 窗口降级原因。 */
export type WindowReason = 'catalog-unsupported' | 'no-session-model' | 'router-unavailable' | 'model-lookup-failed';

/** 一次占用读数。 */
export interface ContextInsightView {
  /** 已用与窗口的比例。 */
  readonly usedRatio: number;
  /** 三档等级。 */
  readonly level: ContextLevel;
  /** 剩余 token。 */
  readonly remainingTokens: number;
  /** 已用 token。 */
  readonly usedTokens: number;
  /** 计算比例用的窗口。 */
  readonly windowTokens: number;
  /** 会话事件数。 */
  readonly events: number;
  /** token 计数来源。 */
  readonly tokensSource: 'usage-projection' | 'unavailable';
  /** 窗口与来源。 */
  readonly window: {
    /** 窗口 token 数。 */
    readonly tokens: number;
    /** 来源。 */
    readonly source: WindowSource;
    /** 是否降级。 */
    readonly degraded: boolean;
    /** 降级原因。 */
    readonly reason?: WindowReason;
    /** 窗口所属 provider。 */
    readonly provider?: string;
    /** 窗口所属模型。 */
    readonly model?: string;
    /** 读取模型元数据失败时的错误码。 */
    readonly errorCode?: string;
  };
}

/** 调用失败。 */
export class InsightCallError extends Error {
  /**
   * @param code - 稳定错误码。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'InsightCallError';
  }
}

/** 数据入口。 */
export interface ContextGateway {
  /** 一个会话的占用。 */
  insight(sessionId: string): Promise<ContextInsightView>;
  /** 全部会话的占用。 */
  all(): Promise<Record<string, ContextInsightView>>;
}

/** 构造依赖。 */
export interface ContextGatewayOptions {
  /** 发请求的实现。 */
  readonly fetchImpl?: typeof fetch;
  /** 端点前缀。 */
  readonly prefix?: string;
}

/** 判一个取值是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析一条占用读数。 */
function insightOf(value: unknown): ContextInsightView {
  if (!isRecord(value) || !isRecord(value.window)) {
    throw new InsightCallError('gateway/internal', '上下文占用的返回形状不符合约定');
  }
  const window = value.window;
  return {
    usedRatio: typeof value.usedRatio === 'number' ? value.usedRatio : 0,
    level: value.level === 'warn' || value.level === 'critical' ? value.level : 'ok',
    remainingTokens: typeof value.remainingTokens === 'number' ? value.remainingTokens : 0,
    usedTokens: typeof value.usedTokens === 'number' ? value.usedTokens : 0,
    windowTokens: typeof value.windowTokens === 'number' ? value.windowTokens : 0,
    events: typeof value.events === 'number' ? value.events : 0,
    tokensSource: value.tokensSource === 'usage-projection' ? 'usage-projection' : 'unavailable',
    window: {
      tokens: typeof window.tokens === 'number' ? window.tokens : 0,
      source: window.source === 'model-catalog' ? 'model-catalog' : 'config',
      degraded: window.degraded === true,
      ...(typeof window.reason === 'string' ? { reason: window.reason as WindowReason } : {}),
      ...(typeof window.provider === 'string' ? { provider: window.provider } : {}),
      ...(typeof window.model === 'string' ? { model: window.model } : {}),
      ...(typeof window.errorCode === 'string' ? { errorCode: window.errorCode } : {}),
    },
  };
}

/**
 * 建立上下文占用的数据入口。
 * @param options - 请求实现与前缀覆盖。
 * @returns 数据入口。
 */
export function createContextGateway(options: ContextGatewayOptions = {}): ContextGateway {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const prefix = options.prefix ?? '/api/';
  let sequence = 0;
  const call = async (endpoint: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    sequence += 1;
    const response = await fetchImpl(`${prefix}${endpoint}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `chatdsh-insight-${String(sequence)}`,
        method: endpoint,
        payload: { args },
      }),
    });
    if (!response.ok) throw new InsightCallError('gateway/unreachable', `上下文接口返回 ${String(response.status)}`);
    const body = (await response.json()) as {
      result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
    };
    const result = body.result;
    if (result === undefined) throw new InsightCallError('gateway/internal', '上下文接口的应答缺少结果字段');
    if (result.ok !== true) throw new InsightCallError(result.error?.code ?? 'gateway/internal', result.error?.message ?? '上下文读取失败');
    return result.value;
  };
  return {
    async insight(sessionId: string): Promise<ContextInsightView> {
      return insightOf(await call('chatdshContextInsights/insight', { sessionId }));
    },
    async all(): Promise<Record<string, ContextInsightView>> {
      const value = await call('chatdshContextInsights/all', {});
      if (!isRecord(value)) throw new InsightCallError('gateway/internal', '全会话占用的返回形状不符合约定');
      const out: Record<string, ContextInsightView> = {};
      for (const [sessionId, entry] of Object.entries(value)) out[sessionId] = insightOf(entry);
      return out;
    },
  };
}
