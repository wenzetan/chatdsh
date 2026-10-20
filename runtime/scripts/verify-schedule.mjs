// 定时与推送的验收。
//
// 控制平面登记一个短期到期的通知任务，设备订阅事件流。到期后任务应当被执行，设备应当收到
// 一条通知；再查一次任务列表，执行结果应当被记下来。
//
// 用法：node scripts/verify-schedule.mjs [--port 3192]
// 退出码 0 表示任务按期执行且通知投递到了在线设备。

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3192 : Number.parseInt(argv[index + 1], 10);
const HOME = tempHome('schedule-home');

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
const login = 'schedule@example.test';

async function waitReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // 还没起来。
    }
    await delay(300);
  }
  throw new Error(`控制平面未就绪：\n${output.slice(-600)}`);
}

function call(path, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'tailscale-user-login': login },
  });
}

const failures = [];
try {
  await waitReady();
  console.log(`控制平面已就绪：${base}`);

  const sessionId = 'ffffffff-1111-2222-3333-444444444444';
  await call('/chatdsh/gateway/replica', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, events: [{ seq: 0, kind: 'session/end-seed', time: Date.now(), bytes: 2 }] }),
  });

  // 订阅事件流，收集推送。
  const controller = new AbortController();
  const stream = await call('/chatdsh/gateway/events', {
    headers: { 'x-chatdsh-device-id': 'schedule-device' },
    signal: controller.signal,
  });
  const pushes = [];
  const reader = stream.body.getReader();
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
          if (line.startsWith('data: ')) pushes.push(line.slice(6));
        }
      }
    } catch {
      // 订阅结束。
    }
  })();
  await delay(600);

  const scheduled = await call('/chatdsh/gateway/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, action: 'notify', delayMs: 1500, payload: '验收用通知' }),
  });
  const created = await scheduled.json();
  console.log(`登记任务：${scheduled.status} ${JSON.stringify(created).slice(0, 120)}`);
  if (scheduled.status !== 200) failures.push(`登记失败（${scheduled.status}）`);

  await delay(6000);

  const listResponse = await call('/chatdsh/gateway/schedule');
  const listed = await listResponse.json();
  const tasks = listed.tasks ?? [];
  const task = tasks.find((item) => item.id === created.id);
  console.log(`任务状态：${JSON.stringify(task ?? '（未找到）')}`);
  if (task === undefined) failures.push('任务列表里没有刚登记的任务');
  else if (task.executedAt === undefined || task.executedAt === null) failures.push('任务没有在到期后执行');

  const notifyPushes = pushes.filter((line) => line.includes('"kind":"scheduled"'));
  console.log(`设备收到定时推送 ${notifyPushes.length} 条`);
  if (notifyPushes.length === 0) failures.push('设备没有收到定时任务的通知');

  controller.abort();
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  await delay(600);
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('定时与推送验收通过');
process.exit(0);
