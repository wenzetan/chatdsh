// MCP 连接的验收。
//
// 数据根里放一条指向探针服务器的连接器记录，启动运行时之后核对探针日志：MCP 客户端应当
// 完成 initialize 握手并拉取 tools/list。这条链路此前只验证到「加载器行被创建」。
//
// 用法：node scripts/verify-mcp-connection.mjs
// 退出码 0 表示握手完成且工具列表被拉取。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PROBE_LOG = resolve(ROOT, '.run', 'mcp-probe.log');
const PROBE_SERVER = resolve(ROOT, 'e2e', 'fixtures', 'mcp-probe.mjs');

const home = tempHome('mcp-connection');
mkdirSync(join(home, 'storages'), { recursive: true });
writeFileSync(join(home, 'storages', 'connectors_store.json'), JSON.stringify({
  unit: { name: 'connectors_store', version: 1 },
  global: {},
  tables: {
    connectors: {
      'probe-connector': {
        id: 'probe-connector',
        name: 'probe server',
        transport: 'stdio',
        command: process.execPath,
        args: [PROBE_SERVER],
        enabled: true,
        createdAt: 1792430000000,
        updatedAt: 1792430000000,
      },
    },
  },
}, null, 2));

mkdirSync(join(home, 'profiles'), { recursive: true });
const profileLink = join(home, 'profiles', 'chatdsh-web');
if (!existsSync(profileLink)) symlinkSync(join(ROOT, 'profiles', 'chatdsh-web'), profileLink);

rmSync(PROBE_LOG, { force: true });

const child = spawn(dshCommand(), ['--profile', 'chatdsh-web', '--port', '3096', '--no-open'], {
  env: { ...process.env, DSH_HOME: home, MCP_PROBE_LOG: PROBE_LOG },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const failures = [];
try {
  const deadline = Date.now() + 90_000;
  let booted = false;
  while (Date.now() < deadline) {
    if (/dsh web: http/.test(output)) { booted = true; break; }
    if (output.includes('startup failed')) throw new Error(`启动失败：\n${output.slice(-600)}`);
    await delay(400);
  }
  if (!booted) throw new Error(`等待启动超时：\n${output.slice(-600)}`);
  console.log('运行时已启动');

  // 等 MCP 客户端握手并拉取工具列表。
  let methods = [];
  const waitDeadline = Date.now() + 30_000;
  while (Date.now() < waitDeadline) {
    if (existsSync(PROBE_LOG)) {
      methods = readFileSync(PROBE_LOG, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
        .map((entry) => entry.method)
        .filter((method) => method !== null && method !== undefined);
      if (methods.includes('tools/list')) break;
    }
    await delay(500);
  }
  console.log(`探针收到的请求：${JSON.stringify(methods)}`);

  if (!methods.includes('initialize')) failures.push('MCP 客户端没有发起 initialize');
  if (!methods.includes('tools/list')) failures.push('MCP 客户端没有拉取 tools/list');
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  await delay(600);
  rmSync(PROBE_LOG, { force: true });
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('MCP 连接验收通过');
process.exit(0);
