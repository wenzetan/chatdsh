// 连接器面板点击交互的端到端验收。
//
// 真实运行时、真实浏览器、真实 Remote 调用：先在页面上下文创建一条连接器记录，
// 打开设置页的连接器区段，点击「停用」，断言界面变成已停用且记录写回存储。
//
// 用法：node scripts/verify-connector-toggle-ui.mjs [--port 50071]
// 前置：CHATDSH_TEST_GATEWAY_API_KEY 与 HERMES_API_KEY 提供测试凭据。
import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 50071 : Number.parseInt(argv[index + 1], 10);
const PROFILE = 'chatdsh-hermes-live';

const HOME = tempHome('connector-toggle-ui');
mkdirSync(join(HOME, 'profiles'), { recursive: true });
symlinkSync(resolve(ROOT, 'e2e', 'profiles', PROFILE), join(HOME, 'profiles', PROFILE));

const runtime = spawn(dshCommand(), ['--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let errors = '';
runtime.stdout.setEncoding('utf8');
runtime.stdout.on('data', (chunk) => { output += chunk; });
runtime.stderr.setEncoding('utf8');
runtime.stderr.on('data', (chunk) => { errors += chunk; });

const failures = [];
let browser;
try {
  const deadline = Date.now() + 90_000;
  let url;
  while (Date.now() < deadline) {
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(output);
    if (match !== null) { url = match[0]; break; }
    if (output.includes('startup failed')) throw new Error(`启动失败：${errors.slice(-600)}`);
    await new Promise((settle) => setTimeout(settle, 400));
  }
  if (url === undefined) throw new Error(`等待启动超时：${errors.slice(-600)}`);

  browser = await launchBrowser({ executable: '/usr/bin/google-chrome', port: 9262, userDataDir: tempHome('chrome-connector-toggle') });
  const page = await browser.open();
  try {
    await page.navigate(url);
    await new Promise((settle) => setTimeout(settle, 12_000));

    const created = await page.evaluate(`(async () => {
      const service = globalThis.__CHATDSH_REMOTE__?.namespaces.get('chatdshConnectors')?.service;
      if (service === undefined) return { ok: false, error: 'connectors 命名空间不可用' };
      try {
        const record = await service.save({ name: 'e2e-connector', transport: 'http', url: 'http://127.0.0.1:9', enabled: true });
        return { ok: true, id: record.value.id };
      } catch (error) { return { ok: false, error: String(error) }; }
    })()`);
    if (created.ok !== true) throw new Error(`创建连接器失败：${created.error}`);
    console.log(`已创建连接器：${created.id}`);

    const clicked = await page.evaluate(`(() => {
      const settings = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '设置');
      if (settings === undefined) return false;
      settings.click();
      return true;
    })()`);
    if (clicked !== true) throw new Error('没有找到设置按钮');
    await new Promise((settle) => setTimeout(settle, 2500));

    const section = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '连接器');
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    if (section !== true) throw new Error('没有找到连接器区段');
    await new Promise((settle) => setTimeout(settle, 2000));

    const before = await page.evaluate('document.body.innerText');
    if (!before.includes('e2e-connector')) throw new Error('连接器面板没有列出新建记录');

    const toggled = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '停用');
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    if (toggled !== true) throw new Error('没有找到停用按钮');
    await new Promise((settle) => setTimeout(settle, 2500));

    const after = await page.evaluate('document.body.innerText');
    if (!after.includes('（已停用）')) throw new Error('点击后界面没有显示已停用');
    const stored = await page.evaluate(`(async () => {
      const service = globalThis.__CHATDSH_REMOTE__.namespaces.get('chatdshConnectors').service;
      const list = await service.list();
      return list.value.find((record) => record.name === 'e2e-connector');
    })()`);
    if (stored?.enabled !== false) throw new Error('存储里的连接器没有变成停用');
    console.log('点击后界面与存储都已停用');

    await page.evaluate(`(async () => {
      const service = globalThis.__CHATDSH_REMOTE__.namespaces.get('chatdshConnectors').service;
      await service.delete(${JSON.stringify(created.id)});
    })()`);
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
console.log('连接器面板点击交互验收通过');
