/**
 * 工作区工具的共享类型：文件、终端、附件、录音四类能力的数据形状与失败形状。
 *
 * 这些类型只描述浏览器侧的界面所需字段。宿主返回的记录按业务字段透传，视图不自己推断
 * 上限、状态或错误码。
 * @module @chatdsh/client-workspace-tools/types
 */

/** Remote 调用返回的信封。 */
export interface RemoteEnvelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** 传输层：把 `<服务名>/<方法名>` 与位置参数送到 Remote 命名空间。 */
export interface RemoteTransport {
  call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope>;
}

/** 一个 Remote 命名空间的最小形状。 */
export interface RemoteNamespace {
  readonly [method: string]: ((...args: never[]) => Promise<RemoteEnvelope>) | undefined;
}

/** 界面动作名，写入 `chatdsh.client.ui.action` 的 `action`。 */
export type WorkspaceUiAction =
  | 'tree-refresh'
  | 'tree-expand'
  | 'file-open'
  | 'attachment-select'
  | 'attachment-retry'
  | 'attachment-cancel'
  | 'attachment-insert'
  | 'recording-start'
  | 'recording-stop'
  | 'recording-cancel'
  | 'transcription-confirm';

/** 动作结果。 */
export type WorkspaceOutcome = 'ok' | 'failed';

/** 浏览器侧遥测面。 */
export interface WorkspaceTelemetry {
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  action(action: WorkspaceUiAction, outcome: WorkspaceOutcome): void;
  failure(error: unknown): void;
}

/** 工作区文件目录里的一项。 */
export interface DirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'other';
  readonly size?: number;
}

/** 一次目录列举的结果。 */
export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

/** 一次文本读取的结果。 */
export interface TextFilePage {
  readonly absolutePath: string;
  readonly text: string;
  readonly lines: number;
  readonly offset: number;
  readonly eof: boolean;
  readonly bytes?: number;
}

/** 一次字节读取的结果。 */
export interface ByteFilePage {
  readonly absolutePath: string;
  readonly base64: string;
  readonly eof: boolean;
  readonly bytes?: number;
}

/** 一次文件信息读取的结果。 */
export interface FileStat {
  readonly absolutePath: string;
  readonly bytes?: number;
}

/** 宿主报告的一条附件记录。 */
export interface AttachmentRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId?: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
  readonly createdAt: number;
  readonly artifactId: string;
  readonly artifactVersion: number;
}

/** 宿主报告的附件上限。 */
export interface AttachmentLimits {
  readonly maxBytes: number;
  readonly maxPerMessage: number;
  readonly allowedTypes: readonly string[];
  readonly maxFilenameLength: number;
}

/** 宿主报告的转写能力状态。 */
export interface TranscriptionCapability {
  readonly available: boolean;
  readonly reason?: string;
  readonly providerId?: string;
  readonly maxAudioBytes: number;
  readonly maxDurationMs: number;
  readonly acceptedTypes: readonly string[];
}

/** 宿主报告的一条录音记录。 */
export interface RecordingRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly size: number;
  readonly durationMs: number;
  readonly digest: string;
  readonly createdAt: number;
  readonly transcriptionState: 'none' | 'transcribed';
}

/** 附件在模型上下文里的一项。 */
export interface AttachmentContextEntry {
  readonly attachmentId: string;
  readonly marker: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

/** 数据入口。 */
export interface WorkspaceGateway {
  listDirectory(path: string): Promise<DirectoryListing>;
  stat(path: string): Promise<FileStat>;
  readText(path: string): Promise<TextFilePage>;
  readBytes(path: string): Promise<ByteFilePage>;
  attachmentLimits(): Promise<AttachmentLimits>;
  uploadAttachment(input: {
    readonly sessionId: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly base64: string;
  }): Promise<AttachmentRecord>;
  readAttachment(id: string): Promise<{ readonly record: AttachmentRecord; readonly base64: string }>;
  attachmentContext(ids: readonly string[]): Promise<{ readonly entries: readonly AttachmentContextEntry[]; readonly text: string }>;
  voiceCapability(): Promise<TranscriptionCapability>;
  uploadRecording(input: {
    readonly sessionId: string;
    readonly mimeType: string;
    readonly durationMs: number;
    readonly base64: string;
  }): Promise<RecordingRecord>;
  transcribeRecording(id: string, options: { readonly language?: string }): Promise<{ readonly text: string }>;
  removeRecording(id: string): Promise<boolean>;
}

/** 带稳定错误码的客户端失败。 */
export class WorkspaceClientError extends Error {
  /**
   * @param code - 稳定错误码，显示在提示里并按码聚合上报。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceClientError';
  }
}
