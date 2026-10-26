// 桌面壳在 Windows 真机上的验收（在 Windows 主机上用 node 运行）。
//
// 启动 Electron 主进程，让它拉起 `chatdsh-desktop` 运行时并加载界面，然后在渲染进程里读取
// DOM 与计算样式，核对界面基础设计确实生效。断言：
//   1. 运行时打印带令牌的地址并可用；
//   2. 主题样式节点已挂载，`data-color-scheme` 有取值；
//   3. 画布、面板、品牌、成功、警告、危险六个令牌解析为本设计取值，正文 13px；
//   4. 上游 `--dsw-alias-bg-base` 已映射到本设计画布；
//   5. 自建面板（项目、上下文）出现在界面上。
// 全程不依赖截图，结论来自界面里的计算值与文本。
//
// 用法（在 Windows 上）：
//   node runtime/scripts/verify-desktop-shell-win.mjs
// 环境变量：
//   CHATDSH_ELECTRON    electron.exe 路径（默认取 desktop/electron/node_modules）
//   CHATDSH_DSH_HOME    DSH 数据根（默认 %USERPROFILE%\chatdsh-home）
//   CHATDSH_PORT        运行时端口（默认 3151）

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_DIR = join(ROOT, 'desktop', 'electron');
const ELECTRON = process.env.CHATDSH_ELECTRON ?? join(ELECTRON_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const DSH_HOME = process.env.CHATDSH_DSH_HOME ?? join(homedir(), 'chatdsh-home');
const PORT = process.env.CHATDSH_PORT ?? '3151';

if (!existsSync(ELECTRON)) {
  console.error(`找不到 electron：${ELECTRON}`);
  process.exit(2);
}
// 数据根下的 profiles 指向仓库里的 desktop profile。
const profilesDir = join(DSH_HOME, 'profiles');
mkdirSync(profilesDir, { recursive: true });
const profileLink = join(profilesDir, 'chatdsh-desktop');
if (!existsSync(profileLink)) {
  symlinkSync(join(ROOT, 'profiles', 'chatdsh-desktop'), profileLink, 'junction');
}

const child = spawn(ELECTRON, ['.', '--no-sandbox'], {
  cwd: ELECTRON_DIR,
  env: {
    ...process.env,
    CHATDSH_LAUNCH_ROOT: join(DSH_HOME, 'launch-root'),
    CHATDSH_DSH_HOME: DSH_HOME,
    CHATDSH_PROFILE: 'chatdsh-desktop',
    CHATDSH_PORT: PORT,
    CHATDSH_CWD: ROOT,
    CHATDSH_SELFTEST: '1',
    CHATDSH_ONBOARD: '1',
    CHATDSH_EXIT_AFTER_CAPTURE: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { out += chunk; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { out += chunk; });

const failures = [];
function expect(label, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'} ${label}${detail ? `：${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
const timeout = new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 180_000));
await Promise.race([exited, timeout]);

// 运行时就绪
const ready = out.match(/\[chatdsh\] runtime ready: (http:\/\/\S+)/);
expect('运行时就绪', ready !== null, ready?.[1] ?? '');

// 解析自检 JSON
const selftestLine = out.split(/\r?\n/).find((line) => line.includes('[chatdsh] selftest '));
let result;
if (selftestLine !== undefined) {
  try {
    result = JSON.parse(selftestLine.slice(selftestLine.indexOf('selftest ') + 'selftest '.length));
  } catch (error) {
    expect('自检结果可解析', false, String(error));
  }
}
expect('自检结果存在', result !== undefined);

if (result !== undefined) {
  expect('主题样式节点已挂载', result.hasThemeNode === true);
  expect('配色属性有取值', result.scheme === 'dark' || result.scheme === 'light', result.scheme);
  const tokens = result.tokens ?? {};
  expect('画布令牌', tokens.bg === '#0e0e10' || tokens.bg === '#f6f7f9', tokens.bg);
  expect('面板令牌', tokens.panel === '#17181c' || tokens.panel === '#ffffff', tokens.panel);
  expect('品牌令牌', tokens.brand === '#4d6bfe' || tokens.brand === '#3d56e8', tokens.brand);
  expect('成功令牌', tokens.ok === '#3fb37f' || tokens.ok === '#1f9d63', tokens.ok);
  expect('警告令牌', tokens.warn === '#e8b04b' || tokens.warn === '#b4790a', tokens.warn);
  expect('危险令牌', tokens.danger === '#ff7b7b' || tokens.danger === '#d64545', tokens.danger);
  expect('正文字号 13px', tokens.fontSize === '13px', tokens.fontSize);
  expect('上游别名已映射', result.aliasBase === tokens.bg, result.aliasBase);
  expect('正文使用设计字体族', /Segoe|PingFang|Microsoft YaHei/.test(result.bodyFont ?? ''), '');
  expect('界面有内容', (result.textLength ?? 0) > 50, String(result.textLength));
  const sample = result.textSample ?? '';
  expect('自建面板出现（项目/上下文）', sample.includes('项目') || sample.includes('上下文'), '');
  // 首次进入流程推进到工作区/预设阶段：自建预设（ChatDSH 工作 / ChatDSH 聊天）出现在界面上。
  const onboardLog = out;
  const reachedPreset = /ChatDSH 工作|ChatDSH 聊天/.test(onboardLog)
    || /onboard: reached main ui/.test(onboardLog);
  expect('首次进入推进到自建预设/主界面', reachedPreset, '');
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('Windows 桌面壳验收通过');
process.exit(0);
