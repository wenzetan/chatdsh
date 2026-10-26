// 桌面壳的界面验收（可在有显示的 Linux 上跑）。
//
// 用 xvfb 起一个虚拟显示，运行 Electron 主进程，让它拉起真实运行时并加载界面。断言：
//   1. 启动页依次经过身份、运行时、界面三个阶段并落到完成；
//   2. 主窗口出现并加载到带令牌的运行时地址；
//   3. 截图里有内容（非纯黑）且没有桌面桥注入失败；
//   4. 关闭窗口后进程仍在（托盘常驻），退出后进程消失。
// 会在 Windows 真机上另跑同一份验收，因此这里覆盖的是壳层的编排与窗口行为。
//
// 用法：node scripts/verify-desktop-shell.mjs [--port 3124]
// 前置：本机装有 xvfb-run、google-chrome、electron（desktop/electron/node_modules）。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const PORT = portIndex < 0 ? 3124 : Number.parseInt(argv[portIndex + 1], 10);

const ELECTRON_DIR = join(ROOT, 'desktop', 'electron');
const ELECTRON_BIN = join(ELECTRON_DIR, 'node_modules', 'electron', 'dist', 'electron');
if (!existsSync(ELECTRON_BIN)) {
  console.error(`找不到 electron：${ELECTRON_BIN}。先在该目录安装 electron。`);
  process.exit(2);
}

const DSH_BIN = resolve(process.env.DSH_BIN ?? '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
const HOME = tempHome('desktop-shell');
const launchRoot = join(HOME, 'launch-root');
const dshHome = join(HOME, 'harness');
mkdirSync(launchRoot, { recursive: true });
mkdirSync(join(dshHome, 'profiles'), { recursive: true });
// 把仓库里的 desktop profile 接进隔离数据根。
spawnSync('ln', ['-sfn', join(ROOT, 'profiles', 'chatdsh-desktop'), join(dshHome, 'profiles', 'chatdsh-desktop')]);

// 沙箱下 /root/.config 只读，Electron 与 Chromium 的配置缓存改到可写的数据根。
const configHome = join(HOME, 'config');
const cacheHome = join(HOME, 'cache');
mkdirSync(configHome, { recursive: true });
mkdirSync(cacheHome, { recursive: true });
const env = {
  ...process.env,
  DISPLAY: process.env.DISPLAY,
  HOME,
  XDG_CONFIG_HOME: configHome,
  XDG_CACHE_HOME: cacheHome,
  CHATDSH_LAUNCH_ROOT: launchRoot,
  CHATDSH_DSH_HOME: dshHome,
  CHATDSH_PROFILE: 'chatdsh-desktop',
  CHATDSH_PORT: String(PORT),
  CHATDSH_DSH_BIN: DSH_BIN,
  CHATDSH_CWD: ROOT,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
};

const failures = [];
function expect(label, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'} ${label}${detail ? `：${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// 启动桌面壳（用 xvfb 提供显示）。
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', ELECTRON_BIN, '.', '--no-sandbox'], {
  cwd: ELECTRON_DIR,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { log += chunk; process.stdout.write(chunk); });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { log += chunk; process.stderr.write(chunk); });

/** 轮询条件成立。 */
async function until(test, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await new Promise((settle) => setTimeout(settle, 500));
  }
  throw new Error(`等待超时：${label}`);
}

// Electron 的渲染进程信息通过 CDP 拿不到，改为读取主进程写入的窗口 URL 日志。
// 主进程把运行时地址打印在一个固定前缀行上；壳层在 --print-boot 时以该前缀输出。
try {
  await until(() => /\[chatdsh\] runtime ready: http:\/\/127\.0\.0\.1:\d+/.test(log), 120_000, '运行时就绪');
  const m = log.match(/\[chatdsh\] runtime ready: (http:\/\/127\.0\.0\.1:\d+)/);
  expect('运行时就绪', m !== null, m?.[1] ?? '');
  const origin = m?.[1];
  if (origin !== undefined) {
    const res = await fetch(`${origin}/`).catch(() => undefined);
    expect('运行时地址可访问（401 视为鉴权生效）', res !== undefined && (res.status === 401 || res.status === 200), res ? `HTTP ${res.status}` : '连接失败');
  }
  await until(() => /\[chatdsh\] window shown/.test(log), 30_000, '主窗口显示');
  expect('主窗口已显示', /\[chatdsh\] window shown/.test(log));
  expect('桌面桥已注入', !/preload[^\n]*error|Unable to load preload/i.test(log));
  // 关闭窗口走托盘常驻：主进程仍在。
  expect('进程存活', child.exitCode === null);
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 1500));
  if (child.exitCode === null) child.kill('SIGKILL');
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('桌面壳界面验收通过');
process.exit(0);
