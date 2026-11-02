/**
 * 预加载脚本：向页面暴露白名单桌面桥。
 *
 * 页面拿不到 `ipcRenderer`、`require` 或任意通道调用能力；每个方法对应 `ipc.mjs` 里登记
 * 过的一个通道，参数在主进程按同一份白名单再校验一次。沙箱模式下的预加载用 CommonJS
 * 书写。
 * @module chatdsh-desktop-shell/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 调用一个需要返回值的通道。 */
const invoke = (channel, payload) => (payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload));

/** 向一个不返回值的通道发送消息。 */
const send = (channel, payload) => (payload === undefined ? ipcRenderer.send(channel) : ipcRenderer.send(channel, payload));

/**
 * 订阅主进程事件。
 * @param channel - 事件通道。
 * @param callback - 回调。
 * @returns 取消订阅函数。
 */
const listen = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('回调必须是函数');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

/** 只保留登记过的活动字段，避免多余字段被主进程拒绝。 */
const activityPayload = (report) => ({
  runningTurns: report.runningTurns,
  pendingApprovals: report.pendingApprovals,
  drafts: report.drafts,
  hasSession: report.hasSession,
  sourceDeviceOnline: report.sourceDeviceOnline,
  paused: report.paused,
  recentSessions: report.recentSessions,
  workspace: report.workspace,
});

contextBridge.exposeInMainWorld('chatdshDesktop', {
  platform: process.platform,

  status: Object.freeze({
    get: () => invoke('chatdsh:status:get'),
    on: (callback) => listen('chatdsh:status', callback),
  }),

  keepAlive: Object.freeze({
    get: () => invoke('chatdsh:keepalive:get'),
    set: (enabled) => invoke('chatdsh:keepalive:set', enabled === true),
  }),

  window: Object.freeze({
    state: () => invoke('chatdsh:window:state'),
    minimize: () => send('chatdsh:window:minimize'),
    toggleMaximize: () => send('chatdsh:window:toggle-maximize'),
    close: () => send('chatdsh:window:close'),
    open: (route) => invoke('chatdsh:window:open', { route }),
    list: () => invoke('chatdsh:window:list'),
    focus: (windowId) => invoke('chatdsh:window:focus', { windowId }),
    dismiss: (windowId) => invoke('chatdsh:window:dismiss', { windowId }),
    restore: () => invoke('chatdsh:window:restore'),
  }),

  native: Object.freeze({
    chooseDirectory: (purpose) => invoke('chatdsh:native:choose-directory', { purpose }),
    openExternal: (url) => invoke('chatdsh:native:open-external', { url }),
    openPath: (path) => invoke('chatdsh:native:open-path', { path }),
    writeClipboard: (text) => invoke('chatdsh:native:clipboard-write', { text }),
  }),

  notifications: Object.freeze({
    show: (request) => invoke('chatdsh:notification:show', {
      kind: request.kind,
      title: request.title,
      body: request.body,
      route: request.route,
    }),
    onClick: (callback) => listen('chatdsh:notification:click', callback),
  }),

  updates: Object.freeze({
    state: () => invoke('chatdsh:update:state'),
    check: (channel) => invoke('chatdsh:update:check', { channel }),
    download: () => invoke('chatdsh:update:download'),
    install: (confirmed) => invoke('chatdsh:update:install', { confirmed: confirmed === true }),
    cancel: () => invoke('chatdsh:update:cancel'),
    onState: (callback) => listen('chatdsh:update:changed', callback),
  }),

  power: Object.freeze({
    state: () => invoke('chatdsh:power:state'),
    set: (enabled, mode) => invoke('chatdsh:power:set', { enabled: enabled === true, mode }),
  }),

  login: Object.freeze({
    state: () => invoke('chatdsh:login:state'),
    set: (enabled) => invoke('chatdsh:login:set', { enabled: enabled === true }),
  }),

  startup: Object.freeze({
    failure: () => invoke('chatdsh:startup:failure'),
    retry: () => invoke('chatdsh:startup:retry'),
    safeMode: (reason, disabledExtensions) => invoke('chatdsh:startup:safe-mode', {
      reason: String(reason),
      disabledExtensions: Array.isArray(disabledExtensions) ? disabledExtensions : [],
    }),
    diagnostics: () => invoke('chatdsh:startup:diagnostics'),
  }),

  logs: Object.freeze({
    open: () => invoke('chatdsh:logs:open'),
    openDir: () => invoke('chatdsh:logs:dir'),
  }),

  activity: Object.freeze({
    report: (report) => send('chatdsh:activity:report', activityPayload(report)),
  }),

  onMenuAction: (callback) => listen('chatdsh:menu:action', callback),
});
