/**
 * 桌面控制面板的浏览器侧入口。
 *
 * 三个部分共用一份数据入口：权限向导负责申请与逐项确认，持续指示条负责授权期间的可识别显示
 * 与立即中断，审计面板负责查看记录。样式由 `mountDesktopControl` 注入文档一次。
 * @module @chatdsh/client-desktop-control/client
 */

import { createElement, type ComponentType } from 'react';
import { AuditPanel } from './audit.tsx';
import { createControlGateway } from './gateway.ts';
import { ControlIndicator } from './indicator.tsx';
import { CONTROL_CSS, CONTROL_STYLE_ID } from './styles.ts';
import { browserTelemetry } from './telemetry.ts';
import { PermissionWizard } from './wizard.tsx';
import type { ControlGateway, ControlTelemetry } from './types.ts';

export { runControlAction } from './action.ts';
export type { ControlActionInput } from './action.ts';
export { AuditPanel } from './audit.tsx';
export type { AuditPanelProps } from './audit.tsx';
export { ControlCallError, CONTROL_PREFIX, CSRF_HEADER, createControlGateway } from './gateway.ts';
export type { ControlGatewayOptions } from './gateway.ts';
export { ControlIndicator } from './indicator.tsx';
export type { ControlIndicatorProps } from './indicator.tsx';
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
} from './lease.ts';
export { CONTROL_CSS, CONTROL_STYLE_ID } from './styles.ts';
export { browserTelemetry, noteAction, TELEMETRY_PATH, UI_ACTION_EVENT } from './telemetry.ts';
export {
  AUDIT_KIND_LABELS,
  AUDIT_OUTCOME_LABELS,
  DURATION_CHOICES,
  ERROR_LABELS,
  LEASE_STATUS_LABELS,
} from './types.ts';
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
} from './types.ts';
export { PermissionWizard } from './wizard.tsx';
export type { PermissionWizardProps } from './wizard.tsx';

/** 面板区域标识。 */
export const SURFACE_ID = 'chatdsh-desktop-control';

/**
 * 往文档里注入面板样式，重复调用只注入一次。
 * @param doc - 目标文档。
 */
export function ensureControlStyles(doc: Document): void {
  if (doc.getElementById(CONTROL_STYLE_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = CONTROL_STYLE_ID;
  style.textContent = CONTROL_CSS;
  doc.head.append(style);
}

/** 整个面板的属性。 */
export interface DesktopControlSurfaceProps {
  /** 数据入口。 */
  readonly gateway: ControlGateway;
  /** 界面动作遥测。 */
  readonly telemetry?: ControlTelemetry;
  /** 指示条刷新间隔，毫秒。 */
  readonly pollIntervalMs?: number;
  /** 审计条数上限。 */
  readonly auditLimit?: number;
}

/**
 * 三个部分组合成的完整面板。
 * @param props - 数据入口与刷新参数。
 * @returns 面板内容。
 */
export function DesktopControlSurface({ gateway, telemetry = browserTelemetry, pollIntervalMs, auditLimit }: DesktopControlSurfaceProps) {
  return createElement('div', { id: SURFACE_ID, style: { display: 'flex', flexDirection: 'column', gap: 'var(--cdh-s4)' } },
    createElement(ControlIndicator, {
      gateway,
      telemetry,
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    }),
    createElement(PermissionWizard, { gateway, telemetry }),
    createElement(AuditPanel, {
      gateway,
      telemetry,
      ...(auditLimit === undefined ? {} : { limit: auditLimit }),
    }));
}

/**
 * 挂载参数：数据入口缺省时按同源路径建立一份。
 */
export interface DesktopControlBinding {
  /** 数据入口。 */
  readonly gateway?: ControlGateway;
  /** 界面动作遥测。 */
  readonly telemetry?: ControlTelemetry;
  /** 指示条刷新间隔，毫秒。 */
  readonly pollIntervalMs?: number;
  /** 审计条数上限。 */
  readonly auditLimit?: number;
}

/**
 * 绑定数据入口之后的面板。
 * @param options - 数据入口、遥测与刷新参数。
 * @returns 可直接挂载的组件。
 */
export function bindDesktopControl(options: DesktopControlBinding): ComponentType {
  const gateway = options.gateway ?? createControlGateway();
  const telemetry = options.telemetry ?? browserTelemetry;
  return function BoundDesktopControl() {
    ensureControlStyles(document);
    return createElement(DesktopControlSurface, {
      gateway,
      telemetry,
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.auditLimit === undefined ? {} : { auditLimit: options.auditLimit }),
    });
  };
}
