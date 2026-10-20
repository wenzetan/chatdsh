/**
 * 模型提供方的注册信息。
 *
 * 模型这一类的服务实例是上游的 `LlmAdapter`，它的类型来自 DSH，因此本契约包只定义
 * 与上游无关的注册信息：provider 路由、展示名、端点与静态请求头。实现包在自己的
 * 目录里同时提供 `LlmAdapter` 实例，由运行时按 provider 路由注册。
 *
 * 按会话变化的请求头无法由静态配置表达，必须由实现自己从调用头信息生成。
 * @module @chatdsh/core-contracts/model-backend
 */

/** 一个模型提供方路由的注册信息。 */
export interface ModelProviderInfo {
  /** provider 路由标识，例如 `llm-gateway`、`openclaw`。 */
  readonly provider: string;
  /** 配置界面显示的提供方名称。 */
  readonly displayName: string;
  /** 端点地址；服务端按会话或模型分流时缺省。 */
  readonly baseUrl?: string;
  /** 静态请求头。按会话变化的头不写在这里，改由实现生成。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 已知的模型列表，用于界面选择；缺省表示按上游目录发现。 */
  readonly models?: readonly string[];
}
