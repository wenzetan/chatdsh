// WP11 验收的公共装配：真实宿主服务、真实页面服务与真实 Chrome 会话。
//
// 宿主侧按真实注册方式挂载存储中枢、JSON 后端、存储域、系统提示、模型运行时、技能注册表、
// 会话注册表、加载器、agent preset 注册表与插件清单，再把技能服务与助手服务挂上去。三档预设
// 按 `@chatdsh/core-contracts` 的档位声明登记，装配清单因此能读出与部署一致的工具行。
// 页面服务把 `/<服务名>/<方法名>` 直接交给这些真实服务，失败按 Remote 信封返回。
// 浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图。

import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const execute = promisify(execFile);

/** Node 与 agent-browser 所在的目录。 */
export const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';

/** 运行仓库根。 */
export const RUNTIME = resolve(import.meta.dirname, '../..');

/** 仓库根。 */
export const REPO = resolve(RUNTIME, '..');

ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const jsonBackend = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: AgentPresetRegistry } = await import('@deepseek-ai/dsh-agent-preset-registry');
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { default: PluginInventory } = await import('@deepseek-ai/dsh-host-plugin-inventory');
const { TypertRemoteService } = await import(join(REPO, 'dsh-adapter/lib/index.js'));
const contracts = await import(join(RUNTIME, 'packages/core/contracts/lib/index.js'));
const upstream = await import(join(REPO, 'dsh-adapter/lib/upstream.js'));
const assistantsPackage = await import(join(RUNTIME, 'packages/host/assistants/lib/index.js'));
const skillsPackage = await import(join(RUNTIME, 'packages/host/skills/lib/index.js'));
const uiKit = await import(join(RUNTIME, 'packages/core/ui-kit/lib/index.js'));

/** 三档预设在两份声明里都出现的人格行。 */
const COMMON_ROWS = ['persona', 'agent-instructions', 'time-context'];

/**
 * 由工具行取装配用的包名，规则与宿主装配一致。
 * @param {string} row - 行标识。
 * @returns {string} 包名。
 */
export function packageOfRow(row) {
  if (row.startsWith('chatdsh-')) return `@chatdsh/${row.slice('chatdsh-'.length)}`;
  const name = upstream.UPSTREAM_TOOL_ROWS[row];
  if (name === undefined) throw new Error(`未登记的工具行：${row}`);
  return name;
}

/**
 * 登记三档预设，让插件清单能读出与部署一致的装配行。
 * @param {object} ctx - 宿主上下文。
 */
export async function registerTierPresets(ctx) {
  for (const tier of contracts.CHATDSH_TOOL_TIERS) {
    const plugins = [
      ...COMMON_ROWS.map((row) => ({ id: row, name: upstream.UPSTREAM_AGENT_ROWS[row] })),
      ...[...tier.upstreamRows, ...tier.chatdshRows].map((row) => {
        if (row === 'tool-bash') return { id: row, name: packageOfRow(row), disabled: { __jsExpr: "process.platform === 'win32'" } };
        if (row === 'tool-pwsh') return { id: row, name: packageOfRow(row), disabled: { __jsExpr: "process.platform !== 'win32'" } };
        return { id: row, name: packageOfRow(row) };
      }),
    ];
    if (tier.presentation === 'ptc') plugins.push({ id: 'tool-presentation', name: upstream.UPSTREAM_ROWS['tool-presentation'], config: { mode: 'ptc' } });
    await ctx.agentPresets.register({ id: contracts.presetIdOf(tier.id), name: tier.name, description: tier.description, order: tier.order, plugins });
  }
}

/**
 * 挂载一套真实宿主。
 * @param {{ home: string, skills?: readonly { name: string, description: string, source?: string }[] }} options 数据根与初始技能。
 * @returns {Promise<{ ctx: object, assistants: object, skills: object }>} 上下文与两个服务。
 */
export async function openHostStack({ home, skills = [] }) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(jsonBackend, { root: join(home, 'runtime', 'storages') });
  await ctx.plugin(domainPlugin, { backend: 'json' });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(SessionPlugin);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(Loader, { baseUrl: `${RUNTIME}/` });
  await ctx.plugin(AgentPresetRegistry, { default: 'chatdsh-work' });
  await ctx.plugin(PluginInventory);
  await registerTierPresets(ctx);
  for (const skill of skills) {
    ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: `# ${skill.name}`,
      ...(skill.source === undefined ? {} : { source: skill.source }),
    });
  }
  const skillsService = new skillsPackage.ChatdshSkillsService(ctx);
  await skillsService[TypertRemoteService.init]();
  const assistantsService = new assistantsPackage.ChatdshAssistantsService(ctx);
  await assistantsService[TypertRemoteService.init]();
  return { ctx, assistants: assistantsService, skills: skillsService };
}

/**
 * 把服务端失败编成线的信封：只有 RemoteError 保留错误码。
 * @param {unknown} error - 失败对象。
 * @returns {{ code: string, message: string }} 信封里的错误。
 */
export function wireFailureOf(error) {
  if (typeof error === 'object' && error !== null && error.isDSHRemoteError === true) {
    return { code: error.code, message: error.message };
  }
  return {
    code: typeof error?.code === 'string' ? error.code : 'gateway/internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 起一个页面服务：`/` 返回面板页面，`/api/<服务名>/<方法名>` 交给调用方给的处理函数。
 * @param {{ handlers: Record<string, (args: readonly unknown[]) => Promise<unknown>>, script: string }} options 处理函数与页面脚本。
 * @returns {Promise<object>} 服务信息。
 */
export async function startPanelPage({ handlers, script }) {
  const batches = [];
  const tokens = (await import('node:fs')).readFileSync(join(RUNTIME, 'packages/client/theme/src/client/styles/tokens.css'), 'utf8');
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>WP11 面板</title><style>',
    tokens,
    '\n',
    uiKit.UI_KIT_CSS,
    '\ndialog { margin: auto; } main { padding: 16px; max-width: 860px; }\n</style></head><body>',
    '<main><div id="root"></div></main>',
    '<script>',
    script,
    '</script></body></html>',
  ].join('');
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/chatdsh/telemetry/browser') {
        batches.push({ signal: request.headers['x-chatdsh-signal'], body: JSON.parse(raw) });
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      const endpoint = url.pathname.replace(/^\/api\//u, '');
      const handler = handlers[endpoint];
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'object-not-found', message: endpoint } }));
        return;
      }
      const body = raw === '' ? {} : JSON.parse(raw);
      let payload;
      try {
        payload = { ok: true, value: await handler(body.args ?? []) };
      } catch (error) {
        payload = { ok: false, error: wireFailureOf(error) };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    batches,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * 用 esbuild 把页面入口打成浏览器可执行的脚本。
 * @param {string} entry - 页面脚本源码。
 * @param {string} sourcefile - 源码文件名，用于诊断。
 * @returns {Promise<string>} 脚本文本。
 */
export async function bundlePage(entry, sourcefile) {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: RUNTIME, loader: 'tsx', sourcefile },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    alias: { '@chatdsh/core-ui-kit': join(RUNTIME, 'packages/core/ui-kit/src/index.ts') },
    logLevel: 'warning',
  });
  const script = bundle.outputFiles[0].text;
  if (script.length < 5000) throw new Error(`页面脚本大小异常：${String(script.length)}`);
  return script;
}

/**
 * 建一个 agent-browser 调用器：独立会话、独立 HOME、独立 profile、不截图。
 * @param {{ session: string, home: string }} options 会话名与独立数据根。
 * @returns {(name: string, ...args: string[]) => Promise<object>} 调用器。
 */
export function browserOf({ session, home }) {
  const env = {
    ...process.env,
    TMPDIR: home,
    HOME: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const call = async (name, ...args) => {
    const result = await execute(`${NODE_BIN}/agent-browser`, ['--session', session, '--json', name, ...args], {
      env,
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    if (response.success !== true) throw new Error(`agent-browser ${name} 失败：${result.stdout}`);
    return response;
  };
  return call;
}
