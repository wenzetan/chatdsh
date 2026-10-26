/**
 * 预加载脚本：向页面暴露最小的桌面桥。
 *
 * 只暴露壳层必须让页面知道的信息（平台、保活与电源状态、窗口动作），不暴露 Node 能力，
 * 页面上下文保持隔离。沙箱模式下的预加载用 CommonJS 书写。
 * @module chatdsh-desktop-shell/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatdshDesktop', {
  platform: process.platform,
  getKeepAlive: () => ipcRenderer.invoke('chatdsh:keepalive:get'),
  setKeepAlive: (enabled) => ipcRenderer.invoke('chatdsh:keepalive:set', enabled === true),
  window: {
    minimize: () => ipcRenderer.send('chatdsh:window:minimize'),
    toggleMaximize: () => ipcRenderer.send('chatdsh:window:toggle-maximize'),
    close: () => ipcRenderer.send('chatdsh:window:close'),
  },
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('chatdsh:status', listener);
    return () => ipcRenderer.removeListener('chatdsh:status', listener);
  },
});
