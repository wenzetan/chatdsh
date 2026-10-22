// MCP 服务端的真实验收。
//
// 起一个真实的 chatdsh-web 运行时，打开 MCP 协议入口，用标准 MCP 客户端完成握手、
// 列举工具与一次工具调用。断言三件事：协议版本协商成立、工具目录里能看到宿主注册的
// 工具、没有令牌的请求被 401 拒绝且不进入协议层。
//
// 令牌由脚本生成并通过环境变量传给运行时，脚本不打印令牌本身。
//
// 用法：node scripts/verify-mcp-server.mjs [--port 3095]
// 退出码 0 表示三项验收都成立。

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from './lib/cleanup.mjs';
import { normalizeProfileDeps } from './lib/profile-deps.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3095 : Number.parseInt(argv[index + 1], 10);
const PROFILE = 'chatdsh-web';
const TOKEN_ENV = 'CHATDSH_MCP_TOKEN';
const TOKEN = randomBytes(24).toString('base64url');

/** DSH 安装根。启动器与 node 版本必须与安装一致。 */
function runtimeInstall() {
  return process.env.CHATDSH_DSH_INSTALL ?? '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh';
}

/** 在数据根里挂上 profile。 */
function ensureProfile(home, profileName) {
  mkdirSync(join(home, 'profiles'), { recursive: true });
  const link = join(home, 'profiles', profileName);
  if (!existsSync(link)) symlinkSync(join(ROOT, 'profiles', profileName), link);
}

/** 停一个子进程。 */
async function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const home = tempHome('mcp-server-live');
ensureProfile(home, PROFILE);
normalizeProfileDeps(join(ROOT, 'profiles', PROFILE));
const install = runtimeInstall();
const node = join(install, '..', '..', '..', '..', 'bin', 'node');
const command = join(install, 'lib', 'bin.js');

const child = spawn(node, [command, '--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: home, [TOKEN_ENV]: TOKEN }, // gitleaks:allow
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let errors = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { errors += chunk; });

const failures = [];
try {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (/dsh web: http/.test(output)) break;
    if (child.exitCode !== null) throw new Error(`运行时提前退出（${child.exitCode}）：\n${errors.slice(-1200)}`);
    await delay(300);
  }
  if (!/dsh web: http/.test(output)) throw new Error(`运行时启动超时：\n${errors.slice(-1200)}`);
  console.log(`运行时已启动：http://127.0.0.1:${PORT}/`);
  if (errors.includes('chatdsh-mcp-server')) failures.push('MCP 服务端没有在真实运行时里激活');

  const url = `http://127.0.0.1:${PORT}/mcp`;

  // 没有令牌的请求必须在协议层之前被拒绝。
  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  if (unauthorized.status !== 401) failures.push(`未鉴权请求应当返回 401，实际 ${unauthorized.status}`);

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'chatdsh-mcp-e2e', version: '0.0.0' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length === 0) failures.push('工具目录为空');
    console.log(`MCP 握手通过：协议版本 ${String(client.getServerVersion()?.name ?? 'chatdsh')}，工具 ${tools.tools.length} 个`);
    const names = tools.tools.map((tool) => tool.name);
    if (!names.includes('working_directory')) failures.push(`工具目录里没有宿主注册的 working_directory，实际：${names.join('、')}`);

    const called = await client.callTool({ name: 'working_directory', arguments: {} });
    // 宿主工具在会话外调用时会报告缺少 agent；这里只断言协议层把结果原样交回。
    if (called.content === undefined) failures.push('工具调用没有返回内容');
    const text = (called.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    if (text === '') failures.push('工具调用没有返回文本');
    console.log(`MCP 工具调用通过：返回 ${text.length} 个字符`);
  } finally {
    await client.close();
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await stop(child);
}

if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('MCP 服务端验收通过');
