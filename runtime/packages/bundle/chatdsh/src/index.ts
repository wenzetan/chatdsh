/**
 * ChatDSH 纯附加组合包。
 *
 * 组合包本身不注册服务，所有装配由 `cordis.patch.yml` 以纯 `insert` 方式声明，
 * 供官方 DSH Web 与 Desktop profile 直接安装。
 * @module @chatdsh/bundle
 */

/** 组合包补丁文件相对路径。 */
export const PATCH_FILE = './cordis.patch.yml';

/** 本组合包追加的宿主与客户端插件行标识。 */
export const CHATDSH_PLUGIN_ROWS = [
  'chatdsh-telemetry',
  'chatdsh-device-link',
  'chatdsh-push',
  'chatdsh-import',
  'chatdsh-settings-sync',
  'chatdsh-client-telemetry',
  'chatdsh-client-pwa',
] as const;
