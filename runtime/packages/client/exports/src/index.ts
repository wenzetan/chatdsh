/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板在浏览器侧，由 `dsh.client` 声明的 `./client` 子路径提供；宿主侧这里给出挂载约定、
 * 数据入口的工厂与不依赖 React 的纯函数，宿主与测试都从这一层取。宿主进程加载本入口时
 * 不会碰到浏览器专有的模块。
 * @module @chatdsh/client-exports
 */

export {
  attachmentRows,
  missingDecision,
  needsMissingConfirmation,
  tallyOf,
  POLICY_HINTS,
  POLICY_LABELS,
  ATTACHMENT_STATE_LABELS,
} from './client/attachments.ts';
export type { AttachmentRow, AttachmentTally, MissingDecision } from './client/attachments.ts';
export {
  describeExpiry,
  FORMAT_HINTS,
  FORMAT_LABELS,
  formatBytes,
  formatEstimate,
  formatVolume,
  formatsFor,
  isFormatAvailable,
  PRIVATE_FORMATS,
  suggestedFilename,
} from './client/format.ts';
export { ExportCallError, createExportGateway, CSRF_HEADER, ESTIMATE_PATH, JOBS_PATH } from './client/gateway.ts';
export { describeJob, isRunning, nextPollDelay, progressOf, regenerateHint, STATE_LABELS } from './client/job.ts';
export type { JobView, StateTone } from './client/job.ts';
export {
  canPrint,
  defaultPrintInput,
  PRINT_EXCLUSION_LABELS,
  PRINT_HIDE_CLASSES,
  printDocument,
  printPreviewSummary,
  printScopeOf,
  printingNow,
} from './client/print.ts';
export type { PrintInput, PrintScopeView } from './client/print.ts';
export {
  ExportSelectionError,
  formatChoices,
  newOperationId,
  requestDigestOf,
  scopeOf,
  selectionOf,
} from './client/scope.ts';
export type { FormatChoice, SelectionInput } from './client/scope.ts';
export { browserTelemetry, noteAction, TELEMETRY_PATH } from './client/telemetry.ts';
export {
  ATTACHMENT_POLICIES,
  ERROR_LABELS,
  EXPORT_ACTIONS,
  EXPORT_ATTACHMENT_STATES,
  EXPORT_EXCLUDED_CONTENT,
  EXPORT_FORMATS,
  EXPORT_STATES,
  PRINT_EXCLUSIONS,
} from './client/types.ts';
export type {
  ActionOutcome,
  AttachmentPolicy,
  ContentScope,
  ExportAction,
  ExportAttachmentState,
  ExportAttachmentView,
  ExportDownloadView,
  ExportEstimateView,
  ExportExcludedContent,
  ExportFormat,
  ExportGateway,
  ExportJobList,
  ExportJobView,
  ExportScopeView,
  ExportSelection,
  ExportSource,
  ExportState,
  Loadable,
  PanelTelemetry,
  PrintExclusion,
} from './client/types.ts';

/** 面板的区域标识，与浏览器侧入口共用同一个约定。 */
export const PANEL_ID = 'chatdsh-exports';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
