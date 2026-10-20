/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板全部在浏览器侧，宿主侧的空实现让这个包出现在宿主名册里；浏览器产物由
 * `dsh.client` 声明与 `./client` 子路径提供。
 * @module @chatdsh/client-projects
 */

/** 侧栏席位名，与浏览器侧共用同一个约定。 */
export const PANEL_SLOT = 'sidebar.panellist';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/**
 * 宿主侧的服务依赖。
 *
 * 这个插件的全部行为都在浏览器侧，宿主侧不需要任何服务；显式声明空列表，避免加载器
 * 把浏览器侧的模块依赖当成宿主侧的服务依赖来等待。
 */
export const inject: string[] = [];

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
