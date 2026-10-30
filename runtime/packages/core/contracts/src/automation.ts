/**
 * 自动化的契约。
 *
 * 自动化由三部分组成：触发条件（webhook 或定时）、动作（起一个会话）、以及投递记录
 * （哪一次外部事件被收下）。控制平面持有记录与投递去重，运行时按动作起会话。
 * @module @chatdsh/core-contracts/automation
 */

/** 外部事件的来源。 */
export const AUTOMATION_EVENT_SOURCES = ['github', 'generic'] as const;

/** 来源取值。 */
export type AutomationEventSource = (typeof AUTOMATION_EVENT_SOURCES)[number];

/** 触发条件。 */
export type AutomationTrigger =
  | {
    /** 外部系统按约定投递。 */
    readonly kind: 'webhook';
    /** 比对请求头的密钥所在的环境变量名；值不落配置。 */
    readonly secretEnv: string;
  }
  | {
    /** 定时触发。 */
    readonly kind: 'schedule';
    /** 五段式 cron 表达式。 */
    readonly cron: string;
  };

/** 动作。 */
export type AutomationAction = {
  /** 起一个新会话，把提示词交给它。 */
  readonly kind: 'start-session';
  /** 目标工作区；省略时落在默认目录。 */
  readonly workspaceId?: string;
  /** 交给会话的提示词。 */
  readonly prompt: string;
};

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
}

/** 一次被收下的外部投递。 */
export interface AutomationEvent {
  /** 命中的自动化标识。 */
  readonly automationId: string;
  /** 外部系统给出的事件标识；重复投递按它去重。 */
  readonly eventId: string;
  /** 收下时刻的毫秒时间戳。 */
  readonly receivedAt: number;
  /** 来源。 */
  readonly source: AutomationEventSource;
  /** 规范化后的请求体，供动作使用。 */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** 投递失败的原因码。 */
export const AUTOMATION_ERROR_CODES = {
  /** 自动化不存在。 */
  notFound: 'automation-not-found',
  /** 密钥不匹配。 */
  unauthorized: 'webhook-unauthorized',
  /** 请求体不是 JSON 对象。 */
  invalid: 'automation/webhook-invalid',
} as const;
