// 回合记忆写入的端到端验收。
//
// 用一个真实的聊天回合驱动：ACP profile 配置测试模型网关与 Hindsight，发一条带唯一
// 标记的消息，然后轮询 Hindsight 新建的 turn-summary 文档。这条链路覆盖
// 「回合结束 → 读会话日志 → 模型摘要 → 算 bank → 写 Hindsight」。
//
// 前置：deploy/compose.yaml 的 Hermes 不参与；需要 Hindsight 在 HINDSIGHT_URL（默认
// http://127.0.0.1:8889）可用，测试模型网关由 CHATDSH_TEST_GATEWAY_API_KEY 提供。
//

// 用法：node scripts/verify-memory-turn.mjs [--profile chatdsh-acp-live] [--timeout 120000]
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
const RUN_STARTED = Date.now() - 5_000;

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

let childError = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { childError += chunk; });

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

async function findTurnDocument() {
  const listResponse = await fetch(`${HINDSIGHT}/v1/default/banks/${encodeURIComponent(BANK)}/documents?limit=20`);
  if (!listResponse.ok) return undefined;
  const list = await listResponse.json();
  for (const item of list.items ?? []) {
    if (typeof item.id !== 'string') continue;
    if (Date.parse(item.updated_at) < RUN_STARTED) continue;
    if (item.retain_params?.context !== 'turn-summary') continue;
    const detailResponse = await fetch(`${HINDSIGHT}/v1/default/banks/${encodeURIComponent(BANK)}/documents/${encodeURIComponent(item.id)}`);
    if (!detailResponse.ok) continue;
    const detail = await detailResponse.json();
    if (typeof detail.original_text === 'string' && detail.original_text.trim() !== '') return detail;
  }
  return undefined;
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
  let document;
  while (Date.now() < deadline) {
    document = await findTurnDocument();
    if (document !== undefined) break;
    await new Promise((settle) => setTimeout(settle, 1000));
  }
  if (document === undefined) {
    failures.push('回合结束后没有找到写入文档');
  } else {
    console.log(`写入文档：${String(document.original_text).slice(0, 160)}`);
    const text = String(document.original_text);
    if (text.includes('用户：') || text.includes('助手：')) failures.push('回合写入仍是规则抽取结果，模型摘要没有生效');
  }
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 600));
}

if (failures.length > 0 && childError.trim() !== '') console.log(`运行时错误：${childError.slice(-2000)}`);

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('回合记忆写入验收通过');
