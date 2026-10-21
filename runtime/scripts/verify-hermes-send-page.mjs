// Hermes 聊天 send 的页面上下文端到端验收。
//
// 用真实运行时、真实浏览器页面与真实 Hermes 测试容器：页面里的联调桥挂载自建
// Remote 贡献，脚本在页面上下文创建会话并调用 `chatdshHermesChat.send`，断言回复文本
// 与写入事件数。前端资源来自 e2e/profiles/chatdsh-hermes-live。
//
// 前置：deploy/compose.yaml 的 Hermes 在 50011 可用；CHATDSH_TEST_GATEWAY_API_KEY
// 提供测试模型；HERMES_API_KEY 提供 Hermes 凭据。
//
// 用法：node scripts/verify-hermes-send-page.mjs [--port 50062]
// 退出码 0 表示 send 返回助手文本且写入了 6 条事件。

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 50062 : Number.parseInt(argv[index + 1], 10);
const PROFILE = 'chatdsh-hermes-live';

const HOME = tempHome('hermes-send-page');
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
  console.log(`运行时已启动：${url.split('?')[0]}`);

  browser = await launchBrowser({
    executable: '/usr/bin/google-chrome',
    port: 9253,
    userDataDir: tempHome('chrome-hermes-send'),
  });
  const page = await browser.open();
  try {
    await page.navigate(url);
    await new Promise((settle) => setTimeout(settle, 12_000));
    const result = await page.evaluate(`(async () => {
      const remote = globalThis.__CHATDSH_REMOTE__;
      const ns = globalThis.__CHATDSH_NAMESPACE__;
      if (remote === undefined || ns === undefined) return { ok: false, error: '联调桥没有挂载' };
      const sessionSvc = remote.namespaces.get('session')?.service;
      if (sessionSvc === undefined) return { ok: false, error: 'session 命名空间不可用' };
      const created = await sessionSvc.create({ cwd: ${JSON.stringify(ROOT)}, preset: 'chatdsh' });
      const sessionId = created.value.sessionId;
      const sent = await ns.send(sessionId, '只回复两个字：收到');
      return { ok: true, sessionId, sent };
    })()`);
    console.log(`页面调用结果：${JSON.stringify(result).slice(0, 400)}`);
    if (result.ok !== true) failures.push(result.error ?? '页面调用失败');
    else if (result.sent?.ok !== true) failures.push(`send 返回失败：${JSON.stringify(result.sent?.error)}`);
    else if (result.sent.value.appended !== 6) failures.push(`写入事件数应为 6，实际 ${result.sent.value.appended}`);
    else if (!String(result.sent.value.assistantText ?? '').includes('收到')) failures.push('助手文本里没有「收到」');
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
console.log('页面上下文 send 验收通过');
