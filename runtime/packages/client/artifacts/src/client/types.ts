/**
 * 制品面板的数据形状与依赖接口。
 *
 * 记录形状与宿主服务 `chatdshArtifacts` 的返回值一致；读取结果另外带内容类型与受限预览
 * 标记，面板据此选择查看器。面板只依赖这些接口，不接触网络、对象存储与模块加载器。
 * @module @chatdsh/client-artifacts/types
 */

/** 一条制品记录，`version` 指向当前版本。 */
export interface ArtifactRecord {
  /** 制品标识。 */
  readonly id: string;
  /** 归属会话。 */
  readonly sessionId: string;
  /** 归属工作区；聊天会话产出的制品没有这一项。 */
  readonly workspaceId?: string;
  /** 展示名。 */
  readonly title: string;
  /** 制品种类。 */
  readonly kind: string;
  /** 当前版本的媒体类型。 */
  readonly mimeType: string;
  /** 当前版本的字节数。 */
  readonly size: number;
  /** 当前版本号，从 1 开始。 */
  readonly version: number;
  /** 建立时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 最后写入时刻的毫秒时间戳。 */
  readonly updatedAt: number;
  /** 产生该制品的会话事件序号。 */
  readonly sourceEventSeq?: number;
}

/** 一个版本对外的形状。 */
export interface ArtifactVersionView {
  readonly artifactId: string;
  readonly version: number;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: number;
  /** 历史版本不可改写。 */
  readonly immutable: true;
  /** 产生该版本的会话。 */
  readonly sourceSessionId: string;
  /** 产生该版本的回合编号。 */
  readonly sourceTurn?: number;
  /** 内容是否可下载。 */
  readonly downloadable: boolean;
}

/** 版本列表：当前版本出现在列表里。 */
export interface ArtifactVersionList {
  readonly artifactId: string;
  readonly currentVersion: number;
  readonly versions: ArtifactVersionView[];
}

/** 删除范围：删除全部版本时列出涉及版本与占用空间。 */
export interface ArtifactDeleteScope {
  readonly artifactId: string;
  readonly allVersions: boolean;
  readonly versions: number[];
  readonly affectedVersions: number[];
  readonly totalBytes: number;
  readonly requiresConfirm: true;
}

/** 预览方式。 */
export type ArtifactPreviewMode = 'text' | 'html-sandbox' | 'image' | 'pdf' | 'download-only';

/** 受限预览标记；三个开关在宿主侧恒为假。 */
export interface ArtifactPreviewView {
  readonly mode: ArtifactPreviewMode;
  readonly scriptAllowed: false;
  readonly hostBridgeAllowed: false;
  readonly formSubmitAllowed: false;
}

/** 一次读取的结果。 */
export interface ArtifactReadResult {
  readonly record: ArtifactRecord;
  readonly version: ArtifactVersionView;
  /** 内容字节，base64。 */
  readonly base64: string;
  /** 宿主报告的内容类型。 */
  readonly contentType: string;
  /** 受限预览标记。 */
  readonly preview: ArtifactPreviewView;
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
 * `endpoint` 采用 `<服务名>/<方法名>` 的写法；`args` 是按位置排列的参数。成功与业务失败
 * 都以信封返回，连接失败以拒绝表示，由数据入口统一折算成离线失败。
 */
export interface ArtifactsTransport {
  /**
   * 发出一次调用。
   * @param endpoint - `<服务名>/<方法名>`。
   * @param args - 按位置排列的参数。
   * @returns 结果信封；连接失败以拒绝表示。
   */
  call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope>;
}

/** 界面动作名，写入 `chatdsh.client.ui.action` 事件的 `action` 属性。 */
export type ArtifactUiAction =
  | 'artifact.filter'
  | 'artifact.versions'
  | 'artifact.preview'
  | 'artifact.download'
  | 'artifact.open-external'
  | 'artifact.delete';

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
  action(action: ArtifactUiAction, outcome: ActionOutcome): void;
  /**
   * 记一次失败事件。
   * @param error - 失败对象。
   */
  failure(error: unknown): void;
}

/** 面板使用的数据入口。 */
export interface ArtifactsGateway {
  /** 列出制品；省略会话标识时列出全部。 */
  list(sessionId?: string): Promise<ArtifactRecord[]>;
  /** 读取某个制品的版本列表。 */
  versionList(id: string): Promise<ArtifactVersionList>;
  /** 读取某个版本的内容；省略版本号时取当前版本。 */
  read(id: string, version?: number): Promise<ArtifactReadResult>;
  /** 计算删除范围，用于删除全部版本的确认。 */
  deleteScope(id: string): Promise<ArtifactDeleteScope>;
  /** 删除一个制品及其全部版本。 */
  remove(id: string): Promise<boolean>;
  /** 记一次界面动作。 */
  noteAction(action: ArtifactUiAction, outcome: ActionOutcome): void;
}
