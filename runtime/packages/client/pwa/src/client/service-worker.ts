/**
 * Service Worker 源码的生成。
 *
 * 生成的脚本只做三件事：预缓存应用自身的静态资源、按缓存判定规则响应读取请求、按用户动作
 * 切换版本。版本号写进缓存名，激活时删掉同前缀的旧版本缓存；新版本安装后停在等待状态，
 * 由界面在草稿保存并确认之后发消息切换，页面不会被执行中的重载打断。
 *
 * 判定函数与响应检查直接取本包实现并内联进脚本，生成结果与浏览器侧的行为因此来自同一份
 * 代码。
 * @module @chatdsh/client-pwa/service-worker
 */

import { classifyRequest, defaultCacheRules, shouldStoreResponse, type CacheRules } from './cache-policy.ts';
import { CACHE_PREFIX, DEFAULT_SCOPE, OFFLINE_PATH, SERVICE_WORKER_PATH } from './paths.ts';

/** 生成 Service Worker 的输入。 */
export interface ServiceWorkerBuildOptions {
  /** 版本号；写入缓存名，同一个版本复用同一份缓存。 */
  readonly version: string;
  /** 判定规则；缺省取应用壳与图标的预缓存清单。 */
  readonly rules?: CacheRules;
  /** 离线回退页地址。 */
  readonly offlinePath?: string;
  /** 导航请求的离线回退页面，通常是应用壳地址。 */
  readonly navigationFallback?: string;
  /** 缓存名前缀。 */
  readonly cachePrefix?: string;
  /** 脚本地址，写进生成脚本的注释。 */
  readonly scriptPath?: string;
  /** 作用域，写进生成脚本的注释。 */
  readonly scope?: string;
}

/**
 * 生成 Service Worker 脚本。
 * @param options - 版本、规则与回退地址。
 * @returns 可直接作为 `sw.js` 提供的脚本文本。
 */
export function buildServiceWorkerSource(options: ServiceWorkerBuildOptions): string {
  const rules = options.rules ?? defaultCacheRules();
  const version = options.version;
  const offlinePath = options.offlinePath ?? OFFLINE_PATH;
  const navigationFallback = options.navigationFallback ?? '/';
  const cachePrefix = options.cachePrefix ?? CACHE_PREFIX;
  const scriptPath = options.scriptPath ?? SERVICE_WORKER_PATH;
  const scope = options.scope ?? DEFAULT_SCOPE;
  return [
    `/* ChatDSH Service Worker：${scriptPath}，作用域 ${scope}，由 @chatdsh/client-pwa 生成。 */`,
    "'use strict';",
    '',
    `const VERSION = ${JSON.stringify(version)};`,
    `const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};`,
    `const CACHE_NAME = CACHE_PREFIX + '-static-' + VERSION;`,
    `const OFFLINE_PATH = ${JSON.stringify(offlinePath)};`,
    `const NAVIGATION_FALLBACK = ${JSON.stringify(navigationFallback)};`,
    `const RULES = ${JSON.stringify(rules)};`,
    `const PRECACHE = RULES.precache;`,
    `const AUTHORIZATION_HEADER = ${JSON.stringify('authorization')};`,
    '',
    '/* 与浏览器侧共用的判定函数，由本包实现序列化而来。 */',
    `const classifyRequest = ${classifyRequest.toString()};`,
    `const shouldStoreResponse = ${shouldStoreResponse.toString()};`,
    '',
    '/* 预缓存全部静态资源；任一资源失败都让安装失败，缓存因此不会处于残缺状态。 */',
    'async function precacheAll() {',
    '  const cache = await caches.open(CACHE_NAME);',
    '  const failures = [];',
    '  await Promise.all(PRECACHE.map(async (path) => {',
    "    const response = await fetch(path, { cache: 'reload' });",
    '    if (!response.ok) {',
    "      failures.push(path + ' ' + String(response.status));",
    '      return;',
    '    }',
    '    await cache.put(path, response);',
    '  }));',
    '  if (failures.length > 0) throw new Error(\'预缓存失败：\' + failures.join(\'、\'));',
    '}',
    '',
    '/* 删掉同前缀的旧版本缓存，只保留当前版本。 */',
    'async function removeOldCaches() {',
    '  const names = await caches.keys();',
    '  const stale = names.filter((name) => name.startsWith(CACHE_PREFIX + \'-\') && name !== CACHE_NAME);',
    '  await Promise.all(stale.map((name) => caches.delete(name)));',
    '}',
    '',
    '/* 由一次请求得到判定函数需要的字段。 */',
    'function requestFacts(request) {',
    '  return {',
    '    url: request.url,',
    '    method: request.method,',
    '    mode: request.mode,',
    '    origin: self.location.origin,',
    '    authorization: [...request.headers.keys()].includes(AUTHORIZATION_HEADER),',
    '  };',
    '}',
    '',
    '/* 静态资源优先取缓存，未命中时取网络并按响应头部决定是否写缓存。 */',
    'async function cacheFirst(request) {',
    '  const cache = await caches.open(CACHE_NAME);',
    '  const cached = await cache.match(request);',
    '  if (cached !== undefined) return cached;',
    '  const response = await fetch(request);',
    '  const facts = { status: response.status, type: response.type, headers: Array.from(response.headers.entries()) };',
    '  if (shouldStoreResponse(facts)) await cache.put(request, response.clone());',
    '  return response;',
    '}',
    '',
    '/* 导航请求走网络，断网时依次回退到应用壳与离线回退页。 */',
    'async function networkFirstNavigation(request) {',
    '  try {',
    '    return await fetch(request);',
    '  } catch (error) {',
    '    const cache = await caches.open(CACHE_NAME);',
    '    const shell = await cache.match(NAVIGATION_FALLBACK, { ignoreSearch: true });',
    '    if (shell !== undefined) return shell;',
    '    const offline = await cache.match(OFFLINE_PATH);',
    '    if (offline !== undefined) return offline;',
    '    throw error;',
    '  }',
    '}',
    '',
    "self.addEventListener('install', (event) => {",
    '  event.waitUntil(precacheAll());',
    '});',
    '',
    "self.addEventListener('activate', (event) => {",
    '  event.waitUntil((async () => {',
    '    await removeOldCaches();',
    '    await self.clients.claim();',
    '  })());',
    '});',
    '',
    "self.addEventListener('message', (event) => {",
    '  const data = event.data || {};',
    "  if (data.type === 'VERSION') {",
    '    const port = event.ports && event.ports[0];',
    '    if (port) port.postMessage({ version: VERSION, cache: CACHE_NAME, precache: PRECACHE.length, rules: RULES.exclusions.length });',
    '    return;',
    '  }',
    "  if (data.type === 'SKIP_WAITING') void self.skipWaiting();",
    '});',
    '',
    "self.addEventListener('fetch', (event) => {",
    '  const request = event.request;',
    '  const decision = classifyRequest(requestFacts(request), RULES);',
    "  if (decision.strategy === 'navigation') {",
    '    event.respondWith(networkFirstNavigation(request));',
    '    return;',
    '  }',
    "  if (decision.strategy === 'precache' || decision.strategy === 'static') {",
    '    event.respondWith(cacheFirst(request));',
    '  }',
    '});',
    '',
    '/* 推送到达时展示系统通知；点击打开对应设备页面。 */',
    "self.addEventListener('push', (event) => {",
    '  if (event.data === null) return;',
    '  const payload = JSON.parse(event.data.text());',
    "  if (payload.kind !== 'notification') return;",
    '  const items = Array.isArray(payload.items) ? payload.items : [];',
    '  const shown = [];',
    '  for (const item of items) {',
    '    if (typeof item !== "object" || item === null) continue;',
    '    const title = typeof item.title === "string" && item.title !== "" ? item.title : "ChatDSH";',
    '    const options = {',
    '      body: typeof item.summary === "string" ? item.summary : "",',
    '      tag: typeof item.tag === "string" && item.tag !== "" ? item.tag : item.id,',
    '      data: { sessionId: item.sessionId, deviceId: item.deviceId, notificationId: item.id },',
    '    };',
    '    shown.push(self.registration.showNotification(title, options));',
    '  }',
    '  if (shown.length > 0) event.waitUntil(Promise.all(shown));',
    '});',
    '',
    "self.addEventListener('notificationclick', (event) => {",
    '  event.notification.close();',
    '  const data = event.notification.data || {};',
    '  const target = typeof data.deviceId === "string" && data.deviceId !== ""',
    '    ? "/d/" + encodeURIComponent(data.deviceId) + "/"',
    '    : "/";',
    '  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {',
    '    for (const client of list) {',
    '      if (typeof client.navigate === "function" && client.url.startsWith(self.registration.scope)) {',
    '        return client.navigate(target).then(() => client.focus());',
    '      }',
    '    }',
    '    return self.clients.openWindow(target);',
    '  }));',
    '});',
    '',
  ].join('\n');
}
