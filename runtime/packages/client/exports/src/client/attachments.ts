/**
 * 附件清单与缺失确认。
 *
 * 逐项附件按可下载、缺失、需要源设备三种状态显示，每种状态都有稳定文案与下一步动作。
 * 丢失的附件不会静默跳过：保留缺失清单的处理方式下，只要存在非可下载的附件，用户必须先
 * 确认才能继续生成，取消则整次导出不提交。
 * @module @chatdsh/client-exports/attachments
 */

import type { AttachmentPolicy, ExportAttachmentState, ExportAttachmentView } from './types.ts';

/** 附件处理方式的中文名。 */
export const POLICY_LABELS: Readonly<Record<AttachmentPolicy, string>> = {
  'available-only': '只包含可下载的附件',
  'include-missing-list': '包含缺失清单并逐项列出',
  exclude: '不包含附件',
};

/** 附件处理方式的说明。 */
export const POLICY_HINTS: Readonly<Record<AttachmentPolicy, string>> = {
  'available-only': '缺失与需要源设备的附件不进入导出，导出说明里仍然记录被跳过的条数。',
  'include-missing-list': '缺失与需要源设备的附件逐项列出，生成之前需要确认一次。',
  exclude: '附件全部不进入导出，正文里只保留引用标记。',
};

/** 附件状态的文案。 */
export const ATTACHMENT_STATE_LABELS: Readonly<Record<ExportAttachmentState, string>> = {
  downloadable: '可下载',
  missing: '缺失',
  'needs-source-device': '需要源设备',
};

/** 一行附件的展示事实。 */
export interface AttachmentRow {
  readonly id: string;
  readonly filename: string;
  readonly state: ExportAttachmentState;
  readonly stateLabel: string;
  readonly size?: number;
  /** 状态徽标的色调。 */
  readonly tone: 'ok' | 'warn' | 'danger';
  /** 需要用户处理的说明；可下载时缺省。 */
  readonly note?: string;
}

/** 附件计数。 */
export interface AttachmentTally {
  readonly total: number;
  readonly downloadable: number;
  readonly missing: number;
  readonly needsSourceDevice: number;
}

/**
 * 统计附件。
 * @param attachments - 逐项附件。
 * @returns 各类计数。
 */
export function tallyOf(attachments: readonly ExportAttachmentView[]): AttachmentTally {
  let downloadable = 0;
  let missing = 0;
  let needsSourceDevice = 0;
  for (const attachment of attachments) {
    if (attachment.state === 'downloadable') downloadable += 1;
    else if (attachment.state === 'missing') missing += 1;
    else needsSourceDevice += 1;
  }
  return { total: attachments.length, downloadable, missing, needsSourceDevice };
}

/**
 * 生成附件清单行。
 * @param attachments - 逐项附件。
 * @returns 展示行。
 */
export function attachmentRows(attachments: readonly ExportAttachmentView[]): AttachmentRow[] {
  return attachments.map((attachment) => {
    if (attachment.state === 'downloadable') {
      return {
        id: attachment.id,
        filename: attachment.filename,
        state: attachment.state,
        stateLabel: ATTACHMENT_STATE_LABELS.downloadable,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        tone: 'ok',
      };
    }
    if (attachment.state === 'missing') {
      return {
        id: attachment.id,
        filename: attachment.filename,
        state: attachment.state,
        stateLabel: ATTACHMENT_STATE_LABELS.missing,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        tone: 'danger',
        note: '文件已不在数据目录里，导出清单会记录这一项。',
      };
    }
    return {
      id: attachment.id,
      filename: attachment.filename,
      state: attachment.state,
      stateLabel: ATTACHMENT_STATE_LABELS['needs-source-device'],
      ...(attachment.size === undefined ? {} : { size: attachment.size }),
      tone: 'warn',
      note: '附件在会话所属设备上，需要在那台设备可用时再导出。',
    };
  });
}

/**
 * 是否需要用户确认缺失清单。
 * @param policy - 附件处理方式。
 * @param attachments - 逐项附件。
 * @returns 需要确认时为真。
 */
export function needsMissingConfirmation(policy: AttachmentPolicy, attachments: readonly ExportAttachmentView[]): boolean {
  if (policy !== 'include-missing-list') return false;
  return attachments.some((attachment) => attachment.state !== 'downloadable');
}

/** 确认结论。 */
export type MissingDecision =
  | { readonly action: 'generate' }
  | { readonly action: 'confirm'; readonly prompt: string }
  | { readonly action: 'blocked'; readonly reason: string };

/**
 * 决定是否可以直接生成。
 * @param policy - 附件处理方式。
 * @param attachments - 逐项附件。
 * @param confirmed - 用户是否已经确认过缺失清单。
 * @returns 生成、等待确认或拒绝。
 */
export function missingDecision(
  policy: AttachmentPolicy,
  attachments: readonly ExportAttachmentView[],
  confirmed: boolean,
): MissingDecision {
  if (policy === 'exclude') return { action: 'generate' };
  const tally = tallyOf(attachments);
  if (tally.total === 0) return { action: 'generate' };
  if (policy === 'available-only') {
    if (tally.downloadable === 0) {
      return { action: 'blocked', reason: '这个范围里的附件都不可下载，请改用包含缺失清单的方式或取消导出。' };
    }
    return { action: 'generate' };
  }
  if (!needsMissingConfirmation(policy, attachments)) return { action: 'generate' };
  if (!confirmed) {
    return {
      action: 'confirm',
      prompt: `有 ${String(tally.missing + tally.needsSourceDevice)} 项附件不可下载（缺失 ${String(tally.missing)}，需要源设备 ${String(tally.needsSourceDevice)}），确认后会逐项列进导出清单。`,
    };
  }
  return { action: 'generate' };
}
