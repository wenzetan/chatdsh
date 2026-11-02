/**
 * 项目面板的数据形状与依赖接口。
 *
 * 记录形状与宿主服务 `chatdshProjects` 的返回值一致；目录列举与助手名册分别来自
 * `directoryPicker` 与 `agentPresets` 两个 Remote 命名空间，模型可选值来自
 * `chatdshModelProviders`。面板只依赖这些接口，不直接接触网络与模块加载器。
 * @module @chatdsh/client-projects/types
 */

/** 一条项目记录，`displayTitle` 由宿主在写入时算好。 */
export interface ProjectRecord {
  /** 规范化后的绝对路径，同时是记录的身份。 */
  readonly path: string;
  /** 调用方写入的名称；空串表示按目录末段显示。 */
  readonly title: string;
  /** 列表与说明段落使用的展示名。 */
  readonly displayTitle: string;
  /** 项目说明原文。 */
  readonly instructions: string;
  /** 默认模型引用，写法为 `provider/model`。 */
  readonly defaultModel?: string;
  /** 默认助手标识，取值是已注册的预设标识。 */
  readonly defaultAssistant?: string;
  /** 记录版本，写入时用于比较交换。 */
  readonly revision: number;
  /** 最后写入时刻的毫秒时间戳。 */
  readonly updatedAt: number;
}

/** 一次写入的输入；省略的字段表示保持原值。 */
export interface ProjectInput {
  readonly path: string;
  readonly title?: string;
  readonly instructions?: string;
  readonly defaultModel?: string;
  readonly defaultAssistant?: string;
  readonly revision?: number;
}

/** 目录列举里的一行。 */
export interface DirectoryRow {
  readonly name: string;
  readonly path: string;
  readonly hidden: boolean;
}

/** 一次目录列举的结果，形状与服务 `directoryPicker/list` 一致。 */
export interface DirectoryListing {
  readonly path: string;
  readonly home: string;
  readonly crumbs: readonly DirectoryRow[];
  readonly entries: readonly DirectoryRow[];
  readonly truncated: boolean;
}

/** 助手名册里的一行。 */
export interface AssistantOption {
  /** 预设标识，同时是写入 `defaultAssistant` 的取值。 */
  readonly id: string;
  /** 展示名；缺省时界面回退到标识。 */
  readonly name?: string;
  /** 装配失败的原因；有值时该预设不能选。 */
  readonly broken?: string;
}

/** 模型提供方与它声明的模型。 */
export interface ModelProviderRow {
  readonly provider: string;
  readonly displayName: string;
  readonly models?: readonly string[];
}

/** Remote 失败的信封形状。 */
export interface RemoteFailure {
  readonly code: string;
  readonly message: string;
}

/** Remote 调用的结果信封；业务失败走 `ok: false` 分支。 */
export type RemoteEnvelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RemoteFailure };

/**
 * 一次 Remote 调用的传输层。
 *
 * `endpoint` 采用 `<服务名>/<方法名>` 的写法，与 typert descriptor 的端点名一致；
 * `args` 是按位置排列的参数。成功与业务失败都以信封返回，连接失败以拒绝表示，由数据入口
 * 统一折算成离线失败。生产实现经模块加载器提供的 `ctx.remote` 命名空间发出调用，测试实现
 * 把它换成真实的 HTTP 通道。
 */
export interface ProjectsTransport {
  /**
   * 发出一次调用。
   * @param endpoint - `<服务名>/<方法名>`。
   * @param args - 按位置排列的参数。
   * @returns 结果信封；连接失败以拒绝表示。
   */
  call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope>;
}

/** 界面动作名，写入 `chatdsh.client.ui.action` 事件的 `action` 属性。 */
export type ProjectUiAction = 'project.create' | 'project.update' | 'project.delete' | 'project.browse';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed' | 'rejected';

/** 浏览器侧遥测面：只用到 span、事件与计数器。 */
export interface PanelTelemetry {
  /**
   * 跑一次带 span 的调用，失败时补失败事件与计数。
   * @param method - `rpc.method` 属性取值。
   * @param work - 实际调用。
   * @returns 调用结果。
   */
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  /**
   * 记一次界面动作。
   * @param action - 动作名。
   * @param outcome - 结果。
   */
  action(action: ProjectUiAction, outcome: ActionOutcome): void;
  /**
   * 记一次失败事件。
   * @param error - 失败对象。
   */
  failure(error: unknown): void;
}

/** 面板使用的数据入口。 */
export interface ProjectsGateway {
  /** 列出全部项目记录。 */
  list(): Promise<ProjectRecord[]>;
  /** 读取一个项目的记录。 */
  get(path: string): Promise<ProjectRecord | undefined>;
  /** 新建一个项目。 */
  create(input: ProjectInput): Promise<ProjectRecord>;
  /** 更新一个项目。 */
  set(input: ProjectInput): Promise<ProjectRecord>;
  /** 删除一个项目的记录。 */
  remove(path: string): Promise<boolean>;
  /** 列举一个目录；省略路径时由宿主给出家目录。 */
  listDirectory(path?: string): Promise<DirectoryListing>;
  /** 读取可选的默认助手。 */
  listAssistants(): Promise<readonly AssistantOption[]>;
  /** 读取可选的默认模型引用。 */
  listModels(): Promise<readonly string[]>;
  /** 记一次界面动作。 */
  noteAction(action: ProjectUiAction, outcome: ActionOutcome): void;
}
