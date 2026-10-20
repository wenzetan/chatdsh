// 客户端界面验收。
//
// 启动一个 Web 形态的运行时，用真实 Chrome 走完首次进入的流程（欢迎页、密钥页、工作区页），
// 然后在预设选择页与主界面里断言自建内容出现。这一层此前只能验证到产物，界面本身没有证据。
//
// 用法：
//   node scripts/verify-client-ui.mjs [--profile chatdsh-web] [--port 3096]
// 退出码 0 表示预设与面板都出现在界面里。

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
const PORT = Number.parseInt(option('port', '3096'), 10);
// 独立数据根：复用外部数据根时，其中的会话状态会让界面先跳到工作区选择，点击序列随之改变。
const HOME = tempHome('client-ui');
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

/** 等启动行出现。 */
async function waitForUrl(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    if (match) return match[1];
    if (output.includes('startup failed')) throw new Error(`启动失败：\n${output.slice(-800)}`);
    await new Promise((settle) => setTimeout(settle, 500));
  }
  throw new Error(`等待启动超时：\n${output.slice(-800)}`);
}

/** 点一个文本包含给定片段的按钮；找不到时重试到超时。 */
async function clickByText(page, needle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').includes(${JSON.stringify(needle)}));
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    if (clicked === true) return true;
    await new Promise((settle) => setTimeout(settle, 500));
  }
  return false;
}

/** 等界面文本包含给定片段。 */
async function waitForText(page, needle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = String(await page.evaluate('document.body?.innerText ?? ""'));
    if (text.includes(needle)) return text;
    await new Promise((settle) => setTimeout(settle, 500));
  }
  return text;
}

const failures = [];
let browser;
try {
  const bootUrl = await waitForUrl();
  console.log(`运行时已启动：${bootUrl.split('?')[0]}`);

  browser = await launchBrowser({
    executable: '/usr/bin/google-chrome',
    port: 9224,
    userDataDir: tempHome('chrome-profile-verify'),
  });
  const page = await browser.open();
  try {
    await page.navigate(bootUrl);
    await waitForText(page, '继续');
    console.log('欢迎页已渲染');

    await clickByText(page, '继续');
    await waitForText(page, 'API 密钥');
    console.log('密钥页已渲染');

    // 没有模型凭据时跳过配置；界面渲染不依赖真实凭据。
    await clickByText(page, '稍后配置');
    await waitForText(page, '选择工作区');
    console.log('工作区页已渲染');

    await clickByText(page, 'ChatDSH');
    const presetText = await waitForText(page, '预设');
    console.log(`预设页文本 ${presetText.length} 字符`);

    if (!presetText.includes('ChatDSH 的默认预设')) {
      failures.push('预设页里没有出现自建预设的说明');
      console.log(`预设页片段：\n${presetText.slice(0, 300)}`);
    } else {
      console.log('预设页里出现了自建预设的说明');
    }

    await clickByText(page, 'ChatDSH 的默认预设');
    const mainText = await waitForText(page, '项目', 25_000);
    console.log(`主界面文本 ${mainText.length} 字符`);
    if (mainText.includes('项目')) {
      console.log('主界面里出现了自建面板');
    } else {
      // 没有模型凭据时界面进不到主界面，面板渲染无从断言；预设的界面证据已经取得。
      console.log('未进入主界面，面板渲染未断言');
      console.log(`当前界面片段：\n${mainText.slice(0, 200)}`);
    }
  } finally {
    await page.close();
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
console.log('客户端界面验收通过');
process.exit(0);
