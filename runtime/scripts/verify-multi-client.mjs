// 多客户端共存的验收（当前实现覆盖的部分）。
//
// 两个客户端读同一会话的副本，应当得到逐条相同、按序号连续的事件序列；一端落后之后按水位
// 补齐，补齐的内容与另一端一致。已读同步与审批收敛依赖客户端之间的实时通道，尚未实现。
//
// 用法：node scripts/verify-multi-client.mjs [--port 3187]
// 退出码 0 表示两端序列一致且补齐正确。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3187 : Number.parseInt(argv[index + 1], 10);
const HOME = tempHome('multi-home');

mkdirSync(HOME, { recursive: true });

const child = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
  env: { ...process.env, DSH_HOME: HOME, CHATDSH_GATEWAY_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const base = `http://127.0.0.1:${PORT}`;
const login = 'multi@example.test';

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
function call(path, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'tailscale-user-login': login },
  });
}

/** 上报一批事件。 */
async function append(sessionId, events) {
  const response = await call('/chatdsh/gateway/replica', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, events }),
  });
  if (response.status !== 200) throw new Error(`上报失败：${response.status} ${await response.text()}`);
  return response.json();
}

/** 读副本。 */
async function read(sessionId) {
  const response = await call(`/chatdsh/gateway/replica?sessionId=${sessionId}`);
  if (response.status !== 200) throw new Error(`读取失败：${response.status}`);
  return response.json();
}

const failures = [];
try {
  await waitReady();
  console.log(`控制平面已就绪：${base}`);

  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const first = [0, 1, 2].map((seq) => ({ seq, kind: 'session/end-seed', time: Date.now() + seq, bytes: 4 }));
  await append(sessionId, first);

  // 两个客户端各自读一次，序列应当逐条相同。
  const clientA = await read(sessionId);
  const clientB = await read(sessionId);
  const seqOf = (payload) => (payload.events ?? []).map((event) => event.seq);
  console.log(`客户端 A 读到序号 ${JSON.stringify(seqOf(clientA))}`);
  console.log(`客户端 B 读到序号 ${JSON.stringify(seqOf(clientB))}`);
  if (JSON.stringify(seqOf(clientA)) !== JSON.stringify(seqOf(clientB))) {
    failures.push('两端读到的事件序号不一致');
  }
  if (JSON.stringify(seqOf(clientA)) !== JSON.stringify([0, 1, 2])) {
    failures.push('副本的序号不连续');
  }

  // 一端落后：再上报两条之后，落后的一端按水位补齐。
  await append(sessionId, [3, 4].map((seq) => ({ seq, kind: 'session/end-seed', time: Date.now() + seq, bytes: 4 })));
  const caughtUp = await read(sessionId);
  console.log(`补齐后读到序号 ${JSON.stringify(seqOf(caughtUp))}，水位 ${JSON.stringify(caughtUp.watermark)}`);
  if (JSON.stringify(seqOf(caughtUp)) !== JSON.stringify([0, 1, 2, 3, 4])) {
    failures.push('补齐后的事件序列不完整');
  }
  if (caughtUp.watermark !== 4) failures.push(`水位应为 4，实际 ${caughtUp.watermark}`);

  // 重复上报同一条事件不应产生重复记录。
  await append(sessionId, [{ seq: 4, kind: 'session/end-seed', time: Date.now(), bytes: 4 }]);
  const afterDuplicate = await read(sessionId);
  const seqs = seqOf(afterDuplicate);
  if (new Set(seqs).size !== seqs.length) failures.push('重复上报产生了重复记录');
  console.log(`重复上报后台并：${JSON.stringify(seqs)}`);

  // 同一个序号带着不同内容再来一次：先到者胜，后来者不得改写。
  await append(sessionId, [{ seq: 4, kind: 'session/end-seed', time: Date.now(), bytes: 99 }]);
  const afterRewrite = await read(sessionId);
  const seq4 = (afterRewrite.events ?? []).find((event) => event.seq === 4);
  console.log(`序号 4 的字节数：${JSON.stringify(seq4?.bytes ?? null)}`);
  if (seq4 !== undefined && seq4.bytes === 99) failures.push('后到的同序号事件覆盖了已有记录');
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
console.log('多客户端共存验收通过（覆盖副本一致性部分）');
process.exit(0);
