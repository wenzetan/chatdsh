/**
 * 通知中心的对外类型。
 *
 * 取值与宿主侧的 HTTP 接口逐字对应：列表分页、已读与已处理结果、设置、订阅状态、验证
 * 通知与推送事件。界面只使用这里的字段，存储层的列名与内部游标不进入界面。
 * @module @chatdsh/client-notifications/types
 */

/** 通知种类。 */
export const NOTIFICATION_KINDS = [
  'approval',
  'question',
  'run-finished',
  'run-failed',
  'automation',
  'share',
  'device',
  'system',
] as const;

/** 通知种类取值。 */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 通知中心支持的过滤条件。 */
export const NOTIFICATION_FILTERS = ['all', 'unread', 'approval', 'run-result'] as const;

/** 过滤条件取值。 */
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

/** 过滤条件的界面名称。 */
export const FILTER_LABELS: Readonly<Record<NotificationFilter, string>> = {
  all: '全部',
  unread: '未读',
  approval: '审批',
  'run-result': '执行结果',
};

/** 通知种类的界面名称。 */
export const KIND_LABELS: Readonly<Record<NotificationKind, string>> = {
  approval: '审批请求',
  question: '提问',
  'run-finished': '执行完成',
  'run-failed': '执行失败',
  automation: '自动化',
  share: '分享',
  device: '设备',
  system: '系统',
};

/** 通知投递的两种节奏。 */
export const DELIVERY_MODES = ['all-at-once', 'two-stage'] as const;

/** 投递节奏取值。 */
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** 投递节奏的界面名称。 */
export const DELIVERY_MODE_LABELS: Readonly<Record<DeliveryMode, string>> = {
  'all-at-once': '一次性投递',
  'two-stage': '两阶段投递',
};

/** 系统通知内容的隐私级别。 */
export const PRIVACY_LEVELS = ['type', 'summary', 'preview'] as const;

/** 隐私级别取值。 */
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

/** 隐私级别的界面名称。 */
export const PRIVACY_LABELS: Readonly<Record<PrivacyLevel, string>> = {
  type: '仅产品与事件类型',
  summary: '产品、事件类型与摘要',
  preview: '产品、事件类型与消息预览',
};

/** 系统通知权限状态。 */
export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/** 系统通知权限的界面名称。 */
export const PERMISSION_LABELS: Readonly<Record<NotificationPermissionState, string>> = {
  default: '尚未请求',
  granted: '已允许',
  denied: '已拒绝',
  unsupported: '不支持',
};

/** 推送订阅状态。 */
export type SubscriptionState = 'subscribed' | 'expired' | 'gone' | 'unsubscribed';

/** 推送订阅状态的界面名称。 */
export const SUBSCRIPTION_LABELS: Readonly<Record<SubscriptionState, string>> = {
  subscribed: '已订阅',
  expired: '已过期',
  gone: '已失效',
  unsubscribed: '未订阅',
};

/** 通知中心里的一条通知。 */
export interface NotificationView {
  /** 通知标识。 */
  readonly id: string;
  /** 事件类型。 */
  readonly kind: NotificationKind;
  /** 业务标题。 */
  readonly title: string;
  /** 摘要。 */
  readonly summary: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知的稳定 tag。 */
  readonly tag?: string;
  /** 是否可撤回。 */
  readonly revocable: boolean;
  /** 事件发生时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 首次被读的时刻；没有任何客户端读过时缺省。 */
  readonly readAt?: number;
  /** 业务已处理时刻。 */
  readonly handledAt?: number;
  /** 读过这条通知的访问客户端标识。 */
  readonly readClients: readonly string[];
}

/** 通知中心的一页。 */
export interface NotificationPage {
  /** 当前页的记录，按时间倒序。 */
  readonly items: readonly NotificationView[];
  /** 下一页游标；没有更多时缺省。 */
  readonly nextCursor?: string;
  /** 当前设备与会话范围里的未读条数。 */
  readonly unread: number;
  /** 当前设备与会话范围里的已处理条数。 */
  readonly handled: number;
}

/** 分页查询。 */
export interface NotificationQuery {
  /** 过滤条件。 */
  readonly filter: NotificationFilter;
  /** 每页条数。 */
  readonly limit: number;
  /** 上一页返回的游标。 */
  readonly cursor?: string;
  /** 只看某台设备的记录。 */
  readonly deviceId?: string;
  /** 只看某个会话的记录。 */
  readonly sessionId?: string;
  /** 时间下限的毫秒时间戳。 */
  readonly since?: number;
  /** 时间上限的毫秒时间戳。 */
  readonly until?: number;
}

/** 已读标记结果。 */
export interface ReadResult {
  /** 本次新标记的条数。 */
  readonly marked: number;
  /** 已经处于已读状态的条数。 */
  readonly unchanged: number;
}

/** 业务已处理标记结果。 */
export interface HandledResult {
  /** 本次新标记的条数。 */
  readonly marked: number;
  /** 已经处于已处理状态的条数。 */
  readonly unchanged: number;
}

/** 通知设置；`privacy` 与 `revision` 由通知宿主维护。 */
export interface NotificationSettings {
  /** 投递节奏。 */
  readonly deliveryMode: DeliveryMode;
  /** 第一阶段等待，单位秒。 */
  readonly firstStageSeconds: number;
  /** 第二阶段等待，单位秒。 */
  readonly secondStageSeconds: number;
  /** 回合结束时投递。 */
  readonly onTurnEnd: boolean;
  /** 审批提出时投递。 */
  readonly onApproval: boolean;
  /** 系统通知展示消息预览。 */
  readonly messagePreview: boolean;
  /** 当前会话聚焦时静默。 */
  readonly quietWhenFocused: boolean;
  /** 系统通知内容的隐私级别。 */
  readonly privacy: PrivacyLevel;
  /** 服务端版本号。 */
  readonly revision: number;
  /** 最近写入时刻。 */
  readonly updatedAt: number;
}

/** 写入设置时提交的字段。 */
export type SettingsDraft = Omit<NotificationSettings, 'revision' | 'updatedAt'>;

/** 设置写入结果。 */
export type SettingsSaveResult =
  | { readonly ok: true; readonly settings: NotificationSettings }
  | { readonly ok: false; readonly code: string; readonly current: NotificationSettings };

/** 推送订阅的对外状态。 */
export interface SubscriptionView {
  /** 订阅状态。 */
  readonly state: SubscriptionState;
  /** 系统通知权限。 */
  readonly permission: NotificationPermissionState;
  /** 最近更新时刻。 */
  readonly updatedAt: number;
  /** 失效或失败时的错误码。 */
  readonly code?: string;
}

/** 保存订阅时提交的字段。 */
export interface SubscriptionInput {
  /** 推送服务端点。 */
  readonly endpoint: string;
  /** 订阅公钥。 */
  readonly p256dh: string;
  /** 订阅认证密钥。 */
  readonly auth: string;
  /** 系统通知权限。 */
  readonly permission: NotificationPermissionState;
}

/** 一次验证通知的结果。 */
export interface ProbeResult {
  /** 服务端受理时刻。 */
  readonly acceptedAt?: number;
  /** 客户端实际接收时刻。 */
  readonly receivedAt?: number;
  /** 结果。 */
  readonly result: 'accepted' | 'delivered' | 'failed' | 'revoked';
  /** 失败原因码。 */
  readonly code?: string;
}

/** 验证通知的应答。 */
export interface ProbeOutcome {
  /** 验证标识。 */
  readonly id: string;
  /** 两段结果。 */
  readonly probe: ProbeResult;
}

/** 推送事件里的一条通知。 */
export interface PushNotification {
  /** 通知标识。 */
  readonly id: string;
  /** 事件类型。 */
  readonly kind: NotificationKind;
  /** 展示标题。 */
  readonly title: string;
  /** 摘要；隐私级别为仅事件类型时缺省。 */
  readonly summary?: string;
  /** 命令或消息原文；只有预览级别才出现。 */
  readonly preview?: string;
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId?: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 系统通知的稳定 tag。 */
  readonly tag?: string;
  /** 事件发生时刻。 */
  readonly createdAt: number;
  /** 已读时刻。 */
  readonly readAt?: number;
  /** 已处理时刻。 */
  readonly handledAt?: number;
  /** 是否可撤回。 */
  readonly revocable: boolean;
}

/** 控制平面通过事件流下发的事件。 */
export type PushEvent =
  | {
    readonly kind: 'notification';
    readonly items: readonly PushNotification[];
    readonly count: number;
    readonly stage: number;
    readonly mode: DeliveryMode;
  }
  | {
    readonly kind: 'notification-read';
    readonly ids: readonly string[];
    readonly clientId: string;
    readonly deviceId?: string;
    readonly readAt: number;
    readonly unread: number;
  }
  | {
    readonly kind: 'notification-handled';
    readonly ids: readonly string[];
    readonly handledAt: number;
  }
  | {
    readonly kind: 'notification-withdraw';
    readonly ids: readonly string[];
    readonly tags: readonly string[];
    readonly sessionId?: string;
    readonly objectId?: string;
    readonly at: number;
  };

/** 打开一条通知时给出的业务目标。 */
export interface NavigationTarget {
  /** 关联设备。 */
  readonly deviceId?: string;
  /** 关联会话。 */
  readonly sessionId: string;
  /** 关联对象的稳定标识。 */
  readonly objectId?: string;
  /** 事件类型。 */
  readonly kind: NotificationKind;
}

/** 打开通知的结果。 */
export type OpenResult =
  | { readonly kind: 'navigate'; readonly target: NavigationTarget }
  | { readonly kind: 'missing'; readonly message: string }
  | { readonly kind: 'no-session'; readonly message: string };
