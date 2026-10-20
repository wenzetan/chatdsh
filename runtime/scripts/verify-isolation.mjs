// 身份与隔离的验收。
//
// 控制平面按请求头识别账号。这里用两个不同的账号标识验证三条已经实现的规则：
// 归属表按账号隔离、跨账号读写副本被拒绝、带他人账号标识查询被拒绝。
//
// 用法：node scripts/verify-isolation.mjs [--port 3186]
// 退出码 0 表示三条都成立。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3186 : Number.parseInt(argv[index + 1], 10);
const HOME = tempHome('isolate-home');

mkdirSync(HOME, { recursive: true });

const child = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
  env: { ...process.env, DSH_HOME: HOME, CHATDSH_GATEWAY_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const base = `http://127.0.0.1:${PORT}`;

/** 等控制平面就绪。 */
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

/** 带身份头的请求。 */
function as(login) {
  return (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'tailscale-user-login': login },
  });
}

const failures = [];
try {
  await waitReady();
  console.log(`控制平面已就绪：${base}`);

  const alice = as('alice@example.test');
  const bob = as('bob@example.test');

  // 会话标识用固定值，副本上报与归属检查都不依赖真实运行时。
  const sessionId = '11111111-2222-3333-4444-555555555555';

  const appended = await alice('/chatdsh/gateway/replica', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, events: [{ seq: 0, kind: 'session/end-seed', time: Date.now(), bytes: 2 }] }),
  });
  console.log(`alice 上报副本：${appended.status}`);
  if (appended.status !== 200) failures.push('alice 的上报被拒绝');

  const aliceOwnership = await alice('/chatdsh/gateway/ownership');
  const aliceSessions = (await aliceOwnership.json()).sessions ?? [];
  if (!aliceSessions.some((session) => session.sessionId === sessionId)) {
    failures.push('alice 的归属表里没有刚上报的会话');
  }

  // 跨账号读副本：bob 的账号看到的副本里不应有 alice 的会话数据。
  const bobReplica = await bob(`/chatdsh/gateway/replica?sessionId=${sessionId}`);
  const bobBody = await bobReplica.json();
  console.log(`bob 读同一会话的副本：${bobReplica.status}，水位 ${JSON.stringify(bobBody.watermark ?? null)}`);
  if (bobReplica.status === 200 && bobBody.watermark !== null && bobBody.watermark !== undefined) {
    failures.push('bob 读到了 alice 的副本水位');
  }

  // 跨账号写：bob 用同一会话标识上报，应被拒绝。
  const bobAppend = await bob('/chatdsh/gateway/replica', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, events: [{ seq: 1, kind: 'session/end-seed', time: Date.now(), bytes: 2 }] }),
  });
  console.log(`bob 上报同一会话：${bobAppend.status}`);
  if (bobAppend.status !== 403) failures.push(`跨账号写入没有被拒绝（${bobAppend.status}）`);

  // 带他人账号标识查询归属表，应被拒绝。
  const spoof = await bob(`/chatdsh/gateway/ownership?accountId=${encodeURIComponent('alice@example.test')}`);
  console.log(`bob 查询 alice 的归属表：${spoof.status}`);
  if (spoof.status === 200) {
    const body = await spoof.json();
    if (body.accountId !== 'bob@example.test') failures.push('伪装账号标识取得了他人归属表');
  } else if (spoof.status !== 403) {
    failures.push(`伪装查询返回了意外状态 ${spoof.status}`);
  }
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 600));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('身份与隔离验收通过');
process.exit(0);
