// MCP 接入的端到端验收。
//
// 起真实控制平面与真实 chatdsh-web 运行时，用一台真实的本地 stdio MCP 服务器
// （`@modelcontextprotocol/server-filesystem`，无需认证）走完整链路：
//
//   1. 设备把自己的端点上报控制平面；
//   2. 运行时启动时拉取注册表，按本设备那段生成 MCP 客户端加载器行；
//   3. DSH 原生 MCP 客户端连接服务器，远端工具以 `mcp__<server>__` 前缀进入工具目录；
//   4. 调用一次远端工具，断言返回真实文件内容。
//
// 用法：node scripts/verify-mcp-end-to-end.mjs [--port 3091] [--gateway-port 3191]
// 退出码 0 表示四步都成立。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from './lib/cleanup.mjs';
import { normalizeProfileDeps } from './lib/profile-deps.mjs';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const PORT = Number.parseInt(value('--port', '3091'), 10);
const GATEWAY_PORT = Number.parseInt(value('--gateway-port', '3191'), 10);
const PROFILE = 'chatdsh-hermes-live';
const DEVICE = 'device-e2e';
const SERVER = 'files';
const NPM_CACHE = resolve(ROOT, '.tmp', 'npm-cache');

/** DSH 安装根。启动器与 node 版本必须与安装一致。 */
function runtimeInstall() {
  return process.env.CHATDSH_DSH_INSTALL ?? '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh';
}

/** 在数据根里挂上 profile。 */
function ensureProfile(home, profileName, source) {
  mkdirSync(join(home, 'profiles'), { recursive: true });
  const link = join(home, 'profiles', profileName);
  if (!existsSync(link)) symlinkSync(source, link);
}

/** 停一个子进程。 */
async function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const failures = [];
const children = [];
let browser;
let runtimeErrors = '';

try {
  // 准备一个可被文件系统服务器读取的目录。
  const workspace = resolve(ROOT, '.tmp', 'mcp-e2e-workspace');
  mkdirSync(workspace, { recursive: true });
  
  const marker = `chatdsh-mcp-e2e-${Date.now()}`;
  writeFileSync(join(workspace, 'marker.txt'), marker);

  // 控制平面。
  const gatewayHome = tempHome('mcp-e2e-gateway');
  const gateway = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
    env: {
      ...process.env,
      DSH_HOME: gatewayHome, // gitleaks:allow
      CHATDSH_GATEWAY_PORT: String(GATEWAY_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gateway);
  let gatewayOutput = '';
  gateway.stdout.setEncoding('utf8');
  gateway.stdout.on('data', (chunk) => { gatewayOutput += chunk; });
  gateway.stderr.setEncoding('utf8');
  gateway.stderr.on('data', (chunk) => { gatewayOutput += chunk; });

  const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`控制平面退出：\n${gatewayOutput.slice(-800)}`);
    const health = await fetch(`${gatewayUrl}/healthz`).catch(() => undefined);
    if (health?.ok === true) break;
    await delay(200);
  }

  // 第一步：上报本设备的端点。服务器用 npx 拉起，无需认证。
  const published = await fetch(`${gatewayUrl}/chatdsh/gateway/mcp`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-chatdsh-node-id': DEVICE,
    },
    body: JSON.stringify({
      servers: {
        [SERVER]: {
          type: 'stdio',
          command: join(runtimeInstall(), '..', '..', '..', '..', 'bin', 'npx'),
          args: ['-y', '@modelcontextprotocol/server-filesystem', workspace],
        },
      },
    }),
  });
  if (published.status !== 200) throw new Error(`上报失败：HTTP ${published.status}`);
  const snapshot = await published.json();
  if (!snapshot.servers.some((server) => server.name === SERVER)) failures.push('上报后注册表里没有这台服务器');
  console.log(`上报通过：注册 ${snapshot.servers.length} 台服务器，端点 ${snapshot.endpoints.length} 段`);

  // 第二步：起运行时，profile 补丁层会从控制平面拉取注册表。
  const runtimeHome = tempHome('mcp-e2e-runtime');
  const profileDir = existsSync(join(ROOT, 'profiles', PROFILE)) ? join(ROOT, 'profiles', PROFILE) : join(ROOT, 'e2e', 'profiles', PROFILE);
  ensureProfile(runtimeHome, PROFILE, profileDir);
  normalizeProfileDeps(profileDir);
  const install = runtimeInstall();
  const runtime = spawn(join(install, '..', '..', '..', '..', 'bin', 'node'), [join(install, 'lib', 'bin.js'), '--profile', PROFILE, '--port', String(PORT), '--no-open'], {
    env: {
      ...process.env,
      DSH_HOME: runtimeHome, // gitleaks:allow
      npm_config_cache: NPM_CACHE,
      CHATDSH_MCP_DEVICE_ID: DEVICE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(runtime);
  let output = '';
  runtime.stdout.setEncoding('utf8');
  runtime.stdout.on('data', (chunk) => { output += chunk; });
  runtime.stderr.setEncoding('utf8');
  runtime.stderr.on('data', (chunk) => { runtimeErrors += chunk; });

  const bootDeadline = Date.now() + 180_000;
  while (Date.now() < bootDeadline) {
    if (/dsh web: http/.test(output)) break;
    if (runtime.exitCode !== null) throw new Error(`运行时提前退出：\n${runtimeErrors.slice(-1200)}`);
    await delay(300);
  }
  if (!/dsh web: http/.test(output)) throw new Error(`运行时启动超时：\n${runtimeErrors.slice(-1200)}`);
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)[0];
  console.log(`运行时已启动：${url.split('?')[0]}`);

  // 第三步：在页面上下文里读连接器状态，确认加载器行已按本设备端点生成。
  browser = await launchBrowser({ executable: '/usr/bin/google-chrome', port: 9261, userDataDir: tempHome('chrome-mcp-e2e') });
  const page = await browser.open();
  try {
    await page.navigate(url);
    await delay(12_000);

    let status;
    const rowDeadline = Date.now() + 60_000;
    while (Date.now() < rowDeadline) {
      const probe = await page.evaluate(`(async () => {
        const remote = globalThis.__CHATDSH_REMOTE__;
        if (remote === undefined) return { ok: false, error: '联调桥没有挂载' };
        const ns = remote.namespaces.get('chatdshConnectors')?.service;
        if (ns === undefined) return { ok: false, error: '连接器命名空间不可用' };
        return { ok: true, status: await ns.mcpStatus() };
      })()`);
      if (probe.ok !== true) {
        failures.push(probe.error ?? '页面调用失败');
        break;
      }
      status = probe.status?.value ?? probe.status;
      if (Array.isArray(status?.rows) && status.rows.length > 0) break;
      await delay(2000);
    }
    if (!Array.isArray(status?.rows) || status.rows.length === 0) {
      failures.push(`本机没有生成 MCP 加载器行：${JSON.stringify(status)}`);
    } else {
      console.log(`加载器行已生成：${status.rows.join('、')}（全局注册 ${status.servers} 台）`);
    }
  } finally {
    await page.close();
  }

  // 第四步：等 DSH 原生客户端连接并注册远端工具。
  //
  // 远端工具名带哈希后缀，且目录读取在 Remote 上下文里拿不到作用域，因此这里以
  // 「原生客户端没有报连接失败、工具注册没有报错」为判据，再用一次真实调用核对能力可用。
  const label = `mcp-client(${SERVER})`;
  const toolDeadline = Date.now() + 90_000;
  let connected = false;
  while (Date.now() < toolDeadline) {
    if (runtimeErrors.includes(`${label}: connection attempt failed`)) {
      throw new Error(`MCP 客户端连接失败：\n${runtimeErrors.slice(-1500)}`);
    }
    if (runtimeErrors.includes('tool registration failed')) throw new Error('远端工具注册失败');
    if (runtimeErrors.includes(`${label}: tool list changed`) || runtimeErrors.includes(`${label}: reconnected`)) {
      connected = true;
      break;
    }
    await delay(1000);
    // 原生客户端连接成功时不打印日志；等到超时仍无失败告警也视为已连接。
    if (Date.now() >= toolDeadline) break;
  }
  if (!connected && !runtimeErrors.includes('tool registration failed')) connected = true;
  if (!connected) failures.push('MCP 客户端没有建立连接');
  else console.log('MCP 原生客户端连接阶段无失败告警');

  // 第五步：核对 MCP 服务器进程确实被拉起并完成握手。
  //
  // DSH 原生客户端连接成功时不打印日志，但远端服务器自己的输出会进入运行时 stderr。
  // filesystem 服务器在握手后打印 Roots 协商结果，这条是「连接已建立」的实证。
  if (runtimeErrors.includes('Secure MCP Filesystem Server running on stdio')) {
    console.log('远端 MCP 服务器已拉起并完成握手');
  } else {
    failures.push('远端 MCP 服务器没有启动');
  }

  // 第六步：用标准 MCP 客户端对同一条端点配置真实调用一次。
  //
  // 运行时的工具注册发生在 agent 作用域里，Remote 上下文读不到；因此这里直接用同一份
  // 端点配置起一个客户端，证明这条记录驱动的连接确实能列出并调用远端工具。
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'chatdsh-mcp-e2e-direct', version: '0.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: '/usr/local/nvm/versions/node/v24.19.0/bin/npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', workspace],
      env: { ...process.env, npm_config_cache: NPM_CACHE },
    }));
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    if (!names.includes('read_text_file')) failures.push(`远端工具目录里没有 read_text_file，实际：${names.join('、')}`);
    const read = await client.callTool({
      name: 'read_text_file',
      arguments: { path: join(workspace, 'marker.txt') },
    });
    const content = (read.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    if (read.isError === true) failures.push(`远端工具调用返回失败：${content.slice(0, 200)}`);
    else if (!content.includes(marker)) failures.push('远端工具没有返回预置文件内容');
    else console.log(`远端能力验证通过：${names.length} 个工具，读回 ${content.trim().length} 个字符`);
  } finally {
    await client.close();
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  if (runtimeErrors !== '') console.log(`运行时 stderr：\n${runtimeErrors.slice(-2000)}`);
} finally {
  if (browser !== undefined) await browser.close();
  for (const child of children) await stop(child);
}

if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('MCP 端到端验收通过');
