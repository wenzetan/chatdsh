/**
 * 真实 Electron 环境下的桌面壳能力自检。
 *
 * 由 `e2e/unit/client-complete-wp32-electron.test.mjs` 用 xvfb 启动：这里不加载业务界面，
 * 只验证真实 Electron 平台接口下的菜单构建、托盘位图、窗口边界恢复、剪贴板、通知能力、
 * 电源阻止、启动恢复页，以及预加载桥在真实渲染进程里的暴露面与来源校验。
 * 结果写成一行 `WP32-SMOKE {json}` 并落到 `WP32_SMOKE_OUT` 指定的文件。
 * @module chatdsh-desktop-shell/wp32-smoke
 */

import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, powerSaveBlocker, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CALL_CHANNELS, createIpcRouter } from './ipc.mjs';
import { loginItemSettings, loginSupport } from './login-item.mjs';
import { assertUniqueAccelerators, buildAppMenuTemplate, toElectronTemplate } from './menu.mjs';
import { notificationCapability } from './notifications.mjs';
import { powerPlan } from './power.mjs';
import { trayBitmap, trayMenu } from './tray.mjs';
import { restoreWindowState, writeWindowState } from './window-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(HERE, 'preload.cjs');
const RECOVERY_PRELOAD = join(HERE, 'recovery-preload.cjs');
const RECOVERY = join(HERE, 'recovery.html');

const results = [];

/** 记录一项检查；抛出时记为失败并带上原因。 */
async function check(name, action) {
  try {
    const detail = await action();
    results.push({ name, ok: true, detail });
    return detail;
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/** 记录一项环境能力，不参与退出码。 */
async function capability(name, action) {
  try {
    results.push({ name, ok: true, detail: await action(), optional: true });
  } catch (error) {
    results.push({ name, ok: true, detail: { available: false, reason: error instanceof Error ? error.message : String(error) }, optional: true });
  }
}

/** 写结果并退出。 */
function finish() {
  const payload = {
    platform: process.platform,
    electron: process.versions.electron,
    ok: results.every((item) => item.ok),
    results,
  };
  const out = process.env.WP32_SMOKE_OUT;
  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  }
  console.log(`WP32-SMOKE ${JSON.stringify(payload)}`);
  app.exit(payload.ok ? 0 : 1);
}

/** 探针服务的句柄。 */
const probeServer = { server: undefined, origin: undefined };

/** 起一个只提供探针页面的回环服务。 */
function startProbeServer() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!DOCTYPE html><html><body>probe</body></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      probeServer.server = server;
      probeServer.origin = `http://127.0.0.1:${address.port}`;
      resolve({ origin: probeServer.origin });
    });
  });
}

// 自检窗口会逐个销毁，不能让默认行为在窗口全关时结束进程。
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays();
  await check('display', () => ({ count: displays.length, workArea: displays[0].workArea }));

  await check('menu', () => {
    const template = buildAppMenuTemplate({ platform: process.platform, sourceDeviceOnline: true, hasSession: true, updateEnabled: true });
    assertUniqueAccelerators(template);
    const menu = Menu.buildFromTemplate(toElectronTemplate(template, () => {}));
    Menu.setApplicationMenu(menu);
    return { groups: menu.items.map((item) => item.label), count: menu.items.length };
  });

  await check('tray-image', () => {
    const bitmap = trayBitmap('attention');
    const image = nativeImage.createFromBitmap(bitmap.buffer, { width: bitmap.width, height: bitmap.height });
    return { empty: image.isEmpty(), size: image.getSize() };
  });

  await capability('tray-created', () => {
    const bitmap = trayBitmap('running');
    const tray = new Tray(nativeImage.createFromBitmap(bitmap.buffer, { width: bitmap.width, height: bitmap.height }));
    tray.setToolTip('ChatDSH · 自检');
    tray.setContextMenu(Menu.buildFromTemplate(trayMenu({
      ready: true,
      pendingApprovals: 1,
      recentSessions: 2,
      preventSleep: true,
      trayEnabled: true,
      launchAtLogin: false,
    }).filter((item) => item.type !== 'separator').map((item) => ({ label: item.label, enabled: item.enabled }))));
    tray.destroy();
    return { available: true };
  });

  await check('window-restore', () => {
    const stateFile = join(app.getPath('userData'), 'window-state.json');
    writeWindowState(stateFile, { bounds: { x: 20000, y: 20000, width: 4000, height: 3000 }, maximized: false, displayId: 1 });
    const restored = restoreWindowState({ file: stateFile, displays });
    const window = new BrowserWindow({
      x: restored.bounds.x,
      y: restored.bounds.y,
      width: restored.bounds.width,
      height: restored.bounds.height,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const applied = window.getBounds();
    window.destroy();
    return { restored: restored.bounds, adjustments: restored.adjustments, applied, displayId: restored.displayId };
  });

  await check('clipboard', async () => {
    await clipboard.writeText('chatdsh-wp32-clipboard');
    const text = await clipboard.readText();
    return { text, type: typeof text };
  });

  await check('notification-capability', () => notificationCapability({
    platform: process.platform,
    isSupported: Notification.isSupported(),
    permission: process.platform === 'darwin' ? 'not-determined' : undefined,
  }));

  await check('power-blocker', () => {
    const plan = powerPlan({ enabled: true, mode: 'prevent-display-sleep', active: false });
    const id = powerSaveBlocker.start(plan.type);
    const started = powerSaveBlocker.isStarted(id);
    powerSaveBlocker.stop(id);
    return { started, stopped: !powerSaveBlocker.isStarted(id) };
  });

  await check('login-item', () => {
    const support = loginSupport(process.platform);
    if (!support.supported) return { support };
    return { support, settings: loginItemSettings({ enabled: false, platform: process.platform, executablePath: process.execPath }) };
  });

  await check('dialog-api', () => ({
    openDialog: typeof dialog.showOpenDialog === 'function',
    messageBox: typeof dialog.showMessageBox === 'function',
  }));

  const probe = await check('probe-server', () => startProbeServer());
  const allowedOrigins = new Set();
  const router = createIpcRouter({
    handlers: { 'chatdsh:status:get': () => ({ probe: 'ok' }) },
    allowedOrigins,
    allowedFiles: new Set(),
    isTrustedSender: () => true,
  });
  for (const entry of CALL_CHANNELS) {
    if (entry.channel !== 'chatdsh:status:get') continue;
    ipcMain.handle(entry.channel, (event, ...args) => router.invoke(entry.channel, event, ...args));
  }

  if (probe !== undefined) {
    const bridgeWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await check('probe-page', () => bridgeWindow.loadURL(`${probe.origin}/`));
    await check('preload-surface', async () => {
      const surface = await bridgeWindow.webContents.executeJavaScript(`(() => ({
        nodeRequire: typeof window.require,
        nodeProcess: typeof window.process,
        ipcRenderer: typeof window.ipcRenderer,
        namespaces: Object.keys(window.chatdshDesktop || {}).sort(),
        platform: window.chatdshDesktop?.platform,
      }))()`);
      if (surface.nodeRequire !== 'undefined') throw new Error('渲染进程仍然可以看到 require');
      if (surface.nodeProcess !== 'undefined') throw new Error('渲染进程仍然可以看到 process');
      if (surface.ipcRenderer !== 'undefined') throw new Error('渲染进程仍然可以看到 ipcRenderer');
      return surface;
    });
    await check('untrusted-sender-rejected', async () => {
      const verdict = await bridgeWindow.webContents.executeJavaScript(
        'window.chatdshDesktop.status.get().then(() => "resolved", () => "rejected")',
      );
      if (verdict !== 'rejected') throw new Error('未受信来源的调用没有被拒绝');
      return { verdict };
    });
    allowedOrigins.add(probe.origin);
    await check('trusted-sender-accepted', async () => {
      const value = await bridgeWindow.webContents.executeJavaScript('window.chatdshDesktop.status.get()');
      if (value?.probe !== 'ok') throw new Error('受信来源的调用没有到达处理函数');
      return value;
    });
    bridgeWindow.destroy();
    await new Promise((settle) => probeServer.server.close(settle));
  }
  const recoveryFile = pathToFileURL(RECOVERY).href;
  const recoveryRouter = createIpcRouter({
    handlers: {
      'chatdsh:startup:failure': () => ({
        failure: {
          stage: 'runtime',
          code: 'startup-failed',
          exitCode: 1,
          uptimeSeconds: 2,
          attempt: 1,
          at: new Date().toISOString(),
          logTail: ['[launcher] 控制平面端口 3170'],
        },
        safeMode: { active: false },
      }),
      'chatdsh:startup:retry': () => ({ ok: true }),
      'chatdsh:startup:safe-mode': (payload) => ({ ok: true, reason: payload.reason }),
      'chatdsh:startup:diagnostics': () => ({ ok: true, path: '/data/diagnostics.json' }),
      'chatdsh:logs:open': () => ({ ok: true }),
      'chatdsh:logs:dir': () => ({ ok: true }),
    },
    allowedOrigins: new Set(),
    allowedFiles: new Set([recoveryFile]),
    isTrustedSender: () => true,
  });
  for (const channel of [
    'chatdsh:startup:failure', 'chatdsh:startup:retry', 'chatdsh:startup:safe-mode',
    'chatdsh:startup:diagnostics', 'chatdsh:logs:open', 'chatdsh:logs:dir',
  ]) {
    ipcMain.handle(channel, (event, ...args) => recoveryRouter.invoke(channel, event, ...args));
  }
  const recoveryWindow = new BrowserWindow({
    width: 720,
    height: 660,
    show: false,
    webPreferences: { preload: RECOVERY_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await check('recovery-page', async () => {
    await recoveryWindow.loadFile(RECOVERY);
    const deadline = Date.now() + 3000;
    let stage = '';
    while (Date.now() < deadline) {
      stage = await recoveryWindow.webContents.executeJavaScript("document.getElementById('stage').textContent");
      if (stage === 'runtime') break;
      await new Promise((settle) => setTimeout(settle, 50));
    }
    if (stage !== 'runtime') throw new Error(`恢复页没有读出失败阶段：${stage}`);
    const bridge = await recoveryWindow.webContents.executeJavaScript(
      '({ hasFailure: typeof window.chatdshRecovery.failure, hasSafeMode: typeof window.chatdshRecovery.safeMode, nodeRequire: typeof window.require })',
    );
    if (bridge.nodeRequire !== 'undefined') throw new Error('恢复页看到了 Node');
    return { stage, ...bridge };
  });
  recoveryWindow.destroy();

  finish();
});
