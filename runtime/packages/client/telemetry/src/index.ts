/**
 * 客户端插件在宿主侧的入口。
 *
 * 浏览器侧的产物由 `./client` 子路径提供，这个入口只承载包身份与共享常量，
 * 让模块图的扫描与远端调用解析有稳定的包路径。
 * @module @chatdsh/client-telemetry
 */

/** 中继端点，浏览器侧与服务端共用同一个约定。 */
export const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/**
 * 宿主侧插件体。
 *
 * 这个插件的全部行为都在浏览器侧，宿主侧的空实现是为了让它出现在宿主的名册里：
 * 加载器据 `apply` 判定它是一个插件，浏览器产物则由 `dsh.client` 声明与 `./client` 子路径提供。
 */
export function apply(): void {}
