// 自建模型提供方的端到端验收。
//
// 用 CHATDSH_PROVIDER_URL / CHATDSH_PROVIDER_API_KEY / CHATDSH_PROVIDER_MODEL 启动
// Web 形态的运行时，在真实 Chrome 里走完首次进入流程，发一句话并等待助手回复。
// 这一步同时证明三件事：提供方路由已注册、默认模型选中了该模型、请求确实到达了端点。
//
// 用法：
//   CHATDSH_PROVIDER_URL=https://provider.example/v1 \
//   CHATDSH_PROVIDER_API_KEY=... \
//   CHATDSH_PROVIDER_MODEL=... \
//   node scripts/verify-provider-chat.mjs
//
// URL 是 OpenAI 兼容基地址（含 /v1，不含 /chat/completions）。密钥只从环境变量读，
// 脚本不打印请求头，也不把值写进临时数据根之外的任何文件。
// 退出码 0 表示界面里出现了助手回复。

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const PORT = Number.parseInt(option('port', '3097'), 10);

/** 读取一个命令行选项。 */
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

/** 检查提供方环境变量是否齐全。 */
function providerEnv() {
  const url = process.env.CHATDSH_PROVIDER_URL;
  const key = process.env.CHATDSH_PROVIDER_API_KEY;
  const model = process.env.CHATDSH_PROVIDER_MODEL;
  const missing = [
    url === undefined || url === '' ? 'CHATDSH_PROVIDER_URL' : undefined,
    key === undefined || key === '' ? 'CHATDSH_PROVIDER_API_KEY' : undefined,
    model === undefined || model === '' ? 'CHATDSH_PROVIDER_MODEL' : undefined,
  ].filter((item) => item !== undefined);
  if (missing.length > 0) throw new Error(`缺少环境变量：${missing.join('、')}`);
  new URL(url);
  return { url, key, model };
}

/** 点一个文本或 aria-label 包含给定片段的按钮。 */
async function clickByText(page, needle, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) =>
        (item.textContent || '').includes(${JSON.stringify(needle)})
        || (item.getAttribute('aria-label') || '').includes(${JSON.stringify(needle)}));
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    if (clicked === true) return true;
    await new Promise((settle) => setTimeout(settle, 300));
  }
  return false;
}

/** 等界面文本包含给定片段。 */
async function waitForText(page, needle, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = String(await page.evaluate('document.body?.innerText ?? ""'));
    if (text.includes(needle)) return text;
    await new Promise((settle) => setTimeout(settle, 300));
  }
  return text;
}

const { url, model } = providerEnv();
const HOME = tempHome('provider-chat');
mkdirSync(join(HOME, 'profiles'), { recursive: true });
symlinkSync(join(ROOT, 'profiles', 'chatdsh-web'), join(HOME, 'profiles', 'chatdsh-web'));

const runtime = spawn(dshCommand(), ['--profile', 'chatdsh-web', '--port', String(PORT), '--no-open'], {
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

const failures = [];
let browser;
try {
  const bootUrl = await waitForUrl();
  console.log(`运行时已启动：${bootUrl.split('?')[0]}`);
  console.log(`提供方端点：${new URL(url).origin}${new URL(url).pathname}`);
  console.log(`模型：${model}`);

  browser = await launchBrowser({
    executable: '/usr/bin/google-chrome',
    port: 9227,
    userDataDir: tempHome('chrome-provider-chat'),
  });
  const page = await browser.open();
  try {
    await page.navigate(bootUrl);
    await waitForText(page, '继续');
    await clickByText(page, '继续');
    await waitForText(page, 'API 密钥');
    await clickByText(page, '稍后配置');
    await waitForText(page, '选择工作区');
    await clickByText(page, 'ChatDSH');
    await waitForText(page, '预设');
    await clickByText(page, 'ChatDSH 工作');
    const mainText = await waitForText(page, '项目');
    if (!mainText.includes('项目')) throw new Error('没有进入主界面');

    if (!mainText.includes(model)) failures.push(`界面里没有显示模型 ${model}`);
    else console.log('主界面已显示自建提供方的模型');

    const inserted = await page.evaluate(`(() => {
      const input = document.querySelector('[data-composer-input="true"]');
      if (input === null) return false;
      input.focus();
      document.execCommand('insertText', false, '只回复两个字：收到');
      return true;
    })()`);
    if (inserted !== true) throw new Error('没有找到输入框');
    await new Promise((settle) => setTimeout(settle, 400));
    if (!await clickByText(page, '发送消息')) throw new Error('没有找到发送按钮');

    const finalText = await waitForText(page, '收到', 60_000);
    if (!finalText.includes('收到')) {
      failures.push('等待助手回复超时');
      console.log(`界面片段：\n${finalText.slice(-500)}`);
    } else {
      console.log('助手回复已到达界面');
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
console.log('自建模型提供方端到端验收通过');
process.exit(0);
