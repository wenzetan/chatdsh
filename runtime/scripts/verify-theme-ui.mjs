// 主题插件的界面验收。
//
// 启动一个 Web 形态的运行时，用真实 Chrome 打开首屏，断言：
//   1. 主题样式节点已挂到文档上；
//   2. `data-color-scheme` 与上游 `data-ds-dark-theme` 一致（配色跟随上游呈现器）；
//   3. 当前配色下，画布与面板令牌、正文底色取到本设计对应取值；
//   4. 上游别名 `--dsw-alias-bg-base` 已映射到本设计令牌；
//   5. 切换上游暗色属性后，本设计令牌块随之切换，并能切回。
// 首屏在欢迎页即完成断言：主题插件用 `immediately` 在启动早期挂样式，不依赖进入主界面。
//
// 用法：node scripts/verify-theme-ui.mjs [--profile chatdsh-web] [--port 3099]
// 退出码 0 表示断言全部成立。

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

const PROFILE = option('profile', 'chatdsh-web');
const PORT = Number.parseInt(option('port', '3099'), 10);

const HOME = tempHome('theme-ui');
mkdirSync(join(HOME, 'profiles'), { recursive: true });
symlinkSync(join(ROOT, 'profiles', PROFILE), join(HOME, 'profiles', PROFILE));

const runtime = spawn(dshCommand(), ['--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
runtime.stdout.setEncoding('utf8');
runtime.stdout.on('data', (chunk) => { output += chunk; });
runtime.stderr.setEncoding('utf8');
runtime.stderr.on('data', (chunk) => { output += chunk; });

async function waitForUrl(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    if (match) return match[1];
    if (output.includes('startup failed')) throw new Error(`启动失败：\n${output.slice(-1200)}`);
    await new Promise((settle) => setTimeout(settle, 400));
  }
  throw new Error(`等待启动超时：\n${output.slice(-1200)}`);
}

const failures = [];
function expect(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '通过' : '失败'} ${label}：${JSON.stringify(actual)}${ok ? '' : `（期望 ${JSON.stringify(expected)}）`}`);
  if (!ok) failures.push(label);
}

// 两套配色下本设计令牌块与正文底色的期望取值。
const SCHEME = {
  dark: { bg: '#0e0e10', panel: '#17181c', bodyBg: 'rgb(14, 14, 16)' },
  light: { bg: '#f6f7f9', panel: '#ffffff', bodyBg: 'rgb(246, 247, 249)' },
};

const READ = `(() => {
  const body = getComputedStyle(document.body);
  const root = getComputedStyle(document.documentElement);
  return {
    darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
    scheme: document.body.getAttribute('data-color-scheme'),
    bodyBg: body.backgroundColor,
    bodyFont: body.fontFamily,
    tokenBg: body.getPropertyValue('--chatdsh-bg').trim(),
    tokenPanel: body.getPropertyValue('--chatdsh-panel').trim(),
    aliasBgBase: body.getPropertyValue('--dsw-alias-bg-base').trim(),
    contentFontSize: body.getPropertyValue('--dsh-content-font-size').trim(),
  };
})()`;

let browser;
try {
  const bootUrl = await waitForUrl();
  console.log(`运行时已启动：${bootUrl.split('?')[0]}`);
  browser = await launchBrowser({ executable: '/usr/bin/google-chrome', port: 9229, userDataDir: tempHome('chrome-theme') });
  const page = await browser.open();
  try {
    await page.navigate(bootUrl);
    const deadline = Date.now() + 20_000;
    let present = false;
    while (Date.now() < deadline) {
      present = await page.evaluate('document.getElementById("chatdsh-theme-styles") !== null');
      if (present === true) break;
      await new Promise((settle) => setTimeout(settle, 400));
    }
    expect('样式节点已挂载', present, true);

    const initial = await page.evaluate(READ);
    const initialScheme = initial.darkAttr === true ? 'dark' : 'light';
    expect('初始 · data-color-scheme 跟随上游暗色属性', initial.scheme, initialScheme);
    expect('初始 · 画布令牌', initial.tokenBg, SCHEME[initialScheme].bg);
    expect('初始 · 面板令牌', initial.tokenPanel, SCHEME[initialScheme].panel);
    expect('初始 · 正文底色', initial.bodyBg, SCHEME[initialScheme].bodyBg);
    expect('初始 · 上游别名已映射到本设计令牌', initial.aliasBgBase === SCHEME[initialScheme].bg || initial.aliasBgBase.includes('--chatdsh-bg'), true);
    expect('正文使用设计字体族', initial.bodyFont.includes('PingFang') || initial.bodyFont.includes('Segoe') || initial.bodyFont.includes('sans-serif'), true);
    const sizePx = Number.parseInt(initial.contentFontSize, 10);
    expect('正文内容字号不低于 13px', Number.isFinite(sizePx) && sizePx >= 13, true);

    // 切到暗色：本设计令牌块应取暗色取值。
    await page.evaluate('document.body.setAttribute("data-ds-dark-theme", "")');
    await new Promise((settle) => setTimeout(settle, 300));
    const dark = await page.evaluate(READ);
    expect('暗色 · data-color-scheme', dark.scheme, 'dark');
    expect('暗色 · 画布令牌', dark.tokenBg, SCHEME.dark.bg);
    expect('暗色 · 正文底色', dark.bodyBg, SCHEME.dark.bodyBg);

    // 切到亮色：本设计令牌块应取亮色取值。
    await page.evaluate('document.body.removeAttribute("data-ds-dark-theme")');
    await new Promise((settle) => setTimeout(settle, 300));
    const light = await page.evaluate(READ);
    expect('亮色 · data-color-scheme', light.scheme, 'light');
    expect('亮色 · 画布令牌', light.tokenBg, SCHEME.light.bg);
    expect('亮色 · 正文底色', light.bodyBg, SCHEME.light.bodyBg);

    // 切回暗色，确认可以来回切换。
    await page.evaluate('document.body.setAttribute("data-ds-dark-theme", "")');
    await new Promise((settle) => setTimeout(settle, 300));
    const back = await page.evaluate(READ);
    expect('切回 · data-color-scheme', back.scheme, 'dark');
    expect('切回 · 画布令牌', back.tokenBg, SCHEME.dark.bg);
  } finally {
    await page.close();
  }
  if (/client-theme[^\n]*(失败|error|Error|throw)/i.test(output)) {
    console.log('运行时输出里出现 client-theme 报错');
    failures.push('运行时无 client-theme 报错');
  }
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  if (browser !== undefined) await browser.close();
  runtime.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 600));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('主题界面验收通过');
process.exit(0);
