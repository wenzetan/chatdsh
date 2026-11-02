/**
 * PWA 的固定路径与版本常量。
 *
 * 静态资源由运行时宿主按这些路径提供；本包只产出内容与路径约定，路由与构建接入由 WP39
 * 完成。Service Worker 的脚本地址决定它的作用域：脚本放在根路径，作用域因此覆盖整个
 * 客户端。版本号写入缓存名，发布新版本时只替换新缓存，旧版本在激活阶段清理。
 * @module @chatdsh/client-pwa/paths
 */

/** 应用清单地址。 */
export const MANIFEST_PATH = '/manifest.webmanifest';

/** Service Worker 脚本地址。 */
export const SERVICE_WORKER_PATH = '/sw.js';

/** 离线回退页地址。 */
export const OFFLINE_PATH = '/offline.html';

/** Service Worker 的作用域。 */
export const DEFAULT_SCOPE = '/';

/** 静态资源目录前缀。 */
export const ASSETS_PREFIX = '/assets/';

/** 图标目录。 */
export const ICONS_PREFIX = '/assets/icons/';

/** 缓存名前缀；同一前缀的缓存都归本包管理，版本号接在后面。 */
export const CACHE_PREFIX = 'chatdsh-pwa';

/** 当前清单与产物的版本；发布时替换成构建版本号。 */
export const PWA_VERSION = '1';

/** 可达性探测的地址；该地址在缓存规则里被排除，始终走网络。 */
export const DEFAULT_PROBE_PATH = '/healthz';

/** 发送目标地址；由 WP39 的静态资源与客户端路由接入具体实现。 */
export const DEFAULT_SEND_ENDPOINT = '/chatdsh/client/messages';

/** 缓存名的拼法：前缀、类别与版本号。 */
export function cacheNameOf(version: string): string {
  return `${CACHE_PREFIX}-static-${version}`;
}
