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

/** 全部登记过的上游包名。 */
export const UPSTREAM_PACKAGE_NAMES: readonly string[] = [...new Set([
  ...Object.values(UPSTREAM_BUNDLES),
  ...Object.values(UPSTREAM_CLIENT_UI),
])];
