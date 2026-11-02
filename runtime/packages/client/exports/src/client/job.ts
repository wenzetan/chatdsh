/**
 * 导出任务的状态与界面动作。
 *
 * 状态取值与跨组件契约一致：预估、生成中、正在取消、完成、失败、失效。取消完成的判定是
 * 「正在取消」且带完成时刻；失败带原因码，说明文字按码给出。界面能否取消、下载、重新生成
 * 都由状态与时刻推导，不做重复生成：重新生成必须换一个新的操作标识。
 * @module @chatdsh/client-exports/job
 */

import { describeExpiry } from './format.ts';
import type { ExportJobView, ExportState } from './types.ts';

/** 状态的中文名。 */
export const STATE_LABELS: Readonly<Record<ExportState, string>> = {
  estimated: '已预估',
  generating: '生成中',
  cancelling: '正在取消',
  completed: '已完成',
  failed: '失败',
  expired: '已失效',
};

/** 状态徽标的色调。 */
export type StateTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger';

/** 任务在界面上的结论。 */
export interface JobView {
  readonly label: string;
  readonly tone: StateTone;
  readonly detail: string;
  readonly canCancel: boolean;
  readonly canDownload: boolean;
  readonly canRegenerate: boolean;
  /** 已结束且没有产物。 */
  readonly terminal: boolean;
}

/** 是否处于生成过程中。 */
function running(state: ExportState): boolean {
  return state === 'generating' || state === 'estimated';
}

/**
 * 计算任务在界面上的结论。
 * @param job - 任务视图。
 * @param now - 当前时刻，用于失效判断。
 * @returns 状态文案与可用动作。
 */
export function describeJob(job: ExportJobView, now: number): JobView {
  if (job.state === 'cancelling') {
    const stopped = job.completedAt !== undefined;
    return {
      label: stopped ? '已取消' : '正在取消',
      tone: 'warn',
      detail: stopped
        ? '这次导出已取消，没有可下载的文件；需要时重新生成。'
        : '正在终止生成，半成品文件会被删掉。',
      canCancel: false,
      canDownload: false,
      canRegenerate: stopped,
      terminal: stopped,
    };
  }
  if (job.state === 'generating' || job.state === 'estimated') {
    return {
      label: STATE_LABELS[job.state],
      tone: 'brand',
      detail: '正在按所选范围生成文件，完成之后可以下载。',
      canCancel: true,
      canDownload: false,
      canRegenerate: false,
      terminal: false,
    };
  }
  if (job.state === 'completed') {
    const expired = job.expiresAt !== undefined && job.expiresAt <= now;
    if (expired) {
      return {
        label: STATE_LABELS.expired,
        tone: 'warn',
        detail: '下载地址已失效，重新生成会得到新的文件。',
        canCancel: false,
        canDownload: false,
        canRegenerate: true,
        terminal: true,
      };
    }
    return {
      label: STATE_LABELS.completed,
      tone: 'ok',
      detail: `${describeExpiry(job, now)}生成的文件可以下载。`,
      canCancel: false,
      canDownload: true,
      canRegenerate: true,
      terminal: false,
    };
  }
  if (job.state === 'expired') {
    return {
      label: STATE_LABELS.expired,
      tone: 'warn',
      detail: '下载地址已失效，请重新生成。',
      canCancel: false,
      canDownload: false,
      canRegenerate: true,
      terminal: true,
    };
  }
  return {
    label: STATE_LABELS.failed,
    tone: 'danger',
    detail: '导出没有完成，按失败原因调整后重新生成。',
    canCancel: false,
    canDownload: false,
    canRegenerate: true,
    terminal: true,
  };
}

/**
 * 下一次读取状态前的等待时间。
 * @param state - 任务状态。
 * @returns 毫秒；任务不在进行中时为空。
 */
export function nextPollDelay(state: ExportState): number | undefined {
  if (state === 'generating' || state === 'cancelling' || state === 'estimated') return 400;
  return undefined;
}

/**
 * 是否需要轮询。
 * @param state - 任务状态。
 * @returns 进行中时为真。
 */
export function isRunning(state: ExportState): boolean {
  return running(state) || state === 'cancelling';
}

/**
 * 生成进度的比例估计。
 *
 * 生成过程没有服务端进度上报，界面只用状态与已用时间给出一个上限不超过 0.9 的估计值，
 * 完成时直接跳到 1；预估阶段显示 0。
 * @param job - 任务视图。
 * @param now - 当前时刻。
 * @returns 0 到 1 的比例。
 */
export function progressOf(job: ExportJobView, now: number): number {
  if (job.state === 'completed') return 1;
  if (!isRunning(job.state)) return 0;
  if (job.state === 'estimated') return 0;
  const elapsed = Math.max(0, now - job.createdAt);
  return Math.min(0.9, elapsed / 8000);
}

/**
 * 重新生成需要的操作标识说明。
 * @param job - 旧任务。
 * @returns 给界面的提示。
 */
export function regenerateHint(job: ExportJobView): string {
  if (job.state === 'expired') return '重新生成会得到一个全新的下载地址。';
  if (job.state === 'cancelling') return '重新生成会丢掉这次的范围选择，需要重新确认一次。';
  return '重新生成使用同一个范围，但会换一个新的操作标识';
}
