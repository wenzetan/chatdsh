/**
 * 桌面壳的遥测信号登记与转调。
 *
 * 全部名称集中在这里，和 `package.json` 的 `chatdsh.telemetry` 声明逐项对应。调用只转给
 * `telemetry.mjs` 的同一条中继管道，桌面壳不新建第二条上报通道。
 * @module chatdsh-desktop-shell/signals
 */

import { noteEvent, noteMetric, startSpan } from './telemetry.mjs';

/** 登记的 span 名称。 */
export const SPANS = Object.freeze({
  startup: 'chatdsh.desktop.startup.',
  runtimeOrchestrate: 'chatdsh.desktop.runtime.orchestrate',
  menuInvoke: 'chatdsh.desktop.menu.invoke',
  trayInvoke: 'chatdsh.desktop.tray.invoke',
  windowRestore: 'chatdsh.desktop.window.restore',
  nativeInvoke: 'chatdsh.desktop.native.invoke',
  ipcInvoke: 'chatdsh.desktop.ipc.invoke',
  updateCheck: 'chatdsh.desktop.update.check',
  updateInstall: 'chatdsh.desktop.update.install',
  powerBlock: 'chatdsh.desktop.power.block',
});

/** 登记的事件名称。 */
export const EVENTS = Object.freeze({
  menuRejected: 'chatdsh.desktop.menu.rejected',
  ipcRejected: 'chatdsh.desktop.ipc.rejected',
  nativeRejected: 'chatdsh.desktop.native.rejected',
  updateRejected: 'chatdsh.desktop.update.rejected',
  powerFailed: 'chatdsh.desktop.power.failed',
  loginFailed: 'chatdsh.desktop.login.failed',
  startupFailed: 'chatdsh.desktop.startup.failed',
  startupSafeMode: 'chatdsh.desktop.startup.safe_mode',
  crashEvidence: 'chatdsh.desktop.crash.evidence',
  notification: 'chatdsh.desktop.notification',
});

/** 登记的指标名称。 */
export const METRICS = Object.freeze({
  startupSeconds: 'chatdsh_desktop_startup_seconds',
  actions: 'chatdsh_desktop_actions_total',
  ipcRejections: 'chatdsh_desktop_ipc_rejections_total',
  updateFailures: 'chatdsh_desktop_update_failures_total',
  safeModeStarts: 'chatdsh_desktop_safe_mode_starts_total',
  crashes: 'chatdsh_desktop_crashes_total',
  powerBlockers: 'chatdsh_desktop_power_blockers',
});

/**
 * 开始一段 span。
 * @param name - span 名称。
 * @returns 结束函数，入参是结果与附加属性。
 */
export function beginSpan(name) {
  return startSpan(name);
}

/**
 * 记录一次拒绝或失败分支。
 * @param name - 事件名称。
 * @param type - `error.type` 取值。
 * @param code - `error.code` 取值。
 * @param extra - 附加属性。
 */
export function noteFailure(name, type, code, extra = {}) {
  noteEvent(name, { 'error.type': type, 'error.code': code, ...extra });
}

/**
 * 记录一次计数。
 * @param name - 指标名称。
 * @param attributes - 属性。
 * @param value - 累加值，缺省为 1。
 */
export function noteCount(name, attributes, value = 1) {
  noteMetric(name, value, attributes, 'sum');
}

/**
 * 记录一个瞬时值。
 * @param name - 指标名称。
 * @param value - 数值。
 * @param attributes - 属性。
 */
export function noteGauge(name, value, attributes) {
  noteMetric(name, value, attributes, 'gauge');
}
