/**
 * 桌面控制插件的宿主侧入口。
 *
 * 面板在浏览器侧，由 `dsh.client` 声明的 `./client` 子路径提供；这里给出不依赖文档对象的
 * 纯函数、类型与挂载约定，宿主与测试都从这一层取。
 * @module @chatdsh/client-desktop-control
 */

export { runControlAction } from './client/action.ts';
export type { ControlActionInput } from './client/action.ts';
export { ControlCallError, CONTROL_PREFIX, CSRF_HEADER, createControlGateway } from './client/gateway.ts';
export type { ControlGatewayOptions } from './client/gateway.ts';
export {
  canAct,
  canInterrupt,
  canPause,
  canRequest,
  capabilityGaps,
  describeAuditEntry,
  elapsedOf,
  formatDuration,
  indicatorSummary,
  isLeaseActive,
  leaseStatusLabel,
  remainingOf,
  scopeLabel,
  targetLabel,
} from './client/lease.ts';
export { browserTelemetry, noteAction, TELEMETRY_PATH, UI_ACTION_EVENT } from './client/telemetry.ts';
export {
  AUDIT_KIND_LABELS,
  AUDIT_OUTCOME_LABELS,
  DURATION_CHOICES,
  ERROR_LABELS,
  LEASE_STATUS_LABELS,
} from './client/types.ts';
export type {
  ActionOutcome,
  AuditEntry,
  CapabilityGap,
  CapabilityView,
  ConfirmResult,
  ControlGateway,
  ControlScope,
  ControlState,
  ControlTelemetry,
  LeaseStatus,
  LeaseView,
  PendingItemView,
  PendingView,
  PermitView,
  PermissionState,
  RequirementView,
  RequestInput,
  SettingsEntryView,
} from './client/types.ts';

/** 面板的区域标识，与浏览器侧入口共用同一个约定。 */
export const PANEL_ID = 'chatdsh-desktop-control';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
