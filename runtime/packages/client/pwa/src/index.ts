/**
 * 客户端插件在宿主侧的入口。
 *
 * 宿主侧只提供静态内容与路径约定：应用清单、Service Worker 脚本、离线回退页与相关的资源
 * 地址。界面、权限、凭据与草稿都在浏览器侧，由 `./client` 子路径提供。静态资源路由、构建与
 * 发布版本的注入由 WP39 接入，这里生成的内容可以直接作为响应体使用。
 * @module @chatdsh/client-pwa
 */

import { defaultCacheRules } from './client/cache-policy.ts';
import { buildManifest, MANIFEST_URL, type ManifestOptions, type WebAppManifest } from './client/manifest.ts';
import { offlinePage, type OfflinePageOptions } from './client/offline.ts';
import { DEFAULT_SCOPE, MANIFEST_PATH, OFFLINE_PATH, PWA_VERSION, SERVICE_WORKER_PATH, cacheNameOf } from './client/paths.ts';
import { buildServiceWorkerSource, type ServiceWorkerBuildOptions } from './client/service-worker.ts';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 静态资源地址。 */
export const STATIC_PATHS = {
  manifest: MANIFEST_PATH,
  serviceWorker: SERVICE_WORKER_PATH,
  offline: OFFLINE_PATH,
  scope: DEFAULT_SCOPE,
} as const;

/** 宿主侧生成的一组静态内容。 */
export interface PwaStaticContent {
  /** 应用清单地址。 */
  readonly manifestPath: string;
  /** 应用清单对象。 */
  readonly manifest: WebAppManifest;
  /** 应用清单的响应体。 */
  readonly manifestJson: string;
  /** 应用清单的响应内容类型。 */
  readonly manifestContentType: string;
  /** Service Worker 脚本地址。 */
  readonly serviceWorkerPath: string;
  /** Service Worker 脚本内容。 */
  readonly serviceWorkerSource: string;
  /** 当前版本对应的缓存名。 */
  readonly cacheName: string;
  /** 离线回退页地址。 */
  readonly offlinePath: string;
  /** 离线回退页内容。 */
  readonly offlineHtml: string;
}

/** 生成静态内容的选项。 */
export interface PwaStaticContentOptions extends ManifestOptions, OfflinePageOptions {
  /** Service Worker 的版本号；缺省与清单版本一致。 */
  readonly serviceWorkerVersion?: string;
  /** 预缓存清单；缺省取应用壳与图标。 */
  readonly precache?: readonly string[];
  /** 导航请求的离线回退地址。 */
  readonly navigationFallback?: string;
}

/**
 * 生成清单、Service Worker 与离线页。
 * @param options - 名称、版本、图标与回退地址覆盖。
 * @returns 一组静态内容。
 */
export function pwaStaticContent(options: PwaStaticContentOptions = {}): PwaStaticContent {
  const version = options.version ?? PWA_VERSION;
  const manifest = buildManifest({ ...options, version });
  const serviceWorkerOptions: ServiceWorkerBuildOptions = {
    version: options.serviceWorkerVersion ?? version,
    rules: defaultCacheRules(options.precache),
    offlinePath: OFFLINE_PATH,
    ...(options.navigationFallback === undefined ? {} : { navigationFallback: options.navigationFallback }),
  };
  return {
    manifestPath: MANIFEST_URL,
    manifest,
    manifestJson: JSON.stringify(manifest, null, 2),
    manifestContentType: 'application/manifest+json',
    serviceWorkerPath: SERVICE_WORKER_PATH,
    serviceWorkerSource: buildServiceWorkerSource(serviceWorkerOptions),
    cacheName: cacheNameOf(serviceWorkerOptions.version),
    offlinePath: OFFLINE_PATH,
    offlineHtml: offlinePage({ name: manifest.name, ...(options.navigation === undefined ? {} : { navigation: options.navigation }) }),
  };
}

/** 宿主侧插件体：静态内容由 {@link pwaStaticContent} 提供，这里没有需要加载的行为。 */
export function apply(): void {}
