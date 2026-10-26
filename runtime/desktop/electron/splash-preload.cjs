// 启动页的最小桥：只暴露打开日志的动作，不向页面暴露 Node。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatdshSplashBridge', {
  openLog: () => ipcRenderer.invoke('chatdsh:logs:open'),
  openLogDir: () => ipcRenderer.invoke('chatdsh:logs:dir'),
});
