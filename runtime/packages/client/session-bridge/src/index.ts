/**
 * 设备内导航桥。
 *
 * 宿主与设备内容席位分处两个窗口，通过经过校验的 `postMessage` 通道完成席位握手与会话
 * 导航。宿主侧 {@link NavigationHost} 负责声明席位、发导航请求、等待回执、有限重试；
 * 内容端 {@link NavigationContent} 负责上报就绪、按真实打开结果确认或拒绝；契约在
 * {@link parseBridgeMessage} 里逐字段校验；遥测由 {@link createNavigationTelemetry} 交给
 * 同源中继。
 * @module @chatdsh/client-session-bridge
 */

export {
  BRIDGE_CAPABILITIES,
  CONTENT_STATES,
  DEFAULT_NAVIGATION_ATTEMPTS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  MAX_NAVIGATION_ATTEMPTS,
  NAVIGATION_REJECTION_CODES,
  NAVIGATION_VERSION,
  navigateMessage,
  parseBridgeMessage,
  readyMessage,
  rejectedMessage,
  selectedMessage,
  sourceMessage,
  stateRank,
  stricterState,
  type BridgeCapability,
  type BridgeMessage,
  type BridgeParseResult,
  type ContentState,
  type ContentToHostMessage,
  type HostToContentMessage,
  type NavigateRequest,
  type NavigationErrorType,
  type NavigationRejection,
  type NavigationRejectionCode,
  type ReadyReport,
  type RejectedReport,
  type SelectedReport,
  type SourceDeclaration,
} from './contract.ts';
export {
  NavigationHost,
  type HandshakeOutcome,
  type NavigationHostOptions,
  type NavigationOutcome,
} from './host.ts';
export {
  NavigationContent,
  NavigationOpenError,
  type NavigationContentOptions,
  type OpenedSession,
} from './content.ts';
export {
  CSRF_HEADER,
  RELAY_PATH,
  SCOPE,
  createNavigationTelemetry,
  randomHex,
  type NavigationActionOutcome,
  type NavigationFailureOutcome,
  type NavigationFailureRecord,
  type NavigationSpanRecord,
  type NavigationTelemetry,
  type NavigationTelemetryOptions,
  type OtlpAttribute,
  type OtlpAttributeValue,
} from './telemetry.ts';
