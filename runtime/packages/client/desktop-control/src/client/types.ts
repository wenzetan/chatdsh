/**
 * 桌面控制面板的类型、枚举与文案。
 *
 * 界面展示的状态与宿主回报的结构一一对应：能力声明、授权项、授权状态、租约、逐项确认清单与
 * 审计记录。文案按状态与时刻生成，不做猜测。
 * @module @chatdsh/client-desktop-control/types
 */

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed';

/** 租约状态。 */
export type LeaseStatus = 'active' | 'paused' | 'expired' | 'revoked' | 'interrupted';

/** 作用范围。 */
export type ControlScope =
  | { readonly kind: 'region'; readonly displayId: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly kind: 'window'; readonly applicationId: string; readonly windowId: string };

/** 能力缺口。 */
export interface CapabilityGap {
  readonly code: string;
  readonly detail: string;
}

/** 能力声明。 */
export interface CapabilityView {
  readonly platform: string;
  readonly platformLabel: string;
  readonly supported: boolean;
  readonly available: boolean;
  readonly capabilities: readonly string[];
  readonly minimumVersion?: number;
  readonly provider?: { readonly name: string; readonly version?: string };
  readonly gaps: readonly CapabilityGap[];
  readonly notice: string;
}

/** 一项系统授权。 */
export interface RequirementView {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  readonly settingsPath?: string;
  readonly note?: string;
}

/** 授权状态。 */
export type PermissionState = Readonly<Record<string, boolean>>;

/** 租约。 */
export interface LeaseView {
  readonly leaseId: string;
  readonly requestId?: string;
  readonly scope: ControlScope;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly endedAt?: number;
  readonly status: LeaseStatus;
  readonly paused: boolean;
  readonly reason?: string;
  readonly actionCount: number;
}

/** 逐项确认清单里的一项。 */
export interface PendingItemView {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly confirmed: boolean;
}

/** 待确认的授权申请。 */
export interface PendingView {
  readonly requestId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly scope: ControlScope;
  readonly durationMs: number;
  readonly items: readonly PendingItemView[];
}

/** 宿主回报的状态。 */
export interface ControlState {
  readonly capability: CapabilityView;
  readonly requirements: readonly RequirementView[];
  readonly permissions: PermissionState;
  readonly lease?: LeaseView;
  readonly remainingMs: number;
  readonly activeActions: number;
  readonly pending?: PendingView;
  readonly now: number;
}

/** 系统设置入口。 */
export interface SettingsEntryView {
  readonly id: string;
  readonly label: string;
  readonly path?: string;
  readonly note?: string;
}

/** 逐项确认的结果。 */
export interface ConfirmResult {
  readonly denied?: boolean;
  readonly item?: string;
  readonly settings?: readonly SettingsEntryView[];
  readonly granted?: boolean;
  readonly lease?: LeaseView;
  readonly missing?: readonly string[];
  readonly remaining?: number;
  readonly pending?: PendingView;
  readonly confirmed?: string;
}

/** 一份动作许可。 */
export interface PermitView {
  readonly permitId: string;
  readonly leaseId: string;
  readonly action: string;
  readonly expiresAt: number;
}

/** 审计记录。 */
export interface AuditEntry {
  readonly at: number;
  readonly time: string;
  readonly kind: string;
  readonly outcome: string;
  readonly leaseId?: string;
  readonly requestId?: string;
  readonly action?: string;
  readonly scope?: ControlScope;
  readonly expiresAt?: number;
  readonly expiresAtTime?: string;
  readonly detail?: string;
}

/** 发起授权申请的输入。 */
export interface RequestInput {
  readonly scope: ControlScope;
  readonly durationMs: number;
  readonly purpose: string;
}

/** 宿主通信面。 */
export interface ControlGateway {
  state(): Promise<ControlState>;
  request(input: RequestInput): Promise<PendingView>;
  confirm(input: { readonly requestId: string; readonly itemId: string; readonly confirmed: boolean }): Promise<{ readonly result: ConfirmResult; readonly state: ControlState }>;
  checkPermissions(): Promise<{ readonly permissions: PermissionState; readonly state: ControlState }>;
  action(input: { readonly action: string; readonly point?: { readonly x: number; readonly y: number } }): Promise<PermitView>;
  endAction(input: { readonly permitId: string; readonly outcome: string }): Promise<ControlState>;
  pause(paused: boolean): Promise<ControlState>;
  interrupt(reason: string): Promise<ControlState>;
  audit(limit?: number): Promise<readonly AuditEntry[]>;
}

/** 界面动作的遥测面。 */
export interface ControlTelemetry {
  action(action: string, outcome: ActionOutcome): void;
}

/** 授权期限选项，分钟。 */
export const DURATION_CHOICES = Object.freeze([
  { minutes: 5, label: '5 分钟' },
  { minutes: 15, label: '15 分钟' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 60, label: '60 分钟' },
]);

/** 租约状态文案。 */
export const LEASE_STATUS_LABELS: Readonly<Record<LeaseStatus, string>> = Object.freeze({
  active: '授权有效',
  paused: '已暂停',
  expired: '已到期',
  revoked: '已撤销',
  interrupted: '已中断',
});

/** 审计种类的文案。 */
export const AUDIT_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  capability: '能力声明',
  request: '发起申请',
  grant: '授权',
  deny: '拒绝',
  blocked: '系统授权未通过',
  use: '动作',
  end: '动作结束',
  pause: '暂停',
  resume: '恢复',
  interrupt: '中断',
  revoke: '撤销',
  expire: '到期失效',
});

/** 审计结果的文案。 */
export const AUDIT_OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  available: '可用',
  unavailable: '不可用',
  pending: '等待确认',
  granted: '已授权',
  denied: '已拒绝',
  'permission-missing': '系统授权未通过',
  permitted: '已放行',
  ok: '成功',
  failed: '失败',
  interrupted: '已中断',
  revoked: '已撤销',
  expired: '已失效',
  rejected: '已拒绝',
});

/** 错误码文案。 */
export const ERROR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'platform-unsupported': '当前平台没有声明桌面控制能力',
  'provider-missing': '宿主没有加载控制提供方',
  'lease-missing': '没有生效中的授权',
  'lease-paused': '授权已暂停，不会发起新动作',
  'lease-expired': '授权期限已到，请重新授权',
  'lease-interrupted': '授权已中断',
  'lease-revoked': '授权已撤销',
  'lease-stale': '这份授权已经被替换',
  'request-missing': '这次申请已经结束',
  'request-expired': '确认超时，请重新发起申请',
  'item-unknown': '这是清单里没有的条目',
  'permit-missing': '这次动作没有对应许可',
  'point-outside-scope': '动作坐标不在授权范围之内',
  'purpose-missing': '请先填写用途',
  'purpose-too-long': '用途说明太长',
  'duration-range': '授权期限不在允许范围之内',
  'csrf-missing': '缺少来源校验，请从桌面客户端发起',
  'control-failed': '桌面控制没有完成这次请求',
  'service-unavailable': '桌面控制服务不可用',
});
