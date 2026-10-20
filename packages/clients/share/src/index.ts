/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板全部在浏览器侧，宿主侧的空实现让这个包出现在宿主名册里；浏览器产物由
 * `dsh.client` 声明与 `./client` 子路径提供。
 * @module @chatdsh/client-share
 */

/** 设置页区段席位名，与浏览器侧共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
