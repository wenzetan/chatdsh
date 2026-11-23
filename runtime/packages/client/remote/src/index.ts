/**
 * 客户端插件在宿主侧的入口。
 *
 * 浏览器侧的产物由 `./client` 子路径提供。这个入口只承载包身份，让宿主插件加载器
 * 能按 `dsh.client` 声明找到同一个包的浏览器产物。
 * @module @chatdsh/client-remote
 */

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/**
 * 宿主侧插件体。
 *
 * 全部行为都在浏览器侧，宿主侧的空实现只让加载器把这个包放进插件名册。
 */
export function apply(): void {}
