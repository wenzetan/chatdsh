/**
 * 动效偏好的应用：把偏好写到文档根元素上，并提供停用动效的样式。
 *
 * 偏好取值来自设置服务的 `chatdsh-settings-enhancements.motion` 字段；`system` 交给媒体查询，
 * `reduced` 停止过渡与动画，`full` 保持完整动效。样式只由本插件注入一次。
 * @module @chatdsh/host-settings-enhancements/appearance
 */

/** 文档根元素上的动效属性。 */
export const MOTION_ATTRIBUTE = 'data-chdsh-motion';

/** 样式元素标识。 */
export const MOTION_STYLE_ID = 'chdsh-motion-preference';

/** 减少动效时的样式。 */
export const MOTION_CSS = `html[${MOTION_ATTRIBUTE}="reduced"] *,html[${MOTION_ATTRIBUTE}="reduced"] *::before,html[${MOTION_ATTRIBUTE}="reduced"] *::after{animation-duration:0.001ms !important;animation-iteration-count:1 !important;transition-duration:0.001ms !important;}`;

/**
 * 应用一次动效偏好。
 * @param value - 偏好取值。
 */
export function applyMotionPreference(value: string): void {
  if (typeof document === 'undefined') return;
  if (value === 'system' || value === '' || value === undefined) {
    document.documentElement.removeAttribute(MOTION_ATTRIBUTE);
    return;
  }
  document.documentElement.setAttribute(MOTION_ATTRIBUTE, value);
}

/** 注入减少动效的样式；重复调用只保留一份。 */
export function installMotionStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MOTION_STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = MOTION_STYLE_ID;
  style.textContent = MOTION_CSS;
  document.head.append(style);
}
