// MCP 全局注册与按设备端点记录的真实验收。
//
// 三段验收：
//   1. 设备 A 上报 context7 的端点，注册表里出现这台服务器；
//   2. 设备 B 读到同一台服务器，并上报自己那一段不同的连接方式；
//   3. 用 B 那一段配置经标准 MCP 客户端真实连接一次，证明记录能直接驱动接入。
//
// 用法：node scripts/verify-mcp-registry.mjs [--port 3197] [--url https://mcp.context7.com/mcp]
// 退出码 0 表示三段都成立。

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from './lib/cleanup.mjs';
import { ensureDeps } from '../e2e/lib/ensure-deps.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(ROOT, '..');
ensureDeps(ROOT);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const PORT = Number.parseInt(value('--port', '3197'), 10);
const ENDPOINT = value('--url', 'https://mcp.context7.com/mcp');

/** 停一个子进程。 */
async function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const home = tempHome('mcp-registry-live');
const child = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
  env: {
    ...process.env,
    DSH_HOME: home, // gitleaks:allow
    CHATDSH_GATEWAY_PORT: String(PORT),
    CHATDSH_ACCESS_PROVIDER: 'manual',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { output += chunk; });

const failures = [];
try {
  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`控制平面退出（${child.exitCode}）：\n${output.slice(-800)}`);
    const health = await fetch(`${base}/healthz`).catch(() => undefined);
    if (health?.ok === true) break;
    await delay(200);
  }

  const call = (method, body, deviceId) => fetch(`${base}/chatdsh/gateway/mcp${method === 'DELETE' ? '?server=context7' : ''}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'tailscale-user-login': 'alice',
      'x-chatdsh-device-id': deviceId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // 第一段：设备 A 上报。
  const first = await call('PUT', { servers: { context7: { type: 'http', url: ENDPOINT } } }, 'device-a');
  if (first.status !== 200) failures.push(`设备 A 上报失败：${first.status}`);
  const afterFirst = await first.json();
  if (!afterFirst.servers.some((server) => server.name === 'context7')) failures.push('设备 A 上报后注册表里没有 context7');
  console.log(`设备 A 上报通过：注册 ${afterFirst.servers.length} 台服务器，端点 ${afterFirst.endpoints.length} 段`);

  // 第二段：设备 B 读到全局注册，并上报自己的连接方式。
  const read = await call('GET', undefined, 'device-b');
  const snapshot = await read.json();
  if (!snapshot.servers.some((server) => server.name === 'context7')) failures.push('设备 B 读不到设备 A 上报的服务器');
  const second = await call('PUT', { servers: { context7: { type: 'http', url: ENDPOINT } } }, 'device-b');
  const afterSecond = await second.json();
  const endpoints = afterSecond.endpoints.filter((endpoint) => endpoint.server === 'context7');
  if (endpoints.length !== 2) failures.push(`同一服务器应当有 2 段端点，实际 ${endpoints.length}`);
  console.log(`设备 B 读取与上报通过：同一服务器 ${endpoints.length} 段端点，设备 ${endpoints.map((endpoint) => endpoint.deviceId).join('、')}`);

  // 第三段：用设备 B 的记录真实连接一次。
  const mine = endpoints.find((endpoint) => endpoint.deviceId === 'device-b');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'chatdsh-mcp-registry-e2e', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mine.row.url)));
    const tools = await client.listTools();
    if (tools.tools.length === 0) failures.push('按记录连接后远端工具目录为空');
    console.log(`按记录真实接入通过：${tools.tools.length} 个工具（${tools.tools.map((tool) => tool.name).join('、')}）`);
  } finally {
    await client.close();
  }

  // 设备 B 移除自己那一段，设备 A 不受影响。
  const removed = await call('DELETE', undefined, 'device-b');
  const afterRemove = await removed.json();
  if (afterRemove.endpoints.filter((endpoint) => endpoint.server === 'context7').length !== 1) {
    failures.push('设备 B 移除后应当只剩设备 A 那一段');
  }
  console.log('单设备移除通过：另一段端点保留，全局注册仍在');
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await stop(child);
}

if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('MCP 注册表验收通过');
