/**
 * ChatDSH 桌面壳主进程。
 *
 * 负责这些事：取单实例锁；用启动页按启动五阶段逐步报进度；拉起控制平面并由它拉起运行时，
 * 把窗口指向控制平面；提供应用菜单、托盘、关闭到托盘、窗口位置恢复、原生目录与外部打开、
 * 系统通知、电源阻止、开机启动、更新校验、启动恢复与安全模式；全部 IPC 走白名单分发。
 * 控制平面进程的编排在 `gateway-launch.mjs`，页面的最小桥在 `preload.cjs`，恢复页的桥在
 * `recovery-preload.cjs`。
 * @module chatdsh-desktop-shell/main
 */

import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, powerSaveBlocker, screen, shell, systemPreferences } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GatewayLauncher } from './gateway-launch.mjs';
import { CALL_CHANNELS, createIpcRouter } from './ipc.mjs';
import { loginItemSettings, loginSupport, describeLoginFailure } from './login-item.mjs';
import { MENU_ACTIONS, MENU_ACTION_IDS, assertUniqueAccelerators, buildAppMenuTemplate, quitDecision, toElectronTemplate } from './menu.mjs';
import { assertClipboardText, assertDirectoryChoice, classifyOpenTarget, directoryPickerOptions, NativeRejection } from './native.mjs';
import { assertNotificationRequest, describeNotificationFailure, notificationCapability, routeToUrl } from './notifications.mjs';
import { POWER_MODES, describePowerState, powerPlan } from './power.mjs';
import { EVENTS, METRICS, SPANS, beginSpan, noteCount, noteFailure, noteGauge } from './signals.mjs';
import {
  buildFailureRecord, clearFailureRecord, enterSafeMode, exitSafeMode, readCrashes, readFailureRecord,
  readSafeMode, recordCrash, recoveryChoices, safeModeEnv, safeModeNotice, writeDiagnostics, writeFailureRecord,
} from './startup-recovery.mjs';
import { noteEvent, setTelemetryOrigin } from './telemetry.mjs';
import { trayBitmap, trayMenu, trayStateOf, trayTooltip, windowCloseAction } from './tray.mjs';
import { createUpdateService, installGate, loadUpdateSource, updatePresentation, UpdateError } from './updates.mjs';
import { captureWindowState, restoreWindowState, writeWindowState } from './window-state.mjs';
import { createWindowHandlers, mergeWindowChannels } from './windows/ipc.mjs';
import { createWindowDescriptor, WindowRegistry, cascadedBounds, windowTitleOf } from './windows/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPLASH = join(HERE, 'splash.html');
const PRELOAD = join(HERE, 'preload.cjs');
const SPLASH_PRELOAD = join(HERE, 'splash-preload.cjs');
const RECOVERY = join(HERE, 'recovery.html');
const RECOVERY_PRELOAD = join(HERE, 'recovery-preload.cjs');

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
    windowStateFile: join(userData, 'window-state.json'),
    windowSessionFile: join(userData, 'window-session.json'),
    updateSourceFile: join(userData, 'update-source.json'),
    updateDirectory: join(userData, 'updates'),
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
 * @param message - 日志正文。
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
  let stored;
  try {
    stored = JSON.parse(readFileSync(config.keepAliveFile, 'utf8'));
  } catch {
    return defaults;
  }
  return {
    tray: stored.tray === undefined ? defaults.tray : stored.tray === true,
    launchAtLogin: stored.launchAtLogin === true,
    preventSleep: stored.preventSleep === true,
    mode: POWER_MODES.includes(stored.mode) ? stored.mode : defaults.mode,
  };
}

function saveKeepAlive(state) {
  mkdirSync(dirname(config.keepAliveFile), { recursive: true });
  writeFileSync(config.keepAliveFile, JSON.stringify(state, null, 2));
}

/** 从界面与菜单上报的活动状态。 */
const activity = {
  runningTurns: 0,
  pendingApprovals: 0,
  drafts: 0,
  recentSessions: 0,
  hasSession: false,
  sourceDeviceOnline: false,
  paused: false,
  workspace: undefined,
};

/** 允许原生打开的文件根目录。 */
const fileRoots = [config.userData, config.dshHome, LOG_DIR, config.updateDirectory];

/** 控制平面状态与窗口句柄。 */
const state = {
  keepAlive: loadKeepAlive(),
  powerBlockerId: undefined,
  powerFailure: undefined,
  loginError: undefined,
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
  failureRecord: undefined,
  safeMode: undefined,
  startedAt: Date.now(),
};

let splashWindow;
let mainWindow;
let recoveryWindow;
let tray;
let trayState;
let menuSignature = '';
let windowSaveTimer;
/** 第二窗口登记表：主窗口与全部第二窗口都在这里登记，关闭时摘下。 */
const windowRegistry = new WindowRegistry();
/** 第二窗口标识到 BrowserWindow 的映射。 */
const secondaryWindows = new Map();
/** 第二窗口的关闭动作由托盘与主窗口关闭流程共用同一份判定。 */
let windowSessionSaveTimer;
const splashPhases = new Map();
const splashLogs = [];
let splashFailure;
let splashFailurePath = '';
let lastRuntimeLine = '';
let runtimeStartedAt = 0;

/** 主窗口来源集合：启动后加入控制平面地址。 */
const allowedOrigins = new Set();
/** 本地页面精确地址：启动页与恢复页。 */
const allowedFiles = new Set([pathToFileURL(SPLASH).href, pathToFileURL(RECOVERY).href]);

/** 更新服务：按需创建。 */
let updateService;
let updateConfigurationError;

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
    startupSpans.set(phase, { finish: beginSpan(`${SPANS.startup}${phase}`), startedAt: Date.now() });
  } else {
    const running = startupSpans.get(phase);
    if (running !== undefined) {
      startupSpans.delete(phase);
      running.finish(status === 'failed' ? 'failed' : 'ok', { stage: phase });
      noteGauge(METRICS.startupSeconds, (Date.now() - running.startedAt) / 1000, { stage: phase });
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
  const plan = powerPlan({
    enabled: state.keepAlive.preventSleep === true,
    mode: state.keepAlive.mode,
    active: state.powerBlockerId !== undefined,
  });
  const finish = beginSpan(SPANS.powerBlock);
  let outcome = 'ok';
  if (plan.action === 'start') {
    try {
      state.powerBlockerId = powerSaveBlocker.start(plan.type);
      if (!powerSaveBlocker.isStarted(state.powerBlockerId)) {
        state.powerBlockerId = undefined;
        state.powerFailure = 'blocker-unavailable';
      } else {
        state.powerFailure = undefined;
      }
    } catch (error) {
      state.powerBlockerId = undefined;
      state.powerFailure = 'blocker-refused';
      log(`[chatdsh] power blocker failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (plan.action === 'stop') {
    if (powerSaveBlocker.isStarted(state.powerBlockerId)) powerSaveBlocker.stop(state.powerBlockerId);
    state.powerBlockerId = undefined;
    state.powerFailure = undefined;
  }
  if (state.powerFailure !== undefined) {
    outcome = 'failed';
    noteFailure(EVENTS.powerFailed, 'power', state.powerFailure, { 'power.mode': plan.type });
  }
  finish(outcome, { 'power.mode': plan.type, action: plan.action });
  noteGauge(METRICS.powerBlockers, state.powerBlockerId === undefined ? 0 : 1, { 'power.mode': plan.type });
  broadcastStatus();
}

/** 电源状态快照。 */
function powerSnapshot() {
  return {
    enabled: state.keepAlive.preventSleep === true,
    mode: state.keepAlive.mode,
    active: state.powerBlockerId !== undefined && powerSaveBlocker.isStarted(state.powerBlockerId),
    failureCode: state.powerFailure,
    detail: describePowerState({
      enabled: state.keepAlive.preventSleep === true,
      mode: state.keepAlive.mode,
      active: state.powerBlockerId !== undefined && powerSaveBlocker.isStarted(state.powerBlockerId),
      failureCode: state.powerFailure,
      platform: process.platform,
    }),
  };
}

/** 开机启动状态快照。 */
function loginSnapshot() {
  const support = loginSupport(process.platform);
  let enabled = false;
  if (support.supported) {
    try {
      enabled = app.getLoginItemSettings().openAtLogin === true;
    } catch (error) {
      state.loginError = 'settings-write-failed';
      log(`[chatdsh] login item read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    supported: support.supported,
    hint: support.hint,
    enabled,
    requested: state.keepAlive.launchAtLogin === true,
    errorCode: state.loginError,
    detail: state.loginError === undefined ? '' : describeLoginFailure(state.loginError),
  };
}

/** 设置开机启动，失败时保留原因供设置页显示。 */
function setLoginItem(enabled) {
  const support = loginSupport(process.platform);
  if (!support.supported) {
    state.loginError = 'platform-unsupported';
    noteFailure(EVENTS.loginFailed, 'login', 'platform-unsupported');
    noteCount(METRICS.actions, { action: 'login.set', outcome: 'unsupported' });
    broadcastStatus();
    return loginSnapshot();
  }
  const settings = loginItemSettings({ enabled, platform: process.platform, executablePath: process.execPath });
  try {
    app.setLoginItemSettings(settings);
    const applied = app.getLoginItemSettings().openAtLogin === true;
    state.loginError = applied === enabled ? undefined : 'status-mismatch';
  } catch (error) {
    state.loginError = 'settings-write-failed';
    log(`[chatdsh] login item write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  state.keepAlive = { ...state.keepAlive, launchAtLogin: enabled };
  saveKeepAlive(state.keepAlive);
  if (state.loginError !== undefined) {
    noteFailure(EVENTS.loginFailed, 'login', state.loginError);
    noteCount(METRICS.actions, { action: 'login.set', outcome: 'failed' });
  } else {
    noteCount(METRICS.actions, { action: 'login.set', outcome: 'ok' });
  }
  broadcastStatus();
  return loginSnapshot();
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
    power: powerSnapshot(),
    login: loginSnapshot(),
    failure: state.failure,
    activity: { ...activity },
    safeMode: state.safeMode === undefined ? { active: false } : {
      active: true,
      notice: safeModeNotice(state.safeMode),
      disabledExtensions: state.safeMode.disabledExtensions,
      reason: state.safeMode.reason,
    },
    update: updatePresentation(updateService?.state() ?? { status: 'idle' }, app.getVersion()),
    window: { maximized: mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isMaximized() },
  };
}

function broadcastStatus() {
  const snapshot = statusSnapshot();
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chatdsh:status', snapshot);
  }
  updateTray(snapshot);
}

/** 更新状态广播。 */
function broadcastUpdate() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  const service = updateService;
  if (service === undefined) return;
  mainWindow.webContents.send('chatdsh:update:changed', updatePresentation(service.state(), app.getVersion()));
}

/** 更新状态快照，供页面初始化读取。 */
function updateSnapshot() {
  const service = updateService;
  if (service === undefined) {
    return {
      ...updatePresentation({ status: 'idle' }, app.getVersion()),
      configured: false,
      configurationError: updateConfigurationError,
      channel: undefined,
      progress: undefined,
      notes: '',
    };
  }
  const detailed = service.state();
  return {
    ...updatePresentation(detailed, app.getVersion()),
    configured: detailed.configured,
    configurationError: updateConfigurationError,
    channel: detailed.channel,
    version: detailed.version,
    progress: detailed.progress,
    error: detailed.error,
    stagedPath: detailed.stagedPath,
    rollback: detailed.rollback,
  };
}

/** 打开主窗口并加载已就绪的运行时地址。 */
async function showMainWindow() {
  if (state.bootUrl === undefined) return;
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    const restored = restoreWindowState({ file: config.windowStateFile, displays: screen.getAllDisplays() });
    const finish = beginSpan(SPANS.windowRestore);
    finish('ok', {
      adjustment: restored.adjustments.length === 0 ? 'none' : restored.adjustments.join(','),
      'display.count': restored.displayCount,
      source: restored.source,
    });
    mainWindow = new BrowserWindow({
      x: restored.bounds.x,
      y: restored.bounds.y,
      width: restored.bounds.width,
      height: restored.bounds.height,
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
    if (restored.maximized) mainWindow.maximize();
    mainWindow.once('ready-to-show', () => mainWindow.show());
    guardNavigation(mainWindow);
    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
      mainWindow.on(event, () => scheduleWindowStateSave());
    }
    mainWindow.on('close', (event) => {
      const action = windowCloseAction({ quitting: state.quitting, trayEnabled: state.keepAlive.tray === true });
      if (action === 'hide') {
        event.preventDefault();
        mainWindow.hide();
        return;
      }
      if (state.quitting !== true) {
        const decision = quitDecision(activity);
        if (decision.needsConfirm) {
          event.preventDefault();
          void requestQuit('window-close');
        }
      }
    });
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
    log(`[chatdsh] window restored ${JSON.stringify(restored.bounds)} adjustments=${restored.adjustments.join(',') || 'none'} source=${restored.source}`);
  }
  await mainWindow.loadURL(state.bootUrl);
  mainWindow.show();
  if (splashWindow !== undefined && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = undefined;
}

/** 延迟保存窗口状态，避免拖动过程中频繁写盘。 */
function scheduleWindowStateSave() {
  if (windowSaveTimer !== undefined) clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => {
    windowSaveTimer = undefined;
    if (mainWindow === undefined || mainWindow.isDestroyed()) return;
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    writeWindowState(config.windowStateFile, captureWindowState(mainWindow, display.id));
  }, 400);
}

/** 窗口状态快照。 */
function windowStateSnapshot() {  if (mainWindow === undefined || mainWindow.isDestroyed()) return { restored: false };
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    restored: true,
    bounds,
    maximized: mainWindow.isMaximized(),
    displayId: display.id,
    displayCount: screen.getAllDisplays().length,
    file: config.windowStateFile,
  };
}

/** 读回第二窗口会话文件；文件缺失或内容不可解析时按空会话处理。 */
function readWindowSession() {
  if (!existsSync(config.windowSessionFile)) return { version: 1, windows: [] };
  try {
    return JSON.parse(readFileSync(config.windowSessionFile, 'utf8'));
  } catch (error) {
    log(`[chatdsh] window session unreadable: ${error instanceof Error ? error.message : String(error)}`);
    noteCount(METRICS.actions, { action: 'window.session-read', outcome: 'failed' });
    return { version: 1, windows: [] };
  }
}

/** 延迟保存第二窗口会话，避免拖动过程中频繁写盘。 */
function scheduleWindowSessionSave() {
  if (windowSessionSaveTimer !== undefined) clearTimeout(windowSessionSaveTimer);
  windowSessionSaveTimer = setTimeout(() => {
    windowSessionSaveTimer = undefined;
    writeFileSync(config.windowSessionFile, JSON.stringify(windowRegistry.snapshot(), null, 2), { mode: 0o600 });
  }, 400);
}

/**
 * 打开一个第二窗口。
 * @param {object} descriptor - 窗口登记。
 * @returns {Promise<string>} 窗口标识。
 */
async function openSecondaryWindow(descriptor) {
  if (state.bootUrl === undefined) throw new Error('运行时地址还没有就绪');
  const display = screen.getPrimaryDisplay();
  const base = mainWindow !== undefined && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : display.workArea;
  const bounds = cascadedBounds(base, windowRegistry.nextIndex(), display.workArea);
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    backgroundColor: '#0e0e10',
    title: windowTitleOf(descriptor),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secondaryWindows.set(descriptor.id, window);
  guardNavigation(window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    secondaryWindows.delete(descriptor.id);
    windowRegistry.remove(descriptor.id);
    scheduleWindowSessionSave();
    broadcastStatus();
  });
  await window.loadURL(routeToUrl(descriptor.route, state.bootUrl));
  window.show();
  scheduleWindowSessionSave();
  broadcastStatus();
  return descriptor.id;
}

/** 聚焦一个第二窗口。 */
function focusSecondaryWindow(windowId) {
  const window = secondaryWindows.get(windowId);
  if (window === undefined || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

/** 关闭一个第二窗口。 */
function closeSecondaryWindow(windowId) {
  const window = secondaryWindows.get(windowId);
  if (window === undefined || window.isDestroyed()) return;
  window.close();
}

/** 按存盘会话恢复第二窗口。 */
async function restoreSecondaryWindows() {
  if (state.bootUrl === undefined) return [];
  const snapshot = readWindowSession();
  const restored = [];
  for (const descriptor of snapshot.windows ?? []) {
    if (descriptor.kind !== 'secondary') continue;
    if (windowRegistry.get(descriptor.id) !== undefined) continue;
    try {
      const record = windowRegistry.add(createWindowDescriptor({
        id: descriptor.id,
        kind: 'secondary',
        route: descriptor.route,
        openedAt: descriptor.openedAt,
      }));
      await openSecondaryWindow(record);
      restored.push({ id: record.id, route: record.route });
    } catch (error) {
      noteFailure(EVENTS.ipcRejected, 'ipc', 'window-restore', { channel: 'chatdsh:window:restore', kind: 'invoke' });
      log(`[chatdsh] window restore skipped ${descriptor.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return restored;
}

/** 第二窗口的处理器表。 */
function secondaryWindowHandlers() {
  return createWindowHandlers({
    registry: windowRegistry,
    openWindow: openSecondaryWindow,
    focusWindow: focusSecondaryWindow,
    closeWindow: closeSecondaryWindow,
    restoreWindows: restoreSecondaryWindows,
  });
}

/** 判定地址是否指向本机服务。 */
function isLoopbackHttpUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 接管窗口内的导航与外开链接。
 * @param window - 浏览器窗口。
 */
function guardNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openTargetQuietly(url, 'window-open');
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isLoopbackHttpUrl(url)) return;
    event.preventDefault();
    openTargetQuietly(url, 'navigate');
  });
}

/**
 * 外部打开并吞掉拒绝结果：拒绝原因已经写进遥测与日志，页面不需要再处理。
 * @param raw - 原始目标。
 * @param reason - 触发来源。
 */
function openTargetQuietly(raw, reason) {
  void openTarget(raw, reason).catch(() => undefined);
}

/**
 * 外部打开一个目标：网络地址交给系统浏览器，文件路径交给系统默认程序。
 * @param raw - 原始目标。
 * @param reason - 触发来源，写进遥测属性。
 * @returns 打开结果。
 */
async function openTarget(raw, reason) {
  const finish = beginSpan(SPANS.nativeInvoke);
  try {
    const target = classifyOpenTarget(raw, fileRoots);
    if (target.kind === 'url') await shell.openExternal(target.value);
    else await shell.openPath(target.value);
    finish('ok', { action: `open-${target.kind}`, reason });
    noteCount(METRICS.actions, { action: `native.open-${target.kind}`, outcome: 'ok' });
    return { opened: true, kind: target.kind };
  } catch (error) {
    const code = error instanceof NativeRejection ? error.code : 'open-failed';
    finish('failed', { action: 'open', reason });
    noteFailure(EVENTS.nativeRejected, 'native', code, { action: 'open' });
    noteCount(METRICS.actions, { action: 'native.open', outcome: 'rejected' });
    log(`[chatdsh] open rejected: ${code}`);
    throw error;
  }
}

/** 托盘图标：按状态生成单色位图，避免依赖外部资源。 */
function trayImage(stateName) {
  const bitmap = trayBitmap(stateName);
  return nativeImage.createFromBitmap(bitmap.buffer, { width: bitmap.width, height: bitmap.height });
}

/** 把托盘菜单描述转成 Electron 模板。 */
function toTrayTemplate(items) {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' };
    const base = { label: item.label };
    if (item.enabled !== undefined) base.enabled = item.enabled;
    if (item.type !== undefined) base.type = item.type;
    if (item.action !== undefined) base.click = () => dispatchAction(item.action, 'tray');
    return base;
  });
}

/** 刷新托盘图标、提示与菜单。 */
function updateTray(snapshot) {
  if (tray === undefined) return;
  const next = trayStateOf({
    ready: snapshot.ready,
    runningTurns: snapshot.activity.runningTurns,
    pendingApprovals: snapshot.activity.pendingApprovals,
    failure: snapshot.failure,
  });
  if (next.state !== trayState) {
    trayState = next.state;
    tray.setImage(trayImage(next.state));
  }
  tray.setToolTip(trayTooltip({
    ready: snapshot.ready,
    workspace: snapshot.activity.workspace,
    pendingApprovals: snapshot.activity.pendingApprovals,
    runningTurns: snapshot.activity.runningTurns,
    failure: snapshot.failure,
  }));
  tray.setContextMenu(Menu.buildFromTemplate(toTrayTemplate(trayMenu({
    ready: snapshot.ready,
    workspace: snapshot.activity.workspace,
    pendingApprovals: snapshot.activity.pendingApprovals,
    recentSessions: snapshot.activity.recentSessions,
    preventSleep: snapshot.preventSleep,
    trayEnabled: snapshot.keepAlive,
    launchAtLogin: snapshot.login.requested,
    updateEnabled: updateService !== undefined,
  }))));
}

/** 创建托盘。 */
function createTray() {
  const initial = trayStateOf({ ready: false });
  trayState = initial.state;
  // 无图形会话（远程、无桌面环境）下系统托盘可能创建失败；不把它当成启动阻断条件。
  try {
    tray = new Tray(trayImage(initial.state));
    tray.on('click', () => { void showMainWindow(); });
    updateTray(statusSnapshot());
  } catch (error) {
    log(`[chatdsh] tray unavailable: ${error instanceof Error ? error.message : String(error)}`);
    tray = undefined;
  }
}

/** 更新保活设置并落盘。 */
function setKeepAlive(patch) {
  state.keepAlive = { ...state.keepAlive, ...patch };
  saveKeepAlive(state.keepAlive);
  applyPowerPolicy();
  syncMenu();
  return statusSnapshot();
}

/** 重新构建应用菜单；条件没有变化时跳过。 */
function syncMenu() {
  const next = JSON.stringify({
    platform: process.platform,
    sourceDeviceOnline: activity.sourceDeviceOnline,
    hasSession: activity.hasSession,
    paused: activity.paused,
    updateEnabled: updateService !== undefined,
  });
  if (next === menuSignature) return;
  menuSignature = next;
  const template = buildAppMenuTemplate({
    platform: process.platform,
    sourceDeviceOnline: activity.sourceDeviceOnline,
    hasSession: activity.hasSession,
    paused: activity.paused,
    updateEnabled: updateService !== undefined,
  });
  assertUniqueAccelerators(template);
  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectronTemplate(template, (action) => dispatchAction(action, 'menu'))));
}

/** 发送菜单动作给渲染进程。 */
function sendMenuAction(action) {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('chatdsh:menu:action', { action });
}

/** 托盘动作集合。 */
const TRAY_ACTION_IDS = new Set(['window.open', 'session.recent', 'power.toggle', 'login.toggle', 'tray.toggle']);

/**
 * 执行一个菜单或托盘动作。
 * @param action - 动作标识。
 * @param source - 触发来源：`menu` 或 `tray`。
 */
function dispatchAction(action, source) {
  const finish = beginSpan(source === 'tray' ? SPANS.trayInvoke : SPANS.menuInvoke);
  const known = MENU_ACTION_IDS.includes(action) || TRAY_ACTION_IDS.has(action);
  if (!known) {
    finish('failed', { action });
    noteFailure(EVENTS.menuRejected, 'menu-action', 'action-unknown', { action });
    noteCount(METRICS.actions, { action, outcome: 'rejected' });
    return;
  }
  noteCount(METRICS.actions, { action, outcome: 'ok' });
  finish('ok', { action });
  void performAction(action).catch((error) => {
    noteFailure(EVENTS.menuRejected, 'menu-action', 'action-failed', { action });
    log(`[chatdsh] action ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 动作的实际处理。 */
async function performAction(action) {
  switch (action) {
    case MENU_ACTIONS.appQuit:
      await requestQuit('menu');
      return;
    case MENU_ACTIONS.updateCheck:
      await checkUpdate(undefined);
      return;
    case MENU_ACTIONS.logsOpen:
      await shell.openPath(LOG_FILE);
      return;
    case MENU_ACTIONS.logsDir:
      await shell.openPath(LOG_DIR);
      return;
    case MENU_ACTIONS.diagnosticsExport:
      await exportDiagnostics();
      return;
    case 'power.toggle':
      setKeepAlive({ preventSleep: state.keepAlive.preventSleep !== true });
      return;
    case 'tray.toggle':
      setKeepAlive({ tray: state.keepAlive.tray !== true });
      return;
    case 'login.toggle':
      setLoginItem(state.keepAlive.launchAtLogin !== true);
      return;
    case 'window.open':
      await showMainWindow();
      return;
    default:
      sendMenuAction(action);
  }
}

/**
 * 退出应用；运行中的任务需要用户确认。
 * @param reason - 退出来源。
 */
async function requestQuit(reason) {
  if (state.quitting) return;
  const decision = quitDecision({
    runningTurns: activity.runningTurns,
    pendingApprovals: activity.pendingApprovals,
    updateDownloading: updateService?.state().status === 'downloading',
  });
  if (decision.needsConfirm) {
    const window = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const options = {
      type: 'warning',
      buttons: decision.buttons,
      defaultId: 1,
      cancelId: 1,
      message: decision.message,
      detail: decision.detail,
      noLink: true,
    };
    const result = window === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options);
    if (result.response !== 0) {
      noteCount(METRICS.actions, { action: 'app.quit', outcome: 'cancelled' });
      return;
    }
  }
  noteCount(METRICS.actions, { action: 'app.quit', outcome: 'ok' });
  log(`[chatdsh] quitting by ${reason}`);
  state.quitting = true;
  app.quit();
}

/** 显示系统通知；权限状态按系统结果如实报告。 */
async function showNotification(payload) {
  let request;
  try {
    request = assertNotificationRequest(payload);
  } catch (error) {
    noteCount(METRICS.actions, { action: 'notification.show', outcome: 'rejected' });
    throw error;
  }
  const permission = process.platform === 'darwin' && typeof systemPreferences.getNotificationSettings === 'function'
    ? systemPreferences.getNotificationSettings().authorizationStatus
    : undefined;
  const capability = notificationCapability({
    platform: process.platform,
    isSupported: Notification.isSupported(),
    permission,
  });
  if (capability.status !== 'granted') {
    noteEvent(EVENTS.notification, { kind: request.kind, outcome: capability.status });
    noteCount(METRICS.actions, { action: 'notification.show', outcome: capability.status });
    return {
      shown: false,
      status: capability.status,
      reason: capability.reason,
      detail: describeNotificationFailure(capability.reason),
    };
  }
  const notification = new Notification({
    title: request.title,
    body: request.body,
    silent: request.kind === 'turn-complete',
  });
  notification.on('click', () => {
    openBusinessRoute(request.route);
  });
  notification.show();
  noteEvent(EVENTS.notification, { kind: request.kind, outcome: 'shown' });
  noteCount(METRICS.actions, { action: 'notification.show', outcome: 'shown' });
  return { shown: true, status: 'granted' };
}

/**
 * 打开通知指向的业务页面。
 * @param route - 站内路径。
 */
function openBusinessRoute(route) {
  if (mainWindow === undefined || mainWindow.isDestroyed() || state.bootUrl === undefined) return;
  const url = routeToUrl(route, state.bootUrl);
  mainWindow.webContents.send('chatdsh:notification:click', { route });
  void mainWindow.loadURL(url);
}

/** 读取更新源；配置不合法时记录原因并禁用更新入口。 */
function ensureUpdateService() {
  if (updateService !== undefined) return updateService;
  if (updateConfigurationError !== undefined) throw new UpdateError(updateConfigurationError.code, updateConfigurationError.message);
  try {
    const source = loadUpdateSource({ file: config.updateSourceFile, env: process.env });
    if (source === undefined) throw new UpdateError('source-missing', '没有配置更新源');
    updateService = createUpdateService({
      source,
      appVersion: app.getVersion(),
      directory: config.updateDirectory,
    });
    syncMenu();
    return updateService;
  } catch (error) {
    updateConfigurationError = {
      code: error instanceof UpdateError ? error.code : 'source-invalid',
      message: error.message,
    };
    throw error;
  }
}

/** 检查更新。 */
async function checkUpdate(channel) {
  const finish = beginSpan(SPANS.updateCheck);
  try {
    const service = ensureUpdateService();
    const snapshot = await service.check();
    finish('ok', { channel: snapshot.channel ?? channel ?? 'stable' });
    broadcastUpdate();
    broadcastStatus();
    return { ok: true, state: updateSnapshot() };
  } catch (error) {
    const code = error instanceof UpdateError ? error.code : 'update-failed';
    finish('failed', { channel: channel ?? 'stable' });
    noteFailure(EVENTS.updateRejected, 'update', code, { stage: 'check' });
    noteCount(METRICS.updateFailures, { stage: 'check' });
    log(`[chatdsh] update check failed: ${code}`);
    broadcastUpdate();
    return { ok: false, code, message: error.message };
  }
}

/** 下载并校验更新包。 */
async function downloadUpdate() {
  try {
    const service = ensureUpdateService();
    await service.download();
    broadcastUpdate();
    return { ok: true, state: updateSnapshot() };
  } catch (error) {
    const code = error instanceof UpdateError ? error.code : 'update-failed';
    noteFailure(EVENTS.updateRejected, 'update', code, { stage: 'download' });
    noteCount(METRICS.updateFailures, { stage: 'download' });
    log(`[chatdsh] update download failed: ${code}`);
    broadcastUpdate();
    return { ok: false, code, message: error.message };
  }
}

/** 中断更新下载。 */
function cancelUpdate() {
  try {
    const service = ensureUpdateService();
    service.cancel();
    broadcastUpdate();
    return { ok: true, state: updateSnapshot() };
  } catch (error) {
    const code = error instanceof UpdateError ? error.code : 'update-failed';
    noteCount(METRICS.updateFailures, { stage: 'cancel' });
    return { ok: false, code, message: error.message };
  }
}

/** 安装更新：校验通过后才允许启动安装程序，运行中任务先确认。 */
async function installUpdate(confirmed) {
  if (confirmed !== true) {
    noteCount(METRICS.actions, { action: 'update.install', outcome: 'rejected' });
    return { ok: false, code: 'not-confirmed', message: '需要在界面里确认后再安装' };
  }
  const finish = beginSpan(SPANS.updateInstall);
  let service;
  try {
    service = ensureUpdateService();
  } catch (error) {
    finish('failed', { channel: 'unknown' });
    noteFailure(EVENTS.updateRejected, 'update', 'source-missing', { stage: 'install' });
    noteCount(METRICS.updateFailures, { stage: 'install' });
    return { ok: false, code: 'source-missing', message: error.message };
  }
  const preliminary = installGate({ state: service.state(), activity, confirmed: false });
  const window = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options = {
    type: preliminary.reasons.length === 0 ? 'question' : 'warning',
    buttons: ['安装并重启', '取消'],
    defaultId: preliminary.reasons.length === 0 ? 0 : 1,
    cancelId: 1,
    message: preliminary.reasons.length === 0 ? '安装更新并重启 ChatDSH' : '安装更新会中断正在进行的任务',
    detail: preliminary.message,
    noLink: true,
  };
  const answer = window === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options);
  if (answer.response !== 0) {
    noteCount(METRICS.actions, { action: 'update.install', outcome: 'cancelled' });
    finish('ok', { channel: service.state().channel ?? 'stable' });
    return { ok: false, code: 'cancelled' };
  }
  let plan;
  try {
    plan = service.install(activity, true);
  } catch (error) {
    const code = error instanceof UpdateError ? error.code : 'update-failed';
    noteFailure(EVENTS.updateRejected, 'update', code, { stage: 'install' });
    noteCount(METRICS.updateFailures, { stage: 'install' });
    finish('failed', { channel: service.state().channel ?? 'stable' });
    broadcastUpdate();
    return { ok: false, code, message: error.message };
  }
  const child = spawn(plan.packagePath, [], { detached: true, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    const snapshot = service.markInstallFailed(error);
    noteFailure(EVENTS.updateRejected, 'update', 'install-failed', { stage: 'install' });
    noteCount(METRICS.updateFailures, { stage: 'install' });
    finish('failed', { channel: snapshot.channel ?? 'stable' });
    broadcastUpdate();
    return { ok: false, code: 'install-failed', message: error.message, rollback: snapshot.rollback };
  }
  child.unref();
  finish('ok', { channel: service.state().channel ?? 'stable' });
  noteCount(METRICS.actions, { action: 'update.install', outcome: 'ok' });
  state.quitting = true;
  app.quit();
  return { ok: true, state: updateSnapshot() };
}

/** 导出诊断包：失败记录、崩溃证据与有界脱敏日志。 */
async function exportDiagnostics() {
  const failure = state.failureRecord ?? readFailureRecord(config.userData);
  const file = writeDiagnostics(config.userData, {
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
    },
    failure,
    crashes: readCrashes(config.userData),
    lines: splashLogs,
  });
  log(`[chatdsh] diagnostics written: ${file}`);
  await shell.openPath(file);
  return { ok: true, path: file };
}

/** 启动恢复页面读取的数据。 */
function startupFailureSnapshot() {
  const record = state.failureRecord ?? readFailureRecord(config.userData);
  return {
    failure: record,
    choices: recoveryChoices(record),
    safeMode: state.safeMode === undefined ? { active: false } : {
      active: true,
      notice: safeModeNotice(state.safeMode),
      disabledExtensions: state.safeMode.disabledExtensions,
      reason: state.safeMode.reason,
    },
    logFile: LOG_FILE,
    diagnostics: join(config.userData, 'diagnostics.json'),
  };
}

/** 重启应用。 */
function relaunch(extraArguments = []) {
  state.quitting = true;
  app.relaunch({ args: [...process.argv.slice(1), ...extraArguments] });
  app.quit();
}

/** 进入安全模式并重启。 */
async function enterSafeModeAndRelaunch(payload) {
  const record = enterSafeMode(config.userData, {
    reason: payload.reason,
    disabledExtensions: payload.disabledExtensions ?? [],
  });
  noteEvent(EVENTS.startupSafeMode, { reason: record.reason });
  noteCount(METRICS.safeModeStarts, { reason: record.reason });
  log(`[chatdsh] safe mode requested: ${record.reason}`);
  await state.gateway.stop();
  relaunch(['--safe-mode']);
  return { ok: true, record };
}

/** 应用安全模式：环境变量交给控制平面，界面读取状态显示停用范围。 */
function applySafeMode() {
  if (!process.argv.includes('--safe-mode')) {
    leaveSafeMode();
    return;
  }
  const record = readSafeMode(config.userData) ?? enterSafeMode(config.userData, { reason: 'command-line' });
  state.safeMode = record;
  Object.assign(process.env, safeModeEnv(record));
  noteEvent(EVENTS.startupSafeMode, { reason: record.reason });
  noteCount(METRICS.safeModeStarts, { reason: record.reason });
  log(`[chatdsh] safe mode active: ${safeModeNotice(record)}`);
}

/** 退出安全模式。 */
function leaveSafeMode() {
  exitSafeMode(config.userData);
  state.safeMode = undefined;
  delete process.env.CHATDSH_SAFE_MODE;
  delete process.env.CHATDSH_SAFE_MODE_REASON;
  delete process.env.CHATDSH_DISABLED_EXTENSIONS;
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

/** 记录启动失败并展示恢复页。 */
function reportStartupFailure(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  state.failure = message;
  state.failureRecord = buildFailureRecord({
    stage,
    code: 'startup-failed',
    exitCode: state.gateway.child?.exitCode ?? undefined,
    uptimeSeconds: (Date.now() - state.startedAt) / 1000,
    lines: splashLogs,
  });
  writeFailureRecord(config.userData, state.failureRecord);
  noteFailure(EVENTS.startupFailed, 'startup', 'startup-failed', { stage });
  log(`[chatdsh] failure at ${stage}: ${message}`);
  splashPhase(stage === 'runtime' ? 'runtime' : stage, 'failed');
  const brief = message.length > 1800 ? `${message.slice(0, 1800)}\n…（完整内容见日志文件）` : message;
  splashFail(`实例启动失败：\n${brief}`, LOG_FILE);
  broadcastStatus();
  void showRecoveryWindow();
}

/** 展示启动恢复窗口。 */
async function showRecoveryWindow() {
  if (recoveryWindow !== undefined && !recoveryWindow.isDestroyed()) {
    recoveryWindow.focus();
    return;
  }
  recoveryWindow = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 560,
    minHeight: 480,
    show: false,
    backgroundColor: '#0e0e10',
    title: 'ChatDSH 启动恢复',
    webPreferences: {
      preload: RECOVERY_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  recoveryWindow.once('ready-to-show', () => recoveryWindow.show());
  recoveryWindow.on('closed', () => {
    recoveryWindow = undefined;
  });
  await recoveryWindow.loadFile(RECOVERY);
  log('[chatdsh] recovery window shown');
  if (splashWindow !== undefined && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = undefined;
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
  const orchestrate = beginSpan(SPANS.runtimeOrchestrate);
  try {
    prepareBundledProfile(config);
    const started = await state.gateway.start();
    state.origin = started.gatewayUrl;
    state.bootUrl = `${started.gatewayUrl}${started.bootPath}`;
    allowedOrigins.add(new URL(started.gatewayUrl).origin);
    setTelemetryOrigin(started.gatewayUrl);
    orchestrate('ok', { 'runtime.id': started.gatewayUrl });
    clearFailureRecord(config.userData);
    // 固定前缀行：窗口地址是控制平面地址，运行时由控制平面反代。
    log(`[chatdsh] runtime ready: ${started.gatewayUrl} (port ${started.gatewayPort}, runtime ${started.runtimePort})`);
    splashDetail('runtime', `控制平面 ${started.gatewayPort} · 运行时 ${started.runtimePort}`);
    splashPhase('runtime', 'done', started.gatewayUrl);
  } catch (error) {
    orchestrate('failed');
    clearInterval(progressTimer);
    reportStartupFailure('runtime', error);
    if (process.env.CHATDSH_EXIT_AFTER_CAPTURE === '1') {
      await new Promise((settle) => setTimeout(settle, 1500));
      await capture(splashWindow, 'splash-failed');
      log('[chatdsh] exiting after failure');
      state.quitting = true;
      app.quit();
    }
    return;
  }
  clearInterval(progressTimer);
  splashPhase('ui', 'active');
  try {
    await showMainWindow();
  } catch (error) {
    reportStartupFailure('ui', error);
    return;
  }
  log('[chatdsh] window shown');
  splashPhase('ui', 'done');
  broadcastStatus();
  await restoreSecondaryWindows();
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

/** 活动上报：窗口侧把运行中回合与待审批数量报给壳层。 */
function reportActivity(report) {
  activity.runningTurns = report.runningTurns;
  activity.pendingApprovals = report.pendingApprovals;
  activity.drafts = report.drafts;
  if (report.hasSession !== undefined) activity.hasSession = report.hasSession;
  if (report.sourceDeviceOnline !== undefined) activity.sourceDeviceOnline = report.sourceDeviceOnline;
  if (report.paused !== undefined) activity.paused = report.paused;
  if (report.recentSessions !== undefined) activity.recentSessions = report.recentSessions;
  if (report.workspace !== undefined) activity.workspace = report.workspace;
  syncMenu();
  broadcastStatus();
}

/** IPC 处理函数表；通道由 `ipc.mjs` 的白名单约束。 */
const ipcHandlers = {
  ...secondaryWindowHandlers(),
  'chatdsh:status:get': () => statusSnapshot(),
  'chatdsh:keepalive:get': () => statusSnapshot(),
  'chatdsh:keepalive:set': (enabled) => setKeepAlive({ preventSleep: enabled }),
  'chatdsh:logs:open': () => shell.openPath(LOG_FILE),
  'chatdsh:logs:dir': () => shell.openPath(LOG_DIR),
  'chatdsh:window:state': () => windowStateSnapshot(),
  'chatdsh:native:choose-directory': async (payload) => {
    const finish = beginSpan(SPANS.nativeInvoke);
    const window = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const options = directoryPickerOptions(payload.purpose);
    const result = window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
    try {
      const path = assertDirectoryChoice(result.canceled ? [] : result.filePaths);
      finish('ok', { action: 'choose-directory', purpose: payload.purpose });
      noteCount(METRICS.actions, { action: 'native.choose-directory', outcome: 'ok' });
      return { ok: true, path };
    } catch (error) {
      const code = error instanceof NativeRejection ? error.code : 'picker-failed';
      finish('failed', { action: 'choose-directory', purpose: payload.purpose });
      noteFailure(EVENTS.nativeRejected, 'native', code, { action: 'choose-directory' });
      noteCount(METRICS.actions, { action: 'native.choose-directory', outcome: 'cancelled' });
      return { ok: false, code, message: error.message };
    }
  },
  'chatdsh:native:open-external': async (payload) => {
    await openTarget(payload.url, 'ipc');
    return { ok: true };
  },
  'chatdsh:native:open-path': async (payload) => {
    await openTarget(payload.path, 'ipc');
    return { ok: true };
  },
  'chatdsh:native:clipboard-write': async (payload) => {
    const text = assertClipboardText(payload.text);
    await clipboard.writeText(text);
    noteCount(METRICS.actions, { action: 'native.clipboard-write', outcome: 'ok' });
    return { ok: true, length: text.length };
  },
  'chatdsh:notification:show': (payload) => showNotification(payload),
  'chatdsh:update:state': () => updateSnapshot(),
  'chatdsh:update:check': (payload) => checkUpdate(payload.channel),
  'chatdsh:update:download': () => downloadUpdate(),
  'chatdsh:update:install': (payload) => installUpdate(payload.confirmed),
  'chatdsh:update:cancel': () => cancelUpdate(),
  'chatdsh:power:state': () => powerSnapshot(),
  'chatdsh:power:set': (payload) => setKeepAlive({ preventSleep: payload.enabled, mode: payload.mode ?? state.keepAlive.mode }),
  'chatdsh:login:state': () => loginSnapshot(),
  'chatdsh:login:set': (payload) => setLoginItem(payload.enabled),
  'chatdsh:startup:failure': () => startupFailureSnapshot(),
  'chatdsh:startup:retry': () => {
    leaveSafeMode();
    relaunch([]);
    return { ok: true };
  },
  'chatdsh:startup:safe-mode': (payload) => enterSafeModeAndRelaunch(payload),
  'chatdsh:startup:diagnostics': () => exportDiagnostics(),
  'chatdsh:window:minimize': () => { mainWindow?.minimize(); },
  'chatdsh:window:toggle-maximize': () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  },
  'chatdsh:window:close': () => { mainWindow?.close(); },
  'chatdsh:activity:report': (report) => { reportActivity(report); },
};

/** 按白名单注册 IPC 通道。 */
function registerIpc() {
  const channels = mergeWindowChannels(CALL_CHANNELS);
  const router = createIpcRouter({
    handlers: ipcHandlers,
    allowedOrigins,
    allowedFiles,
    channels,
    isTrustedSender: (event) => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) return true;
      if (recoveryWindow !== undefined && !recoveryWindow.isDestroyed() && event.sender === recoveryWindow.webContents) return true;
      if (splashWindow !== undefined && !splashWindow.isDestroyed() && event.sender === splashWindow.webContents) return true;
      for (const window of secondaryWindows.values()) {
        if (!window.isDestroyed() && event.sender === window.webContents) return true;
      }
      return false;
    },
  });
  for (const entry of channels) {
    if (entry.kind === 'invoke') {
      ipcMain.handle(entry.channel, (event, ...args) => router.invoke(entry.channel, event, ...args));
    } else {
      ipcMain.on(entry.channel, (event, ...args) => {
        void router.send(entry.channel, event, ...args);
      });
    }
  }
}

/** 统计启动过程里的渲染进程与子进程退出。 */
function observeCrashes() {
  app.on('render-process-gone', (_event, webContents, details) => {
    const uptimeSeconds = Math.round((Date.now() - state.startedAt) / 1000);
    const record = recordCrash(config.userData, {
      code: 'ERR_RENDER_GONE',
      reason: `渲染进程退出（${details.reason}）`,
      uptimeSeconds,
    });
    noteEvent(EVENTS.crashEvidence, { 'exit.code': details.exitCode ?? 'unknown', 'uptime.seconds': uptimeSeconds });
    noteCount(METRICS.crashes, { reason: 'render-process-gone' });
    log(`[chatdsh] render process gone; evidence count ${record.length}`);
  });
  app.on('child-process-gone', (_event, details) => {
    const uptimeSeconds = Math.round((Date.now() - state.startedAt) / 1000);
    recordCrash(config.userData, {
      code: `ERR_CHILD_${String(details.type).toUpperCase()}`,
      reason: `子进程退出（${details.reason}）`,
      uptimeSeconds,
    });
    noteEvent(EVENTS.crashEvidence, { 'exit.code': details.exitCode ?? 'unknown', 'uptime.seconds': uptimeSeconds });
    noteCount(METRICS.crashes, { reason: String(details.reason) });
    log(`[chatdsh] child process gone: ${details.type} ${details.reason}`);
  });
}

// 单实例：第二次启动把已有窗口提到前台。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (recoveryWindow !== undefined && !recoveryWindow.isDestroyed()) {
      recoveryWindow.focus();
      return;
    }
    void showMainWindow();
  });
  app.whenReady().then(async () => {
    log(`[chatdsh] starting ${app.getVersion()} profile=${config.profile} bin=${config.dshBin}`);
    log(`[chatdsh] log file: ${LOG_FILE}`);
    applySafeMode();
    const previousFailure = readFailureRecord(config.userData);
    if (previousFailure !== undefined) {
      state.failureRecord = previousFailure;
      noteFailure(EVENTS.startupFailed, 'startup', 'previous-failure', { stage: previousFailure.stage });
    }
    try {
      ensureUpdateService();
    } catch (error) {
      log(`[chatdsh] update source unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    createSplash();
    createTray();
    registerIpc();
    observeCrashes();
    syncMenu();
    applyPowerPolicy();
    await boot();
  });
  app.on('window-all-closed', () => {
    // 托盘常驻时不因窗口全关而退出。
    if (state.keepAlive.tray !== true && state.quitting !== true) void requestQuit('window-all-closed');
  });
  app.on('before-quit', async () => {
    state.quitting = true;
    if (windowSaveTimer !== undefined) clearTimeout(windowSaveTimer);
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      const display = screen.getDisplayMatching(mainWindow.getBounds());
      writeWindowState(config.windowStateFile, captureWindowState(mainWindow, display.id));
    }
    if (state.powerBlockerId !== undefined && powerSaveBlocker.isStarted(state.powerBlockerId)) {
      powerSaveBlocker.stop(state.powerBlockerId);
      state.powerBlockerId = undefined;
      noteGauge(METRICS.powerBlockers, 0, { 'power.mode': state.keepAlive.mode });
    }
    await state.gateway.stop();
  });
}
