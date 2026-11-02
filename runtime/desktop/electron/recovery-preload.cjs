// 启动恢复页的最小桥：只暴露读取失败记录、重试、安全模式、诊断导出与打开日志。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatdshRecovery', {
  failure: () => ipcRenderer.invoke('chatdsh:startup:failure'),
  retry: () => ipcRenderer.invoke('chatdsh:startup:retry'),
  safeMode: (reason) => ipcRenderer.invoke('chatdsh:startup:safe-mode', { reason, disabledExtensions: [] }),
  diagnostics: () => ipcRenderer.invoke('chatdsh:startup:diagnostics'),
  openLog: () => ipcRenderer.invoke('chatdsh:logs:open'),
  openLogDir: () => ipcRenderer.invoke('chatdsh:logs:dir'),
});
