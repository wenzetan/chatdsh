/**
 * 附件上传的界面状态：选择、校验、进度、重试、取消与发送拦截。
 *
 * 校验使用宿主回报的上限与允许类型，超限提示里给出文件大小与真实上限。上传中的附件与
 * 失败的附件都会拦住发送，取消的条目不再拦发送并保留移除入口。上传完成的条目往输入区
 * 插入一条可删除的引用标记，模型上下文里的表示与宿主 `context` 方法一致。
 * @module @chatdsh/client-workspace-tools/attachments
 */

import { WorkspaceClientError, type AttachmentContextEntry, type AttachmentLimits, type AttachmentRecord } from './types.ts';

/** 附件的上传状态。 */
export const UPLOAD_STATES = ['queued', 'uploading', 'uploaded', 'failed', 'cancelled'] as const;

/** 上传状态取值。 */
export type UploadState = (typeof UPLOAD_STATES)[number];

/** 状态说明。 */
export const UPLOAD_STATE_TEXT: Readonly<Record<UploadState, string>> = {
  queued: '等待上传',
  uploading: '正在上传',
  uploaded: '已上传',
  failed: '上传失败',
  cancelled: '已取消',
};

/** 浏览器文件对象里本模块用到的字段。 */
export interface FileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

/** 一个被拒绝的文件。 */
export interface RejectedFile {
  readonly filename: string;
  readonly code: string;
  readonly message: string;
}

/** 一个附件条目。 */
export interface UploadSlot {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly state: UploadState;
  /** 上传进度，取 0 到 1。 */
  readonly progress: number;
  /** 已尝试的上传次数。 */
  readonly attempts: number;
  /** 失败说明。 */
  readonly failure?: { readonly code: string; readonly message: string };
  /** 宿主记录的附件标识。 */
  readonly remoteId?: string;
}

/** 发送检查结论。 */
export interface SendCheck {
  readonly canSend: boolean;
  readonly blockers: readonly string[];
  readonly reason?: string;
}

/** 失败码到说明的映射。 */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  'attachment-too-large': '附件超过宿主允许的大小上限。',
  'attachment-type-rejected': '附件的媒体类型不在允许范围内。',
  'attachment-name-invalid': '附件文件名不符合宿主要求。',
  'attachment-count-exceeded': '附件数量超过单条消息的上限。',
  'attachment-store-unavailable': '制品库没有挂载，附件无法保存。',
  'client/offline': '运行时不可达，附件没有上传成功。',
};

/**
 * 把上传失败折算成带错误码的说明。
 * @param error - 失败对象。
 * @returns 错误码与说明。
 */
export function describeUploadFailure(error: unknown): { readonly code: string; readonly message: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : 'attachment-upload-failed';
  return {
    code,
    message: FAILURE_TEXT[code] ?? (error instanceof Error ? error.message : '附件上传失败，原因未知。'),
  };
}

/**
 * 附件在输入区里的引用标记。
 * @param slot - 已上传的条目。
 * @returns 标记文本。
 */
export function attachmentToken(slot: { readonly remoteId?: string; readonly id: string; readonly filename: string }): string {
  return `[附件 ${slot.remoteId ?? slot.id} ${slot.filename}]`;
}

/**
 * 附件上传控制器。
 */
export class AttachmentUploader {
  private readonly limits: AttachmentLimits;
  private slots: UploadSlot[] = [];
  private readonly inserted = new Set<string>();
  private idCounter = 0;
  private readonly createId: () => string;

  /**
   * @param limits - 宿主回报的上限与允许类型。
   * @param options - 标识生成覆盖。
   */
  constructor(limits: AttachmentLimits, options: { readonly createId?: () => string } = {}) {
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
      throw new WorkspaceClientError('attachment-limits-invalid', '附件上限必须是正整数字节数');
    }
    this.limits = limits;
    this.createId = options.createId ?? (() => `attachment-${String((this.idCounter += 1))}`);
  }

  /** 当前全部条目。 */
  get state(): readonly UploadSlot[] {
    return this.slots;
  }

  /** 宿主上限。 */
  get configuredLimits(): AttachmentLimits {
    return this.limits;
  }

  /**
   * 选择一组文件：逐个校验，合格的进入等待上传状态。
   * @param files - 浏览器给出的文件对象。
   * @returns 接受的条目与被拒绝的文件。
   */
  select(files: readonly FileLike[]): { readonly accepted: readonly UploadSlot[]; readonly rejected: readonly RejectedFile[] } {
    const accepted: UploadSlot[] = [];
    const rejected: RejectedFile[] = [];
    for (const file of files) {
      const reason = this.check(file, accepted.length);
      if (reason !== undefined) {
        rejected.push({ filename: file.name, ...reason });
        continue;
      }
      const normalized = (file.type.split(';')[0] ?? '').trim().toLowerCase();
      const slot: UploadSlot = {
        id: this.createId(),
        filename: file.name,
        mimeType: normalized,
        size: file.size,
        state: 'queued',
        progress: 0,
        attempts: 0,
      };
      accepted.push(slot);
      this.slots = [...this.slots, slot];
    }
    return { accepted, rejected };
  }

  /**
   * 校验一个文件。
   * @param file - 文件对象。
   * @param acceptedInBatch - 本批次已接受的条目数。
   * @returns 拒绝原因；合格时为空。
   */
  private check(file: FileLike, acceptedInBatch: number): { readonly code: string; readonly message: string } | undefined {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      return { code: 'attachment-empty', message: '空文件不能作为附件。' };
    }
    if (file.size > this.limits.maxBytes) {
      return {
        code: 'attachment-too-large',
        message: `${file.name} 为 ${String(file.size)} 字节，超过上限 ${String(this.limits.maxBytes)} 字节。`,
      };
    }
    const normalized = (file.type.split(';')[0] ?? '').trim().toLowerCase();
    if (!this.limits.allowedTypes.includes(normalized)) {
      return {
        code: 'attachment-type-rejected',
        message: `${file.name} 的类型 ${normalized === '' ? '未知' : normalized} 不在允许的附件类型里：${this.limits.allowedTypes.join('、')}。`,
      };
    }
    const total = this.slots.filter((slot) => slot.state !== 'cancelled').length + acceptedInBatch;
    if (total >= this.limits.maxPerMessage) {
      return {
        code: 'attachment-count-exceeded',
        message: `单条消息最多 ${String(this.limits.maxPerMessage)} 个附件，已经没有空位。`,
      };
    }
    return undefined;
  }

  /**
   * 开始上传一个条目。
   * @param id - 条目标识。
   * @returns 更新后的条目。
   */
  begin(id: string): UploadSlot {
    return this.patch(id, (slot) => {
      if (slot.state !== 'queued' && slot.state !== 'failed') {
        throw new WorkspaceClientError('attachment-not-uploadable', `附件 ${slot.filename} 当前状态不能上传`);
      }
      return { ...slot, state: 'uploading', progress: 0, failure: undefined, attempts: slot.attempts + 1 };
    });
  }

  /**
   * 更新上传进度。
   * @param id - 条目标识。
   * @param ratio - 进度，取 0 到 1。
   * @returns 更新后的条目。
   */
  progress(id: string, ratio: number): UploadSlot {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new WorkspaceClientError('attachment-progress-invalid', '上传进度必须落在 0 到 1 之间');
    }
    return this.patch(id, (slot) => ({ ...slot, progress: ratio }));
  }

  /**
   * 上传完成。
   * @param id - 条目标识。
   * @param record - 宿主返回的附件记录。
   * @returns 更新后的条目。
   */
  complete(id: string, record: AttachmentRecord): UploadSlot {
    return this.patch(id, (slot) => ({ ...slot, state: 'uploaded', progress: 1, failure: undefined, remoteId: record.id }));
  }

  /**
   * 上传失败。
   * @param id - 条目标识。
   * @param error - 失败对象。
   * @returns 更新后的条目。
   */
  fail(id: string, error: unknown): UploadSlot {
    const failure = describeUploadFailure(error);
    return this.patch(id, (slot) => ({ ...slot, state: 'failed', failure }));
  }

  /**
   * 重新上传一个失败的条目。
   * @param id - 条目标识。
   * @returns 更新后的条目。
   */
  retry(id: string): UploadSlot {
    return this.patch(id, (slot) => {
      if (slot.state !== 'failed') {
        throw new WorkspaceClientError('attachment-not-retryable', `附件 ${slot.filename} 没有失败，不能重试`);
      }
      return { ...slot, state: 'uploading', progress: 0, failure: undefined, attempts: slot.attempts + 1 };
    });
  }

  /**
   * 取消上传。
   * @param id - 条目标识。
   * @returns 更新后的条目。
   */
  cancel(id: string): UploadSlot {
    return this.patch(id, (slot) => {
      if (slot.state === 'uploaded') {
        throw new WorkspaceClientError('attachment-not-cancellable', `附件 ${slot.filename} 已经上传完成`);
      }
      return { ...slot, state: 'cancelled', progress: 0, failure: undefined };
    });
  }

  /**
   * 移除条目。
   * @param id - 条目标识。
   */
  remove(id: string): void {
    this.slotOf(id);
    this.slots = this.slots.filter((slot) => slot.id !== id);
    this.inserted.delete(id);
  }

  /**
   * 取一个条目。
   * @param id - 条目标识。
   * @returns 条目。
   */
  slotOf(id: string): UploadSlot {
    const slot = this.slots.find((item) => item.id === id);
    if (slot === undefined) throw new WorkspaceClientError('attachment-not-found', `附件条目 ${id} 不存在`);
    return slot;
  }

  /** 等待上传与失败的条目数。 */
  get pendingCount(): number {
    return this.slots.filter((slot) => slot.state === 'queued' || slot.state === 'uploading' || slot.state === 'failed').length;
  }

  /**
   * 发送前的附件检查：未完成或被拦住的附件会阻止发送。
   * @returns 结论与原因。
   */
  sendCheck(): SendCheck {
    const blockers: string[] = [];
    if (this.pendingCount > 0) blockers.push('attachment-pending');
    const first = blockers[0];
    return {
      canSend: blockers.length === 0,
      blockers,
      ...(first === undefined ? {} : { reason: '还有附件没有上传完成，或者上传失败待重试。' }),
    };
  }

  /**
   * 把已上传的附件插入输入区。
   * @param target - 支持 `insert` 的输入区。
   * @param id - 条目标识。
   * @returns 插入的标记文本。
   */
  insertReference(target: { insert(text: string): void }, id: string): string {
    const slot = this.slotOf(id);
    if (slot.state !== 'uploaded' || slot.remoteId === undefined) {
      throw new WorkspaceClientError('attachment-not-uploaded', `附件 ${slot.filename} 还没有上传完成，不能插入引用`);
    }
    const token = attachmentToken(slot);
    target.insert(token);
    this.inserted.add(slot.id);
    return token;
  }

  /** 已经插入输入区的条目数。 */
  get insertedCount(): number {
    return this.inserted.size;
  }

  /** 已上传附件在上下文里的表示。 */
  contextPreview(): AttachmentContextEntry[] {
    return this.slots
      .filter((slot) => slot.state === 'uploaded' && slot.remoteId !== undefined)
      .map((slot) => ({
        attachmentId: slot.remoteId as string,
        marker: attachmentToken(slot),
        filename: slot.filename,
        mimeType: slot.mimeType,
        size: slot.size,
      }));
  }

  /** 按条目标识改写并返回新条目。 */
  private patch(id: string, change: (slot: UploadSlot) => UploadSlot): UploadSlot {
    const index = this.slots.findIndex((slot) => slot.id === id);
    if (index < 0) throw new WorkspaceClientError('attachment-not-found', `附件条目 ${id} 不存在`);
    const next = change(this.slots[index] as UploadSlot);
    this.slots = [...this.slots.slice(0, index), next, ...this.slots.slice(index + 1)];
    return next;
  }
}
