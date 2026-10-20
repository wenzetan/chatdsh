// 验证客户端插件进入了浏览器模块图，并且产物可取回。
//
// 流程：启动一个 Web 形态的 profile，用启动时打印的 token 换取鉴权 cookie，取回首页，
// 在 `window.__DSH_BOOT__` 的条目里找到目标客户端包，再按它自己的 combo URL 请求产物。
// 这三步分别对应「宿主激活」「模块图包含」「浏览器可取回」。
//
// 用法：
//   node scripts/verify-client-asset.mjs --profile chatdsh-web --package @chatdsh/client-telemetry [--port 3098]
// 环境变量：DSH_HOME 指定数据根。退出码 0 表示三项都成立。

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

const PROFILE = option('profile');
const PACKAGE = option('package');
const PORT = Number.parseInt(option('port', '3098'), 10);
if (PROFILE === undefined) throw new Error('必须给出 --profile');
if (PACKAGE === undefined) throw new Error('必须给出 --package');

// 独立数据根：脚本的结果不依赖外部环境里已有的会话与存储。
const HOME = tempHome('client-asset');
mkdirSync(join(HOME, 'profiles'), { recursive: true });
symlinkSync(join(ROOT, 'profiles', PROFILE), join(HOME, 'profiles', PROFILE));

const child = spawn(dshCommand(), ['--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { output += chunk; });

/** 等待启动行出现，返回带 token 的地址。 */
async function waitForUrl(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    if (match) return match[1];
    if (output.includes('startup failed')) throw new Error(`启动失败：\n${output.slice(-1200)}`);
    await new Promise((settle) => setTimeout(settle, 500));
  }
  throw new Error(`等待启动超时，已收到输出：\n${output.slice(-1200)}`);
}

const failures = [];
try {
  const bootUrl = await waitForUrl();
  const base = new URL(bootUrl);
  const origin = `${base.protocol}//${base.host}`;
  console.log(`运行时已启动：${origin}`);

  // token 换 cookie：这一步返回 303 并带上会话 cookie。
  const login = await fetch(bootUrl, { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (cookie === '') throw new Error('没有拿到鉴权 cookie');
  console.log(`鉴权通过，cookie 长度 ${cookie.length}`);

  const page = await fetch(`${origin}/`, { headers: { cookie } });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`首页返回 ${page.status}`);

  const ids = [...html.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]);
  console.log(`模块图条目 ${ids.length} 个`);
  if (!ids.includes(PACKAGE)) {
    failures.push(`模块图里没有 ${PACKAGE}`);
  } else {
    console.log(`模块图包含 ${PACKAGE}`);
  }

  const escaped = PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const asset = html.match(new RegExp(`plugins/\\?\\?${escaped}/client\\.js&rev=[0-9a-z]+`));
  if (asset === null) {
    failures.push(`${PACKAGE} 没有独立的产物地址`);
  } else {
    const response = await fetch(`${origin}/${asset[0]}`, { headers: { cookie } });
    const body = await response.text();
    console.log(`产物返回 ${response.status}，${body.length} 字节`);
    if (response.status !== 200) failures.push(`产物返回 ${response.status}`);
    if (!body.includes('__ModuleLoader__.load')) failures.push('产物不是模块加载器格式');
    if (!body.includes(PACKAGE)) failures.push('产物里没有包标识');
  }
} catch (error) {
  console.log(`验证中断：${String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 600));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('客户端产物验证通过');
process.exit(0);
