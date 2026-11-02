/**
 * 导出面板的浏览器侧入口。
 *
 * 宿主把 `ExportsPanel` 挂到会话的导出入口上，面板自带数据入口的缺省实现与界面动作遥测；
 * 测试与嵌入场景可以传入受控的数据入口、权限与时钟。纯函数与类型在这里一并导出，宿主与
 * 测试因此不必知道内部模块的划分。
 * @module @chatdsh/client-exports/client
 */

import { createElement, type ComponentType } from 'react';
import { createExportGateway } from './gateway.ts';
import { ExportPanel } from './panel.tsx';
import { browserTelemetry } from './telemetry.ts';
import type { ExportGateway, ExportSource } from './types.ts';

export { attachmentRows, missingDecision, needsMissingConfirmation, tallyOf, POLICY_HINTS, POLICY_LABELS, ATTACHMENT_STATE_LABELS } from './attachments.ts';
export type { AttachmentRow, AttachmentTally, MissingDecision } from './attachments.ts';
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
} from './format.ts';
export { ExportCallError, createExportGateway, CSRF_HEADER, ESTIMATE_PATH, JOBS_PATH } from './gateway.ts';
export { describeJob, isRunning, nextPollDelay, progressOf, regenerateHint, STATE_LABELS } from './job.ts';
export type { JobView, StateTone } from './job.ts';
export { ExportPanel } from './panel.tsx';
export type { ExportPanelProps } from './panel.tsx';
export {
  canPrint,
  defaultPrintInput,
  PRINT_EXCLUSION_LABELS,
  PRINT_HIDE_CLASSES,
  printDocument,
  printPreviewSummary,
  printScopeOf,
  printingNow,
} from './print.ts';
export type { PrintInput, PrintScopeView } from './print.ts';
export {
  ExportSelectionError,
  formatChoices,
  newOperationId,
  requestDigestOf,
  scopeOf,
  selectionOf,
} from './scope.ts';
export type { FormatChoice, SelectionInput } from './scope.ts';
export { browserTelemetry, noteAction, TELEMETRY_PATH } from './telemetry.ts';
export {
  ATTACHMENT_POLICIES,
  ERROR_LABELS,
  EXPORT_ACTIONS,
  EXPORT_ATTACHMENT_STATES,
  EXPORT_EXCLUDED_CONTENT,
  EXPORT_FORMATS,
  EXPORT_STATES,
  PRINT_EXCLUSIONS,
} from './types.ts';
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
} from './types.ts';

/** 面板的区域标识，与宿主侧入口共用同一个约定。 */
export const PANEL_ID = 'chatdsh-exports';

/** 面板元素的可选部分。 */
export interface ExportsPanelBinding {
  /** 数据入口；缺省用同源接口建立一份共享入口。 */
  readonly gateway?: ExportGateway;
  /** 是否具备私有导出权限。 */
  readonly canPrivate?: boolean;
  /** 当前时刻的实现；测试可以固定时钟。 */
  readonly clock?: () => number;
}

let shared: ExportGateway | undefined;

/**
 * 取数据入口。
 * @param provided - 调用方传入的入口。
 * @returns 数据入口。
 */
function gatewayOf(provided?: ExportGateway): ExportGateway {
  if (provided !== undefined) return provided;
  shared ??= createExportGateway({ telemetry: browserTelemetry });
  return shared;
}

/** 宿主挂载时传入的导出源与回合边界。 */
export interface ExportsPanelMountProps {
  /** 导出源。 */
  readonly source: ExportSource;
  /** 可用回合边界。 */
  readonly turnBounds: { readonly turnFrom: number; readonly turnTo: number };
}

/**
 * 绑定数据入口之后的面板：宿主只传导出源与回合边界。
 * @param binding - 数据入口、私有导出权限与时钟。
 * @returns 可直接挂载的组件。
 */
export function bindExportsPanel(binding: ExportsPanelBinding = {}): ComponentType<ExportsPanelMountProps> {
  const face = gatewayOf(binding.gateway);
  return function BoundExportsPanel({ source, turnBounds }: ExportsPanelMountProps) {
    return createElement(ExportPanel, {
      gateway: face,
      source,
      turnBounds,
      ...(binding.canPrivate === undefined ? {} : { canPrivate: binding.canPrivate }),
      ...(binding.clock === undefined ? {} : { clock: binding.clock }),
    });
  };
}
