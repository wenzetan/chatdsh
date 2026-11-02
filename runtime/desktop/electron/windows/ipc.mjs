/**
 * 桌面第二窗口的 IPC 通道与分发。
 *
 * 渲染进程只能通过这里登记的五个通道请求窗口动作：打开、列举、聚焦、关闭与恢复。参数在
 * 这里按白名单校验，路由形状必须与深链接一致；窗口不存在、数量到上限与路由不合法都变成
 * 带原因的拒绝，调用方据此提示。
 *
 * 通道描述与处理函数分开导出：主进程把 `WINDOW_CALL_CHANNELS` 并入既有通道表，把
 * `createWindowHandlers` 的结果并入处理器表即可完成接入。
 * @module chatdsh-desktop-shell/windows/ipc
 */

import { IpcRejection, noArguments, objectArgument } from '../ipc.mjs';
import { EVENTS, METRICS, SPANS, beginSpan, noteCount, noteFailure } from '../signals.mjs';
import { assertWindowRoute, createWindowDescriptor, MAX_DESKTOP_WINDOWS, WindowRouteError } from './registry.mjs';

/** 窗口动作的通道。 */
export const WINDOW_CALL_CHANNELS = Object.freeze([
  { channel: 'chatdsh:window:open', kind: 'invoke', validate: objectArgument({ route: routeArgument() }) },
  { channel: 'chatdsh:window:list', kind: 'invoke', validate: noArguments },
  { channel: 'chatdsh:window:focus', kind: 'invoke', validate: objectArgument({ windowId: windowIdArgument() }) },
  { channel: 'chatdsh:window:dismiss', kind: 'invoke', validate: objectArgument({ windowId: windowIdArgument() }) },
  { channel: 'chatdsh:window:restore', kind: 'invoke', validate: noArguments },
]);

/** 窗口状态变化的事件通道。 */
export const WINDOW_EVENT_CHANNELS = Object.freeze(['chatdsh:window:changed']);

/** 窗口标识的长度上限。 */
const WINDOW_ID_MAX = 120;

/**
 * 路由参数：形状必须与深链接一致。
 * @returns {{ required: true, parse: (value: unknown) => string }} 参数描述。
 */
function routeArgument() {
  return {
    required: true,
    parse(value) {
      if (typeof value !== 'string' || value === '') {
        throw new IpcRejection('argument-type', '路由必须是非空字符串');
      }
      try {
        assertWindowRoute(value);
      } catch (error) {
        if (error instanceof WindowRouteError) throw new IpcRejection('window-route', error.message);
        throw error;
      }
      return value;
    },
  };
}

/**
 * 窗口标识参数。
 * @returns {{ required: true, parse: (value: unknown) => string }} 参数描述。
 */
function windowIdArgument() {
  return {
    required: true,
    parse(value) {
      if (typeof value !== 'string' || value === '' || value.length > WINDOW_ID_MAX) {
        throw new IpcRejection('argument-type', '窗口标识必须是长度合法的字符串');
      }
      return value;
    },
  };
}

/**
 * 记录一次窗口动作的计数。
 * @param {string} action - 动作名。
 * @param {'ok' | 'rejected' | 'failed'} outcome - 结果。
 */
function countAction(action, outcome) {
  noteCount(METRICS.actions, { action, outcome });
}

/**
 * 记录一次拒绝。
 * @param {string} channel - 通道名。
 * @param {string} code - 拒绝原因。
 * @param {string} detail - 补充说明。
 */
function rejectChannel(channel, code, detail) {
  noteFailure(EVENTS.ipcRejected, 'ipc', code, { channel, kind: 'invoke' });
  noteCount(METRICS.ipcRejections, { channel, reason: code });
  countAction(channel.replace('chatdsh:window:', 'window.'), 'rejected');
  return new IpcRejection(code, detail);
}

/**
 * 建立窗口动作的处理函数表。
 *
 * 依赖由主进程注入：打开窗口返回窗口标识；聚焦与关闭按窗口标识操作；恢复从存盘记录重建
 * 窗口列表。每个动作都先校验窗口是否存在，未知标识直接拒绝。
 * @param {{
 *   registry: import('./registry.mjs').WindowRegistry,
 *   openWindow: (descriptor: object) => string | Promise<string>,
 *   focusWindow: (windowId: string) => void,
 *   closeWindow: (windowId: string) => void,
 *   restoreWindows: () => Array<{ id: string, route: string }> | Promise<Array<{ id: string, route: string }>>,
 *   now?: () => number
 * }} options - 主进程提供的能力。
 * @returns {Record<string, (...args: unknown[]) => unknown>} 通道名到处理函数的映射。
 */
export function createWindowHandlers(options) {
  const { registry, openWindow, focusWindow, closeWindow, restoreWindows } = options;
  const now = options.now ?? (() => Date.now());

  /**
   * 取一个已登记的窗口，未知标识直接拒绝。
   * @param {string} channel - 通道名。
   * @param {string} windowId - 窗口标识。
   * @returns {object} 窗口登记。
   */
  function requireWindow(channel, windowId) {
    const descriptor = registry.get(windowId);
    if (descriptor === undefined) {
      throw rejectChannel(channel, 'window-unknown', `窗口不存在：${windowId}`);
    }
    return descriptor;
  }

  return {
    'chatdsh:window:open': async (payload) => {
      const channel = 'chatdsh:window:open';
      if (!registry.canOpenMore()) {
        throw rejectChannel(channel, 'window-limit', `窗口数量上限为 ${String(MAX_DESKTOP_WINDOWS)}`);
      }
      const descriptor = createWindowDescriptor({
        id: `secondary-${String(now())}-${String(registry.count)}`,
        kind: 'secondary',
        route: payload.route,
        openedAt: now(),
      });
      registry.add(descriptor);
      const windowId = await openWindow(descriptor);
      countAction('window.open', 'ok');
      return { windowId: windowId ?? descriptor.id, route: descriptor.route };
    },

    'chatdsh:window:list': () => {
      countAction('window.list', 'ok');
      return { windows: registry.tabs() };
    },

    'chatdsh:window:focus': (payload) => {
      const descriptor = requireWindow('chatdsh:window:focus', payload.windowId);
      focusWindow(descriptor.id);
      countAction('window.focus', 'ok');
      return { windowId: descriptor.id };
    },

    'chatdsh:window:dismiss': (payload) => {
      const descriptor = requireWindow('chatdsh:window:dismiss', payload.windowId);
      closeWindow(descriptor.id);
      countAction('window.close', 'ok');
      return { windowId: descriptor.id };
    },

    'chatdsh:window:restore': async () => {
      const finish = beginSpan(SPANS.windowRestore);
      try {
        const restored = await restoreWindows();
        finish('ok', { adjustments: 'restore', count: restored.length });
        countAction('window.restore', 'ok');
        return { windows: restored };
      } catch (error) {
        finish('failed', { adjustments: 'restore' });
        noteFailure(EVENTS.ipcRejected, 'ipc', 'window-restore', { channel: 'chatdsh:window:restore', kind: 'invoke' });
        countAction('window.restore', 'failed');
        throw error;
      }
    },
  };
}

/**
 * 合并窗口通道与既有通道表。接入方只做一次合并，不修改既有登记。
 * @param {readonly object[]} existing - 既有通道表。
 * @returns {object[]} 合并后的通道表。
 */
export function mergeWindowChannels(existing) {
  const names = new Set(existing.map((entry) => entry.channel));
  for (const entry of WINDOW_CALL_CHANNELS) {
    if (names.has(entry.channel)) throw new Error(`窗口通道与既有通道重名：${entry.channel}`);
  }
  return [...existing, ...WINDOW_CALL_CHANNELS];
}

/**
 * 合并事件通道。
 * @param {readonly string[]} existing - 既有事件通道。
 * @returns {string[]} 合并后的通道表。
 */
export function mergeWindowEventChannels(existing) {
  const names = new Set(existing);
  for (const channel of WINDOW_EVENT_CHANNELS) {
    if (names.has(channel)) throw new Error(`窗口事件通道与既有通道重名：${channel}`);
  }
  return [...existing, ...WINDOW_EVENT_CHANNELS];
}

/**
 * 取聚焦通道的参数描述，供预加载脚本对齐。
 * @returns {{ windowId: { required: true, parse: (value: unknown) => string } }} 参数描述。
 */
export function windowFocusShape() {
  return { windowId: windowIdArgument() };
}

/**
 * 取打开通道的参数描述，供预加载脚本对齐。
 * @returns {{ route: { required: true, parse: (value: unknown) => string } }} 参数描述。
 */
export function windowOpenShape() {
  return { route: routeArgument() };
}

/**
 * 整理打开窗口需要的路由输入，供主进程与渲染进程共用同一段说明。
 * @param {unknown} route - 路由。
 * @returns {{ route: string, sessionId: string, deviceId: string }} 收敛后的输入。
 */
export function describeWindowOpening(route) {
  const parsed = createWindowDescriptor({ id: 'secondary-preview', kind: 'secondary', route });
  return { route: parsed.route, sessionId: parsed.sessionId, deviceId: parsed.deviceId };
}

/**
 * 校验窗口动作参数，供测试与预加载脚本复用。
 * @param {string} channel - 通道名。
 * @param {unknown[]} args - 原始参数。
 * @returns {unknown} 校验结果。
 */
export function validateWindowArguments(channel, args) {
  const entry = WINDOW_CALL_CHANNELS.find((item) => item.channel === channel);
  if (entry === undefined) throw new IpcRejection('channel-not-allowed', '通道没有登记');
  return entry.validate(args);
}
