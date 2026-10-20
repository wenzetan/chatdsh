/**
 * 宿主平面组合包。
 *
 * 组合包本身不注册服务，它的内容全部由 `cordis.patch.yml` 表达：补丁层按
 * `dsh.profile.bundles` 的顺序展开，把宿主平面插件行插入空配置根。本模块存在是为了让
 * 组合包具备可加载的包身份与类型声明。
 * @module @chatdsh/bundle-hosted
 */

/** 宿主平面组合包的补丁文件相对路径。 */
export const PATCH_FILE = './cordis.patch.yml';

/** 本组合包插入的宿主平面插件行 id。 */
export const HOSTED_PLUGIN_ROWS = [
  'chatdsh-identity',
  'chatdsh-telemetry',
  'chatdsh-session-index',
  'chatdsh-usage',
  'chatdsh-assistants',
  'chatdsh-artifacts',
  'chatdsh-projects',
  'chatdsh-push',
  'chatdsh-approval',
  'chatdsh-connectors',
] as const;
