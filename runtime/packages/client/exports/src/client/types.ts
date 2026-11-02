/**
 * 导出面板的对外类型。
 *
 * 面板只描述界面需要的事实：范围、格式、附件结论、任务状态与失败原因。取值与跨组件契约
 * 一一对应，接口返回的形状在这里逐项核对，形状不符按失败处理。
 * @module @chatdsh/client-exports/types
 */

/** 导出格式。 */
export const EXPORT_FORMATS = ['markdown', 'jsonl', 'html', 'pdf'] as const;

/** 导出格式取值。 */
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 导出状态。 */
export const EXPORT_STATES = ['estimated', 'generating', 'cancelling', 'completed', 'failed', 'expired'] as const;

/** 导出状态取值。 */
export type ExportState = (typeof EXPORT_STATES)[number];

/** 附件处理方式。 */
export const ATTACHMENT_POLICIES = ['available-only', 'include-missing-list', 'exclude'] as const;

/** 附件处理方式取值。 */
export type AttachmentPolicy = (typeof ATTACHMENT_POLICIES)[number];

/** 附件的可用状态。 */
export const EXPORT_ATTACHMENT_STATES = ['downloadable', 'missing', 'needs-source-device'] as const;

/** 附件的可用状态取值。 */
export type ExportAttachmentState = (typeof EXPORT_ATTACHMENT_STATES)[number];

/** 打印时去掉的界面部分。 */
export const PRINT_EXCLUSIONS = ['navigation', 'composer', 'interaction-buttons'] as const;

/** 打印时去掉的界面部分取值。 */
export type PrintExclusion = (typeof PRINT_EXCLUSIONS)[number];

/** 默认排除的内容类别。 */
export const EXPORT_EXCLUDED_CONTENT = ['credentials', 'memory-recall', 'internal-paths', 'replica-watermark'] as const;

/** 默认排除的内容类别取值。 */
export type ExportExcludedContent = (typeof EXPORT_EXCLUDED_CONTENT)[number];

/** 界面动作名。 */
export const EXPORT_ACTIONS = [
  'export-estimate',
  'export-create',
  'export-cancel',
  'export-download',
  'export-confirm-missing',
  'export-regenerate',
  'export-print-preview',
] as const;

/** 界面动作名取值。 */
export type ExportAction = (typeof EXPORT_ACTIONS)[number];

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'failed';

/** 面板的遥测面。 */
export interface PanelTelemetry {
  /**
   * 记录一次界面动作。
   * @param action - 动作名。
   * @param outcome - 动作结果。
   */
  action(action: ExportAction, outcome: ActionOutcome): void;
}

/** 内容范围。 */
export interface ContentScope {
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly eventCount: number;
  readonly charCount: number;
  readonly compressed: boolean;
  readonly attachmentsComplete: boolean;
}

/** 导出源。 */
export type ExportSource =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'artifact'; readonly artifactId: string; readonly version: number };

/** 导出里的一项附件。 */
export interface ExportAttachmentView {
  readonly id: string;
  readonly filename: string;
  readonly state: ExportAttachmentState;
  readonly size?: number;
}

/** 导出预估。 */
export interface ExportEstimateView {
  readonly eventCount: number;
  readonly charCount: number;
  readonly bytes: number;
  readonly attachments: readonly ExportAttachmentView[];
}

/** 导出的内容范围。 */
export interface ExportScopeView {
  readonly source: ExportSource;
  readonly scope: ContentScope;
  readonly format: ExportFormat;
  readonly includeToolReads: boolean;
  readonly attachmentPolicy: AttachmentPolicy;
  readonly timeDisplay: 'local' | 'utc';
  readonly redaction: 'default' | 'strict';
  readonly privateExport: boolean;
}

/** 一次导出任务。 */
export interface ExportJobView {
  readonly jobId: string;
  readonly state: ExportState;
  readonly scope: ExportScopeView;
  readonly estimate: ExportEstimateView;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly expiresAt?: number;
  readonly code?: string;
}

/** 界面上的选择。 */
export interface ExportSelection {
  readonly source: ExportSource;
  readonly turnFrom: number;
  readonly turnTo: number;
  readonly format: ExportFormat;
  readonly includeToolReads: boolean;
  readonly attachmentPolicy: AttachmentPolicy;
  readonly timeDisplay: 'local' | 'utc';
  readonly redaction: 'default' | 'strict';
  readonly privateExport: boolean;
}

/** 下载的内容。 */
export interface ExportDownloadView {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** 任务列表。 */
export interface ExportJobList {
  readonly jobs: readonly ExportJobView[];
}

/** 可加载的结果。 */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly error: unknown };

/** 数据入口。 */
export interface ExportGateway {
  /** 遥测面。 */
  readonly telemetry: PanelTelemetry;
  /**
   * 预估导出。
   * @param selection - 界面选择。
   */
  estimate(selection: ExportSelection): Promise<ExportEstimateView>;
  /**
   * 建立导出。
   * @param request - 操作标识、请求摘要与范围。
   */
  create(request: { readonly operationId: string; readonly requestDigest: string; readonly scope: ExportScopeView }): Promise<ExportJobView>;
  /** 列出最近的任务。 */
  jobs(): Promise<ExportJobList>;
  /**
   * 取一条任务。
   * @param jobId - 任务标识。
   */
  job(jobId: string): Promise<ExportJobView>;
  /**
   * 取消任务。
   * @param jobId - 任务标识。
   */
  cancel(jobId: string): Promise<ExportJobView>;
  /**
   * 下载产物。
   * @param jobId - 任务标识。
   */
  download(jobId: string): Promise<ExportDownloadView>;
}

/** 失败原因的中文说明。 */
export const ERROR_LABELS: Readonly<Record<string, string>> = {
  'permission-denied': '当前身份没有这项导出权限，完整业务记录导出需要单独授权。',
  'private-export-forbidden': '完整业务记录导出需要单独授权的私有导出权限。',
  'export-format-unsupported': '当前来源不支持这个格式，或本机缺少对应的渲染能力。',
  'pdf-renderer-unavailable': '本机没有可用的 PDF 渲染器，PDF 导出暂不可用。',
  'artifact-source-unavailable': '制品内容读取还没有接入，制品导出暂不可用。',
  'export-too-large': '导出内容超过配额，请缩小回合范围。',
  'export-expired': '下载地址已失效，请重新生成。',
  'download-expired': '下载地址已失效，请重新生成。',
  'download-missing': '导出文件已不在磁盘上，请重新生成。',
  'job-running': '导出还在进行中，完成之后才能下载。',
  'job-failed': '导出失败，请调整范围或格式后重新生成。',
  'job-finished': '任务已经结束，无法取消。',
  'operation-digest-mismatch': '同一操作标识带了不同的请求内容，请重新发起。',
  'session-not-found': '会话不存在或已删除。',
  'replica-unavailable': '会话副本还没有内容，暂时不能导出。',
  'request-invalid': '请求内容不合法，请检查回合范围与格式。',
  'payload-too-large': '请求内容超过上限。',
  'internal-error': '服务内部故障，未暴露异常原文。',
};
