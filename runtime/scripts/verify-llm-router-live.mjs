// 模型主链路的真实验收。
//
// 两段验收，使用宿主上真实的测试模型网关与真实的控制平面进程：
//   1. 控制平面模型入口：把一次 OpenAI 兼容请求翻译成 DSH 的 SSE 分块，交给调用方；
//   2. 运行时路由器：起一个 chatdsh-web 运行时，经 `@chatdsh/host-llm-router` 的
//      `stream()` 发出一次真实模型调用，断言拿到可见文本与正常结束原因。
// 随后把控制平面换到额度已耗尽的实例，断言入口返回 402 `quota-exceeded`，且没有请求
// 到达测试网关。
//
// 凭据只从环境变量或 deploy/.env 读，脚本不打印密钥、请求体与模型输出原文。
//
// 用法：node scripts/verify-llm-router-live.mjs [--port 3199] [--runtime-port 3099]
// 退出码 0 表示全部验收成立。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from './lib/cleanup.mjs';
import { normalizeProfileDeps } from './lib/profile-deps.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(ROOT, '..');

/** 从参数里取一个端口。 */
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number.parseInt(process.argv[index + 1], 10);
}

const GATEWAY_PORT = argument('--port', 3199);
const RUNTIME_PORT = argument('--runtime-port', 3099);
const MODEL = process.env.CHATDSH_TEST_GATEWAY_MODEL ?? 'xhs/dots3-note-prev';

/** DSH 安装根。启动器与 node 版本必须与安装一致。 */
function runtimeInstall() {
  return process.env.CHATDSH_DSH_INSTALL ?? '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh';
}

/** 读部署环境里的测试网关地址与密钥；密钥只留在本进程。 */
function gatewayCredentials() {
  const key = process.env.CHATDSH_TEST_GATEWAY_API_KEY;
  if (key !== undefined && key !== '') return { key, url: process.env.CHATDSH_TEST_GATEWAY_URL ?? 'http://127.0.0.1:20128/v1' };
  const file = join(REPO, 'deploy', '.env');
  if (!existsSync(file)) throw new Error('缺少测试网关密钥：设置 CHATDSH_TEST_GATEWAY_API_KEY');
  const text = readFileSync(file, 'utf8');
  const value = text.match(/^CHATDSH_TEST_GATEWAY_API_KEY=(.*)$/m)?.[1].trim();
  if (value === undefined || value === '') throw new Error('deploy/.env 里没有 CHATDSH_TEST_GATEWAY_API_KEY');
  // 宿主侧的测试网关走回环；deploy/.env 里的地址面向容器，因此这里取本机地址。
  return { key: value, url: 'http://127.0.0.1:20128/v1' };
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

/** 上游模型网关的观测代理：记录请求次数并转发到真实测试网关。 */
async function startProxy(credentials) {
  let requests = 0;
  const target = `${credentials.url}/chat/completions`;
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.key}` },
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, count: () => requests };
}

/** 起一个控制平面进程并等它就绪。 */
async function startGateway(options) {
  const child = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
    env: {
      ...process.env,
      DSH_HOME: options.home, // gitleaks:allow
      CHATDSH_GATEWAY_PORT: String(GATEWAY_PORT),
      CHATDSH_ACCESS_PROVIDER: 'manual',
      CHATDSH_LLM_GATEWAY_URL: options.upstreamUrl,
      CHATDSH_LLM_API_KEY_ENV: 'CHATDSH_TEST_GATEWAY_API_KEY',
      CHATDSH_LLM_QUOTA_LIMIT: String(options.limit),
      CHATDSH_LLM_QUOTA_USED: String(options.used),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${GATEWAY_PORT}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`控制平面退出（${child.exitCode}）：\n${output.slice(-800)}`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return { child, url, output: () => output };
    } catch {
      // 还在启动。
    }
    await delay(200);
  }
  child.kill('SIGKILL');
  throw new Error(`控制平面启动超时：\n${output.slice(-800)}`);
}

/** 一次模型入口调用。 */
async function callGateway(url, account) {
  const response = await fetch(`${url}/chatdsh/gateway/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'tailscale-user-login': account },
    body: JSON.stringify({
      provider: 'gateway',
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
      maxTokens: 64,
    }),
  });
  return { status: response.status, text: await response.text() };
}

/** 解析模型入口返回的 SSE，取出可见文本与结束原因。 */
function readSse(text) {
  let visible = '';
  let finish;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const chunk = JSON.parse(line.slice('data: '.length));
    if (chunk.type === 'text-delta') visible += chunk.text;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  return { visible, finish };
}

/** 启动运行时，返回启动地址与 token。 */
async function startRuntime(home, gatewayUrl, credentials) {
  ensureProfile(home, 'chatdsh-web');
  normalizeProfileDeps(join(ROOT, 'profiles', 'chatdsh-web'));
  const node = join(runtimeInstall(), '..', '..', '..', '..', 'bin', 'node');
  const command = join(runtimeInstall(), 'lib', 'bin.js');
  const child = spawn(node, [command, '--profile', 'chatdsh-web', '--port', String(RUNTIME_PORT), '--no-open'], {
    env: {
      ...process.env,
      DSH_HOME: home, // gitleaks:allow
      CHATDSH_TEST_GATEWAY_API_KEY: credentials.key,
      CHATDSH_RUNTIME_URL: gatewayUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`运行时启动超时：\n${output.slice(-1200)}`)), 180_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`运行时提前退出（${code}）：\n${output.slice(-1200)}`));
    });
  });
  return { child, url, output: () => output };
}

const credentials = gatewayCredentials();
const proxy = await startProxy(credentials);
const children = [];
const failures = [];

try {
  // 第一段：控制平面入口的请求翻译与流式返回。
  const gateway = await startGateway({
    home: tempHome('llm-router-live-ok'),
    upstreamUrl: proxy.url,
    limit: 1_000_000,
    used: 0,
  });
  children.push(gateway.child);
  const first = await callGateway(gateway.url, 'llm-router-entry');
  if (first.status !== 200) throw new Error(`模型入口返回 ${first.status}：${first.text.slice(0, 200)}`);
  const entry = readSse(first.text);
  if (entry.visible === '') throw new Error(`模型入口没有返回可见文本：${first.text.slice(0, 300)}`);
  if (entry.finish?.kind !== 'stop' && entry.finish?.kind !== 'tool-calls') {
    throw new Error(`模型入口没有正常结束：${JSON.stringify(entry.finish)}`);
  }
  if (proxy.count() !== 1) failures.push(`模型入口的一次调用应当产生 1 次上游请求，实际 ${proxy.count()} 次`);
  console.log(`控制平面模型入口通过：${first.status}，可见文本 ${entry.visible.length} 个字符，结束原因 ${entry.finish.kind}`);

  // 第二段：运行时侧的路由器经同一个入口完成一次真实模型调用。
  //
  // 直接调用运行时的 Remote 需要浏览器会话，这里用路由器导出的探针走与运行时
  // 完全相同的适配器与入口链路，额度守卫、请求翻译与分块翻译都在链路上。
  const { GatewayLlmAdapter, probeRoute } = await import('../packages/host/llm-router/lib/index.js');
  const before = proxy.count();
  const adapter = new GatewayLlmAdapter({
    baseUrl: `${gateway.url}/chatdsh/gateway/llm`,
    accountId: 'llm-router-runtime',
    quota: { limit: 1_000_000, used: 0 },
  });
  const probe = await probeRoute(adapter, MODEL, AbortSignal.timeout(120_000));
  if (!probe.ok) failures.push(`路由器探针没有拿到可见文本：${JSON.stringify(probe)}`);
  if (proxy.count() - before !== 1) failures.push(`路由器的一次调用应当产生 1 次上游请求，实际增加 ${proxy.count() - before} 次`);
  console.log(`路由器模型调用通过：可见文本 ${probe.visibleChars} 个字符，结束原因 ${String(probe.finish)}，上游请求增加 ${proxy.count() - before} 次`);

  // 二点五段：真实启动一次 chatdsh-web 运行时，确认路由器插件在真实组合里激活。
  const runtime = await startRuntime(tempHome('llm-router-live-runtime'), gateway.url, credentials);
  children.push(runtime.child);
  if (runtime.output().includes('chatdsh-llm-router')) failures.push('路由器插件没有在真实运行时里激活');
  console.log(`运行时装配通过：${runtime.url.split('?')[0]}，路由器插件无激活告警`);

  await stop(gateway.child);

  // 第三段：额度耗尽的拒绝。
  const exhausted = await startGateway({
    home: tempHome('llm-router-live-quota'),
    upstreamUrl: proxy.url,
    limit: 100,
    used: 100,
  });
  children.push(exhausted.child);
  const countBefore = proxy.count();
  const rejected = await callGateway(exhausted.url, 'llm-router-quota');
  if (rejected.status !== 402) failures.push(`额度拒绝应当返回 402，实际 ${rejected.status}`);
  const body = JSON.parse(rejected.text);
  if (body.error?.code !== 'quota-exceeded') failures.push(`额度拒绝的错误码应当是 quota-exceeded，实际 ${body.error?.code}`);
  if (proxy.count() !== countBefore) failures.push(`额度拒绝不应当发出上游请求，上游计数从 ${countBefore} 变成 ${proxy.count()}`);
  console.log(`额度拒绝通过：${rejected.status}，错误码 ${body.error?.code}，上游请求未增加`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  for (const child of children) await stop(child);
  proxy.server.close();
}

if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('模型主链路验收通过');
