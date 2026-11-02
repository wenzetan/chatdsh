/**
 * 静态资源缓存的判定规则。
 *
 * Service Worker 只缓存应用自身的静态资源：预缓存清单里的地址、静态资源目录下的样式与图片。
 * 私有接口、认证地址、快照令牌地址、记忆查询与工具结果都走网络直连，命中时不读取也不写入
 * 缓存。规则是一份纯数据，判定函数只依赖参数，因此同一段代码既在生成 Service Worker 时
 * 内联进脚本，也能被浏览器侧与验收测试直接调用，两处行为一致。
 * @module @chatdsh/client-pwa/cache-policy
 */

import { ASSETS_PREFIX, ICONS_PREFIX, MANIFEST_PATH, OFFLINE_PATH } from './paths.ts';

/** 一条按路径前缀排除的规则。 */
export interface CacheExclusion {
  /** 路径前缀或完整路径。 */
  readonly prefix: string;
  /** 排除原因的固定枚举。 */
  readonly reason: string;
}

/** 缓存判定规则。 */
export interface CacheRules {
  /** 预缓存清单，只列应用自身的静态地址。 */
  readonly precache: readonly string[];
  /** 允许按静态资源缓存的目录前缀。 */
  readonly staticPrefixes: readonly string[];
  /** 允许缓存的静态资源扩展名。 */
  readonly staticExtensions: readonly string[];
  /** 按前缀排除的地址。 */
  readonly exclusions: readonly CacheExclusion[];
  /** 按完整路径排除的地址。 */
  readonly excludedExact: readonly CacheExclusion[];
  /** 出现即排除的查询参数键。 */
  readonly sensitiveQueryKeys: readonly string[];
}

/** 一次请求的可判定事实。 */
export interface RequestFacts {
  /** 完整请求地址。 */
  readonly url: string;
  /** 请求方法。 */
  readonly method: string;
  /** 请求模式：`navigate`、`cors`、`same-origin` 或 `no-cors`。 */
  readonly mode: string;
  /** 页面来源，用于判定同源。 */
  readonly origin: string;
  /** 请求是否带 `Authorization` 头。 */
  readonly authorization: boolean;
}

/** 缓存策略。 */
export type CacheStrategy = 'precache' | 'static' | 'navigation' | 'network';

/** 一次请求的判定结论。 */
export interface CacheDecision {
  readonly strategy: CacheStrategy;
  /** 允许写入缓存时为真。 */
  readonly cacheable: boolean;
  /** 判定原因码。 */
  readonly reason: string;
}

/** 一次响应的可判定事实。 */
export interface ResponseFacts {
  readonly status: number;
  readonly type: string;
  readonly headers: readonly (readonly [string, string])[];
}

/** 预缓存清单：应用壳、离线回退页、清单与图标。 */
export const PRECACHE_ASSETS: readonly string[] = [
  '/',
  OFFLINE_PATH,
  MANIFEST_PATH,
  `${ICONS_PREFIX}icon-192.png`,
  `${ICONS_PREFIX}icon-512.png`,
  `${ICONS_PREFIX}icon-maskable-512.png`,
];

/** 按前缀排除的地址与原因。 */
export const CACHE_EXCLUSIONS: readonly CacheExclusion[] = [
  { prefix: '/chatdsh/', reason: 'control-plane-api' },
  { prefix: '/d/', reason: 'device-runtime' },
  { prefix: '/api/', reason: 'runtime-rpc' },
  { prefix: '/s/', reason: 'share-snapshot' },
];

/** 按完整路径排除的地址与原因。 */
export const CACHE_EXCLUDED_EXACT: readonly CacheExclusion[] = [
  { prefix: '/healthz', reason: 'health-probe' },
];

/** 出现即排除的查询参数键；这些参数用来携带访问凭据或配对信息。 */
export const SENSITIVE_QUERY_KEYS: readonly string[] = [
  'token',
  'access_token',
  'code',
  'pairing',
  'authorization',
  'secret',
  'password',
  'api_key',
];

/** 排除原因的中文说明，供界面列出规则。 */
export const CACHE_REASON_TEXT: Readonly<Record<string, string>> = {
  'control-plane-api': '控制平面私有接口（会话、通知、设备、遥测中继）',
  'device-runtime': '经设备前缀转发的运行时内容',
  'runtime-rpc': '运行时 Remote 调用，含工具结果与记忆查询',
  'share-snapshot': '分享快照，地址自带访问令牌',
  'health-probe': '运行时探活端点',
  'sensitive-query': '地址带访问令牌或配对参数',
  authorization: '请求携带 Authorization 头',
  'method-not-get': '非读取请求',
  'cross-origin': '跨源地址',
  'not-allowlisted': '不在静态资源清单内',
};

/**
 * 判定一次请求应当走哪条缓存策略。
 *
 * 顺序固定：先排除非读取、跨源、带认证头与敏感查询参数的请求，再按前缀与完整路径排除私有
 * 地址，导航请求交给网络优先处理，最后才看预缓存清单与静态资源目录。未列入的地址一律走
 * 网络且不写缓存。
 * @param facts - 请求事实。
 * @param rules - 判定规则。
 * @returns 判定结论。
 */
export function classifyRequest(facts: RequestFacts, rules: CacheRules): CacheDecision {
  if (facts.method !== 'GET') return { strategy: 'network', cacheable: false, reason: 'method-not-get' };
  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return { strategy: 'network', cacheable: false, reason: 'invalid-url' };
  }
  if (url.origin !== facts.origin) return { strategy: 'network', cacheable: false, reason: 'cross-origin' };
  if (facts.authorization) return { strategy: 'network', cacheable: false, reason: 'authorization' };
  for (const exclusion of rules.exclusions) {
    if (url.pathname.startsWith(exclusion.prefix)) {
      return { strategy: 'network', cacheable: false, reason: exclusion.reason };
    }
  }
  for (const exclusion of rules.excludedExact) {
    if (url.pathname === exclusion.prefix) {
      return { strategy: 'network', cacheable: false, reason: exclusion.reason };
    }
  }
  for (const key of rules.sensitiveQueryKeys) {
    if (url.searchParams.has(key)) return { strategy: 'network', cacheable: false, reason: 'sensitive-query' };
  }
  if (facts.mode === 'navigate') return { strategy: 'navigation', cacheable: false, reason: 'navigation' };
  for (const path of rules.precache) {
    if (url.pathname === path) return { strategy: 'precache', cacheable: true, reason: 'precache' };
  }
  const inStaticDirectory = rules.staticPrefixes.some((prefix) => url.pathname.startsWith(prefix));
  if (inStaticDirectory) {
    const lower = url.pathname.toLowerCase();
    if (rules.staticExtensions.some((extension) => lower.endsWith(extension))) {
      return { strategy: 'static', cacheable: true, reason: 'static-asset' };
    }
  }
  return { strategy: 'network', cacheable: false, reason: 'not-allowlisted' };
}

/**
 * 判定一次响应能否写入缓存。
 *
 * 只有状态 200、同源常规响应且没有禁止缓存的头部时才写入。带 `set-cookie` 的响应可能携带
 * 会话，`no-store` 与 `private` 明确禁止中间层保存，`opaque` 响应无法检查内容，一律不写。
 * @param response - 响应事实。
 * @returns 允许写入时为真。
 */
export function shouldStoreResponse(response: ResponseFacts): boolean {
  if (response.status !== 200) return false;
  if (response.type !== 'basic') return false;
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) headers[name.toLowerCase()] = value;
  const cacheControl = headers['cache-control'] ?? '';
  if (cacheControl.includes('no-store')) return false;
  if (cacheControl.includes('private')) return false;
  if (headers['set-cookie'] !== undefined) return false;
  if (headers['vary'] === '*') return false;
  return true;
}

/**
 * 按当前版本与预缓存清单构造判定规则。
 * @param precache - 预缓存清单，缺省取应用壳与图标。
 * @returns 判定规则。
 */
export function defaultCacheRules(precache: readonly string[] = PRECACHE_ASSETS): CacheRules {
  return {
    precache,
    staticPrefixes: [ASSETS_PREFIX],
    staticExtensions: ['.css', '.js', '.mjs', '.png', '.svg', '.woff2', '.woff', '.ico', '.webmanifest'],
    exclusions: CACHE_EXCLUSIONS,
    excludedExact: CACHE_EXCLUDED_EXACT,
    sensitiveQueryKeys: SENSITIVE_QUERY_KEYS,
  };
}

/**
 * 判断一个地址是否会被缓存，供界面说明与诊断使用。
 * @param url - 完整地址。
 * @param origin - 当前页面来源。
 * @param rules - 判定规则。
 * @returns 判定结论。
 */
export function cacheDecisionFor(url: string, origin: string, rules: CacheRules): CacheDecision {
  return classifyRequest({ url, method: 'GET', mode: 'no-cors', origin, authorization: false }, rules);
}
