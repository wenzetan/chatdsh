// 自建 Remote 命名空间的页面挂载验收。
//
// 启动带联调桥的运行时，在页面里读取 `ctx.remote.namespaces`，断言每个自建服务的
// 客户端 contribution 都已挂载。缺一个就列出名字并失败。
//
// 用法：node scripts/verify-remote-namespaces.mjs [--port 50063]
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
const PORT = index < 0 ? 50063 : Number.parseInt(argv[index + 1], 10);
const PROFILE = 'chatdsh-hermes-live';

/** 必须在页面里挂载的自建命名空间。 */
const EXPECTED = [
  'chatdshApprovals',
  'chatdshArtifacts',
  'chatdshAssistants',
  'chatdshConnectors',
  'chatdshContextInsights',
  'chatdshHermesChat',
  'chatdshMemory',
  'chatdshModelProviders',
  'chatdshProjects',
  'chatdshSkills',
];

const HOME = tempHome('remote-namespaces');
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
  browser = await launchBrowser({ executable: '/usr/bin/google-chrome', port: 9254, userDataDir: tempHome('chrome-remote-namespaces') });
  const page = await browser.open();
  try {
    await page.navigate(url);
    await new Promise((settle) => setTimeout(settle, 14_000));
    const mounted = await page.evaluate(`(() => {
      const remote = globalThis.__CHATDSH_REMOTE__;
      if (remote === undefined) return null;
      return [...remote.namespaces.keys()];
    })()`);
    console.log(`已挂载命名空间：${JSON.stringify(mounted)}`);
    if (mounted === null) failures.push('页面里没有 ctx.remote');
    else {
      const missing = EXPECTED.filter((name) => !mounted.includes(name));
      if (missing.length > 0) failures.push(`缺少命名空间：${missing.join('、')}`);
    }
    if (mounted !== null) {
      const calls = await page.evaluate(`(async () => {
        const remote = globalThis.__CHATDSH_REMOTE__;
        const service = (name) => remote.namespaces.get(name)?.service;
        const tasks = {
          chatdshApprovals: () => service('chatdshApprovals').pending(),
          chatdshArtifacts: () => service('chatdshArtifacts').list('no-session'),
          chatdshAssistants: () => service('chatdshAssistants').list(),
          chatdshConnectors: () => service('chatdshConnectors').list(),
          chatdshContextInsights: () => service('chatdshContextInsights').all(),
          chatdshHermesChat: () => service('chatdshHermesChat').health(),
          chatdshMemory: () => service('chatdshMemory').status(),
          chatdshModelProviders: () => service('chatdshModelProviders').status(),
          chatdshProjects: () => service('chatdshProjects').list(),
          chatdshSkills: () => service('chatdshSkills').catalog(),
        };
        const out = {};
        for (const [name, call] of Object.entries(tasks)) {
          try { out[name] = await call(); } catch (error) { out[name] = { threw: String(error) }; }
        }
        return out;
      })()`);
      for (const [name, result] of Object.entries(calls)) {
        if (result?.ok !== true) failures.push(`${name} 只读调用失败：${JSON.stringify(result).slice(0, 160)}`);
      }
      console.log(`只读调用：${Object.keys(calls).length} 个命名空间`);
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
console.log('自建 Remote 命名空间挂载验收通过');
