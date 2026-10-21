/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板全部在浏览器侧，宿主侧的空实现让这个包出现在宿主名册里。
 * @module @chatdsh/client-context-insights
 */

/** 侧栏席位名，与浏览器侧共用同一个约定。 */
export const PANEL_SLOT = 'sidebar.panellist';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
