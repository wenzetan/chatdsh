/**
 * 服务后端的契约信封。
 *
 * 三个已知种类（聊天、记忆、模型）各自的服务接口写在同目录下的文件里。本文件只定义
 * 三者共用的部分：种类标识、错误码、健康结果、描述符与调用上下文。
 *
 * 新增一个种类只增加一个文件并在 `BACKEND_KINDS` 里登记，既有的种类与实现不变。
 * 运行时按字符串 id 选择实现，合法取值由注册表决定，不写进类型。
 * @module @chatdsh/core-contracts/services
 */

/** 后端种类。取值为 `BACKEND_KINDS` 之一。 */
export type BackendKind = string;

/** 已知的后端种类。新增种类在这里登记一项。 */
export const BACKEND_KINDS = ['chat', 'memory', 'model'] as const;

/** 已知种类，供类型标注与登记使用。 */
export type KnownBackendKind = typeof BACKEND_KINDS[number];

/**
 * 后端的错误码。
 *
 * 适配层是纯客户端，不持有 `ctx` 与遥测服务，因此错误以枚举码返回，
 * 由调用方翻译成 `error.type` 与 `error.code` 写入诊断。
 */
export type BackendErrorCode =
  | 'unreachable'
  | 'unauthorized'
  | 'timeout'
  | 'malformed'
  | 'rejected'
  | 'unsupported';

/** 携带错误码的失败。实现可以在错误码之外带一条不含敏感内容的说明。 */
export interface BackendFailure {
  /** 错误码。 */
  readonly code: BackendErrorCode;
  /** 简短说明，不得包含凭据、提示词与请求体原文。 */
  readonly detail?: string;
}

/** 健康检查结果。 */
export interface BackendHealth {
  /** 是否可用。 */
  readonly ok: boolean;
  /** 不可用原因，取值为已登记的错误码。 */
  readonly code?: BackendErrorCode;
  /** 附加说明，不得包含敏感内容。 */
  readonly detail?: string;
}

/**
 * 一次后端调用的上下文。
 *
 * `traceparent` 由调用方从当前 span 取出后传入，适配层据此在出站请求里带上链路标识，
 * 这是跨组件边界的传播方式。适配层不生成链路标识，也不读环境。
 */
export interface BackendCallContext {
  /** W3C 链路头；调用方没有活动 span 时缺省。 */
  readonly traceparent?: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 解析与调用过程中由运行时提供的依赖。 */
export interface BackendDeps {
  /** 出站请求用的 fetch 实现，缺省为全局 fetch。 */
  readonly fetch?: typeof fetch;
}

/**
 * 配置校验器。
 *
 * 契约包不绑定具体的校验库，实现方用自己依赖的库实现 `parse`：校验失败时就地抛出，
 * 这是配置装配阶段，失败即终止启动。
 */
export interface BackendConfigSchema<TConfig> {
  /** 校验并返回补齐默认值后的配置。 */
  parse(value: unknown): TConfig;
}

/**
 * 后端描述符。
 *
 * 一个实现包导出一个描述符；注册表按 `kind` 与 `id` 解析。`capabilities` 声明该实现
 * 支持的能力名，调用方在调用前断言，缺失即按 `unsupported` 失败。
 */
export interface BackendDescriptor<TConfig = unknown, TService = unknown> {
  /** 后端种类。 */
  readonly kind: BackendKind;
  /** 实现在种类内的标识，例如 `hermes`、`hindsight`。 */
  readonly id: string;
  /** 实现版本，写入诊断与状态端点。 */
  readonly version: string;
  /** 支持的能力名。 */
  readonly capabilities: readonly string[];
  /** 配置形状的校验器；注册表在创建前调用。 */
  readonly configSchema: BackendConfigSchema<TConfig>;
  /** 创建服务实例。 */
  create(config: TConfig, deps: BackendDeps): TService;
  /** 探测可用性。 */
  health(deps: BackendDeps): Promise<BackendHealth>;
}
