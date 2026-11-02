/**
 * 第二窗口与分屏：新窗口深链接、共用运行时、每窗口选择与草稿、分屏几何与冲突展示。
 *
 * 浏览器侧的界面入口在 `./client/index.ts`，纯逻辑模块（深链接、登记、草稿、分屏、冲突）
 * 不依赖界面，测试与集成方可以直接引用。桌面侧的窗口登记与关闭策略在
 * `runtime/desktop/electron/windows/`。
 * @module @chatdsh/client-multi-window
 */

export {
  PANE_KINDS,
  deepLinkPath,
  deepLinkUrl,
  isPaneKind,
  paneFragment,
  paneLabel,
  parseDeepLink,
  sameSessionOf,
  sameWindowTarget,
  type DeepLinkFailure,
  type DeepLinkResult,
  type PaneKind,
  type PaneSelection,
  type WindowTarget,
} from './window/deep-link.ts';

export {
  CLIENT_KEY,
  DRAFT_KEY_PREFIX,
  IDENTIFIER_MAX,
  SPLIT_KEY_PREFIX,
  WINDOW_CHANNEL,
  WINDOW_KEY,
  assertIdentifier,
  clientIdentity,
  isIdentifier,
  randomIdentifier,
  safeStorage,
  windowIdentity,
} from './window/identifiers.ts';

export {
  MAX_WINDOWS,
  WINDOW_TTL_MS,
  WindowRegistry,
  openWindowRegistry,
  type WindowPresence,
  type WindowRegistryOptions,
  type WindowTab,
} from './window/registry.ts';

export {
  SharedRuntime,
  openSharedRuntime,
  type RuntimeConnection,
  type RuntimeTransport,
  type RuntimeTransportHandlers,
  type SharedRuntimeOptions,
  type SharedRuntimeRole,
  type SharedRuntimeState,
  type SharedRuntimeStats,
} from './window/shared-runtime.ts';

export { eventSourceTransport, type EventSourceTransportOptions } from './window/event-source-transport.ts';

export {
  clearWindowDraft,
  draftKeysOf,
  draftStorageAvailable,
  draftStorageKey,
  readWindowDraft,
  writeWindowDraft,
  type DraftFailureReason,
  type DraftWriteResult,
  type WindowDraft,
  type WindowDraftIdentity,
} from './window/drafts.ts';

export {
  SELECTION_KEY_PREFIX,
  clearWindowSelection,
  readWindowSelection,
  selectionStorageKey,
  writeScrollAnchor,
  writeWindowSelection,
  type WindowSelectionRecord,
} from './window/selection.ts';

export {
  DEFAULT_SPLIT_RATIO,
  MIN_PANE_WIDTH,
  NARROW_WIDTH,
  SEPARATOR_WIDTH,
  SPLIT_LARGE_STEP,
  SPLIT_STEP,
  applySplitKey,
  clampRatio,
  decideSplitLayout,
  ratioBounds,
  ratioFromPointer,
  ratioPercent,
  separatorLeft,
  type SplitKeyAction,
  type SplitKeyResult,
  type SplitLayout,
  type SplitMode,
} from './split/geometry.ts';

export {
  clearSplitRatio,
  readSplitRatio,
  splitStorageKey,
  writeSplitRatio,
  type SplitIdentity,
} from './split/memory.ts';

export {
  ConflictBoard,
  REFRESH_LABEL,
  describeConflict,
  openConflictBoard,
  type AttemptDecision,
  type ConflictBoardOptions,
  type ConflictKind,
  type ConflictNotice,
  type OperationAttempt,
  type OperationOutcome,
} from './conflicts/board.ts';

export {
  CSRF_HEADER,
  RELAY_PATH,
  SCOPE,
  createWindowTelemetry,
  failureAttributesOf,
  type ActionOutcome,
  type WindowTelemetry,
  type WindowTelemetryOptions,
} from './telemetry.ts';

export {
  frameLine,
  objectKeyOf,
  startMultiWindow,
  type MultiWindowHandle,
  type MultiWindowOptions,
  type ObjectSnapshot,
  type SendInput,
  type SendResult,
} from './client/index.ts';

export {
  MULTI_WINDOW_CSS,
  STYLE_ID,
  installMultiWindowStyles,
} from './client/styles.ts';

export {
  createMultiWindowPanel,
  MultiWindowPanel,
  type ActivePane,
  type PanelHandlers,
  type PanelState,
} from './client/panel.ts';
