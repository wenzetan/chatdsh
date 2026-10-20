// 双运行时分派的验收。
//
// 起两个真实的 dsh 实例（各自独立的数据根与端口），控制平面把两个账号分别分派过去。同一
// 账号的两次请求应当落到同一个实例，两个账号的请求应当落到不同实例——用响应体的指纹判定。
//
// 用法：node scripts/verify-routing-live.mjs [--port 3191]
// 退出码 0 表示两个账号各自稳定落到自己的实例，且互不相同。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * 在数据根里挂上 profile。
 * @param home - 该实例的数据根。
 * @param profileName - profile 名称。
 */
function ensureProfile(home, profileName) {
  mkdirSync(join(home, 'profiles'), { recursive: true });
  const link = join(home, 'profiles', profileName);
  if (!existsSync(link)) symlinkSync(join(ROOT, 'profiles', profileName), link);
}
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3191 : Number.parseInt(argv[index + 1], 10);
// 三个数据根都走 tempHome：正常结束、异常退出、信号中断时都会清理。
const runtimes = [
  { name: 'a', port: 3091, profile: 'chatdsh-web', home: tempHome('route-a') },
  // 第二个实例用桌面形态：它多启用一个侧栏面板，页面内联的启动条目因此与 web 形态不同，
  // 这正是区分两者落点的依据。
  { name: 'b', port: 3092, profile: 'chatdsh-desktop', home: tempHome('route-b') },
];
const GATEWAY_HOME = tempHome('routing-live');

const children = [];

/** 起一个 dsh 实例，等它的启动行。 */
async function startRuntime(runtime) {
  ensureProfile(runtime.home, runtime.profile); // gitleaks:allow
  const child = spawn(dshCommand(), ['--profile', runtime.profile, '--port', String(runtime.port), '--no-open'], {
    env: { ...process.env, DSH_HOME: runtime.home }, // gitleaks:allow
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    if (match) return match[1];
    if (output.includes('startup failed')) throw new Error(`实例 ${runtime.name} 启动失败：\n${output.slice(-500)}`);
    await delay(400);
  }
  throw new Error(`实例 ${runtime.name} 启动超时：\n${output.slice(-500)}`);
}

const failures = [];
let gateway;
try {
  const bootA = await startRuntime(runtimes[0]);
  console.log(`实例 a 已启动：${bootA.split('?')[0]}`);
  const bootB = await startRuntime(runtimes[1]);
  console.log(`实例 b 已启动：${bootB.split('?')[0]}`);

  gateway = spawn(process.execPath, [resolve(ROOT, 'packages/gateway/lib/main.js')], {
    env: {
      ...process.env,
      DSH_HOME: GATEWAY_HOME,
      CHATDSH_GATEWAY_PORT: String(PORT),
      CHATDSH_RUNTIME_ROUTES: JSON.stringify({
        'alice@example.test': `http://127.0.0.1:${runtimes[0].port}`,
        'bob@example.test': `http://127.0.0.1:${runtimes[1].port}`,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gateway);
  let output = '';
  gateway.stdout.on('data', (chunk) => { output += chunk; });
  gateway.stderr.on('data', (chunk) => { output += chunk; });

  const readyDeadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch {
      // 还没起来。
    }
    await delay(300);
  }
  if (!ready) throw new Error(`控制平面未就绪：\n${output.slice(-500)}`);
  console.log(`控制平面已就绪：http://127.0.0.1:${PORT}`);

  /** 用某个账号与对应实例的登录令牌请求反代根路径，返回响应体指纹。 */
  async function fingerprint(login, token) {
    // 第一次带令牌拿到会话 cookie，第二次用它取页面本体。
    const login_ = await fetch(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`, {
      headers: { 'tailscale-user-login': login },
      redirect: 'manual',
    });
    const cookie = (login_.headers.get('set-cookie') ?? '').split(';')[0];
    if (cookie === '') throw new Error(`没有拿到会话 cookie（${login}）`);
    const response = await fetch(`http://127.0.0.1:${PORT}/`, {
      headers: { 'tailscale-user-login': login, cookie },
      redirect: 'manual',
    });
    const body = await response.text();
    return {
      status: response.status,
      digest: createHash('sha256').update(body).digest('hex').slice(0, 12),
      length: body.length,
    };
  }

  const tokenA = new URL(bootA).searchParams.get('token') ?? '';
  const tokenB = new URL(bootB).searchParams.get('token') ?? '';
  if (tokenA === '' || tokenB === '') throw new Error('没有取到实例的登录令牌');

  const aliceOne = await fingerprint('alice@example.test', tokenA);
  const aliceTwo = await fingerprint('alice@example.test', tokenA);
  const bobOne = await fingerprint('bob@example.test', tokenB);
  const bobTwo = await fingerprint('bob@example.test', tokenB);

  console.log(`alice 两次：${aliceOne.digest}/${aliceOne.status} 与 ${aliceTwo.digest}/${aliceTwo.status}`);
  console.log(`bob 两次：${bobOne.digest}/${bobOne.status} 与 ${bobTwo.digest}/${bobTwo.status}`);

  if (aliceOne.digest !== aliceTwo.digest) failures.push('同一账号的两次请求落到了不同实例');
  if (bobOne.digest !== bobTwo.digest) failures.push('同一账号的两次请求落到了不同实例');
  if (aliceOne.digest === bobOne.digest) failures.push('两个账号落到了同一个实例');
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await delay(800);
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('双运行时分派验收通过');
process.exit(0);
