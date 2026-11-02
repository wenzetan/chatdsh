/**
 * 自动化界面用到的数据形状。
 *
 * 形状取自控制平面的真实返回：自动化记录、投递记录、设备、会话与原会话的定时任务。字段按
 * 返回值的含义命名，界面不在这一层改名；控制平面可能补充的可选字段（目标设备、助手、
 * 模型、修订号）在这里声明为可选，缺失时界面显示「未指定」，不推断取值。
 * @module @chatdsh/client-automation/types
 */

import type { ScheduleSpec } from './schedule.ts';

/** 外部事件的来源。 */
export type EventSource = 'github' | 'generic';

/**
 * 触发条件。
 *
 * 定时触发里的 `cron` 是控制平面记下的表达式；界面选择的时间方式另存在记录的 `spec` 里，
 * `cron` 只在用户选择 cron 表达式时填写。界面只登记业务记录与执行目标，不在控制平面建立
 * 第二个定时调度器。
 */
export type AutomationTrigger =
  | { readonly kind: 'webhook'; readonly secretEnv: string }
  | { readonly kind: 'schedule'; readonly cron: string };

/** 动作。 */
export interface AutomationAction {
  /** 动作类型：起一个新会话。 */
  readonly kind: 'start-session';
  /** 目标工作区；省略时落在默认目录。 */
  readonly workspaceId?: string;
  /** 交给会话的提示词。 */
  readonly prompt: string;
}

/** 动作的执行目标。 */
export interface AutomationTarget {
  /** 执行设备标识。 */
  readonly deviceId?: string;
  /** 执行设备名称。 */
  readonly deviceName?: string;
  /** 目标工作区标识。 */
  readonly workspaceId?: string;
  /** 目标工作区名称。 */
  readonly workspaceName?: string;
  /** 目标目录。 */
  readonly cwd?: string;
  /** 助手或 preset 标识。 */
  readonly presetId?: string;
  /** 助手或 preset 名称。 */
  readonly presetName?: string;
  /** 模型标识。 */
  readonly model?: string;
}

/** 一条自动化记录。 */
export interface AutomationRecord {
  /** 记录标识。 */
  readonly id: string;
  /** 展示名。 */
  readonly name: string;
  /** 触发条件。 */
  readonly trigger: AutomationTrigger;
  /** 动作。 */
  readonly action: AutomationAction;
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 创建时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 修订号；控制平面提供时用于保存冲突判定。 */
  readonly revision?: number;
  /** 执行目标。 */
  readonly target?: AutomationTarget;
  /** 定时触发的时间方式；控制平面提供时优先于 `trigger.cron` 展示。 */
  readonly spec?: ScheduleSpec;
  /** 最近一次投递的摘要；控制平面提供时直接展示。 */
  readonly lastDelivery?: {
    readonly state: DeliveryState;
    readonly receivedAt: number;
    readonly code?: string;
  };
}

/** 投递状态。 */
export type DeliveryState =
  | 'received'
  | 'validated'
  | 'dispatching'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'unconfirmed';

/** 去重结果。 */
export type DedupeResult = 'new' | 'duplicate';

/** 一条投递记录。 */
export interface AutomationDelivery {
  /** 投递标识。 */
  readonly deliveryId: string;
  /** 命中的自动化标识。 */
  readonly automationId: string;
  /** 外部事件标识。 */
  readonly eventId: string;
  /** 来源。 */
  readonly source: EventSource;
  /** 接收时刻。 */
  readonly receivedAt: number;
  /** 去重结果。 */
  readonly dedupe: DedupeResult;
  /** 当前状态。 */
  readonly state: DeliveryState;
  /** 建立的执行会话。 */
  readonly sessionId?: string;
  /** 完成时刻。 */
  readonly completedAt?: number;
  /** 失败或未确认时的错误码。 */
  readonly code?: string;
}

/** 投递记录的一页。 */
export interface DeliveryPage {
  /** 这一页的记录。 */
  readonly deliveries: readonly AutomationDelivery[];
  /** 下一页游标；没有更多记录时为空。 */
  readonly nextCursor?: string;
}

/** 投递记录查询。 */
export interface DeliveryQuery {
  /** 自动化过滤。 */
  readonly automationId?: string;
  /** 状态过滤。 */
  readonly state?: DeliveryState;
  /** 游标。 */
  readonly cursor?: string;
  /** 每页条数。 */
  readonly limit: number;
}

/** 一个执行节点。 */
export interface DeviceSummary {
  /** 设备标识。 */
  readonly id: string;
  /** 设备名称。 */
  readonly name: string;
  /** 平台。 */
  readonly platform: string;
  /** 是否在线。 */
  readonly online: boolean;
  /** 最近一次握手或心跳的时刻。 */
  readonly lastSeenAt: number;
}

/** 一条会话。 */
export interface SessionSummary {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 会话标题。 */
  readonly title: string;
  /** 最近更新时刻。 */
  readonly updatedAt: number;
  /** 工作目录。 */
  readonly cwd: string;
  /** 工作区名称。 */
  readonly workspaceName: string;
}

/** 一台设备与它名下的会话。 */
export interface DeviceSessions {
  /** 设备标识。 */
  readonly deviceId: string;
  /** 设备名称。 */
  readonly name: string;
  /** 平台。 */
  readonly platform: string;
  /** 是否在线。 */
  readonly online: boolean;
  /** 最近一次握手或心跳的时刻。 */
  readonly lastSeenAt: number;
  /** 会话列表。 */
  readonly sessions: readonly SessionSummary[];
}

/** 会话聚合。 */
export interface SessionsSnapshot {
  /** 按设备分组的会话。 */
  readonly devices: readonly DeviceSessions[];
}

/** 一条原会话的定时任务。 */
export interface ScheduleView {
  /** 定时任务标识。 */
  readonly scheduleId: string;
  /** 原会话标识。 */
  readonly sessionId: string;
  /** 名称。 */
  readonly name: string;
  /** 提醒文本。 */
  readonly prompt: string;
  /** 触发方式。 */
  readonly spec: ScheduleSpec;
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 下次发生时刻。 */
  readonly nextRunAt?: number;
  /** 上次发生时刻。 */
  readonly lastRunAt?: number;
}

/** 新建或编辑自动化时提交的取值。 */
export interface AutomationDraftInput {
  /** 展示名。 */
  readonly name: string;
  /** 触发条件：webhook 或定时。 */
  readonly trigger: AutomationTrigger;
  /** 交给会话的提示词。 */
  readonly prompt: string;
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 执行目标。 */
  readonly target: AutomationTarget;
  /** 定时触发时选择的时间方式；`trigger.cron` 只在方式为 cron 时填写表达式。 */
  readonly spec?: ScheduleSpec;
  /** 修订号；编辑时带上。 */
  readonly revision?: number;
}

/** 界面动作名，取值集合固定。 */
export type AutomationUiAction =
  | 'automation-create'
  | 'automation-edit'
  | 'automation-delete'
  | 'automation-toggle'
  | 'automation-reload'
  | 'automation-copy-webhook'
  | 'automation-deliveries'
  | 'automation-session-open'
  | 'schedule-create'
  | 'schedule-edit'
  | 'schedule-cancel'
  | 'schedule-delete'
  | 'schedule-reload';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed' | 'degraded' | 'unavailable';

/** 浏览器侧遥测面。 */
export interface PanelTelemetry {
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 动作结果。
   */
  action(action: AutomationUiAction, outcome: ActionOutcome): void;
}

/** 面板依赖的数据面。 */
export interface AutomationGateway {
  /** 读取自动化列表。 */
  readonly automations: () => Promise<readonly AutomationRecord[]>;
  /** 建立一条自动化。 */
  readonly create: (input: AutomationDraftInput) => Promise<AutomationRecord>;
  /** 编辑一条自动化。 */
  readonly update: (id: string, input: AutomationDraftInput) => Promise<AutomationRecord>;
  /** 删除一条自动化。 */
  readonly remove: (id: string) => Promise<void>;
  /** 切换启用状态。 */
  readonly setEnabled: (id: string, enabled: boolean) => Promise<AutomationRecord>;
  /** 读取投递记录的一页。 */
  readonly deliveries: (query: DeliveryQuery) => Promise<DeliveryPage>;
  /** 读取执行节点。 */
  readonly devices: () => Promise<readonly DeviceSummary[]>;
  /** 读取按设备分组的会话。 */
  readonly sessions: () => Promise<SessionsSnapshot>;
  /** 读取一条会话在原设备上的定时任务。 */
  readonly schedules: (deviceId: string, sessionId: string) => Promise<readonly ScheduleView[]>;
  /** 在原会话上建立定时任务。 */
  readonly createSchedule: (input: {
    readonly deviceId: string;
    readonly sessionId: string;
    readonly name: string;
    readonly prompt: string;
    readonly spec: ScheduleSpec;
    readonly enabled: boolean;
  }) => Promise<ScheduleView>;
  /**
   * 修改一条定时任务。
   *
   * 停用与启用走同一个入口；删除由 `removeSchedule` 负责。取消一条任务等于停用，
   * 运行时不再发生，记录留在原会话里。
   */
  readonly updateSchedule: (input: {
    readonly deviceId: string;
    readonly sessionId: string;
    readonly scheduleId: string;
    readonly name: string;
    readonly prompt: string;
    readonly spec: ScheduleSpec;
    readonly enabled: boolean;
  }) => Promise<ScheduleView>;
  /** 删除一条定时任务。 */
  readonly removeSchedule: (input: { readonly deviceId: string; readonly sessionId: string; readonly scheduleId: string }) => Promise<void>;
  /** 记录一次界面动作。 */
  readonly noteAction: (action: AutomationUiAction, outcome: ActionOutcome) => void;
}
