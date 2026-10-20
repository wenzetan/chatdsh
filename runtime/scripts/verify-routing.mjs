// 多运行时分派的验收。
//
// 起两个轻量 HTTP 服务冒充两个运行时，控制平面按账号分派到各自的目标。两个账号各请求一次
// 反代路径，核对请求落到了不同的运行时。
//
// 用法：node scripts/verify-routing.mjs [--port 3190]
// 退出码 0 表示两个账号各自命中自己的运行时。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3190 : Number.parseInt(argv[index + 1], 10);
const HOME = tempHome('routing-home');

/** 起一个会自报名字的替身运行时。 */
function startRuntime(name, port) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ runtime: name, path: request.url ?? '/' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const runtimeA = await startRuntime('a', 3301);
const runtimeB = await startRuntime('b', 3302);

const child = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
  env: {
    ...process.env,
    DSH_HOME: HOME,
    CHATDSH_GATEWAY_PORT: String(PORT),
    CHATDSH_RUNTIME_ROUTES: JSON.stringify({
      'alice@example.test': 'http://127.0.0.1:3301',
      'bob@example.test': 'http://127.0.0.1:3302',
    }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const base = `http://127.0.0.1:${PORT}`;

async function waitReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // 还没起来。
    }
    await new Promise((settle) => setTimeout(settle, 300));
  }
  throw new Error(`控制平面未就绪：\n${output.slice(-600)}`);
}

const failures = [];
try {
  await waitReady();
  console.log(`控制平面已就绪：${base}`);

  const hit = async (login) => {
    const response = await fetch(`${base}/probe`, { headers: { 'tailscale-user-login': login } });
    return { status: response.status, body: await response.json() };
  };

  const alice = await hit('alice@example.test');
  const bob = await hit('bob@example.test');
  console.log(`alice 落到 ${JSON.stringify(alice.body)}`);
  console.log(`bob 落到 ${JSON.stringify(bob.body)}`);
  if (alice.body.runtime !== 'a') failures.push(`alice 没有落到 a（${alice.body.runtime}）`);
  if (bob.body.runtime !== 'b') failures.push(`bob 没有落到 b（${bob.body.runtime}）`);

  // 未配置分派的账号回落到默认运行时。默认地址在本机指向别的服务，只核对它没有落到
  // 上面两个替身。
  const carol = await fetch(`${base}/probe`, { headers: { 'tailscale-user-login': 'carol@example.test' } });
  const carolBody = await carol.text();
  console.log(`carol 的状态 ${carol.status}，${carolBody.length} 字节`);
  if (carolBody.includes('"runtime":"a"') || carolBody.includes('"runtime":"b"')) {
    failures.push('未配置分派的账号被误投到了已知运行时');
  }
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  runtimeA.close();
  runtimeB.close();
  await new Promise((settle) => setTimeout(settle, 600));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('多运行时分派验收通过');
process.exit(0);
