/**
 * 导出与打印的宿主模块。
 *
 * 这一层把导出服务、路由、四种格式的渲染、PDF 打印管线与打印样式装在一起，供发行集成
 * 挂载到公共入口。接入工作由发行集成完成，本模块只提供可独立装配的部件。
 * @module @chatdsh/gateway/exports
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { createExportHttpHandler, type ExportHttpHandler } from './http.ts';
import { ExportService, type ExportServiceOptions } from './service.ts';
import type { ExportAuthorize } from './types.ts';

export { createDirectoryAttachmentResolver } from './attachments.ts';
export { attachmentRefsOf, collectContent, MAX_EXPORT_CHARS } from './collect.ts';
export type { CollectOptions, CollectedContent } from './collect.ts';
export {
  buildDocument,
  documentFacts,
  estimateOf,
  exportContentTypeOf,
  exportFilenameOf,
  formatRangeLabel,
  formatTime,
  formatTimeWithZone,
  sourceLabelOf,
} from './document.ts';
export type { DocumentFact, DocumentInput, TimeDisplayOptions } from './document.ts';
export { EXPORT_PRINT_SCOPE, renderHtml } from './html.ts';
export { createExportHttpHandler, EXPORT_ESTIMATE_PATH, EXPORT_LIST_PATH } from './http.ts';
export type { ExportHttpHandler, ExportHttpOptions } from './http.ts';
export { renderJsonl } from './jsonl.ts';
export { renderMarkdown } from './markdown.ts';
export { createChromePdfRenderer } from './pdf.ts';
export type { ChromePdfOptions } from './pdf.ts';
export {
  attachmentStateLabel,
  escapeHtml,
  PRINT_EXCLUSION_CLASSES,
  printModelOfSharePage,
  printStylesheet,
  PUBLIC_PRINT_SCOPE,
  renderPrintDocument,
  renderSharePrintPage,
} from './print.ts';
export { ExportService } from './service.ts';
export type { ExportServiceOptions } from './service.ts';
export { ensureExportSchema, EXPORT_SCHEMA, ExportJobStore } from './store.ts';
export type { ExportJobInsert, ExportJobPatch, ExportJobRow } from './store.ts';
export {
  EXPORT_BYTES_METRIC,
  EXPORT_OPERATIONS_METRIC,
  EXPORT_REJECTED_EVENT,
  EXPORT_SPANS,
  ExportTelemetry,
} from './telemetry.ts';
export type { ExportAction, ExportActionAttributes, ExportSpanName } from './telemetry.ts';
export { ExportError } from './types.ts';
export type {
  ArtifactContentSource,
  AttachmentContext,
  AttachmentRef,
  AttachmentResolver,
  ExportActor,
  ExportAttachmentAvailability,
  ExportAuthorize,
  ExportDocument,
  ExportDownload,
  ExportEntry,
  PdfRenderer,
  PrintDocumentModel,
  PrintFact,
  ResolvedAttachment,
} from './types.ts';

/** 装配导出宿主所需的依赖。 */
export interface ExportsOptions extends ExportServiceOptions {
  /** 遥测出口；与服务的遥测出口是同一份。 */
  readonly telemetry?: ChatdshTelemetry;
  /** 请求者身份校验。 */
  readonly authorize: ExportAuthorize;
}

/** 导出宿主：服务与路由。 */
export interface ExportsHost {
  readonly service: ExportService;
  readonly handler: ExportHttpHandler;
}

/**
 * 装配导出宿主。
 * @param options - 数据库、遥测、身份校验与可选的数据根。
 * @returns 导出服务与路由处理函数。
 */
export function createExports(options: ExportsOptions): ExportsHost {
  const service = new ExportService(options);
  const handler = createExportHttpHandler({
    service,
    authorize: options.authorize,
    telemetry: options.telemetry as ChatdshTelemetry,
  });
  return { service, handler };
}
