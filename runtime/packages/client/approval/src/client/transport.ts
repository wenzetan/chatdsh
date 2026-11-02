/**
 * 审批界面对宿主服务的取数接口。
 *
 * 界面只认这一组方法：远程调用、同源 HTTP 与页面内桥都按同一份形状实现，控制器因此不绑定某
 * 一种传输。宿主返回的失败由传输层抛错，控制器据此把卡片与填写内容留在界面上并说明原因。
 * @module @chatdsh/client-approval/transport
 */

import { unwrapRemoteResult } from '@chatdsh/core-remote-client';
import type {
  ApprovalStats,
  DecisionRequestView,
  DecisionResultView,
  PendingOverview,
  PlanDraftResultView,
  PolicyRecord,
  QuestionCardView,
  QuestionResultView,
  TakeoverResultView,
} from './model.ts';

/** 待处理列表的过滤条件。 */
export type PendingFilter = 'waiting' | 'handled' | 'all';

/** 待处理列表的查询。 */
export interface PendingQueryView {
  readonly filter: PendingFilter;
  readonly sessionId?: string;
}

/** 提问应答的一项。 */
export interface AnswerItemView {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

/** 提问应答的请求。 */
export interface QuestionAnswerView {
  readonly callId: string;
  readonly stateVersion: number;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly answers: readonly AnswerItemView[];
}

/** 跳过的请求。 */
export interface QuestionSkipView {
  readonly callId: string;
  readonly stateVersion: number;
  readonly operationId: string;
  readonly requestDigest: string;
}

/** 接管的请求。 */
export interface TakeoverRequestView {
  readonly action: 'acquire' | 'release';
  readonly callId: string;
  readonly holderId: string;
  readonly holderLabel: string;
  readonly stateVersion: number;
}

/** 草稿保存的请求。 */
export interface PlanDraftRequestView {
  readonly callId: string;
  readonly holderId: string;
  readonly text: string;
  readonly revision: number;
  readonly stateVersion: number;
}

/** 计划提交的请求。 */
export interface PlanSubmitView {
  readonly callId: string;
  readonly stateVersion: number;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly holderId: string;
  readonly decision: 'approve' | 'revise';
  readonly feedback: string;
}

/** 界面使用的取数接口。 */
export interface ApprovalTransport {
  /** 读待处理概览。 */
  pending(query: PendingQueryView): Promise<PendingOverview>;
  /** 读统计。 */
  stats(sessionId?: string): Promise<ApprovalStats>;
  /** 读生效中的策略。 */
  policies(): Promise<readonly PolicyRecord[]>;
  /** 读提问卡片。 */
  questions(): Promise<readonly QuestionCardView[]>;
  /** 提交一次审批决定。 */
  decide(request: DecisionRequestView): Promise<DecisionResultView>;
  /** 提交提问答案。 */
  answerQuestion(request: QuestionAnswerView): Promise<QuestionResultView>;
  /** 跳过提问。 */
  skipQuestion(request: QuestionSkipView): Promise<QuestionResultView>;
  /** 取得或释放计划编辑租约。 */
  takeover(request: TakeoverRequestView): Promise<TakeoverResultView>;
  /** 保存计划草稿。 */
  savePlanDraft(request: PlanDraftRequestView): Promise<PlanDraftResultView>;
  /** 提交计划审阅结果。 */
  submitPlan(request: PlanSubmitView): Promise<QuestionResultView>;
}

/** 远程命名空间的方法形状：返回带 `ok` 信封的结果。 */
export interface RemoteNamespaceLike {
  readonly pending?: (query: unknown) => Promise<unknown>;
  readonly stats?: (sessionId: string) => Promise<unknown>;
  readonly policies?: () => Promise<unknown>;
  readonly questions?: () => Promise<unknown>;
  readonly decide?: (request: unknown) => Promise<unknown>;
  readonly answerQuestion?: (request: unknown) => Promise<unknown>;
  readonly skipQuestion?: (request: unknown) => Promise<unknown>;
  readonly takeover?: (request: unknown) => Promise<unknown>;
  readonly savePlanDraft?: (request: unknown) => Promise<unknown>;
  readonly submitPlan?: (request: unknown) => Promise<unknown>;
}

/**
 * 把远程命名空间包装成界面取数接口。
 *
 * 每个方法都要求宿主侧存在同名远程方法；缺一个就在第一次调用时直接报错，而不是静默返回空
 * 列表——界面上「没有待处理」与「取数不可用」必须可区分。
 * @param namespace - 远程命名空间。
 * @returns 取数接口。
 */
export function remoteTransport(namespace: RemoteNamespaceLike): ApprovalTransport {
  const call = async <T>(name: keyof RemoteNamespaceLike, ...args: unknown[]): Promise<T> => {
    const method = namespace[name];
    if (method === undefined) throw new Error(`宿主没有提供审批方法 ${name}`);
    const result = await (method as (...rest: unknown[]) => Promise<unknown>)(...args);
    return unwrapRemoteResult<T>(result);
  };
  return {
    pending: (query) => call<PendingOverview>('pending', query),
    stats: (sessionId) => call<ApprovalStats>('stats', sessionId ?? ''),
    policies: () => call<PolicyRecord[]>('policies'),
    questions: () => call<QuestionCardView[]>('questions'),
    decide: (request) => call<DecisionResultView>('decide', request),
    answerQuestion: (request) => call<QuestionResultView>('answerQuestion', request),
    skipQuestion: (request) => call<QuestionResultView>('skipQuestion', request),
    takeover: (request) => call<TakeoverResultView>('takeover', request),
    savePlanDraft: (request) => call<PlanDraftResultView>('savePlanDraft', request),
    submitPlan: (request) => call<QuestionResultView>('submitPlan', request),
  };
}

/** 统一资源定位下的端点集合。 */
export interface HttpEndpoints {
  /** 待处理、统计与策略的读取端点前缀。 */
  readonly base: string;
}

/**
 * 把一组同源 HTTP 端点包装成界面取数接口。
 *
 * 载荷是请求体的 JSON，响应对应宿主服务的同名远程方法；非 2xx 一律抛错，由控制器显示取数
 * 失败，不把空列表当成结果。
 * @param endpoints - 端点前缀。
 * @param fetchImpl - 发请求的实现。
 * @returns 取数接口。
 */
export function httpTransport(endpoints: HttpEndpoints, fetchImpl: typeof fetch): ApprovalTransport {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetchImpl(`${endpoints.base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) throw new Error(`审批端点 ${path} 返回 ${String(response.status)}`);
    return (await response.json()) as T;
  };
  return {
    pending: (query) => post<PendingOverview>('pending', query),
    stats: (sessionId) => post<ApprovalStats>('stats', { sessionId: sessionId ?? '' }),
    policies: () => post<PolicyRecord[]>('policies', {}),
    questions: () => post<QuestionCardView[]>('questions', {}),
    decide: (request) => post<DecisionResultView>('decide', request),
    answerQuestion: (request) => post<QuestionResultView>('answerQuestion', request),
    skipQuestion: (request) => post<QuestionResultView>('skipQuestion', request),
    takeover: (request) => post<TakeoverResultView>('takeover', request),
    savePlanDraft: (request) => post<PlanDraftResultView>('savePlanDraft', request),
    submitPlan: (request) => post<QuestionResultView>('submitPlan', request),
  };
}
