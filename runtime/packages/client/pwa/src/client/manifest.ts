/**
 * 应用清单与可安装性检查。
 *
 * 清单字段按 Web App Manifest 的取值给出：名称、图标、起始地址、显示模式、主题色与作用域。
 * 可安装性检查只做判定，输入是清单对象、清单响应状态、安全来源、Service Worker 状态与当前
 * 显示模式，输出是可以直接显示给用户的问题清单；浏览器是否真的弹出安装提示由浏览器决定。
 * @module @chatdsh/client-pwa/manifest
 */

import { ICONS_PREFIX, MANIFEST_PATH, OFFLINE_PATH, PWA_VERSION, DEFAULT_SCOPE } from './paths.ts';

/** 清单里的一项图标。 */
export interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

/** 清单里的一个快捷入口。 */
export interface ManifestShortcut {
  readonly name: string;
  readonly short_name?: string;
  readonly url: string;
  readonly description?: string;
}

/** 应用清单。 */
export interface WebAppManifest {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly lang: string;
  readonly dir: 'ltr';
  readonly start_url: string;
  readonly scope: string;
  readonly display: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
  readonly display_override?: readonly string[];
  readonly background_color: string;
  readonly theme_color: string;
  readonly orientation: string;
  readonly categories: readonly string[];
  readonly icons: readonly ManifestIcon[];
  readonly shortcuts: readonly ManifestShortcut[];
  readonly prefer_related_applications: boolean;
}

/** 生成清单的输入。 */
export interface ManifestOptions {
  /** 产品名称。 */
  readonly name?: string;
  /** 短名称，显示在主屏。 */
  readonly shortName?: string;
  /** 清单版本，写进描述与图标地址的查询串，便于诊断缓存是否更新。 */
  readonly version?: string;
  /** 起始地址。 */
  readonly startUrl?: string;
  /** 作用域。 */
  readonly scope?: string;
  /** 主题色，取设计令牌的品牌填充色。 */
  readonly themeColor?: string;
  /** 背景色，取设计令牌的画布色。 */
  readonly backgroundColor?: string;
}

/** 图标地址；版本作为查询串，图标内容变化时地址随之变化。 */
function iconUrl(name: string, version: string): string {
  return `${ICONS_PREFIX}${name}?v=${encodeURIComponent(version)}`;
}

/**
 * 构造应用清单。
 * @param options - 名称、地址、颜色与版本覆盖。
 * @returns 应用清单。
 */
export function buildManifest(options: ManifestOptions = {}): WebAppManifest {
  const version = options.version ?? PWA_VERSION;
  const startUrl = options.startUrl ?? '/';
  const scope = options.scope ?? DEFAULT_SCOPE;
  return {
    id: scope,
    name: options.name ?? 'ChatDSH 会话客户端',
    short_name: options.shortName ?? 'ChatDSH',
    description: '从浏览器安装的 ChatDSH 客户端：会话、草稿、通知与离线阅读。',
    lang: 'zh-CN',
    dir: 'ltr',
    start_url: startUrl,
    scope,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: options.backgroundColor ?? '#0e0e10',
    theme_color: options.themeColor ?? '#3d56e8',
    orientation: 'any',
    categories: ['productivity'],
    icons: [
      { src: iconUrl('icon-192.png', version), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconUrl('icon-512.png', version), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: iconUrl('icon-maskable-512.png', version), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: '会话列表', short_name: '会话', url: '/', description: '打开聚合会话列表' },
      { name: '新建会话', short_name: '新建', url: '/sessions/new', description: '在指定设备上新建会话' },
    ],
    prefer_related_applications: false,
  };
}

/** 可安装性问题的严重程度。 */
export type IssueSeverity = 'blocking' | 'warning';

/** 一条可安装性问题。 */
export interface InstallabilityIssue {
  /** 固定问题码。 */
  readonly code: string;
  /** 面向用户的中文说明。 */
  readonly message: string;
  readonly severity: IssueSeverity;
}

/** Service Worker 的当前状态。 */
export interface InstallabilityServiceWorker {
  readonly registered: boolean;
  readonly active: boolean;
  readonly controlling: boolean;
  readonly scope?: string;
}

/** 可安装性检查的输入。 */
export interface InstallabilityInput {
  /** 解析后的清单；取不到时为 `undefined`。 */
  readonly manifest: WebAppManifest | undefined;
  /** 清单响应的状态码；没有发出请求时为 0。 */
  readonly manifestStatus: number;
  /** 清单响应的内容类型。 */
  readonly manifestContentType: string;
  /** 是否安全来源。 */
  readonly secureContext: boolean;
  readonly serviceWorker: InstallabilityServiceWorker;
  /** 当前显示模式，例如 `browser` 或 `standalone`。 */
  readonly displayMode: string;
  /** 起始地址的完整地址；用于核对与作用域的关系。 */
  readonly startUrl?: string;
}

/** 可安装性检查的结论。 */
export interface InstallabilityReport {
  /** 满足全部阻断条件时为真。 */
  readonly installable: boolean;
  /** 已经以独立窗口运行。 */
  readonly installed: boolean;
  readonly issues: readonly InstallabilityIssue[];
}

/** 可以接受的清单内容类型。 */
const MANIFEST_TYPES = ['application/manifest+json', 'application/json'];

/** 可以接受的显示模式。 */
const DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui'];

/**
 * 取图标的像素边长。
 * @param icon - 清单图标。
 * @returns 边长集合；`any` 记为 0。
 */
function iconSizes(icon: ManifestIcon): number[] {
  if (icon.sizes.trim() === 'any') return [0];
  const sizes: number[] = [];
  for (const part of icon.sizes.split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(part);
    if (match === null) continue;
    sizes.push(Number(match[1]));
  }
  return sizes;
}

/**
 * 判断清单是否提供了可用的主屏图标。
 * @param manifest - 清单。
 * @param size - 需要的边长。
 * @returns 有对应尺寸或矢量图标时为真。
 */
function hasIconSize(manifest: WebAppManifest, size: number): boolean {
  return manifest.icons.some((icon) => {
    if (icon.type === 'image/svg+xml') return true;
    return iconSizes(icon).some((value) => value === size || value === 0);
  });
}

/**
 * 检查清单与运行环境是否满足安装条件。
 * @param input - 清单、响应与浏览器状态。
 * @returns 检查结论。
 */
export function checkInstallability(input: InstallabilityInput): InstallabilityReport {
  const issues: InstallabilityIssue[] = [];
  const push = (code: string, message: string, severity: IssueSeverity = 'blocking'): void => {
    issues.push({ code, message, severity });
  };

  if (!input.secureContext) {
    push('insecure-context', '当前来源不是安全来源：安装与 Service Worker 要求在 HTTPS 或本机地址下使用。');
  }
  if (input.manifestStatus !== 200) {
    push('manifest-unreachable', `应用清单不可读取（状态 ${String(input.manifestStatus)}），检查静态资源路由是否已接入。`);
  } else if (!MANIFEST_TYPES.some((type) => input.manifestContentType.toLowerCase().includes(type))) {
    push('manifest-content-type', `应用清单的内容类型是 ${input.manifestContentType}，需要 application/manifest+json。`);
  }
  const manifest = input.manifest;
  const startUrl = input.startUrl ?? manifest?.start_url ?? DEFAULT_SCOPE;
  const startPath = new URL(startUrl, 'http://pwa.invalid').pathname;
  if (manifest === undefined) {
    push('manifest-invalid', '应用清单无法解析成对象，安装入口不可用。');
  } else {
    if (manifest.name === '' && manifest.short_name === '') push('name-missing', '应用清单缺少名称。');
    if (manifest.start_url === '') push('start-url-missing', '应用清单缺少起始地址。');
    if (!DISPLAY_MODES.includes(manifest.display)) {
      push('display-invalid', `显示模式 ${manifest.display} 不支持独立窗口，需要 standalone、fullscreen 或 minimal-ui。`);
    }
    if (manifest.scope !== '' && !startPath.startsWith(manifest.scope)) {
      push('start-url-out-of-scope', `起始地址 ${startUrl} 不在作用域 ${manifest.scope} 内。`);
    }
    if (!hasIconSize(manifest, 192)) push('icon-missing-192', '应用清单缺少 192 像素图标，主屏与任务切换器无法显示。');
    if (!hasIconSize(manifest, 512)) push('icon-missing-512', '应用清单缺少 512 像素图标。');
    if (manifest.icons.every((icon) => !(icon.purpose ?? '').includes('maskable'))) {
      push('icon-missing-maskable', '应用清单缺少 maskable 图标，安卓自适应图标会被裁切。', 'warning');
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(manifest.theme_color)) {
      push('theme-color-invalid', `主题色 ${manifest.theme_color} 不是六位十六进制颜色。`, 'warning');
    }
    if (manifest.prefer_related_applications) {
      push('prefer-related-applications', '清单声明优先使用相关应用，浏览器不会提供安装入口。');
    }
    if (manifest.short_name.length > 12) {
      push('short-name-long', '短名称超过 12 个字符，主屏标签会被截断。', 'warning');
    }
  }
  if (!input.serviceWorker.registered) {
    push('service-worker-missing', 'Service Worker 尚未注册，浏览器不会把它判定为可安装应用。');
  } else if (!input.serviceWorker.active) {
    push('service-worker-not-active', 'Service Worker 尚未激活，离线能力不可用。');
  } else if (!input.serviceWorker.controlling) {
    push('service-worker-not-controlling', 'Service Worker 已激活但尚未接管当前页面，刷新后生效。');
  }
  if (input.serviceWorker.scope !== undefined) {
    const scopePath = new URL(input.serviceWorker.scope, 'http://pwa.invalid').pathname;
    if (!startPath.startsWith(scopePath)) {
      push('service-worker-scope', `Service Worker 作用域 ${input.serviceWorker.scope} 不覆盖起始地址 ${startUrl}。`);
    }
  }
  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  return { installable: blocking.length === 0, installed: input.displayMode === 'standalone', issues };
}

/** 解析清单文本。 */
export function parseManifest(text: string): WebAppManifest {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('应用清单不是对象');
  const manifest = parsed as Partial<WebAppManifest> & Record<string, unknown>;
  return {
    ...(manifest as WebAppManifest),
    icons: Array.isArray(manifest.icons) ? (manifest.icons as ManifestIcon[]) : [],
    shortcuts: Array.isArray(manifest.shortcuts) ? (manifest.shortcuts as ManifestShortcut[]) : [],
  };
}

/** 清单的默认地址与离线回退页地址，供界面显示。 */
export const MANIFEST_URL = MANIFEST_PATH;
export const OFFLINE_URL = OFFLINE_PATH;
