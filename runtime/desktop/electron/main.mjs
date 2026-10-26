/**
 * ChatDSH 桌面壳主进程。
 *
 * 负责四件事：取单实例锁；用启动页按启动五阶段逐步报进度；拉起运行时并把窗口指向它；
 * 提供托盘、关闭到托盘、保活与强制不休眠。运行时子进程的编排在 `launch.mjs`，
 * 页面的最小桥在 `preload.mjs`。
 * @module chatdsh-desktop-shell/main
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, powerSaveBlocker, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeLauncher } from './launch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPLASH = join(HERE, 'splash.html');
const PRELOAD = join(HERE, 'preload.cjs');

/**
 * 解析 dsh 的启动入口。
 *
 * 打包后优先用随包携带的 `@deepseek-ai/dsh` 入口（`resources/app/dsh/lib/bin.js`）；
 * 开发态用环境变量 `CHATDSH_DSH_BIN`，都没有时回退到 PATH 上的 `dsh`。
 */
function resolveDshBin(userData) {
  const bundled = join(process.resourcesPath ?? '', 'app', 'dsh', 'lib', 'bin.js');
  if (process.env.CHATDSH_DSH_BIN !== undefined) return process.env.CHATDSH_DSH_BIN;
  if (existsSync(bundled)) return bundled;
  return 'dsh';
}

/** 运行时与数据根来自环境变量，未给时落到 userData 下的固定位置。 */
function resolveConfig() {
  const userData = app.getPath('userData');
  return {
    userData,
    launchRoot: process.env.CHATDSH_LAUNCH_ROOT ?? join(userData, 'launch-root'),
    dshHome: process.env.CHATDSH_DSH_HOME ?? join(userData, 'harness'),
    profile: process.env.CHATDSH_PROFILE ?? 'chatdsh-desktop',
    port: process.env.CHATDSH_PORT === undefined ? undefined : Number.parseInt(process.env.CHATDSH_PORT, 10),
    dshBin: resolveDshBin(userData),
    cwd: process.env.CHATDSH_CWD ?? userData,
    keepAliveFile: join(userData, 'keepalive.json'),
  };
}

const config = resolveConfig();

/** 保活设置：托盘常驻、开机自启、强制不休眠与其子档。 */
function loadKeepAlive() {
  const defaults = { tray: true, launchAtLogin: false, preventSleep: false, mode: 'prevent-display-sleep' };
  try {
    const stored = JSON.parse(readFileSync(config.keepAliveFile, 'utf8'));
    return { ...defaults, ...stored };
  } catch {
    return defaults;
  }
}

function saveKeepAlive(state) {
  mkdirSync(dirname(config.keepAliveFile), { recursive: true });
  writeFileSync(config.keepAliveFile, JSON.stringify(state, null, 2));
}

/** 运行时状态与窗口句柄。 */
const state = {
  keepAlive: loadKeepAlive(),
  powerBlockerId: undefined,
  launcher: new RuntimeLauncher({
    launchRoot: config.launchRoot,
    dshHome: config.dshHome,
    profile: config.profile,
    port: config.port,
    dshBin: config.dshBin,
    cwd: config.cwd,
  }),
  bootUrl: undefined,
  origin: undefined,
  quitting: false,
  failure: undefined,
};

let splashWindow;
let mainWindow;
let tray;

/** 可选截图目录：给了就在每个阶段落一张 PNG，便于真机取证。 */
const captureDir = process.env.CHATDSH_CAPTURE_DIR;

/** 把一张窗口内容写成 PNG；失败只在控制台提示，不影响启动。 */
async function capture(window, name) {
  if (captureDir === undefined || window === undefined || window.isDestroyed()) return;
  try {
    const image = await window.webContents.capturePage();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(captureDir, `${name}.png`), image.toPNG());
    console.log(`[chatdsh] capture ${name}.png`);
  } catch (error) {
    console.log(`[chatdsh] capture ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 把启动阶段写入启动页，并在给了截图目录时落一张阶段截图。 */
function splashPhase(phase, status, detail) {
  console.log(`[chatdsh] phase ${phase} ${status}${detail ? ` ${detail}` : ''}`);
  if (splashWindow === undefined || splashWindow.isDestroyed()) return;
  const script = `window.__chatdshSplash?.phase(${JSON.stringify(phase)}, ${JSON.stringify(status)}, ${JSON.stringify(detail ?? '')})`;
  void splashWindow.webContents.executeJavaScript(script)
    .then(() => capture(splashWindow, `phase-${phase}-${status}`))
    .catch(() => undefined);
}

function splashFail(message) {
  if (splashWindow === undefined || splashWindow.isDestroyed()) return;
  const script = `window.__chatdshSplash?.fail(${JSON.stringify(String(message))})`;
  void splashWindow.webContents.executeJavaScript(script).catch(() => undefined);
}

/** 依据保活设置驱动系统电源策略。 */
function applyPowerPolicy() {
  const enabled = state.keepAlive.preventSleep === true;
  if (enabled && state.powerBlockerId === undefined) {
    const type = state.keepAlive.mode === 'prevent-app-suspension' ? 'prevent-app-suspension' : 'prevent-display-sleep';
    state.powerBlockerId = powerSaveBlocker.start(type);
  } else if (!enabled && state.powerBlockerId !== undefined) {
    if (powerSaveBlocker.isStarted(state.powerBlockerId)) powerSaveBlocker.stop(state.powerBlockerId);
    state.powerBlockerId = undefined;
  }
  broadcastStatus();
}

/** 当前状态快照，供页面与托盘读取。 */
function statusSnapshot() {
  return {
    platform: process.platform,
    ready: state.bootUrl !== undefined,
    keepAlive: state.keepAlive.tray === true,
    preventSleep: state.keepAlive.preventSleep === true,
    powerMode: state.keepAlive.mode,
    powerActive: state.powerBlockerId !== undefined && powerSaveBlocker.isStarted(state.powerBlockerId),
    failure: state.failure,
  };
}

function broadcastStatus() {
  const snapshot = statusSnapshot();
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chatdsh:status', snapshot);
  }
  updateTrayMenu(snapshot);
}

/** 打开主窗口并加载已就绪的运行时地址。 */
async function showMainWindow() {
  if (state.bootUrl === undefined) return;
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 680,
      show: false,
      backgroundColor: '#0e0e10',
      title: 'ChatDSH',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    // 站外链接交给系统浏览器，窗口只承载本地运行时界面。
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.on('close', (event) => {
      // 托盘常驻时关闭窗口只隐藏，进程与运行时继续存活。
      if (state.quitting !== true && state.keepAlive.tray === true) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }
  await mainWindow.loadURL(state.bootUrl);
  mainWindow.show();
  if (splashWindow !== undefined && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = undefined;
}

/** 托盘图标：用一张内置的单色图，避免依赖外部资源。 */
function trayImage() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    buffer[i * 4] = 0x4d;
    buffer[i * 4 + 1] = 0x6b;
    buffer[i * 4 + 2] = 0xfe;
    buffer[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function updateTrayMenu(snapshot) {
  if (tray === undefined) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => { void showMainWindow(); } },
    { type: 'separator' },
    { label: `阻止睡眠：${snapshot.preventSleep ? '开' : '关'}`, click: () => setKeepAlive({ preventSleep: !snapshot.preventSleep }) },
    { label: `托盘常驻：${snapshot.keepAlive ? '开' : '关'}`, click: () => setKeepAlive({ tray: !snapshot.keepAlive }) },
    { type: 'separator' },
    { label: '退出', click: () => { state.quitting = true; app.quit(); } },
  ]);
  tray.setToolTip(`ChatDSH${snapshot.ready ? '' : '（启动中）'}`);
  tray.setContextMenu(menu);
}

function createTray() {
  // 无图形会话（远程、无桌面环境）下系统托盘可能创建失败；不把它当成启动阻断条件。
  try {
    tray = new Tray(trayImage());
    tray.on('click', () => { void showMainWindow(); });
    updateTrayMenu(statusSnapshot());
  } catch (error) {
    console.log(`[chatdsh] tray unavailable: ${error instanceof Error ? error.message : String(error)}`);
    tray = undefined;
  }
}

/** 更新保活设置并落盘。 */
function setKeepAlive(patch) {
  state.keepAlive = { ...state.keepAlive, ...patch };
  saveKeepAlive(state.keepAlive);
  app.setLoginItemSettings({ openAtLogin: state.keepAlive.launchAtLogin === true });
  applyPowerPolicy();
  return statusSnapshot();
}

/**
 * 首次进入的点击序列：把界面推进到主界面。
 *
 * 逐页判断当前状态再决定点击哪个按钮，避免停留在某一页反复点同一个。页面顺序是：
 * 欢迎页（继续）→ 密钥页（稍后配置）→ 工作区页（选工作区、保存并继续）→ 预设页（选预设）。
 */
async function runOnboarding() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  for (let round = 0; round < 18; round += 1) {
    const probe = await mainWindow.webContents.executeJavaScript(`(() => {
      const visible = (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const buttons = [...document.querySelectorAll('button')].filter(visible).map((b) => (b.textContent || '').trim());
      const text = document.body.innerText || '';
      return {
        main: document.querySelector('textarea') !== null || text.includes('描述你想要构建'),
        buttons,
        hasKey: buttons.some((t) => t.includes('稍后配置')),
        hasWs: text.includes('选择工作区') || text.includes('chatdsh-work'),
        hasSave: buttons.some((t) => t.includes('保存并继续')),
        hasPreset: text.includes('ChatDSH 工作') || text.includes('默认工作区') || text.includes('预设'),
      };
    })()`).catch(() => ({ main: false, buttons: [] }));
    if (probe.main === true) {
      console.log('[chatdsh] onboard: reached main ui');
      return;
    }
    const hasWork = probe.buttons.some((t) => t.includes('chatdsh-work'));
    let target;
    if (probe.hasKey === true) target = '稍后配置';
    else if (probe.hasSave === true && probe.hasWs === true) target = '保存并继续';
    else if (hasWork === true) target = 'chatdsh-work';
    else if (probe.hasSave === true) target = '保存并继续';
    else if (probe.hasPreset === true) target = 'ChatDSH 工作';
    else target = '继续';
    const ok = await clickByText(target, 6000);
    console.log(`[chatdsh] onboard click "${target}" ${ok ? 'ok' : 'miss'} buttons=${JSON.stringify(probe.buttons)}`);
    await new Promise((settle) => setTimeout(settle, 2500));
  }
  console.log('[chatdsh] onboard: gave up before main ui');
}

/** 点击第一个文本包含给定片段的按钮；轮询到超时。 */
async function clickByText(needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const script = `(() => {
      const visible = (el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0;
      const b = [...document.querySelectorAll('button')].find((x) => visible(x) && (x.textContent || '').includes(${JSON.stringify(needle)}));
      if (b === undefined) return false;
      b.click();
      return true;
    })()`;
    try {
      const clicked = await mainWindow.webContents.executeJavaScript(script);
      if (clicked === true) return true;
    } catch {
      // 页面切换期间执行可能失败，继续轮询。
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
  return false;
}

/**
 * 真机自检：在渲染进程里读取 DOM 与计算样式，核对主题令牌、布局尺寸与关键界面结构。
 *
 * 不依赖视觉，全部以文本与计算值为证据，结果写到控制台固定前缀行，供脚本解析。
 */
async function runSelfTest() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    console.log('[chatdsh] selftest skipped: no window');
    return;
  }
  const script = `(() => {
    const cs = getComputedStyle(document.body);
    const root = getComputedStyle(document.documentElement);
    const pick = (name) => cs.getPropertyValue(name).trim();
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    };
    return {
      scheme: document.body.getAttribute('data-color-scheme'),
      hasThemeNode: document.getElementById('chatdsh-theme-styles') !== null,
      tokens: {
        bg: pick('--chatdsh-bg'),
        panel: pick('--chatdsh-panel'),
        brand: pick('--chatdsh-brand'),
        ink: pick('--chatdsh-ink'),
        ok: pick('--chatdsh-ok'),
        warn: pick('--chatdsh-warn'),
        danger: pick('--chatdsh-danger'),
        fontSize: pick('--cdh-fs-13'),
      },
      aliasBase: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
      bodyBg: cs.backgroundColor,
      bodyFont: cs.fontFamily,
      textLength: (document.body.innerText || '').length,
      textSample: (document.body.innerText || '').slice(0, 400),
      layout: {
        sidebar: rect('[data-testid="sidebar"], aside, .sidebar'),
        dock: rect('[data-testid="dock"], .dock'),
      },
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('textarea, input').length,
      kitNodes: document.querySelectorAll('[class*="chdsh-"]').length,
      kitPanels: document.querySelectorAll('.chdsh-panel').length,
    };
  })()`;
  try {
    const result = await mainWindow.webContents.executeJavaScript(script);
    console.log(`[chatdsh] selftest ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`[chatdsh] selftest error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 跑一遍启动五阶段：身份、运行时、界面。 */
async function boot() {
  splashPhase('instance', 'active');
  // 单实例锁在上层用 requestSingleInstanceLock 承担，这里记录数据根已就绪。
  splashPhase('instance', 'done', config.profile);
  splashPhase('runtime', 'active');
  try {
    const started = await state.launcher.start();
    state.bootUrl = started.bootUrl;
    state.origin = started.origin;
    // 固定前缀行：便于脚本与排障时从日志里拿到运行时代 理地址。
    console.log(`[chatdsh] runtime ready: ${started.origin}`);
    splashPhase('runtime', 'done', started.origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.failure = message;
    console.log(`[chatdsh] failure: ${message}`);
    splashPhase('runtime', 'failed');
    splashFail(`运行时启动失败：\n${message}`);
    broadcastStatus();
    if (process.env.CHATDSH_EXIT_AFTER_CAPTURE === '1') {
      await new Promise((settle) => setTimeout(settle, 1500));
      await capture(splashWindow, 'splash-failed');
      console.log('[chatdsh] exiting after failure');
      state.quitting = true;
      app.quit();
    }
    return;
  }
  splashPhase('ui', 'active');
  await showMainWindow();
  console.log('[chatdsh] window shown');
  splashPhase('ui', 'done');
  broadcastStatus();
  // 真机取证：等界面首屏稳定后截图；用于自动验收时随后退出。
  if (captureDir !== undefined) {
    await new Promise((settle) => setTimeout(settle, 4000));
    await capture(mainWindow, 'main-window');
    console.log('[chatdsh] capture complete');
  }
  if (process.env.CHATDSH_ONBOARD === '1') {
    await runOnboarding();
    await new Promise((settle) => setTimeout(settle, 2000));
  }
  if (process.env.CHATDSH_DUMP === '1') {
    await new Promise((settle) => setTimeout(settle, 3000));
    const script = `(() => {
      const buttons = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean);
      const clickables = [...document.querySelectorAll('[role="button"], a, [data-testid]')].map((b) => (b.textContent || '').trim()).filter((t) => t && t.length < 40).slice(0, 40);
      return { buttons, clickables };
    })()`;
    try {
      const r = await mainWindow.webContents.executeJavaScript(script);
      console.log(`[chatdsh] dump ${JSON.stringify(r)}`);
    } catch (e) { console.log('[chatdsh] dump error ' + e.message); }
  }
  if (process.env.CHATDSH_SELFTEST === '1') {
    await new Promise((settle) => setTimeout(settle, 3000));
    await runSelfTest();
  }
  if (process.env.CHATDSH_EXIT_AFTER_CAPTURE === '1') {
    console.log('[chatdsh] exiting after capture');
    state.quitting = true;
    app.quit();
  }
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 340,
    resizable: false,
    frame: false,
    show: false,
    backgroundColor: '#0e0e10',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWindow.once('ready-to-show', () => splashWindow.show());
  void splashWindow.loadFile(SPLASH);
}

// 单实例：第二次启动把已有窗口提到前台。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { void showMainWindow(); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    createSplash();
    createTray();
    applyPowerPolicy();
    ipcMain.handle('chatdsh:keepalive:get', () => statusSnapshot());
    ipcMain.handle('chatdsh:keepalive:set', (_event, enabled) => setKeepAlive({ preventSleep: enabled === true }));
    ipcMain.on('chatdsh:window:minimize', () => mainWindow?.minimize());
    ipcMain.on('chatdsh:window:toggle-maximize', () => {
      if (mainWindow === undefined || mainWindow.isDestroyed()) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });
    ipcMain.on('chatdsh:window:close', () => mainWindow?.close());
    await boot();
  });
  app.on('window-all-closed', () => {
    // 托盘常驻时不因窗口全关而退出。
    if (state.keepAlive.tray !== true) app.quit();
  });
  app.on('before-quit', async () => {
    state.quitting = true;
    if (state.powerBlockerId !== undefined && powerSaveBlocker.isStarted(state.powerBlockerId)) {
      powerSaveBlocker.stop(state.powerBlockerId);
      state.powerBlockerId = undefined;
    }
    await state.launcher.stop();
  });
}
