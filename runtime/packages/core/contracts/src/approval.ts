/**
 * 审批记录与会话事件扩展的契约。
 *
 * 渠道会话（`chatBackend` 为 `hermes`）的审批不在 DSH 的审批服务里，而是写成会话内的
 * 插件记录：类型名匹配 `plugin:<小写段>` 语法，读取路径按 `ignorable: true` 放行。
 * @module @chatdsh/core-contracts/approval
 */

/** 审批记录的事件类型名。 */
export const APPROVAL_RECORD_TYPE = 'plugin:chatdsh-approval';

/** 审批选项。 */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

/** 审批请求的来源执行体。 */
export type ApprovalOrigin = 'dsh' | 'hermes';

/** 一条审批请求的写入载荷。 */
export interface ApprovalRequestRecord {
  /** 记录种类。 */
  readonly kind: 'request';
  /** 运行时侧生成的运行标识。 */
  readonly runId: string;
  /** 上游（Hermes 或 DSH 审批服务）的请求标识。 */
  readonly requestId: string;
  /** 来源执行体。 */
  readonly origin: ApprovalOrigin;
  /** 呈现给用户的标题。 */
  readonly title: string;
  /** 呈现给用户的说明。 */
  readonly detail?: string;
  /** 可选项。 */
  readonly choices: readonly ApprovalChoice[];
  /** 超时时刻的毫秒时间戳。 */
  readonly expiresAt: number;
}

/** 一条审批应答的写入载荷。 */
export interface ApprovalDecisionRecord {
  /** 记录种类。 */
  readonly kind: 'decision';
  readonly runId: string;
  readonly requestId: string;
  /** 采纳的选项。 */
  readonly choice: ApprovalChoice;
  /** 应答端标识，用于多客户端共存时的收敛展示。 */
  readonly answeredBy: string;
  /** 应答时刻的毫秒时间戳。 */
  readonly answeredAt: number;
  /** 是否因上游已失效（例如 Hermes 返回 409）而落定为已处理。 */
  readonly stale: boolean;
}

/** 审批记录载荷。 */
export type ApprovalRecord = ApprovalRequestRecord | ApprovalDecisionRecord;
