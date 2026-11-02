/**
 * 系统授权项与系统设置入口。
 *
 * 每一项授权对应一个用途说明与一个系统设置入口。申请之前把用途、作用范围与期限逐项摆出来，
 * 用户拒绝之后给出系统设置入口路径，让他能自己打开对应页面再决定。
 * @module chatdsh-desktop-control/permissions
 */

/** 授权项标识。 */
export const REQUIREMENT_IDS = Object.freeze([
  'accessibility',
  'screen-recording',
  'screen-capture',
  'input-injection',
]);

/** 授权项定义。`settingsPath` 按平台给出真实设置入口。 */
const REQUIREMENTS = Object.freeze({
  accessibility: Object.freeze({
    label: '辅助功能',
    purpose: '读取目标窗口的控件信息，并把点击与键入送到该窗口。',
    settingsPath: Object.freeze({
      darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    }),
    note: undefined,
  }),
  'screen-recording': Object.freeze({
    label: '屏幕录制',
    purpose: '采集屏幕画面，交给模型判断当前界面处于哪一步。',
    settingsPath: Object.freeze({
      darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    }),
    note: undefined,
  }),
  'screen-capture': Object.freeze({
    label: '屏幕采集',
    purpose: '采集屏幕画面，交给模型判断当前界面处于哪一步。',
    settingsPath: Object.freeze({
      win32: 'ms-settings:privacy-screenshots',
    }),
    note: undefined,
  }),
  'input-injection': Object.freeze({
    label: '输入注入',
    purpose: '把点击、键入与滚动送到目标窗口。',
    settingsPath: Object.freeze({}),
    note: 'Windows 没有单独的授权开关。向以管理员身份运行的程序注入会被系统拦截，目标程序需要以普通权限启动。',
  }),
});

/**
 * 取一个授权项在某个平台上的系统设置入口。
 * @param id - 授权项标识。
 * @param platform - 平台标识。
 * @returns 设置入口地址，该平台没有入口时返回 `undefined`。
 */
export function settingsEntryFor(id, platform) {
  const requirement = REQUIREMENTS[id];
  if (requirement === undefined) throw new Error(`未登记的授权项：${id}`);
  return requirement.settingsPath[platform];
}

/**
 * 列出某个平台需要逐项确认的授权项。
 * @param platform - 平台标识。
 * @param requirements - 平台声明的授权项标识列表。
 * @returns 授权项说明列表。
 */
export function permissionItems(platform, requirements) {
  return [...requirements].map((id) => {
    const requirement = REQUIREMENTS[id];
    if (requirement === undefined) throw new Error(`未登记的授权项：${id}`);
    const settingsPath = requirement.settingsPath[platform];
    return Object.freeze({
      id,
      label: requirement.label,
      purpose: requirement.purpose,
      settingsPath,
      note: requirement.note,
    });
  });
}

/**
 * 拒绝之后给出的系统设置入口清单。
 * @param items - `permissionItems` 的返回值。
 * @returns 带入口的条目；没有入口的条目附带说明。
 */
export function settingsEntries(items) {
  return items.map((item) => Object.freeze({
    id: item.id,
    label: item.label,
    path: item.settingsPath,
    note: item.settingsPath === undefined ? item.note : undefined,
  }));
}

/**
 * 把提供方报告的授权状态整理成逐项布尔值。
 * @param reported - 提供方返回值，键是授权项标识。
 * @param items - 需要核对的授权项。
 * @returns 授权状态。
 */
export function permissionStateFrom(reported, items) {
  const state = {};
  for (const item of items) {
    const value = reported[item.id];
    state[item.id] = value === true;
  }
  return state;
}

/**
 * 列出还没有通过的授权项。
 * @param state - `permissionStateFrom` 的返回值。
 * @returns 未通过的授权项标识。
 */
export function missingPermissions(state) {
  return Object.entries(state)
    .filter(([, granted]) => granted !== true)
    .map(([id]) => id);
}
