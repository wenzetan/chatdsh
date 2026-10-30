// 按设备路由的整机验收：一个真实控制平面加两台真实 dsh 运行时。
//
// 控制平面不托管运行时；默认反代目标指向设备 B，用来对照「没有 /d/ 前缀的请求仍走配置的
// 运行时」。两台设备各跑一个 `dsh --profile chatdsh-web`，用节点令牌主动连上控制平面。
//
// 会话是真实会话：先用设备自己的 `/connect` 换取 API 凭据，再调 `session/create` 在设备 A
// 上建一条会话，然后用 `POST /chatdsh/gateway/ownership` 把它的 deviceId 登记为 A。
//
// 断言按顺序打印：`/d/A/` 读得到 A 的会话、`/d/B/` 读不到（并且 A 的凭据在 B 上被拒，
// 证明请求确实落在不同运行时）、没有前缀的请求仍到 B、杀掉 A 后 `/d/A/` 的读写都返回 409、
// 离线设备不接受新的归属写入、B 仍然可用。
//
// 用法：node scripts/verify-device-routing.mjs
// 退出码 0 表示全部通过。端口从 20140 起；被占用时顺延，并在输出里写明实际端口。

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { findFreePort } from '../gateway/lib/runtime.js';

const ROOT = resolve(import.meta.dirname, '..');
const PAIRING_CODE = randomBytes(9).toString('base64url');
const failures = [];

if (!existsSync(join(ROOT, 'gateway', 'lib', 'main.js'))) {
  throw new Error('控制平面尚未编译：先执行 pnpm build');
}

/** 记一条断言结果。 */
function check(ok, label, detail) {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail === undefined ? '' : ` → ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 等一个条件成立。 */
async function waitFor(fn, timeoutMs, intervalMs = 500) {
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

/** 等运行时打印启动地址。 */
async function waitForBoot(runtime, timeoutMs) {
  return waitFor(() => {
    if (runtime.child.exitCode !== null) {
      return { ok: false, detail: `运行时已退出（${runtime.child.exitCode}）\n${runtime.output.slice(-800)}` };
    }
    const match = runtime.output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    return match === null
      ? { ok: false, detail: '还没打印启动地址' }
      : { ok: true, detail: match[1] };
  }, timeoutMs, 1000);
}

/** 用启动口令换一份只在本设备有效的 API 凭据。 */
async function apiCookie(bootUrl) {
  const url = new URL(bootUrl);
  const token = url.searchParams.get('token');
  const response = await fetch(`${url.origin}/connect?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
  if (response.status !== 302 || cookies.length === 0) {
    throw new Error(`取 API 凭据失败：${response.status} ${response.headers.getSetCookie().join(' | ')}`);
  }
  return cookies.join('; ');
}

/** 调一次 Remote 一元端点，返回响应信封。 */
async function rpc(origin, cookie, endpoint, args) {
  const body = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } };
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { status: response.status, text, envelope: undefined };
  }
  return { status: response.status, text, envelope };
}

/** 读设备列表。 */
async function devices(base) {
  const response = await fetch(`${base}/chatdsh/gateway/devices`);
  if (!response.ok) throw new Error(`设备列表返回 ${response.status}`);
  return response.json();
}

const controlPort = await findFreePort(20140);
const portA = await findFreePort(controlPort + 1);
const portB = await findFreePort(portA + 1);
console.log(`端口：控制平面 ${controlPort}、设备 A ${portA}、设备 B ${portB}`);

const root = tempHome('verify-device-routing');
const base = `http://127.0.0.1:${controlPort}`;
const baseA = `http://127.0.0.1:${portA}`;
const baseB = `http://127.0.0.1:${portB}`;

const gateway = startProcess(process.execPath, [join(ROOT, 'gateway', 'lib', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    CHATDSH_TELEMETRY: 'off',
    CHATDSH_GATEWAY_HOST: '127.0.0.1',
    CHATDSH_GATEWAY_PORT: String(controlPort),
    CHATDSH_GATEWAY_DB: join(root, 'gateway.sqlite'),
    CHATDSH_PAIRING_CODE: PAIRING_CODE,
    // 默认反代目标指向设备 B：没有 /d/ 前缀的请求应当仍然落到它上面。
    CHATDSH_RUNTIME_URL: baseB,
  },
});

const runtimes = [];
try {
  const health = await waitFor(async () => {
    if (gateway.child.exitCode !== null) {
      return { ok: false, detail: `控制平面已退出（${gateway.child.exitCode}）\n${gateway.output.slice(-1200)}` };
    }
    try {
      const response = await fetch(`${base}/healthz`);
      return { ok: response.ok, detail: `${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }, 30_000);
  check(health.ok, '控制平面已监听', health.detail);
  if (!health.ok) throw new Error('控制平面没有就绪');

  const nodes = [];
  for (const name of ['device-a', 'device-b']) {
    const response = await fetch(`${base}/chatdsh/gateway/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING_CODE, name, platform: 'linux', role: 'both', capabilities: ['shell'] }),
    });
    if (!response.ok) throw new Error(`配对 ${name} 失败：${response.status} ${await response.text()}`);
    const paired = await response.json();
    nodes.push({ name, deviceId: paired.deviceId, token: paired.token });
    console.log(`配对 ${name}：deviceId=${paired.deviceId}`);
  }

  const ports = [portA, portB];
  for (const [index, node] of nodes.entries()) {
    const home = tempHome(`verify-device-routing-${node.name}`);
    mkdirSync(join(home, 'profiles'), { recursive: true });
    symlinkSync(join(ROOT, 'profiles', 'chatdsh-web'), join(home, 'profiles', 'chatdsh-web'), 'dir');
    const runtime = startProcess(dshCommand(), ['--profile', 'chatdsh-web', '--port', String(ports[index]), '--no-open'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DSH_HOME: home,
        CHATDSH_TELEMETRY: 'off',
        CHATDSH_CONTROL_URL: base,
        CHATDSH_NODE_TOKEN: node.token,
        CHATDSH_DEVICE_ID: node.deviceId,
      },
    });
    runtimes.push({ node, runtime });
  }

  for (const entry of runtimes) {
    const boot = await waitForBoot(entry.runtime, 180_000);
    check(boot.ok, `${entry.node.name} 运行时已启动`, boot.ok ? new URL(boot.detail).origin : boot.detail);
    if (!boot.ok) throw new Error(`${entry.node.name} 没有启动：${entry.runtime.output.slice(-1200)}`);
    entry.bootUrl = boot.detail;
  }

  const online = await waitFor(async () => {
    const listed = await devices(base);
    const onlineIds = new Set(listed.devices.filter((device) => device.online).map((device) => device.id));
    const missing = nodes.filter((node) => !onlineIds.has(node.deviceId)).map((node) => node.name);
    return missing.length === 0
      ? { ok: true, detail: '两台都在线' }
      : { ok: false, detail: `还没上线：${missing.join('、')}` };
  }, 90_000, 1000);
  check(online.ok, '两台设备的长连接都已建立', online.detail);
  if (!online.ok) throw new Error('长连接没有建立');

  const [nodeA, nodeB] = nodes;
  const cookieA = await apiCookie(runtimes[0].bootUrl);
  const cookieB = await apiCookie(runtimes[1].bootUrl);
  console.log('两台设备的 API 凭据已取得');

  // 在设备 A 上建一条真实会话。
  const created = await rpc(baseA, cookieA, 'session/create', { request: { cwd: ROOT } });
  const createdValue = created.envelope?.result?.ok === true ? created.envelope.result.value : undefined;
  check(created.status === 200 && createdValue !== undefined, '在设备 A 上创建真实会话', created.text.slice(0, 200));
  if (createdValue === undefined) throw new Error('设备 A 上没有建成会话');
  const sessionId = createdValue.sessionId;

  // 把这条会话的 deviceId 登记为 A。
  const ownership = await fetch(`${base}/chatdsh/gateway/ownership`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, deviceId: nodeA.deviceId, cwd: ROOT, kind: 'work' }),
  });
  const ownershipBody = await ownership.json();
  check(ownership.status === 200 && ownershipBody.deviceId === nodeA.deviceId, '归属写入把 deviceId 记为 A', JSON.stringify(ownershipBody));

  const listedOwnership = await (await fetch(`${base}/chatdsh/gateway/ownership`)).json();
  const stored = listedOwnership.sessions.find((entry) => entry.sessionId === sessionId);
  check(stored !== undefined && stored.deviceId === nodeA.deviceId, '归属读回时 deviceId 仍是 A', JSON.stringify(stored));

  // 经控制平面 /d/A/ 读会话列表，应当拿到 A 上的那条会话。
  const listThroughA = await rpc(`${base}/d/${nodeA.deviceId}`, cookieA, 'session/list', { _request: {} });
  const itemsA = listThroughA.envelope?.result?.ok === true ? listThroughA.envelope.result.value.items : [];
  const gotSession = itemsA.some((item) => item.sessionId === sessionId);
  check(listThroughA.status === 200 && gotSession, '经 /d/A/ 读到 A 上的那条会话', `sessionId=${sessionId}，items=${itemsA.length}，${listThroughA.text.slice(0, 160)}`);

  // 同一个端点经 /d/B/：B 上没有这条会话。
  const listThroughB = await rpc(`${base}/d/${nodeB.deviceId}`, cookieB, 'session/list', { _request: {} });
  const itemsB = listThroughB.envelope?.result?.ok === true ? listThroughB.envelope.result.value.items : [];
  const leaked = itemsB.some((item) => item.sessionId === sessionId);
  check(listThroughB.status === 200 && !leaked, '经 /d/B/ 读不到 A 上的会话', `items=${itemsB.length}，${listThroughB.text.slice(0, 160)}`);

  // A 的凭据在 B 上被拒：凭据按设备地址绑定，这条对照证明请求确实落在不同的运行时。
  const crossCookie = await rpc(`${base}/d/${nodeB.deviceId}`, cookieA, 'session/list', { _request: {} });
  check(crossCookie.status === 401, '设备 A 的凭据在 /d/B/ 上被拒绝', `status=${crossCookie.status}`);

  // 没有 /d/ 前缀的请求仍走配置的默认运行时（这里指向 B）。
  const noPrefix = await rpc(base, cookieB, 'session/list', { _request: {} });
  const noPrefixOk = noPrefix.envelope?.result?.ok === true;
  const noPrefixHasA = noPrefixOk ? noPrefix.envelope.result.value.items.some((item) => item.sessionId === sessionId) : true;
  check(noPrefix.status === 200 && noPrefixOk && !noPrefixHasA, '没有 /d/ 前缀的请求仍然落到默认运行时（B）', `${noPrefix.status}，items=${noPrefixOk ? noPrefix.envelope.result.value.items.length : '解析失败'}`);

  const healthB = await fetch(`${base}/d/${nodeB.deviceId}/healthz`);
  check(healthB.status === 200, '经 /d/B/ 访问设备本地的 /healthz 返回 200', `${healthB.status} ${await healthB.text()}`);

  // 杀掉设备 A：归属写入与读写请求都明确失败，B 不受影响。
  runtimes[0].runtime.child.kill('SIGTERM');
  const offline = await waitFor(async () => {
    const listed = await devices(base);
    const record = listed.devices.find((device) => device.id === nodeA.deviceId);
    return record !== undefined && record.online === false
      ? { ok: true, detail: JSON.stringify(record) }
      : { ok: false, detail: '设备 A 仍显示在线' };
  }, 30_000, 500);
  check(offline.ok, '杀掉设备 A 后它显示离线', offline.detail);

  const writeOffline = await rpc(`${base}/d/${nodeA.deviceId}`, cookieA, 'session/create', { request: { cwd: ROOT } });
  check(writeOffline.status === 409 && writeOffline.text.includes('device-offline'), '设备离线时 /d/A/ 的写请求返回 409', `${writeOffline.status} ${writeOffline.text}`);

  const readOffline = await fetch(`${base}/d/${nodeA.deviceId}/healthz`);
  check(readOffline.status === 409 && (await readOffline.text()).includes('device-offline'), '设备离线时 /d/A/ 的读请求返回 409', `${readOffline.status}`);

  const ownershipOffline = await fetch(`${base}/chatdsh/gateway/ownership`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: `session-${randomUUID()}`, deviceId: nodeA.deviceId, cwd: ROOT, kind: 'work' }),
  });
  check(ownershipOffline.status === 409 && (await ownershipOffline.text()).includes('device-offline'), '设备离线时不接受新的归属写入', `${ownershipOffline.status}`);

  const stillB = await fetch(`${base}/d/${nodeB.deviceId}/healthz`);
  check(stillB.status === 200, '设备 B 仍然可以经 /d/B/ 访问', `${stillB.status} ${await stillB.text()}`);

  const listStillB = await rpc(`${base}/d/${nodeB.deviceId}`, cookieB, 'session/list', { _request: {} });
  check(listStillB.status === 200 && listStillB.envelope?.result?.ok === true, '设备 B 的会话列表仍然可读', `${listStillB.status}`);
} catch (error) {
  check(false, '验收中断', error instanceof Error ? error.message : String(error));
  if (gateway.output !== '') console.log(`控制平面输出片段：\n${gateway.output.slice(-1200)}`);
  for (const entry of runtimes) {
    if (entry.runtime.output !== '') console.log(`${entry.node.name} 输出片段：\n${entry.runtime.output.slice(-1200)}`);
  }
} finally {
  for (const entry of runtimes) entry.runtime.child.kill('SIGTERM');
  gateway.child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 800));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('按设备路由验收通过');
process.exit(0);
