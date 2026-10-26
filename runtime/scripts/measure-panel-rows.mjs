// 面板列表行与骨架行的尺寸验收。
//
// 设计约束要求状态占位与真实内容等高，数据到达时不产生位移。这里在真实运行时页面里
// 注入一段与组件产出一致的 DOM，量取两组边界尺寸：
//   已加载：.chdsh-list 里的两行 .chdsh-row（标题、徽标、副行、行内按钮），以及只有一行的情形
//   加载态：同宽面板里的两行 .chdsh-skeleton
// 断言单行高度与行距之差都不超过 1 像素。超出即视为占位与真实行不齐。
//
// 用法：node scripts/measure-panel-rows.mjs [--profile chatdsh-web] [--port 3699]
// 退出码 0 表示两者齐平。

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
const PORT = Number.parseInt(option('port', '3699'), 10);

const HOME = tempHome('panel-rows');
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

const PROBE = `(() => {
    const row = (meta) => '<li class="chdsh-row"><span class="chdsh-dot chdsh-dot--ok"></span>' +
      '<div class="chdsh-row__body"><div class="chdsh-row__title">项目名称<span class="chdsh-badge chdsh-badge--ok">启用</span></div>' +
      (meta ? '<div class="chdsh-row__meta">/home/user/work</div>' : '') + '</div>' +
      '<div class="chdsh-row__acts"><button class="chdsh-btn" type="button">操作</button></div></li>';
    const probe = document.createElement('div');
    probe.id = 'chdsh-measure-probe';
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:428px;';
    probe.innerHTML =
      '<section class="chdsh-panel" data-group="loaded-two"><div class="chdsh-panel__head"><h3 class="chdsh-panel__title">项目</h3><span class="chdsh-panel__count">2</span></div>' +
      '<ul class="chdsh-list">' + row(true) + row(true) + '</ul></section>' +
      '<section class="chdsh-panel" data-group="loaded-one"><ul class="chdsh-list">' + row(false) + row(false) + '</ul></section>' +
      '<section class="chdsh-panel" data-group="loading"><div class="chdsh-panel__head"><h3 class="chdsh-panel__title">项目</h3></div>' +
      '<div class="chdsh-skeleton"></div><div class="chdsh-skeleton"></div></section>';
    document.body.appendChild(probe);
    const pick = (group, selector) => [...document.querySelectorAll('[data-group="' + group + '"] ' + selector)];
    const box = (el) => el.getBoundingClientRect();
    const round = (value) => Math.round(value * 100) / 100;
    const pitch = (items) => (items.length < 2 ? null : round(box(items[1]).top - box(items[0]).top));
    const rowsTwo = pick('loaded-two', '.chdsh-row');
    const rowsOne = pick('loaded-one', '.chdsh-row');
    const skels = pick('loading', '.chdsh-skeleton');
    const result = {
      rowTwoLineHeight: round(box(rowsTwo[0]).height),
      rowTwoLinePitch: pitch(rowsTwo),
      rowOneLineHeight: round(box(rowsOne[0]).height),
      rowOneLinePitch: pitch(rowsOne),
      skeletonHeight: round(box(skels[0]).height),
      skeletonPitch: pitch(skels),
    };
    document.getElementById('chdsh-measure-probe').remove();
    return result;
  })()`;

let browser;
try {
  const url = await waitForUrl();
  browser = await launchBrowser({ executable: '/usr/bin/google-chrome', port: 9359, userDataDir: tempHome('chrome-rows') });
  const page = await browser.open();
  await page.navigate(url);
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate('document.getElementById("chatdsh-theme-styles") !== null');
    if (ready === true) break;
    await new Promise((settle) => setTimeout(settle, 300));
  }
  if (ready !== true) throw new Error('主题样式节点未出现，无法量取组件尺寸');

  const measured = await page.evaluate(PROBE);
  console.log(JSON.stringify(measured, null, 2));

  const close = (a, b) => Math.abs(a - b) <= 1;
  const checks = [
    ['两行内容：单行高度', close(measured.rowTwoLineHeight, measured.skeletonHeight), `${measured.rowTwoLineHeight} 与 ${measured.skeletonHeight}`],
    ['两行内容：行距', close(measured.rowTwoLinePitch, measured.skeletonPitch), `${measured.rowTwoLinePitch} 与 ${measured.skeletonPitch}`],
    ['单行内容：单行高度', close(measured.rowOneLineHeight, measured.skeletonHeight), `${measured.rowOneLineHeight} 与 ${measured.skeletonHeight}`],
    ['单行内容：行距', close(measured.rowOneLinePitch, measured.skeletonPitch), `${measured.rowOneLinePitch} 与 ${measured.skeletonPitch}`],
  ];
  let failed = 0;
  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? '通过' : '失败'} ${label}：${detail}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) {
    console.log(`骨架与真实行不齐的有 ${failed} 项`);
    process.exitCode = 1;
  } else {
    console.log('骨架行与真实行等高，行距一致');
  }
} finally {
  if (browser !== undefined) await browser.close();
  runtime.kill('SIGTERM');
}
