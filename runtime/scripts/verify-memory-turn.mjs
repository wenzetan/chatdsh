// 回合记忆写入的端到端验收。
//
// 用一个真实的聊天回合驱动：ACP profile 配置测试模型网关与 Hindsight，发一条带唯一
// 标记的消息，然后轮询 Hindsight 的账号 bank，确认标记落进了记忆。这条链路覆盖
// 「回合结束 → 读会话日志 → 算 bank → 写 Hindsight」，不是纯函数测试。
//
// 前置：deploy/compose.yaml 的 Hermes 不参与；需要 Hindsight 在 HINDSIGHT_URL（默认
// http://127.0.0.1:8889）可用，测试模型网关由 CHATDSH_TEST_GATEWAY_API_KEY 提供。
//
// 用法：node scripts/verify-memory-turn.mjs [--profile chatdsh-acp-live] [--timeout 120000]
// 退出码 0 表示标记出现在召回结果里。

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
  return argv[index + 1] ?? fallback;
}
const PROFILE = option('profile', 'chatdsh-acp-live');
const TIMEOUT = Number.parseInt(option('timeout', '120000'), 10);
const HINDSIGHT = process.env.HINDSIGHT_URL ?? 'http://127.0.0.1:8889';
const BANK = 'acct:local';
const MARKER = `chatdsh-turn-${Date.now()}`;

const HOME = tempHome('memory-turn');
mkdirSync(join(HOME, 'profiles'), { recursive: true });
symlinkSync(resolve(ROOT, 'e2e', 'profiles', PROFILE), join(HOME, 'profiles', PROFILE));

const child = spawn(dshCommand(), ['--profile', PROFILE], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 0;
const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter === undefined) continue;
    pending.delete(message.id);
    if (message.error === undefined) waiter.resolve(message.result);
    else waiter.reject(new Error(JSON.stringify(message.error)));
  }
});
child.stderr.resume();

function request(method, params, timeoutMs = 120_000) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

const failures = [];
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session = await request('session/new', { cwd: '/workspace/chatdsh', mcpServers: [] });
  await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: `这次对话的标记是 ${MARKER}，请只回复：收到` }],
  });
  console.log(`回合完成，等待记忆写入：${MARKER}`);

  const deadline = Date.now() + TIMEOUT;
  let matched = 0;
  while (Date.now() < deadline) {
    const response = await fetch(`${HINDSIGHT}/v1/default/banks/${encodeURIComponent(BANK)}/memories/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: MARKER, max_tokens: 512 }),
    });
    if (response.ok) {
      const payload = await response.json();
      matched = (payload.results ?? []).filter((item) => String(item.text ?? '').includes(MARKER)).length;
      if (matched > 0) break;
    }
    await new Promise((settle) => setTimeout(settle, 3000));
  }
  console.log(`召回命中标记：${matched} 条`);
  if (matched === 0) failures.push('回合结束后没有召回命中标记');
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
console.log('回合记忆写入验收通过');
