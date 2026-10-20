// 已读同步的验收。
//
// 两个订阅连在同一个账号上，一端上报已读水位，另一端应当收到一条带着新水位的通知。
// 用一次性推模式（all-at-once）避免两段式的升级时序干扰这一项。
//
// 用法：node scripts/verify-receipt-sync.mjs [--port 3188]
// 退出码 0 表示两端都收到通知且水位一致。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3188 : Number.parseInt(argv[index + 1], 10);
const HOME = tempHome('receipt-home');

mkdirSync(HOME, { recursive: true });

const child = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
  env: {
    ...process.env,
    DSH_HOME: HOME,
    CHATDSH_GATEWAY_PORT: String(PORT),
    CHATDSH_PUSH_MODE: 'all-at-once',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const base = `http://127.0.0.1:${PORT}`;
const login = 'receipt@example.test';

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

/** 打开一个 SSE 订阅，收集收到的 data 行。 */
async function subscribe(deviceId) {
  const controller = new AbortController();
  const response = await fetch(`${base}/chatdsh/gateway/events`, {
    headers: { 'tailscale-user-login': login, 'x-chatdsh-device-id': deviceId },
    signal: controller.signal,
  });
  const received = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) received.push(line.slice(6));
        }
      }
    } catch {
      // 订阅关闭。
    }
  })();
  return { received, close: () => controller.abort() };
}

const failures = [];
try {
  await waitReady();
  console.log(`控制平面已就绪：${base}`);

  const sessionId = '99999999-8888-7777-6666-555555555555';
  await fetch(`${base}/chatdsh/gateway/replica`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'tailscale-user-login': login },
    body: JSON.stringify({ sessionId, events: [0, 1, 2, 3].map((seq) => ({ seq, kind: 'session/end-seed', time: Date.now() + seq, bytes: 4 })) }),
  });

  const first = await subscribe('device-a');
  const second = await subscribe('device-b');
  await new Promise((settle) => setTimeout(settle, 800));

  // 副本有新事件时，在线设备也应当收到通知——这是跨端实时一致性的来源。
  await fetch(`${base}/chatdsh/gateway/replica`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'tailscale-user-login': login },
    body: JSON.stringify({ sessionId, events: [{ seq: 4, kind: 'session/end-seed', time: Date.now(), bytes: 4 }] }),
  });

  const response = await fetch(`${base}/chatdsh/gateway/receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'tailscale-user-login': login, 'x-chatdsh-device-id': 'device-a' },
    body: JSON.stringify({ sessionId, readUpToSeq: 3 }),
  });
  console.log(`上报已读：${response.status}`);
  if (response.status !== 200) failures.push(`上报已读失败（${response.status}）`);

  await new Promise((settle) => setTimeout(settle, 1200));

  const receipts = await (await fetch(`${base}/chatdsh/gateway/receipt?sessionId=${sessionId}`, {
    headers: { 'tailscale-user-login': login },
  })).json();
  console.log(`已读记录：${JSON.stringify(receipts.receipts ?? [])}`);
  if ((receipts.receipts ?? []).length === 0) failures.push('已读记录为空');
  if ((receipts.receipts ?? []).some((row) => row.deviceId !== 'device-a')) {
    failures.push('回执没有按设备标识区分');
  }

  const parseReceipt = (lines) => lines.filter((line) => line.includes('"kind":"receipt"'));
  const parseReplica = (lines) => lines.filter((line) => line.includes('"kind":"replica"'));
  const onFirst = parseReceipt(first.received);
  const onSecond = parseReceipt(second.received);
  console.log(`订阅 A 收到已读通知 ${onFirst.length} 条，订阅 B 收到 ${onSecond.length} 条`);
  if (onFirst.length === 0) failures.push('订阅 A 没有收到已读通知');
  if (onSecond.length === 0) failures.push('订阅 B 没有收到已读通知');

  const replicas = [...parseReplica(first.received), ...parseReplica(second.received)];
  console.log(`收到副本变更通知 ${replicas.length} 条`);
  if (replicas.length === 0) failures.push('副本变更没有通知到设备');
  for (const line of [...onFirst, ...onSecond]) {
    if (!line.includes('"readUpToSeq":3')) failures.push('通知里的水位不是 3');
  }

  first.close();
  second.close();
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
console.log('已读同步验收通过');
process.exit(0);
