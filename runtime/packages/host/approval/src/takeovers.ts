/**
 * 计划接管的编辑租约与草稿。
 *
 * 一次计划审阅在界面上只有一处编辑区域：取得租约的客户端可以编辑草稿并提交，其他客户端的
 * 编辑区按租约持有者禁用并说明原因。租约按工具调用标识建立，草稿与租约分开保存，因此释放、
 * 关闭面板、刷新页面或换一台客户端接手都能继续编辑已经写下的内容。
 * @module @chatdsh/host-approval/takeovers
 */

import type { PlanDraftResult, TakeoverResult } from './contracts.ts';
import type { TakeoverStateView } from './types.ts';

/** 一份草稿。 */
interface Draft {
  text: string;
  revision: number;
  updatedAt: number;
}

/** 一份编辑租约。 */
interface Lease {
  readonly callId: string;
  readonly holderId: string;
  readonly holderLabel: string;
  readonly acquiredAt: number;
}

/** 编辑租约台账。 */
export class TakeoverDesk {
  private readonly leases = new Map<string, Lease>();
  private readonly drafts = new Map<string, Draft>();
  private readonly now: () => number;

  constructor(options: { readonly now: () => number }) {
    this.now = options.now;
  }

  /**
   * 取得一次编辑租约。
   *
   * 同一处只有一位持有者；持有者重复取得是幂等的，其他人取得时得到持有者与原因。草稿取已保存
   * 的那一份，没有保存过时用调用方给的初值。
   * @param callId - 计划卡片对应的工具调用标识。
   * @param holderId - 接管者标识。
   * @param holderLabel - 接管者的展示名。
   * @param seed - 首次取得时草稿的初值。
   * @returns 结果与草稿。
   */
  acquire(callId: string, holderId: string, holderLabel: string, seed: string): TakeoverResult {
    const existing = this.leases.get(callId);
    if (existing !== undefined) {
      if (existing.holderId === holderId) return this.heldResult('granted', existing);
      return {
        outcome: 'held',
        holderId: existing.holderId,
        holderLabel: existing.holderLabel,
        draft: this.draftOf(callId, seed).text,
        draftRevision: this.draftOf(callId, seed).revision,
        reason: `${existing.holderLabel}正在编辑这份计划，本端编辑区暂时禁用`,
      };
    }
    const at = this.now();
    this.leases.set(callId, { callId, holderId, holderLabel, acquiredAt: at });
    if (!this.drafts.has(callId)) this.drafts.set(callId, { text: seed, revision: 0, updatedAt: at });
    return this.heldResult('granted', { callId, holderId, holderLabel, acquiredAt: at });
  }

  /**
   * 释放租约，草稿保留给下一位接管者。
   * @param callId - 计划卡片对应的工具调用标识。
   * @param holderId - 接管者标识。
   * @returns 结果。
   */
  release(callId: string, holderId: string): TakeoverResult {
    const existing = this.leases.get(callId);
    if (existing === undefined) return { outcome: 'released' };
    if (existing.holderId !== holderId) {
      return {
        outcome: 'rejected',
        holderId: existing.holderId,
        holderLabel: existing.holderLabel,
        code: 'revision-conflict',
        reason: '当前编辑区属于另一位接管者',
      };
    }
    this.leases.delete(callId);
    const draft = this.draftOf(callId, '');
    return { outcome: 'released', draft: draft.text, draftRevision: draft.revision };
  }

  /**
   * 保存草稿。
   * @param callId - 计划卡片对应的工具调用标识。
   * @param holderId - 接管者标识。
   * @param text - 草稿文本。
   * @param revision - 客户端已知的草稿版本。
   * @returns 结果。
   */
  save(callId: string, holderId: string, text: string, revision: number): PlanDraftResult {
    const existing = this.leases.get(callId);
    if (existing === undefined) {
      return { outcome: 'rejected', revision: 0, updatedAt: this.now(), code: 'revision-conflict', reason: '没有取得编辑租约' };
    }
    if (existing.holderId !== holderId) {
      const draft = this.draftOf(callId, '');
      return { outcome: 'rejected', revision: draft.revision, updatedAt: draft.updatedAt, code: 'revision-conflict', reason: '编辑区属于另一位接管者' };
    }
    const draft = this.draftOf(callId, '');
    if (revision !== draft.revision) {
      return { outcome: 'conflict', revision: draft.revision, updatedAt: draft.updatedAt, reason: '草稿已在别处更新，请读取最新版本' };
    }
    const at = this.now();
    this.drafts.set(callId, { text, revision: draft.revision + 1, updatedAt: at });
    return { outcome: 'saved', revision: draft.revision + 1, updatedAt: at };
  }

  /**
   * 读一处租约的当前状态。
   * @param callId - 计划卡片对应的工具调用标识。
   * @param seed - 还没有草稿时的初值。
   * @returns 状态。
   */
  state(callId: string, seed: string): TakeoverStateView {
    const lease = this.leases.get(callId);
    const draft = this.draftOf(callId, seed);
    return {
      ...(lease === undefined ? {} : { holderId: lease.holderId, holderLabel: lease.holderLabel }),
      draft: draft.text,
      draftRevision: draft.revision,
      updatedAt: draft.updatedAt,
    };
  }

  /**
   * 读一处卡片的草稿。
   * @param callId - 计划卡片对应的工具调用标识。
   * @returns 草稿与版本；没有草稿时为 `undefined`。
   */
  draftOf(callId: string, seed: string): Draft {
    const existing = this.drafts.get(callId);
    if (existing !== undefined) return existing;
    const created: Draft = { text: seed, revision: 0, updatedAt: this.now() };
    this.drafts.set(callId, created);
    return created;
  }

  /**
   * 卡片结束时清掉租约与草稿。
   * @param callId - 计划卡片对应的工具调用标识。
   */
  drop(callId: string): void {
    this.leases.delete(callId);
    this.drafts.delete(callId);
  }

  /** 结果组装。 */
  private heldResult(outcome: 'granted' | 'held', lease: Lease): TakeoverResult {
    const draft = this.draftOf(lease.callId, '');
    return {
      outcome,
      holderId: lease.holderId,
      holderLabel: lease.holderLabel,
      draft: draft.text,
      draftRevision: draft.revision,
    };
  }
}
