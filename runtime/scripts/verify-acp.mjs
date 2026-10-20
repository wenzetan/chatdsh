// 端到端验证：用 ACP 协议驱动一个 profile，创建会话、可选发一条消息，然后读回自建投影。
//
// ACP 走 stdio 上的 JSON-RPC：`initialize`、`session/new`、`session/prompt`。会话创建成功说明
// profile 组合、插件激活与预设注册在真实运行时里成立；投影缓存里出现 `chatdsh*` 单元说明
// 自建投影真的在折叠会话事件。
//
// 用法：
//   node scripts/verify-acp.mjs --profile chatdsh-acp [--cwd <目录>] [--prompt "<消息>"]
// 数据根由脚本自建，profile 目录链接在其中，投影缓存也从那里读取。
// 退出码：0 表示会话创建成功且自建投影出现；1 表示任一项失败。

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

const PROFILE = option('profile');
if (PROFILE === undefined) throw new Error('必须给出 --profile');
const CWD = resolve(option('cwd', process.cwd()));
const PROMPT = option('prompt', undefined);
const RESUME = option('resume', undefined);
// 自建数据根并链接 profile 目录：不依赖外部 DSH_HOME 里是否已经装好该 profile。
const HOME = tempHome('acp');
mkdirSync(join(HOME, 'profiles'), { recursive: true });
symlinkSync(resolve(ROOT, 'e2e', 'profiles', PROFILE), join(HOME, 'profiles', PROFILE));

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const child = spawn(dshCommand(), ['--profile', PROFILE], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 0;
const pending = new Map();
let buffer = '';
const stderrLog = [];
/** 收到的 session/update 通知，用于核对流式事件。 */
const updates = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) {
      // 无 id 的是通知；session/update 承载流式事件。
      if (message.method === 'session/update') updates.push(message.params);
      continue;
    }
    if (pending.has(message.id)) {
      const { resolve: settle, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else settle(message.result);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderrLog.push(chunk));

function request(method, params, timeoutMs = 90_000) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((settle, reject) => {
    pending.set(id, { resolve: settle, reject });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`${method} 在 ${timeoutMs} 毫秒内没有响应`));
    }, timeoutMs);
  });
}

function stop() {
  child.stdin.end();
  child.kill('SIGTERM');
}

const failures = [];
let sessionId;

try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  console.log(`initialize 通过，protocolVersion=${init.protocolVersion}`);

  const created = RESUME === undefined
    ? await request('session/new', { cwd: CWD, mcpServers: [] })
    : await request('session/resume', { sessionId: RESUME, cwd: CWD, mcpServers: [] });
  sessionId = created.sessionId ?? RESUME;
  console.log(`${RESUME === undefined ? 'session/new' : 'session/resume'} 通过，会话 ${sessionId}`);

  if (PROMPT !== undefined) {
    try {
      await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: PROMPT }] });
      console.log(`session/prompt 通过，收到 ${updates.length} 条流式事件`);
      if (updates.length === 0) failures.push('prompt');
    } catch (error) {
      // 传了 --prompt 就意味着这一阶段也要验；模型侧失败如实计入失败项。
      failures.push('prompt');
      console.log(`session/prompt 返回错误：${String(error).slice(0, 240)}`);
    }
  }
} catch (error) {
  console.log(`协议阶段失败：${String(error)}`);
  failures.push('protocol');
} finally {
  // 给上报插件的定时器留出窗口：它按间隔成批推送，进程退出会丢掉未发出的批次。
  await new Promise((settle) => setTimeout(settle, 2000));
  stop();
}

// 等进程退出，确保投影缓存已经落盘。
await new Promise((settle) => setTimeout(settle, 1200));

const cacheDir = join(HOME, 'storages', 'session_projcache', 'sessions');
if (sessionId !== undefined && await exists(cacheDir)) {
  const files = (await readdir(cacheDir)).filter((name) => name.includes(sessionId));
  if (files.length === 0) {
    console.log('投影缓存里没有该会话的记录');
    failures.push('projection-cache');
  } else {
    const record = JSON.parse(await readFile(join(cacheDir, files[0]), 'utf8'));
    const rows = record.record?.rows ?? {};
    const own = Object.keys(rows).filter((key) => key.startsWith('chatdsh'));
    if (own.length === 0) {
      console.log('投影缓存里没有自建投影单元');
      failures.push('projection-units');
    }
    for (const key of own) console.log(`${key} = ${JSON.stringify(rows[key].val)}`);
  }
} else if (sessionId !== undefined) {
  console.log(`投影缓存目录不存在：${cacheDir}`);
  failures.push('projection-cache-missing');
}

const stderrText = stderrLog.join('');
for (const line of stderrText.split('\n').filter((line) => /did not activate|failed to import/.test(line))) {
  console.log(`加载器警告：${line}`);
  failures.push('activation');
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join(', ')}`);
  process.exit(1);
}
console.log('端到端验证通过');
process.exit(0);
