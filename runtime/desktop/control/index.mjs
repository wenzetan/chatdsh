/**
 * 桌面控制的组装入口。
 *
 * 把能力声明、系统授权、作用范围、租约与审计拼成一个对象，桌面主进程在启动时创建它并把
 * 请求转给 IPC 白名单（入口接入由 WP39 完成），控制平面不需要知道内部划分。授权流程按项
 * 确认：用途、作用范围、期限与每一项系统授权都要用户逐项确认，拒绝之后给出系统设置入口。
 * @module chatdsh-desktop-control
 */

import { AuditLog } from './audit.mjs';
import { declareCapabilities, describeCapabilities } from './capability.mjs';
import { LeaseAuthority, LeaseRejection, MAX_DURATION_MS, MIN_DURATION_MS } from './lease.mjs';
import { missingPermissions, permissionItems, permissionStateFrom, settingsEntries } from './permissions.mjs';
import { assertProvider } from './provider.mjs';
import { describeScope, normalizeScope, scopeAllowsPoint } from './scope.mjs';
import { beginControlSpan, countControlAction, noteControlRejection } from './telemetry.mjs';

/** 授权申请的有效时间，超时需要重新发起。 */
const REQUEST_TTL_MS = 5 * 60 * 1000;

/** 用途说明的长度上限。 */
const PURPOSE_MAX = 200;

/** 控制层拒绝一次请求。 */
export class ControlRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 说明。
   */
  constructor(code, detail) {
    super(detail === undefined ? `桌面控制拒绝：${code}` : `桌面控制拒绝：${code}（${detail}）`);
    this.name = 'ControlRejection';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 授权期限的中文说明。
 * @param durationMs - 期限，毫秒。
 * @returns 说明文本。
 */
function describeDuration(durationMs) {
  const minutes = durationMs / 60_000;
  if (Number.isInteger(minutes)) return `${minutes} 分钟`;
  return `${Math.round(durationMs / 1000)} 秒`;
}

/**
 * 创建桌面控制对象。
 * @param options.platform - 平台标识，默认取当前进程。
 * @param options.osVersion - 操作系统版本。
 * @param options.provider - 控制提供方实现。
 * @param options.auditFile - 审计记录文件路径。
 * @param options.now - 当前时刻的实现。
 * @returns 桌面控制对象。
 */
export function createDesktopControl({
  platform = process.platform,
  osVersion,
  provider,
  auditFile,
  now = () => Date.now(),
} = {}) {
  if (provider !== undefined) assertProvider(provider);
  const capabilities = declareCapabilities({ platform, osVersion, provider });
  const requirements = permissionItems(platform, capabilities.requirements);
  const authority = new LeaseAuthority({ now });
  const audit = new AuditLog({ file: auditFile, now });
  let permissions = permissionStateFrom({}, requirements);
  let pending;

  audit.record({
    kind: 'capability',
    outcome: capabilities.available ? 'available' : 'unavailable',
    detail: describeCapabilities(capabilities),
  });

  /** 一次授权的申请内容。 */
  function requestItems(scope, durationMs, purpose) {
    const items = [
      { id: 'purpose', title: '用途', detail: purpose },
      { id: 'scope', title: '作用范围', detail: describeScope(scope) },
      { id: 'duration', title: '授权期限', detail: `授权 ${describeDuration(durationMs)} 后自动失效，期间可以暂停或立即中断。` },
    ];
    for (const requirement of requirements) {
      items.push({
        id: `permission-${requirement.id}`,
        title: requirement.label,
        detail: requirement.note === undefined ? requirement.purpose : `${requirement.purpose} ${requirement.note}`,
      });
    }
    return items;
  }

  /** 把申请整理成对外结构。 */
  function pendingView() {
    if (pending === undefined) return undefined;
    return {
      requestId: pending.requestId,
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      scope: pending.scope,
      durationMs: pending.durationMs,
      items: pending.items.map((item) => ({ ...item, confirmed: pending.confirmed.has(item.id) })),
    };
  }

  /** 当前状态。 */
  function state() {
    const snapshot = authority.snapshot();
    return {
      capability: {
        platform: capabilities.platform,
        platformLabel: capabilities.platformLabel,
        supported: capabilities.supported,
        available: capabilities.available,
        capabilities: capabilities.capabilities,
        minimumVersion: capabilities.minimumVersion,
        provider: capabilities.provider,
        gaps: capabilities.gaps,
        notice: describeCapabilities(capabilities),
      },
      requirements,
      permissions,
      lease: snapshot.lease,
      remainingMs: snapshot.remainingMs ?? 0,
      activeActions: snapshot.activeActions,
      pending: pendingView(),
      now: now(),
    };
  }

  const listeners = new Set();

  /** 广播状态。 */
  function emit() {
    const current = state();
    for (const listener of listeners) listener(current);
  }

  authority.subscribe((snapshot, change) => {
    if (change === 'expired') {
      const finish = beginControlSpan('expire');
      audit.record({
        kind: 'expire',
        outcome: 'expired',
        leaseId: snapshot.lease?.leaseId,
        scope: snapshot.lease?.scope,
        expiresAt: snapshot.lease?.expiresAt,
        detail: '授权期限已到，租约自动失效',
      });
      countControlAction('expire', 'expired');
      finish('ok', { lease: snapshot.lease?.leaseId });
    }
    emit();
  });

  /** 动作许可到 span 结束函数的映射。 */
  const spans = new Map();

  /**
   * 取出提供方报告的授权状态。
   * @param request - 是否先发起系统授权请求。
   */
  async function refresh(request) {
    if (provider === undefined) throw new ControlRejection('provider-missing', '没有加载控制提供方');
    const reported = request === true
      ? await provider.requestPermissions()
      : await provider.checkPermissions();
    permissions = permissionStateFrom(reported ?? {}, requirements);
    return permissions;
  }

  /**
   * 逐项确认全部完成之后的授权步骤。
   * @returns 授权结果。
   */
  async function complete(requestId) {
    const request = pending;
    if (request === undefined || request.requestId !== requestId) {
      throw new ControlRejection('request-missing', '授权申请已经结束');
    }
    const finish = beginControlSpan('authorize');
    try {
      const reported = await refresh(true);
      pending = undefined;
      const missing = missingPermissions(reported);
      if (missing.length > 0) {
        audit.record({
          kind: 'blocked',
          outcome: 'permission-missing',
          requestId,
          scope: request.scope,
          expiresAt: now() + request.durationMs,
          detail: `缺少系统授权：${missing.join('、')}`,
        });
        noteControlRejection('authorize', 'permission-missing', { missing: missing.length });
        countControlAction('authorize', 'blocked');
        finish('failed', { missing: missing.length });
        return { granted: false, missing, settings: settingsEntries(requirements) };
      }
      const snapshot = authority.grant({
        scope: request.scope,
        durationMs: request.durationMs,
        requestId,
      });
      audit.record({
        kind: 'grant',
        outcome: 'granted',
        requestId,
        leaseId: snapshot.lease.leaseId,
        scope: snapshot.lease.scope,
        expiresAt: snapshot.lease.expiresAt,
        detail: `授权期限 ${describeDuration(request.durationMs)}`,
      });
      countControlAction('authorize', 'granted');
      finish('ok', { lease: snapshot.lease.leaseId });
      return { granted: true, lease: snapshot.lease };
    } catch (error) {
      noteControlRejection('authorize', error.code ?? 'grant-failed');
      countControlAction('authorize', 'failed');
      finish('failed');
      throw error;
    }
  }

  return {
    /** 能力声明。 */
    get capabilities() {
      return capabilities;
    },

    /** 当前状态。 */
    state,

    /**
     * 查询系统授权状态。
     * @returns 授权状态。
     */
    async checkPermissions() {
      const finish = beginControlSpan('check-permissions');
      try {
        const reported = await refresh(false);
        finish('ok');
        emit();
        return reported;
      } catch (error) {
        noteControlRejection('check-permissions', error.code ?? 'check-failed');
        countControlAction('check-permissions', 'failed');
        finish('failed');
        throw error;
      }
    },

    /**
     * 发起一次授权申请。返回逐项确认清单，尚未授予任何权限。
     * @param input.scope - 作用范围。
     * @param input.durationMs - 授权期限。
     * @param input.purpose - 用途说明。
     * @returns 申请内容。
     */
    beginRequest({ scope, durationMs, purpose }) {
      const finish = beginControlSpan('request');
      try {
        if (!capabilities.supported) throw new ControlRejection('platform-unsupported', describeCapabilities(capabilities));
        if (!capabilities.available) throw new ControlRejection('provider-missing', describeCapabilities(capabilities));
        if (typeof purpose !== 'string' || purpose.trim() === '') {
          throw new ControlRejection('purpose-missing', '用途说明不能为空');
        }
        if (purpose.length > PURPOSE_MAX) {
          throw new ControlRejection('purpose-too-long', `用途说明最多 ${PURPOSE_MAX} 个字符`);
        }
        const normalized = normalizeScope(scope);
        if (typeof durationMs !== 'number' || !Number.isInteger(durationMs)) {
          throw new ControlRejection('duration-type', '授权期限需要整数毫秒');
        }
        if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
          throw new ControlRejection('duration-range', `授权期限需要在 ${MIN_DURATION_MS} 到 ${MAX_DURATION_MS} 毫秒之间`);
        }
        const createdAt = now();
        const requestId = `grant-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        pending = {
          requestId,
          scope: normalized,
          durationMs,
          purpose,
          items: requestItems(normalized, durationMs, purpose),
          confirmed: new Set(),
          createdAt,
          expiresAt: createdAt + REQUEST_TTL_MS,
        };
        audit.record({
          kind: 'request',
          outcome: 'pending',
          requestId,
          scope: normalized,
          expiresAt: createdAt + durationMs,
          detail: purpose,
        });
        countControlAction('request', 'pending');
        finish('ok', { request: requestId });
        emit();
        return pendingView();
      } catch (error) {
        noteControlRejection('request', error.code ?? 'request-failed');
        countControlAction('request', 'rejected');
        finish('failed');
        throw error;
      }
    },

    /**
     * 逐项确认。任一项被拒绝时申请结束，并给出系统设置入口。
     * @param input.requestId - 申请标识。
     * @param input.itemId - 条目标识。
     * @param input.confirmed - 是否确认。
     * @returns 下一步结果。
     */
    async confirm({ requestId, itemId, confirmed }) {
      const request = pending;
      if (request === undefined || request.requestId !== requestId) {
        noteControlRejection('confirm', 'request-missing');
        countControlAction('confirm', 'rejected');
        throw new ControlRejection('request-missing', '授权申请已经结束');
      }
      if (now() > request.expiresAt) {
        pending = undefined;
        audit.record({ kind: 'deny', outcome: 'expired', requestId, scope: request.scope, detail: '确认超时' });
        noteControlRejection('confirm', 'request-expired');
        countControlAction('confirm', 'expired');
        throw new ControlRejection('request-expired', '确认超时，请重新发起申请');
      }
      const item = request.items.find((candidate) => candidate.id === itemId);
      if (item === undefined) {
        noteControlRejection('confirm', 'item-unknown');
        countControlAction('confirm', 'rejected');
        throw new ControlRejection('item-unknown', `没有这一项：${itemId}`);
      }
      if (confirmed !== true) {
        pending = undefined;
        const finish = beginControlSpan('authorize');
        audit.record({
          kind: 'deny',
          outcome: 'denied',
          requestId,
          scope: request.scope,
          expiresAt: now() + request.durationMs,
          detail: `用户拒绝：${item.title}`,
        });
        noteControlRejection('authorize', 'user-denied', { item: item.id });
        countControlAction('authorize', 'denied');
        finish('failed', { item: item.id });
        emit();
        return { denied: true, item: item.id, settings: settingsEntries(requirements) };
      }
      request.confirmed.add(itemId);
      emit();
      const remaining = request.items.filter((candidate) => !request.confirmed.has(candidate.id));
      if (remaining.length > 0) {
        countControlAction('confirm', 'ok');
        return { confirmed: itemId, remaining: remaining.length, pending: pendingView() };
      }
      return complete(requestId);
    },

    /**
     * 发起一次受控动作。
     * @param input.action - 动作名。
     * @param input.point - 动作坐标，给出时核对是否落在范围之内。
     * @returns 动作许可。
     */
    use({ action, point } = {}) {
      const snapshot = authority.snapshot();
      const lease = snapshot.lease;
      if (lease === undefined) {
        noteControlRejection('use', 'lease-missing');
        countControlAction('use', 'rejected');
        throw new LeaseRejection('lease-missing', '没有生效中的授权');
      }
      try {
        if (point !== undefined && !scopeAllowsPoint(lease.scope, point)) {
          throw new ControlRejection('point-outside-scope', '动作坐标不在授权范围之内');
        }
        const permit = authority.begin(lease.leaseId, action);
        spans.set(permit.permitId, beginControlSpan('use'));
        audit.record({
          kind: 'use',
          outcome: 'permitted',
          leaseId: permit.leaseId,
          action,
          scope: lease.scope,
          expiresAt: lease.expiresAt,
          detail: point === undefined ? undefined : `坐标 (${point.x}, ${point.y})`,
        });
        countControlAction('use', 'permitted');
        return permit;
      } catch (error) {
        noteControlRejection('use', error.code ?? 'use-failed');
        countControlAction('use', 'rejected');
        throw error;
      }
    },

    /**
     * 结束一次受控动作。
     * @param input.permitId - 动作许可标识。
     * @param input.outcome - 动作结果。
     * @returns 动作条目。
     */
    end({ permitId, outcome }) {
      const entry = authority.end(permitId, outcome);
      const finish = spans.get(permitId);
      if (finish !== undefined) {
        spans.delete(permitId);
        finish(outcome === 'ok' ? 'ok' : 'failed');
      }
      if (entry === undefined) {
        noteControlRejection('end', 'permit-missing');
        throw new ControlRejection('permit-missing', '没有这次动作的许可');
      }
      audit.record({
        kind: 'end',
        outcome: outcome ?? 'unknown',
        leaseId: entry.leaseId,
        action: entry.action,
        detail: `耗时 ${entry.endedAt - entry.startedAt} 毫秒`,
      });
      countControlAction('use', outcome === 'ok' ? 'ok' : 'failed');
      emit();
      return { permitId, outcome: outcome ?? 'unknown' };
    },

    /**
     * 暂停或恢复授权。
     * @param paused - 是否暂停。
     * @returns 当前状态。
     */
    setPaused(paused) {
      const finish = beginControlSpan(paused === true ? 'pause' : 'resume');
      try {
        const snapshot = authority.setPaused(paused === true);
        audit.record({
          kind: paused === true ? 'pause' : 'resume',
          outcome: 'ok',
          leaseId: snapshot.lease?.leaseId,
          scope: snapshot.lease?.scope,
          expiresAt: snapshot.lease?.expiresAt,
        });
        countControlAction(paused === true ? 'pause' : 'resume', 'ok');
        finish('ok');
        return state();
      } catch (error) {
        noteControlRejection(paused === true ? 'pause' : 'resume', error.code ?? 'pause-failed');
        countControlAction(paused === true ? 'pause' : 'resume', 'rejected');
        finish('failed');
        throw error;
      }
    },

    /**
     * 立即中断。
     * @param reason - 中断原因。
     * @returns 当前状态。
     */
    interrupt(reason) {
      const finish = beginControlSpan('interrupt');
      try {
        const snapshot = authority.interrupt(reason);
        for (const [permitId, spanFinish] of spans) {
          spans.delete(permitId);
          spanFinish('failed', { action: 'use', aborted: true });
        }
        audit.record({
          kind: 'interrupt',
          outcome: 'interrupted',
          leaseId: snapshot.lease?.leaseId,
          scope: snapshot.lease?.scope,
          expiresAt: snapshot.lease?.expiresAt,
          detail: reason ?? '用户中断',
        });
        countControlAction('interrupt', 'interrupted');
        finish('ok');
        return state();
      } catch (error) {
        noteControlRejection('interrupt', error.code ?? 'interrupt-failed');
        countControlAction('interrupt', 'rejected');
        finish('failed');
        throw error;
      }
    },

    /**
     * 撤销授权。
     * @param reason - 撤销原因。
     * @returns 当前状态。
     */
    revoke(reason) {
      const finish = beginControlSpan('revoke');
      try {
        const snapshot = authority.revoke(reason);
        audit.record({
          kind: 'revoke',
          outcome: 'revoked',
          leaseId: snapshot.lease?.leaseId,
          scope: snapshot.lease?.scope,
          expiresAt: snapshot.lease?.expiresAt,
          detail: reason ?? '权限已撤销',
        });
        countControlAction('revoke', 'revoked');
        finish('ok');
        return state();
      } catch (error) {
        noteControlRejection('revoke', error.code ?? 'revoke-failed');
        countControlAction('revoke', 'rejected');
        finish('failed');
        throw error;
      }
    },

    /**
     * 查询审计记录。
     * @param filter - 查询条件。
     * @returns 记录列表。
     */
    auditEntries(filter = {}) {
      return audit.query(filter);
    },

    /**
     * 订阅状态变化，多个窗口各自订阅。
     * @param listener - 收到状态的函数。
     * @returns 取消订阅函数。
     */
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('订阅者必须是函数');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** 进程退出时释放计时器。 */
    dispose() {
      authority.dispose();
      listeners.clear();
    },
  };
}
