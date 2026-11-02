/**
 * 审批界面的视图模型：卡片、分组、统计、键盘意图、焦点顺序与文案。
 *
 * 这一层不接触网络与 DOM，决定与提交的判定都在控制器里；这里只把宿主返回的形状整理成界面
 * 直接可用的行与文字。卡片的状态沿用宿主侧的取值，因此失效原因与统计口径在两侧一致。
 * @module @chatdsh/client-approval/model
 */

/** 一张审批卡片。 */
export interface ApprovalCardView {
  readonly sessionId: string;
  readonly runId?: string;
  readonly callId: string;
  readonly stateVersion: number;
  readonly state: 'pending' | 'answering' | 'decided' | 'expired' | 'unavailable';
  readonly origin: 'dsh' | 'hermes';
  readonly toolName: string;
  readonly summary: string;
  readonly reason?: string;
  readonly deviceId: string;
  readonly cwd?: string;
  readonly capabilityScope: string;
  readonly choices: readonly string[];
  readonly priority: number;
  readonly raisedAt: number;
  readonly expiresAt: number;
  readonly invalidReason?: string;
  readonly invalidText?: string;
  readonly decidedBy?: string;
  readonly decidedChoice?: string;
  readonly decidedAt?: number;
}

/** 工具分组。 */
export interface ApprovalToolGroup {
  readonly toolName: string;
  readonly count: number;
  readonly callIds: readonly string[];
}

/** 会话分组。 */
export interface ApprovalSessionGroup {
  readonly sessionId: string;
  readonly sessionHref: string;
  readonly count: number;
  readonly tools: readonly ApprovalToolGroup[];
}

/** 设备分组。 */
export interface ApprovalDeviceGroup {
  readonly deviceId: string;
  readonly count: number;
  readonly sessions: readonly ApprovalSessionGroup[];
}

/** 待处理概览。 */
export interface PendingOverview {
  readonly cards: readonly ApprovalCardView[];
  readonly groups: readonly ApprovalDeviceGroup[];
  readonly actionable: number;
  readonly readAt: number;
}

/** 一条决定记录。 */
export interface DecisionRecord {
  readonly callId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly result: 'approved' | 'denied' | 'timeout' | 'auto-approved';
  readonly choice?: string;
  readonly decidedBy: string;
  readonly decidedAt: number;
}

/** 统计。 */
export interface ApprovalStats {
  readonly sessionId?: string;
  readonly approved: number;
  readonly denied: number;
  readonly timeout: number;
  readonly autoApproved: number;
  readonly total: number;
  readonly pending: number;
  readonly recent: readonly DecisionRecord[];
  readonly readAt: number;
}

/** 一条生效中的策略。 */
export interface PolicyRecord {
  readonly id: string;
  readonly scope: 'session' | 'device';
  readonly sessionId?: string;
  readonly toolName: string;
  readonly choice: string;
  readonly createdAt: number;
  readonly description: string;
}

/** 一个问题项。 */
export interface QuestionItemView {
  readonly id: string;
  readonly question: string;
  readonly detail?: string;
  readonly header?: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiple: boolean;
  readonly allowFreeText: boolean;
}

/** 计划接管状态。 */
export interface TakeoverStateView {
  readonly holderId?: string;
  readonly holderLabel?: string;
  readonly draft: string;
  readonly draftRevision: number;
  readonly updatedAt: number;
}

/** 一张提问卡片。 */
export interface QuestionCardView {
  readonly sessionId: string;
  readonly callId: string;
  readonly stateVersion: number;
  readonly state: 'pending' | 'answering' | 'submitted' | 'expired' | 'cancelled';
  readonly kind: 'question' | 'plan-review';
  readonly questions: readonly QuestionItemView[];
  readonly planMarkdown?: string;
  readonly raisedAt: number;
  readonly expiresAt: number;
  readonly invalidReason?: string;
  readonly invalidText?: string;
  readonly takeover?: TakeoverStateView;
}

/** 审批选项。 */
export const DECISION_CHOICES = ['once', 'session', 'always', 'deny'] as const;

/** 审批选项取值。 */
export type DecisionChoice = (typeof DECISION_CHOICES)[number];

/** 需要再次确认的两个扩大范围选项。 */
export const ESCALATING_CHOICES: readonly DecisionChoice[] = ['session', 'always'];

/** 选项文案。 */
export const CHOICE_TEXT: Readonly<Record<DecisionChoice, string>> = {
  once: '本次允许',
  session: '本会话允许',
  always: '始终允许',
  deny: '拒绝',
};

/** 卡片状态文案。 */
export const CARD_STATE_TEXT: Readonly<Record<ApprovalCardView['state'], string>> = {
  pending: '等待决定',
  answering: '正在处理',
  decided: '已处理',
  expired: '已超时',
  unavailable: '不可用',
};

/**
 * 扩大范围选项的作用范围说明。
 * @param choice - 选项。
 * @returns 说明。
 */
export function escalationScopeText(choice: DecisionChoice): string {
  return choice === 'session'
    ? '只对本次会话里同一个工具的同类审批生效，会话结束后失效'
    : '对本设备所有会话里同一个工具的同类审批生效，直到撤销';
}

/** 统计里结果对应的文案。 */
export const RECORD_RESULT_TEXT: Readonly<Record<DecisionRecord['result'], string>> = {
  approved: '已批准',
  denied: '已拒绝',
  timeout: '已超时',
  'auto-approved': '按策略自动批准',
};

/** 界面上「只提供单次允许与拒绝」的场合可用的选项。 */
export const GLOBAL_CHOICES: readonly DecisionChoice[] = ['once', 'deny'];

/** 一张卡片在界面上的一行。 */
export interface CardRow {
  readonly card: ApprovalCardView;
  /** 所在分组。 */
  readonly deviceId: string;
  readonly sessionId: string;
  /** 是否可操作：状态为等待、没有失效原因，并且本端在线。 */
  readonly actionable: boolean;
  /** 界面上可用的选项。 */
  readonly offered: readonly DecisionChoice[];
  /** 本端造成的失效原因，例如设备离线。 */
  readonly localInvalidReason?: string;
  /** 本端造成的失效说明。 */
  readonly localInvalidText?: string;
}

/**
 * 把卡片整理成界面行。
 *
 * 会话内可用的选项由卡片携带的能力范围决定，全局列表只提供单次允许与拒绝。离线时卡片在本端
 * 按失效显示并写出原因：这时候决定发不出去，界面要说明白，而不是留一个按了没有反应的按钮。
 * @param cards - 卡片。
 * @param scope - 展示场合：会话内或全局列表。
 * @param options - 本端在线状态。
 * @returns 界面行。
 */
export function cardRows(
  cards: readonly ApprovalCardView[],
  scope: 'session' | 'global',
  options: { readonly online?: boolean } = {},
): CardRow[] {
  const online = options.online ?? true;
  return cards.map((card) => {
    const actionable = online && card.invalidReason === undefined && card.state === 'pending';
    const capabilities = card.choices.filter((choice): choice is DecisionChoice =>
      (DECISION_CHOICES as readonly string[]).includes(choice));
    const offered = scope === 'global'
      ? GLOBAL_CHOICES.filter((choice) => capabilities.includes(choice))
      : capabilities;
    return {
      card,
      deviceId: card.deviceId,
      sessionId: card.sessionId,
      actionable,
      offered: actionable ? offered : [],
      ...(online ? {} : { localInvalidReason: 'device-offline', localInvalidText: '设备不在线，决定没有发出' }),
    };
  });
}

/**
 * 按会话与工具分组的文字行，供全局列表展示。
 * @param groups - 设备分组。
 * @returns 每行一段说明。
 */
export function groupLines(groups: readonly ApprovalDeviceGroup[]): string[] {
  const lines: string[] = [];
  for (const device of groups) {
    for (const session of device.sessions) {
      const tools = session.tools.map((tool) => `${tool.toolName} ${tool.count} 项`).join('、');
      lines.push(`${device.deviceId} · 会话 ${session.sessionId}：${tools}`);
    }
  }
  return lines;
}

/** 打开一张卡片之后默认的焦点目标：卡片标题，落在任何决定按钮之前。 */
export function defaultFocusId(callId: string): string {
  return `card-${callId}-title`;
}

/**
 * 一张卡片的焦点顺序。
 *
 * 顺序是标题、说明、允许、拒绝：拒绝排在最后，打开卡片时焦点停在标题上，因此默认焦点永远
 * 不落在危险按钮上。
 * @param card - 卡片。
 * @param offered - 这条界面上可用的选项。
 * @returns 焦点目标标识列表。
 */
export function focusOrder(card: ApprovalCardView, offered: readonly DecisionChoice[]): string[] {
  const order = [`card-${card.callId}-title`, `card-${card.callId}-summary`];
  for (const choice of offered) order.push(`card-${card.callId}-choice-${choice}`);
  if (card.invalidReason === undefined) order.push(`card-${card.callId}-jump`);
  return order;
}

/** 键盘意图。 */
export const KEY_INTENTS = ['close', 'next', 'previous', 'none'] as const;

/** 键盘意图取值。 */
export type KeyIntent = (typeof KEY_INTENTS)[number];

/** 键盘事件里本模块关心的字段。 */
export interface KeyLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

/**
 * 卡片区域的按键意图。
 *
 * Escape 只关闭，Enter 与空格交给获得焦点的按钮自己处理，因此键盘上不存在「按一下就批准」的
 * 通路；组合键（Ctrl、Meta、Alt）一律不接管。
 * @param event - 键盘事件。
 * @returns 意图。
 */
export function keyIntent(event: KeyLike): KeyIntent {
  if (event.isComposing === true) return 'none';
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return 'none';
  if (event.key === 'Escape') return 'close';
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'previous';
  return 'none';
}

/** 决定请求。 */
export interface DecisionRequestView {
  readonly callId: string;
  readonly stateVersion: number;
  readonly choice: DecisionChoice;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly escalationConfirmed: boolean;
  readonly decidedBy?: string;
}

/** 决定结果。 */
export type DecisionResultView =
  | { readonly outcome: 'decided'; readonly callId: string; readonly stateVersion: number; readonly choice: string; readonly decidedAt: number }
  | { readonly outcome: 'already-decided'; readonly callId: string; readonly choice: string; readonly decidedAt: number }
  | { readonly outcome: 'rejected'; readonly code: string };

/** 提问应答结果。 */
export type QuestionResultView =
  | { readonly outcome: 'submitted'; readonly stateVersion: number; readonly submittedAt: number }
  | { readonly outcome: 'rejected'; readonly code: string; readonly problems?: readonly string[] };

/** 计划草稿保存结果。 */
export interface PlanDraftResultView {
  readonly outcome: 'saved' | 'conflict' | 'rejected';
  readonly revision: number;
  readonly updatedAt: number;
  readonly reason?: string;
  readonly code?: string;
}

/** 接管结果。 */
export interface TakeoverResultView {
  readonly outcome: 'granted' | 'held' | 'released' | 'rejected';
  readonly holderId?: string;
  readonly holderLabel?: string;
  readonly draft?: string;
  readonly draftRevision?: number;
  readonly reason?: string;
  readonly code?: string;
}

/** 驳回原因对应的文案，用于「决定没有生效」的说明。 */
export const REJECTION_TEXT: Readonly<Record<string, string>> = {
  'approval-already-decided': '这张卡片已经被另一客户端处理',
  'approval-expired': '这张卡片已经超过失效时刻',
  'approval-missing-correlation': '卡片缺少工具调用标识，无法处理',
  'approval-choice-unsupported': '当前策略不支持这个选项',
  'revision-conflict': '卡片状态已经变化，请重新读取',
  'request-invalid': '请求内容不合法，决定没有发出',
  'question-expired': '这张提问卡片已经失效',
  'question-missing-correlation': '提问卡片缺少关联标识',
  'question-invalid': '回答与问题不符，填写内容仍然保留',
  'device-offline': '设备不在线，决定没有发出',
};

/**
 * 取一段驳回说明。
 * @param code - 错误码。
 * @returns 文案；未登记的错误码原样带上错误码。
 */
export function rejectionText(code: string): string {
  const known = REJECTION_TEXT[code];
  return known ?? `决定没有生效（${code}）`;
}

/** 计划草稿的存储键，与消息草稿的分段方式一致：客户端、窗口、设备、会话与卡片。 */
export function planDraftKey(parts: {
  readonly clientId: string;
  readonly windowId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly callId: string;
}): string {
  return `chatdsh-approval.plan-draft.v1:${parts.clientId}:${parts.windowId}:${parts.deviceId}:${parts.sessionId}:${parts.callId}`;
}

/** 本地草稿的形状。 */
export interface PlanDraftRecord {
  readonly text: string;
  readonly revision: number;
  readonly updatedAt: number;
}

/**
 * 校验本地草稿。
 * @param value - 解析后的值。
 * @returns 合法时为草稿，否则为 `undefined`。
 */
export function parsePlanDraft(value: unknown): PlanDraftRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') return undefined;
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 0) return undefined;
  if (typeof record.updatedAt !== 'number') return undefined;
  return { text: record.text, revision: record.revision, updatedAt: record.updatedAt };
}

/**
 * 生成一次操作标识：16 字节随机值的十六进制写法。
 * @returns 操作标识。
 */
export function newOperationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 计算请求摘要：决定性字段的 SHA-256 十六进制写法。
 * @param parts - 关联键、状态版本、选项与操作标识。
 * @returns 摘要。
 */
export async function requestDigestOf(parts: {
  readonly callId: string;
  readonly stateVersion: number;
  readonly action: string;
  readonly operationId: string;
}): Promise<string> {
  const text = `${parts.callId}|${parts.stateVersion}|${parts.action}|${parts.operationId}`;
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
