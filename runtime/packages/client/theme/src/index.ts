/**
 * 主题插件在宿主侧的入口。
 *
 * 这个插件的全部行为在浏览器侧：把界面基础设计的令牌与组件样式挂到文档上。宿主侧
 * 只保留包身份，`dsh.client` 声明与 `./client` 子路径提供浏览器产物。
 * @module @chatdsh/client-theme
 */

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 宿主侧没有服务依赖；显式声明空列表，避免加载器把浏览器依赖当宿主依赖等待。 */
export const inject: string[] = [];

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
