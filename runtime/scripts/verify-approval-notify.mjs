// 审批提醒与撤回：控制平面在副本上报里识别 approval/asked 与 approval/decided。
//
// 起真实控制平面进程与两条真实 SSE 订阅，把审批审计事件经副本上报端点推进来：
//   - approval/asked 进副本后，在线设备收到一条 kind=approval 的提醒；
//   - approval/decided 进副本后，尚未投递的同一会话同一关联键的提醒被撤回，不再补发。
// 撤回验证走离线队列：先让设备离线，让提醒落进队列，再上报 approval/decided，最后让设备
// 重连，确认队列里已经没有这条提醒。
//
// 用法：node scripts/verify-approval-notify.mjs
// 退出码 0 表示两项结论都成立。端口从 20190 起，被占用时顺延。

import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempHome } from './lib/cleanup.mjs';
import { findFreePort } from './lib/ports.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const failures = [];

/** 记一条断言结果。 */
function check(ok, label, detail) {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail === undefined ? '' : ` → ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 等一个条件成立。 */
async function waitFor(fn, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.ok) return last;
    await new Promise((settle) => setTimeout(settle, intervalMs));
  }
  return last ?? { ok: false, detail: '没有尝试' };
}

/** 起一个子进程并收集输出。 */
function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, output: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { state.output += chunk; });
  child.stderr.on('data', (chunk) => { state.output += chunk; });
  return state;
}

/** 建立一条 SSE 订阅，返回收到的通知与关闭函数。 */
function openConnection(port, deviceId) {
  return new Promise((resolve, reject) => {
    const received = [];
    const request = get({ host: '127.0.0.1', port, path: `/chatdsh/gateway/events?device=${encodeURIComponent(deviceId)}` }, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((item) => item.startsWith('data: '));
          if (line !== undefined) received.push(line.slice(6));
        }
      });
      resolve({ received, close: () => request.destroy() });
    });
    request.on('error', reject);
  });
}

/** 从一条 SSE 数据里取出审批项；兼容原始审批事件与通知批次。 */
function approvalItemsOf(raw) {
  const event = JSON.parse(raw);
  if (event.kind === 'approval') return [event];
  if (event.kind !== 'notification' || !Array.isArray(event.items)) return [];
  return event.items.filter((item) => item.kind === 'approval');
}

/** 向副本上报端点推一批事件。 */
async function reportEvents(base, deviceId, sessionId, events) {
  const response = await fetch(`${base}/chatdsh/gateway/replica`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-node-id': deviceId },
    body: JSON.stringify({ sessionId, events }),
  });
  if (!response.ok) throw new Error(`副本上报失败：${response.status} ${await response.text()}`);
  return response.json();
}

/** 构造一条带完整信封的副本事件。 */
function replicaEvent(seq, kind, data) {
  const time = Date.now();
  return {
    seq,
    kind,
    time,
    bytes: 1,
    payload: { type: kind, seq, time, data },
  };
}

const port = await findFreePort(20190);
const base = `http://127.0.0.1:${port}`;
const home = tempHome('verify-approval-notify');

const gateway = startProcess(process.execPath, [join(ROOT, 'gateway', 'lib', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_HOME: home,
    CHATDSH_TELEMETRY: 'off',
    CHATDSH_GATEWAY_HOST: '127.0.0.1',
    CHATDSH_GATEWAY_PORT: String(port),
    CHATDSH_GATEWAY_DB: join(home, 'gateway.sqlite'),
    CHATDSH_RUNTIME_URL: 'http://127.0.0.1:1',
    CHATDSH_PUSH_MODE: 'all-at-once',
  },
});

const connections = [];
try {
  const health = await waitFor(async () => {
    if (gateway.child.exitCode !== null) return { ok: false, detail: `控制平面已退出（${gateway.child.exitCode}）\n${gateway.output.slice(-800)}` };
    try {
      const response = await fetch(`${base}/healthz`);
      return { ok: response.ok, detail: String(response.status) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }, 30_000);
  check(health.ok, '控制平面已监听', health.detail);
  if (!health.ok) throw new Error('控制平面没有就绪');

  // 一台在线设备订阅推送。
  const deviceId = 'approval-device';
  const online = await openConnection(port, deviceId);
  connections.push(online);
  await new Promise((settle) => setTimeout(settle, 150));

  // 断言一：approval/asked 进副本后，在线设备收到 kind=approval 提醒。
  const sessionId = `session-${randomUUID()}`;
  const callId = `call-${randomUUID()}`;
  const requestId = `request-${randomUUID()}`;
  await reportEvents(base, deviceId, sessionId, [
    replicaEvent(0, 'turn/start', { turn: 1 }),
    replicaEvent(1, 'approval/asked', { id: requestId, toolName: 'bash', callId, reason: '需要执行命令' }),
  ]);
  const noticed = await waitFor(async () => {
    const hit = online.received.flatMap(approvalItemsOf)[0];
    return hit === undefined
      ? { ok: false, detail: `收到 ${online.received.length} 条：${JSON.stringify(online.received.map((raw) => JSON.parse(raw).kind))}` }
      : { ok: true, detail: hit };
  }, 10_000);
  const noticedCallId = noticed.detail?.callId ?? noticed.detail?.objectId;
  check(noticed.ok && noticedCallId === callId, '断言一：approval/asked 进副本后在线设备收到审批提醒', JSON.stringify(noticed.detail));

  // 断言二：approval/decided 撤回尚未投递的提醒。
  // 先让设备离线，让同一会话的另一条审批提醒落进离线队列，再上报 decided，最后重连确认没有补发。
  online.close();
  await new Promise((settle) => setTimeout(settle, 150));
  const pendingCallId = `call-pending-${randomUUID()}`;
  const pendingRequestId = `request-pending-${randomUUID()}`;
  await reportEvents(base, deviceId, sessionId, [
    { seq: 2, kind: 'approval/asked', time: Date.now(), bytes: 1, payload: { id: pendingRequestId, toolName: 'bash', callId: pendingCallId } },
  ]);
  await reportEvents(base, deviceId, sessionId, [
    replicaEvent(3, 'approval/decided', { id: pendingRequestId, outcome: 'allowed-once' }),
  ]);
  const back = await openConnection(port, deviceId);
  connections.push(back);
  await new Promise((settle) => setTimeout(settle, 500));
  const withdrew = await waitFor(async () => {
    const approval = back.received.flatMap(approvalItemsOf);
    const stillThere = approval.some((item) => (item.callId ?? item.objectId) === pendingCallId);
    return stillThere ? { ok: false, detail: `撤回的提醒仍被补发：${JSON.stringify(approval)}` } : { ok: true, detail: `重连后收到 ${approval.length} 条审批提醒，撤回的那条没有补发` };
  }, 5_000);
  check(withdrew.ok, '断言二：approval/decided 撤回尚未投递的提醒，重连后不再补发', withdrew.detail);
} catch (error) {
  check(false, '验收中断', error instanceof Error ? error.message : String(error));
  if (gateway.output !== '') console.log(`控制平面输出片段：\n${gateway.output.slice(-1200)}`);
} finally {
  for (const connection of connections) connection.close();
  gateway.child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 500));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('审批提醒与撤回验收通过');
process.exit(0);
