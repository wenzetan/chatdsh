/**
 * 桌面第二窗口模块的入口。
 *
 * 主进程接入时从这里取窗口登记、关闭与恢复策略以及 IPC 通道描述；本目录不改动既有主进程
 * 与预加载桥，接入动作由公共入口集成任务完成。
 * @module chatdsh-desktop-shell/windows
 */

export {
  CASCADE_OFFSET,
  MAX_DESKTOP_WINDOWS,
  WINDOW_KINDS,
  WINDOW_SESSION_VERSION,
  WindowRegistry,
  WindowRouteError,
  assertWindowRoute,
  cascadedBounds,
  createWindowDescriptor,
  isWindowId,
  isWindowKind,
  normalizeBounds,
  parseWindowRoute,
  parseWindowSession,
  serializeWindowSession,
  windowTitleOf,
} from './registry.mjs';

export {
  CLOSE_ACTIONS,
  decideWindowClose,
  describeCloseDecision,
  planRestore,
  trayRestoreTargets,
  windowAllClosedAction,
} from './lifecycle.mjs';

export {
  WINDOW_CALL_CHANNELS,
  WINDOW_EVENT_CHANNELS,
  createWindowHandlers,
  describeWindowOpening,
  mergeWindowChannels,
  mergeWindowEventChannels,
  validateWindowArguments,
  windowFocusShape,
  windowOpenShape,
} from './ipc.mjs';
