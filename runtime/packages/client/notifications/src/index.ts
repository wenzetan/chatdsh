/**
 * 客户端插件在宿主侧的入口。
 *
 * 界面、系统通知与实时更新都在浏览器侧，宿主侧没有行为；浏览器产物由 `dsh.client` 声明与
 * `./client` 子路径提供，设置页席位名与浏览器侧共用同一个约定。
 * @module @chatdsh/client-notifications
 */

/** 设置页区段席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
