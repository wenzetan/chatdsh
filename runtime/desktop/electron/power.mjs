/**
 * 阻止睡眠策略。
 *
 * 设置里只有开关与模式两项，实际生效与否由系统决定。这里算出要执行的动作，并把实际
 * 状态与失败原因如实描述给界面，不把请求成功当成已生效。
 * @module chatdsh-desktop-shell/power
 */

/** 支持的阻止模式。 */
export const POWER_MODES = Object.freeze(['prevent-display-sleep', 'prevent-app-suspension']);

/**
 * 计算电源阻止动作。
 * @param context - 是否请求阻止、模式、当前是否持有阻止器。
 * @returns 动作与类型；`action` 为 `start`、`stop` 或 `none`。
 */
export function powerPlan(context = {}) {
  const requested = context.enabled === true;
  const active = context.active === true;
  const mode = context.mode === undefined ? 'prevent-display-sleep' : context.mode;
  if (!POWER_MODES.includes(mode)) throw new Error(`未知电源阻止模式：${mode}`);
  if (requested && !active) return { action: 'start', type: mode, reason: 'requested' };
  if (!requested && active) return { action: 'stop', type: mode, reason: 'released' };
  return { action: 'none', type: mode, reason: requested ? 'already-active' : 'not-requested' };
}

/**
 * 描述电源阻止的实际状态。
 * @param context - 是否请求、模式、是否生效、平台与失败原因。
 * @returns 文案与色调。
 */
export function describePowerState(context = {}) {
  const requested = context.enabled === true;
  const active = context.active === true;
  if (active) {
    const mode = context.mode === 'prevent-app-suspension' ? '阻止系统挂起' : '阻止屏幕关闭';
    return { label: '已阻止', detail: `${mode}已由系统接受`, tone: 'ok' };
  }
  if (requested) {
    return {
      label: '未能生效',
      detail: powerFailureHint(context.failureCode ?? 'blocker-unavailable'),
      tone: 'danger',
    };
  }
  return { label: '未启用', detail: '按设置不阻止睡眠与屏幕关闭', tone: 'muted' };
}

/**
 * 电源阻止失败的说明文案。
 * @param code - 失败原因代码。
 * @returns 说明文本。
 */
export function powerFailureHint(code) {
  const hints = {
    'blocker-unavailable': '系统没有接受阻止请求，请检查电源策略或改用另一种模式',
    'blocker-refused': '系统拒绝了阻止请求，可能是权限或策略限制',
    'unsupported-platform': '当前平台不支持阻止睡眠',
  };
  return hints[code] ?? '电源阻止未能生效';
}
