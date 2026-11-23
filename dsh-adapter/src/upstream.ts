/**
 * 上游包名的唯一登记处。
 *
 * 只保留 ChatDSH 实际引用的官方基础包与白名单设置同步命名空间模块名，
 * 不登记上游内部工具行或私有界面实现。
 * @module @chatdsh/adapter/upstream
 */

/** 上游基础组合包。 */
export const UPSTREAM_BUNDLES = {
  /** 单机通用组合。 */
  base: '@deepseek-ai/dsh-base',
  /** 官方 Web 与 Desktop 渲染进程共用的前端组合。 */
  webApp: '@deepseek-ai/dsh-web-app',
} as const;

/** 白名单设置同步引用的上游配置命名空间包名。 */
export const UPSTREAM_CLIENT_UI = {
  /** 语言偏好。 */
  locale: '@deepseek-ai/dsh-client-locale',
  /** 聊天视图偏好。 */
  chat: '@deepseek-ai/dsh-client-ui-chat',
  /** 产品分析开关。 */
  productAnalytics: '@deepseek-ai/dsh-client-product-analytics',
  /** 默认模型选择。 */
  agentDefaultModel: '@deepseek-ai/dsh-agent-default-model',
  /** 预设注册表。 */
  presetRegistry: '@deepseek-ai/dsh-agent-preset-registry',
} as const;

/** 客户端插件 `dsh.client.inject` 引用的官方界面与 Remote 包名。 */
export const UPSTREAM_CLIENT_PLUGINS = {
  /** 官方客户端渲染与 slots 服务。 */
  renderer: '@deepseek-ai/dsh-client-ui-renderer',
  /** 官方三栏布局与面板选择。 */
  layout: '@deepseek-ai/dsh-client-ui-layout',
  /** 官方侧栏与面板入口列表。 */
  sidebar: '@deepseek-ai/dsh-client-ui-sidebar',
  /** 官方设置外壳与区段列表。 */
  settings: '@deepseek-ai/dsh-client-ui-settings',
  /** 官方对话头部席位。 */
  conversation: '@deepseek-ai/dsh-client-ui-conversation',
  /** 官方语言注册表。 */
  locale: '@deepseek-ai/dsh-client-locale',
  /** 官方浏览器侧 Remote 服务。 */
  apiGateway: '@deepseek-ai/dsh-api-gateway',
} as const;

/** 全部登记过的上游包名。 */
export const UPSTREAM_PACKAGE_NAMES: readonly string[] = [...new Set([
  ...Object.values(UPSTREAM_BUNDLES),
  ...Object.values(UPSTREAM_CLIENT_UI),
  ...Object.values(UPSTREAM_CLIENT_PLUGINS),
])];
