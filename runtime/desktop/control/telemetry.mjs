/**
 * 桌面控制的遥测。
 *
 * 信号名沿用遥测清单桌面壳一节登记的名称：租约动作走 `chatdsh.desktop.computeruse.lease`
 * 这一个 span，动作名放在 `action` 属性里；拒绝与失败分支写 `chatdsh.desktop.native.rejected`
 * 事件并带上 `error.type` 与 `error.code`；可聚合的计数是 `chatdsh_desktop_actions_total`。
 * 上报只走桌面壳已有的中继管道，本模块不新建第二条通道。
 * @module chatdsh-desktop-control/telemetry
 */

import { EVENTS, METRICS, beginSpan, noteCount, noteFailure } from '../electron/signals.mjs';

/** 租约动作的 span 名称。 */
export const CONTROL_SPAN = 'chatdsh.desktop.computeruse.lease';

/** 拒绝与失败事件的名称。 */
export const CONTROL_REJECTION_EVENT = EVENTS.nativeRejected;

/** 动作计数的指标名称。 */
export const CONTROL_ACTION_METRIC = METRICS.actions;

/**
 * 开始一段租约 span。
 * @param action - 动作名，例如 `grant`、`use`、`interrupt`。
 * @returns 结束函数，入参是结果与附加属性。
 */
export function beginControlSpan(action) {
  const finish = beginSpan(CONTROL_SPAN);
  return (outcome, extra = {}) => finish(outcome, { action, ...extra });
}

/**
 * 记录一次拒绝或失败。
 * @param action - 动作名。
 * @param code - 失败代码。
 * @param extra - 附加属性。
 */
export function noteControlRejection(action, code, extra = {}) {
  noteFailure(CONTROL_REJECTION_EVENT, 'desktop-control', code, { action, outcome: 'failed', ...extra });
}

/**
 * 记录一次动作结果。
 * @param action - 动作名。
 * @param outcome - 结果。
 */
export function countControlAction(action, outcome) {
  noteCount(CONTROL_ACTION_METRIC, { action, outcome });
}
