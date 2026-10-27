/**
 * ChatDSH 桌面壳主进程。
 *
 * 负责四件事：取单实例锁；用启动页按启动五阶段逐步报进度；拉起控制平面并由它拉起运行时，
 * 把窗口指向控制平面；提供托盘、关闭到托盘、保活与强制不休眠。控制平面进程的编排在
 * `gateway-launch.mjs`，页面的最小桥在 `preload.cjs`。
 * @module chatdsh-desktop-shell/main
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, powerSaveBlocker, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayLauncher } from './gateway-launch.mjs';
import { setTelemetryOrigin, startSpan } from './telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPLASH = join(HERE, 'splash.html');
const PRELOAD = join(HERE, 'preload.cjs');
const SPLASH_PRELOAD = join(HERE, 'splash-preload.cjs');
/**
 * 解析 dsh 的启动入口。
 *
 * 打包后优先用随包携带的 `@deepseek-ai/dsh` 入口（`resources/app/dsh/lib/bin.js`）；
 * 开发态用环境变量 `CHATDSH_DSH_BIN`，都没有时回退到 PATH 上的 `dsh`。
 */
function resolveDshBin() {
  const bundled = join(process.resourcesPath ?? '', 'app', 'dsh', 'lib', 'bin.js');
  if (process.env.CHATDSH_DSH_BIN !== undefined) return process.env.CHATDSH_DSH_BIN;
  if (existsSync(bundled)) return bundled;
  return 'dsh';
}

/**
 * 解析控制平面的启动入口。
 *
 * 打包后它在 profile 的依赖目录里，这样控制平面对 `@chatdsh/*` 的依赖与运行时共用同一份；
 * 开发态取仓库里的 `gateway/lib/main.js`。
 */
function resolveGatewayBin(profile) {
  if (process.env.CHATDSH_GATEWAY_BIN !== undefined) return process.env.CHATDSH_GATEWAY_BIN;
  const bundled = join(process.resourcesPath ?? '', 'app', 'dsh', 'profiles', profile, 'node_modules', '@chatdsh', 'gateway', 'lib', 'main.js');
  if (existsSync(bundled)) return bundled;
  const development = join(HERE, '..', '..', 'gateway', 'lib', 'main.js');
  if (existsSync(development)) return development;
  throw new Error('找不到控制平面入口；设置 CHATDSH_GATEWAY_BIN 指向 gateway/lib/main.js');
}

/** 运行时与数据根来自环境变量，未给时落到 userData 下的固定位置。 */
function resolveConfig() {
  const userData = app.getPath('userData');
  const profile = process.env.CHATDSH_PROFILE ?? 'chatdsh-desktop';
  return {
    userData,
    launchRoot: process.env.CHATDSH_LAUNCH_ROOT ?? join(userData, 'launch-root'),
    dshHome: process.env.CHATDSH_DSH_HOME ?? join(userData, 'harness'),
    profile,
    port: process.env.CHATDSH_PORT === undefined ? undefined : Number.parseInt(process.env.CHATDSH_PORT, 10),
    dshBin: resolveDshBin(),
    gatewayBin: resolveGatewayBin(profile),
    bootstrapSecret: randomBytes(24).toString('hex'),
    cwd: process.env.CHATDSH_CWD ?? userData,
    keepAliveFile: join(userData, 'keepalive.json'),
  };
}

const config = resolveConfig();

/** 桌面壳日志目录与本次启动的日志文件。 */
const LOG_DIR = join(config.userData, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, `desktop-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

/** 只保留最近 20 份桌面壳日志。 */
function pruneLogs() {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((name) => name.startsWith('desktop-') && name.endsWith('.log'))
      .map((name) => ({ name, mtime: statSync(join(LOG_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(20)) unlinkSync(join(LOG_DIR, file.name));
  } catch {
    // 日志清理失败不能阻断启动。
  }
}
pruneLogs();

/**
 * 写一行桌面壳日志：同时输出到控制台与本次日志文件。
 * @param {string} message - 日志正文。
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // 日志目录不可写时只保留控制台输出。
  }
}

/**
 * 把随包携带的 profile 接进可写的数据根。
 *
 * 打包后的 profile 位于 `resources/app/dsh/profiles/<profile>`，只有留在 dsh 安装目录
 * 内部时，自建插件对 `@deepseek-ai/*` 的 peer 依赖才能沿目录向上解析到随包的 DSH 依赖。
 * 数据根里的 `profiles/<profile>` 因此建一条目录联接，而不是复制一份 profile。
 * 解包运行或开发态没有随包 profile 时保持原状。
 * @param current - 启动配置。
 */
function prepareBundledProfile(current) {
  const bundled = join(process.resourcesPath ?? '', 'app', 'dsh', 'profiles', current.profile);
  if (!existsSync(bundled)) return;
  const profiles = join(current.dshHome, 'profiles');
  const link = join(profiles, current.profile);
  mkdirSync(profiles, { recursive: true });
  try {
    // 便携版每次启动会解压到新的临时目录，旧联接可能还在但已指向不存在的路径；
    // 只有目标一致的联接可以直接复用，其余联接删掉重建。真实目录一律保留。
    if (readlinkSync(link) === bundled) return;
    rmSync(link, { recursive: true, force: true });
  } catch {
    if (existsSync(link)) return;
  }
  // Windows 上目录符号链接需要管理员权限，目录联接不需要；两者都能让模块解析穿过链接。
  symlinkSync(bundled, link, process.platform === 'win32' ? 'junction' : 'dir');
  log(`[chatdsh] bundled profile ready: ${link}`);
}

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

/** 控制平面状态与窗口句柄。 */
const state = {
  keepAlive: loadKeepAlive(),
  powerBlockerId: undefined,
  gateway: new GatewayLauncher({
    bin: config.gatewayBin,
    launchRoot: config.launchRoot,
    dshHome: config.dshHome,
    dshBin: config.dshBin,
    profile: config.profile,
    cwd: config.cwd,
    port: config.port,
    bootstrapSecret: config.bootstrapSecret,
    onLog: (line) => {
      lastRuntimeLine = line;
      splashLog(line);
      log(`[runtime] ${line}`);
    },
  }),
  bootUrl: undefined,
  origin: undefined,
  quitting: false,
  failure: undefined,
};

let splashWindow;
let mainWindow;
let tray;
const splashPhases = new Map();
const splashLogs = [];
let splashFailure;
let splashFailurePath = '';
let lastRuntimeLine = '';
let runtimeStartedAt = 0;

/** 可选截图目录：给了就在每个阶段落一张 PNG，便于真机取证。 */
const captureDir = process.env.CHATDSH_CAPTURE_DIR;

/** 把一张窗口内容写成 PNG；失败只在控制台提示，不影响启动。 */
async function capture(window, name) {
  if (captureDir === undefined || window === undefined || window.isDestroyed()) return;
  try {
    const image = await window.webContents.capturePage();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(captureDir, `${name}.png`), image.toPNG());
    log(`[chatdsh] capture ${name}.png`);
  } catch (error) {
    log(`[chatdsh] capture ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 启动各阶段进行中的 span。 */
const startupSpans = new Map();

/** 在启动页里执行一段脚本；页面未就绪时静默跳过，就绪后会补发快照。 */
function splashExec(script) {
  if (splashWindow === undefined || splashWindow.isDestroyed()) return;
  void splashWindow.webContents.executeJavaScript(script).catch(() => undefined);
}

/** 更新启动页里的阶段状态与明细。 */
function splashPhase(phase, status, detail) {
  splashPhases.set(phase, { status, detail });
  log(`[chatdsh] phase ${phase} ${status}${detail ? ` ${detail}` : ''}`);
  if (status === 'active') {
    startupSpans.set(phase, startSpan(`chatdsh.desktop.startup.${phase}`));
  } else {
    const finish = startupSpans.get(phase);
    if (finish !== undefined) {
      startupSpans.delete(phase);
      finish(status === 'failed' ? 'failed' : 'ok', { stage: phase });
    }
  }
  splashExec(`window.__chatdshSplash?.phase(${JSON.stringify(phase)}, ${JSON.stringify(status)}, ${JSON.stringify(detail ?? '')})`);
  if (status !== 'active') void capture(splashWindow, `phase-${phase}-${status}`);
}

/** 只更新一个阶段的进度明细，不改变阶段状态。 */
function splashDetail(phase, detail) {
  const current = splashPhases.get(phase);
  if (current !== undefined) current.detail = detail;
  splashExec(`window.__chatdshSplash?.detail(${JSON.stringify(phase)}, ${JSON.stringify(String(detail))})`);
}

/** 把运行时输出追加到启动页的日志面板，保留最近 8 行。 */
function splashLog(line) {
  splashLogs.push(String(line));
  if (splashLogs.length > 8) splashLogs.shift();
  splashExec(`window.__chatdshSplash?.log(${JSON.stringify(String(line))})`);
}

/** 显示启动失败原因，并附上本次日志路径。 */
function splashFail(message, logPath) {
  splashFailure = String(message);
  splashFailurePath = logPath === undefined ? '' : String(logPath);
  splashExec(`window.__chatdshSplash?.fail(${JSON.stringify(splashFailure)}, ${JSON.stringify(splashFailurePath)})`);
}

/** 启动页完成加载后，补发之前积压的阶段、日志与失败信息。 */
function applySplashSnapshot() {
  for (const [phase, value] of splashPhases) {
    splashExec(`window.__chatdshSplash?.phase(${JSON.stringify(phase)}, ${JSON.stringify(value.status)}, ${JSON.stringify(value.detail ?? '')})`);
  }
  for (const line of splashLogs) splashExec(`window.__chatdshSplash?.log(${JSON.stringify(line)})`);
  if (splashFailure !== undefined) splashExec(`window.__chatdshSplash?.fail(${JSON.stringify(splashFailure)}, ${JSON.stringify(splashFailurePath)})`);
}

/** 运行时等待进度：已等待秒数加上最后一行运行时输出。 */
function runtimeDetail() {
  const seconds = runtimeStartedAt === 0 ? 0 : Math.max(0, Math.floor((Date.now() - runtimeStartedAt) / 1000));
  const tail = lastRuntimeLine === '' ? '' : ` · ${lastRuntimeLine}`;
  return `已等待 ${seconds}s${tail}`.slice(0, 140);
}

/** 依据保活设置驱动系统电源策略。 */
function applyPowerPolicy() {
  const enabled = state.keepAlive.preventSleep === true;
  const finish = startSpan('chatdsh.desktop.power.block');
  if (enabled && state.powerBlockerId === undefined) {
    const type = state.keepAlive.mode === 'prevent-app-suspension' ? 'prevent-app-suspension' : 'prevent-display-sleep';
    state.powerBlockerId = powerSaveBlocker.start(type);
  } else if (!enabled && state.powerBlockerId !== undefined) {
    if (powerSaveBlocker.isStarted(state.powerBlockerId)) powerSaveBlocker.stop(state.powerBlockerId);
    state.powerBlockerId = undefined;
  }
  finish('ok', { 'power.mode': state.keepAlive.mode ?? 'none', action: enabled ? 'acquire' : 'release' });
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
    { label: '打开本次启动日志', click: () => { void shell.openPath(LOG_FILE); } },
    { label: '打开日志目录', click: () => { void shell.openPath(LOG_DIR); } },
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
    log(`[chatdsh] tray unavailable: ${error instanceof Error ? error.message : String(error)}`);
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
      log('[chatdsh] onboard: reached main ui');
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
    log(`[chatdsh] onboard click "${target}" ${ok ? 'ok' : 'miss'} buttons=${JSON.stringify(probe.buttons)}`);
    await new Promise((settle) => setTimeout(settle, 2500));
  }
  log('[chatdsh] onboard: gave up before main ui');
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
    log('[chatdsh] selftest skipped: no window');
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
    log(`[chatdsh] selftest ${JSON.stringify(result)}`);
  } catch (error) {
    log(`[chatdsh] selftest error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 跑一遍启动五阶段：身份、运行时、界面。 */
async function boot() {
  splashPhase('instance', 'active');
  // 单实例锁在上层用 requestSingleInstanceLock 承担，这里记录数据根已就绪。
  splashPhase('instance', 'done', config.profile);
  splashPhase('runtime', 'active');
  runtimeStartedAt = Date.now();
  lastRuntimeLine = '';
  const progressTimer = setInterval(() => splashDetail('runtime', runtimeDetail()), 1000);
  const orchestrate = startSpan('chatdsh.desktop.runtime.orchestrate');
  try {
    prepareBundledProfile(config);
    const started = await state.gateway.start();
    state.origin = started.gatewayUrl;
    state.bootUrl = `${started.gatewayUrl}${started.bootPath}`;
    setTelemetryOrigin(started.gatewayUrl);
    orchestrate('ok', { 'runtime.id': started.gatewayUrl });
    // 固定前缀行：窗口地址是控制平面地址，运行时由控制平面反代。
    log(`[chatdsh] runtime ready: ${started.gatewayUrl} (port ${started.gatewayPort}, runtime ${started.runtimePort})`);
    splashDetail('runtime', `控制平面 ${started.gatewayPort} · 运行时 ${started.runtimePort}`);
    splashPhase('runtime', 'done', started.gatewayUrl);
  } catch (error) {
    orchestrate('failed');
    const message = error instanceof Error ? error.message : String(error);
    state.failure = message;
    log(`[chatdsh] failure: ${message}`);
    splashPhase('runtime', 'failed');
    const brief = message.length > 1800 ? `${message.slice(0, 1800)}\n…（完整内容见日志文件）` : message;
    splashFail(`实例启动失败：\n${brief}`, LOG_FILE);
    broadcastStatus();
    if (process.env.CHATDSH_EXIT_AFTER_CAPTURE === '1') {
      await new Promise((settle) => setTimeout(settle, 1500));
      await capture(splashWindow, 'splash-failed');
      log('[chatdsh] exiting after failure');
      state.quitting = true;
      app.quit();
    }
    return;
  } finally {
    clearInterval(progressTimer);
  }
  splashPhase('ui', 'active');
  await showMainWindow();
  log('[chatdsh] window shown');
  splashPhase('ui', 'done');
  broadcastStatus();
  // 真机取证：等界面首屏稳定后截图；用于自动验收时随后退出。
  if (captureDir !== undefined) {
    await new Promise((settle) => setTimeout(settle, 4000));
    await capture(mainWindow, 'main-window');
    log('[chatdsh] capture complete');
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
      log(`[chatdsh] dump ${JSON.stringify(r)}`);
    } catch (e) { log('[chatdsh] dump error ' + e.message); }
  }
  if (process.env.CHATDSH_SELFTEST === '1') {
    await new Promise((settle) => setTimeout(settle, 3000));
    await runSelfTest();
  }
  if (process.env.CHATDSH_EXIT_AFTER_CAPTURE === '1') {
    log('[chatdsh] exiting after capture');
    state.quitting = true;
    app.quit();
  }
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 560,
    height: 620,
    resizable: false,
    frame: false,
    show: false,
    backgroundColor: '#0e0e10',
    webPreferences: { preload: SPLASH_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWindow.once('ready-to-show', () => splashWindow.show());
  splashWindow.webContents.once('did-finish-load', applySplashSnapshot);
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
    log(`[chatdsh] starting ${app.getVersion()} profile=${config.profile} bin=${config.dshBin}`);
    log(`[chatdsh] log file: ${LOG_FILE}`);
    createSplash();
    createTray();
    applyPowerPolicy();
    ipcMain.handle('chatdsh:keepalive:get', () => statusSnapshot());
    ipcMain.handle('chatdsh:keepalive:set', (_event, enabled) => setKeepAlive({ preventSleep: enabled === true }));
    ipcMain.handle('chatdsh:logs:open', () => shell.openPath(LOG_FILE));
    ipcMain.handle('chatdsh:logs:dir', () => shell.openPath(LOG_DIR));
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
    await state.gateway.stop();
  });
}
