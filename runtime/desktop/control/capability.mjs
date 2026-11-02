/**
 * 桌面控制的平台能力声明。
 *
 * 能力按平台固定：只有 Windows 与 macOS 声明屏幕采集与输入注入，其他平台返回空能力清单与
 * 不可用原因。界面据此如实说明缺口，因此不会出现"可以申请、永远失败"的入口。
 * @module chatdsh-desktop-control/capability
 */

/** 本模块声明的能力标识。 */
export const CAPABILITY_IDS = Object.freeze(['screen-capture', 'input-injection', 'window-enumeration']);

/** 平台声明表：`requirements` 是操作系统层面的授权项。 */
const PLATFORMS = Object.freeze({
  win32: Object.freeze({
    label: 'Windows',
    capabilities: CAPABILITY_IDS,
    requirements: Object.freeze(['screen-capture', 'input-injection']),
    minimumVersion: undefined,
  }),
  darwin: Object.freeze({
    label: 'macOS',
    capabilities: CAPABILITY_IDS,
    requirements: Object.freeze(['accessibility', 'screen-recording']),
    minimumVersion: 14,
  }),
});

/** 平台名到声明。 */
const SUPPORTED_PLATFORMS = Object.freeze(Object.keys(PLATFORMS));

/**
 * 取一个平台的操作系统版本号的主版本。
 * @param osVersion - 版本文本，例如 `14.5.0`。
 * @returns 主版本号，无法解析时返回 `undefined`。
 */
function majorVersionOf(osVersion) {
  if (typeof osVersion !== 'string') return undefined;
  const match = /^(\d+)/.exec(osVersion.trim());
  return match === null ? undefined : Number.parseInt(match[1], 10);
}

/**
 * 声明当前环境的桌面控制能力。
 *
 * 平台不受支持时 `capabilities` 为空数组，`supported` 为 `false`，缺口清单给出原因；支持
 * 的平台在没有提供方时 `available` 为 `false`，界面据此说明需要哪种提供方。
 * @param options.platform - 平台标识，取 `process.platform` 的取值。
 * @param options.osVersion - 操作系统版本文本。
 * @param options.provider - 控制提供方，需要满足 `provider.mjs` 的接口约定。
 * @returns 能力声明。
 */
export function declareCapabilities({ platform, osVersion, provider } = {}) {
  const gaps = [];
  const declared = PLATFORMS[platform];
  if (declared === undefined) {
    gaps.push({
      code: 'platform-unsupported',
      detail: `桌面控制在 ${platform} 上没有声明能力：屏幕采集与输入注入需要 Windows 或 macOS 宿主。`,
    });
    return {
      platform,
      platformLabel: platform,
      supported: false,
      available: false,
      capabilities: Object.freeze([]),
      requirements: Object.freeze([]),
      minimumVersion: undefined,
      provider: undefined,
      gaps: Object.freeze(gaps),
    };
  }

  const major = majorVersionOf(osVersion);
  if (declared.minimumVersion !== undefined && (major === undefined || major < declared.minimumVersion)) {
    gaps.push({
      code: 'version-unsupported',
      detail: `桌面控制需要 ${declared.label} ${declared.minimumVersion} 及以上，当前系统版本为 ${osVersion ?? '未知'}。`,
    });
  }

  if (provider === undefined) {
    gaps.push({
      code: 'provider-missing',
      detail: '宿主没有加载控制提供方，桌面控制在本次启动里不可用。',
    });
  }

  const supported = declared.minimumVersion === undefined || (major !== undefined && major >= declared.minimumVersion);
  return {
    platform,
    platformLabel: declared.label,
    supported,
    available: supported && provider !== undefined,
    capabilities: supported ? Object.freeze([...declared.capabilities]) : Object.freeze([]),
    requirements: Object.freeze([...declared.requirements]),
    minimumVersion: declared.minimumVersion,
    provider: provider === undefined ? undefined : Object.freeze({ name: provider.name, version: provider.version }),
    gaps: Object.freeze(gaps),
  };
}

/**
 * 判定平台是否可能声明桌面控制能力。
 * @param platform - 平台标识。
 * @returns 是否属于声明平台。
 */
export function isSupportedPlatform(platform) {
  return SUPPORTED_PLATFORMS.includes(platform);
}

/**
 * 能力声明的一句话说明，供界面直接展示。
 * @param capabilities - `declareCapabilities` 的返回值。
 * @returns 说明文本。
 */
export function describeCapabilities(capabilities) {
  if (!capabilities.supported) {
    return `${capabilities.platformLabel} 不提供桌面控制：本平台没有声明屏幕采集与输入注入能力。`;
  }
  if (!capabilities.available) {
    return `${capabilities.platformLabel} 支持桌面控制，本次启动没有加载控制提供方，暂时不可申请授权。`;
  }
  return `${capabilities.platformLabel} 支持桌面控制，提供方 ${capabilities.provider.name} ${capabilities.provider.version ?? ''}`.trim();
}
