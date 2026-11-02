/**
 * 桌面控制界面的状态换算与文案。
 *
 * 这些函数只读状态，不发请求：多久运行、还剩多久、能否中断、能否发起动作、审计记录怎么读。
 * 多个窗口读到同一份状态时，换算结果因此完全一致。
 * @module @chatdsh/client-desktop-control/lease
 */

import {
  AUDIT_KIND_LABELS,
  AUDIT_OUTCOME_LABELS,
  LEASE_STATUS_LABELS,
  type AuditEntry,
  type ControlScope,
  type ControlState,
  type LeaseStatus,
  type LeaseView,
} from './types.ts';

/**
 * 把毫秒换成一位到两位的秒数。
 * @param ms - 毫秒。
 * @returns 文本。
 */
function seconds(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))} 秒`;
}

/**
 * 把时长换成分钟与秒。
 * @param ms - 毫秒。
 * @returns 文本，例如 `3 分 05 秒`。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  if (minutes === 0) return seconds(ms);
  return `${minutes} 分 ${String(total % 60).padStart(2, '0')} 秒`;
}

/**
 * 一份租约是否仍然有效。
 * @param lease - 租约。
 * @returns 是否有效。
 */
export function isLeaseActive(lease: LeaseView | undefined): boolean {
  return lease !== undefined && (lease.status === 'active' || lease.status === 'paused');
}

/**
 * 剩余期限。
 * @param state - 宿主状态。
 * @returns 毫秒。
 */
export function remainingOf(state: ControlState): number {
  const lease = state.lease;
  if (lease === undefined || !isLeaseActive(lease)) return 0;
  return Math.max(0, lease.expiresAt - state.now);
}

/**
 * 已经运行的时长。
 * @param state - 宿主状态。
 * @returns 毫秒。
 */
export function elapsedOf(state: ControlState): number {
  const lease = state.lease;
  if (lease === undefined) return 0;
  const end = isLeaseActive(lease) ? state.now : (lease.endedAt ?? state.now);
  return Math.max(0, end - lease.grantedAt);
}

/**
 * 作用范围的一句话。
 * @param scope - 作用范围。
 * @returns 文本。
 */
export function scopeLabel(scope: ControlScope): string {
  if (scope.kind === 'region') {
    return `屏幕区域 ${scope.width}×${scope.height}，左上角 (${scope.x}, ${scope.y})，显示器 ${scope.displayId}`;
  }
  return `目标窗口 ${scope.applicationId}，窗口 ${scope.windowId}`;
}

/**
 * 目标应用的可识别名称。
 * @param scope - 作用范围。
 * @returns 文本。
 */
export function targetLabel(scope: ControlScope): string {
  return scope.kind === 'window' ? scope.applicationId : `显示器 ${scope.displayId}`;
}

/**
 * 租约状态文案。
 * @param lease - 租约。
 * @returns 文本。
 */
export function leaseStatusLabel(lease: LeaseView | undefined): string {
  if (lease === undefined) return '未授权';
  return LEASE_STATUS_LABELS[lease.status as LeaseStatus] ?? lease.status;
}

/**
 * 指示条的一句话状态。
 * @param state - 宿主状态。
 * @returns 文本。
 */
export function indicatorSummary(state: ControlState): string {
  const lease = state.lease;
  if (lease === undefined) return '桌面控制未授权';
  if (isLeaseActive(lease)) {
    const paused = lease.status === 'paused' ? '，已暂停' : '';
    return `桌面控制进行中：${targetLabel(lease.scope)}${paused}`;
  }
  return `桌面控制${leaseStatusLabel(lease)}：${lease.reason ?? '租约已结束'}`;
}

/**
 * 能否暂停或恢复。
 * @param state - 宿主状态。
 * @returns 是否可用。
 */
export function canPause(state: ControlState): boolean {
  return isLeaseActive(state.lease);
}

/**
 * 能否立即中断。
 * @param state - 宿主状态。
 * @returns 是否可用。
 */
export function canInterrupt(state: ControlState): boolean {
  return isLeaseActive(state.lease);
}

/**
 * 此刻能否发起动作。只有有效且未暂停的租约放行。
 * @param state - 宿主状态。
 * @returns 是否放行。
 */
export function canAct(state: ControlState): boolean {
  return state.lease !== undefined && state.lease.status === 'active' && remainingOf(state) > 0;
}

/**
 * 能否发起授权申请。
 * @param state - 宿主状态。
 * @returns 是否可用。
 */
export function canRequest(state: ControlState): boolean {
  return state.capability.supported && state.capability.available;
}

/**
 * 一条审计记录的可读内容。
 * @param entry - 记录。
 * @returns 分行文本。
 */
export function describeAuditEntry(entry: AuditEntry): { readonly kind: string; readonly at: string; readonly scope: string; readonly expires: string; readonly outcome: string } {
  return {
    kind: AUDIT_KIND_LABELS[entry.kind] ?? entry.kind,
    at: new Date(entry.at).toLocaleString('zh-CN', { hour12: false }),
    scope: entry.scope === undefined ? '不适用' : scopeLabel(entry.scope),
    expires: entry.expiresAtTime === undefined ? '不适用' : new Date(entry.expiresAtTime).toLocaleString('zh-CN', { hour12: false }),
    outcome: AUDIT_OUTCOME_LABELS[entry.outcome] ?? entry.outcome,
  };
}

/**
 * 系统缺口的逐条说明。
 * @param state - 宿主状态。
 * @returns 说明列表。
 */
export function capabilityGaps(state: ControlState): readonly string[] {
  const gaps = state.capability.gaps.map((gap) => gap.detail);
  return gaps.length === 0 ? [state.capability.notice] : gaps;
}
