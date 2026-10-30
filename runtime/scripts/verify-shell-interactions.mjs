// 外壳交互的整机验收：一个真实控制平面、两台真实 dsh 运行时与一台真实 Chrome。
//
// 编排同 verify-shell.mjs：控制平面不托管运行时，两台设备各跑一个 `dsh --profile chatdsh-web`，
// 用配对得到的节点令牌连上控制平面。两台设备各建一条真实会话，工作目录的末段同名，用来
// 验证左栏按工作区显示名跨设备合并。
//
// 断言按顺序打印：
//   1. 同名工作区跨设备合并成一个节点，节点里有两条位置（两台设备）；
//   2. 选中设备 A 的会话后，右栏 iframe 的 src 以 `/d/<A 的 deviceId>/` 开头；
//   3. 杀掉 A 后选中它的会话，右栏出现离线遮罩，遮罩里的输入框 `disabled` 为真；
//   4. 重新拉起 A 并回到在线后，遮罩消失、iframe 重新加载；
//   5. 通过「新建会话」选设备与目录后，控制平面出现该会话的归属记录且 deviceId 正确。
//
// 用法：node scripts/verify-shell-interactions.mjs
// 退出码 0 表示全部通过。端口从 20170 起；被占用时顺延，并在输出里写明实际端口。

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { findFreePort } from '../gateway/lib/runtime.js';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const ROOT = resolve(import.meta.dirname, '..');
const PAIRING_CODE = randomBytes(9).toString('base64url');
const failures = [];

if (!existsSync(join(ROOT, 'gateway', 'lib', 'main.js'))) {
  throw new Error('控制平面尚未编译：先执行 pnpm build');
}
if (!existsSync(join(ROOT, 'packages', 'tool', 'browser', 'lib', 'cdp.js'))) {
  throw new Error('浏览器驱动尚未编译：先执行 pnpm build');
}

/** 记一条断言结果。 */
function check(ok, label, detail) {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail === undefined ? '' : ` → ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 等一个条件成立。 */
async function waitFor(fn, timeoutMs, intervalMs = 400) {
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
    throw new Error(`取 API 凭据失败：${response.status}`);
  }
  return cookies.join('; ');
}

/** 调一次设备运行时的 Remote 一元端点。 */
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
    envelope = undefined;
  }
  return { status: response.status, text, envelope };
}

/** 在设备上建一条真实会话并给它改名。 */
async function createNamedSession(origin, cookie, cwd, title) {
  const created = await rpc(origin, cookie, 'session/create', { request: { cwd } });
  const sessionId = created.envelope?.result?.ok === true ? created.envelope.result.value.sessionId : undefined;
  if (sessionId === undefined) throw new Error(`session/create 失败：${created.status} ${created.text.slice(0, 300)}`);
  const renamed = await rpc(origin, cookie, 'session/rename', { request: { sessionId, title } });
  if (renamed.envelope?.result?.ok !== true) throw new Error(`session/rename 失败：${renamed.status} ${renamed.text.slice(0, 300)}`);
  return sessionId;
}

/** 读聚合会话列表端点。 */
async function sessionsOf(base) {
  const response = await fetch(`${base}/chatdsh/gateway/sessions`);
  if (!response.ok) throw new Error(`聚合会话列表返回 ${response.status}`);
  return response.json();
}

/** 读设备列表端点。 */
async function devicesOf(base) {
  const response = await fetch(`${base}/chatdsh/gateway/devices`);
  if (!response.ok) throw new Error(`设备列表返回 ${response.status}`);
  return response.json();
}

/** 等两台设备都在线。 */
async function waitOnline(base, deviceIds, timeoutMs) {
  return waitFor(async () => {
    const listed = await devicesOf(base);
    const onlineIds = new Set(listed.devices.filter((device) => device.online).map((device) => device.id));
    const missing = deviceIds.filter((id) => !onlineIds.has(id));
    return missing.length === 0 ? { ok: true, detail: '都在线' } : { ok: false, detail: `未上线：${missing.join('、')}` };
  }, timeoutMs, 800);
}

/** 在工作区节点结构里读取左栏状态。 */
const WORKSPACE_STATE_EXPRESSION = `(() => {
  return [...document.querySelectorAll('.workspace')].map((section) => ({
    workspaceName: section.dataset.workspaceName ?? '',
    entries: [...section.querySelectorAll('.workspace-entry')].map((entry) => ({
      deviceId: entry.dataset.deviceId ?? '',
      sessions: [...entry.querySelectorAll('.session')].map((button) => ({
        sessionId: button.dataset.sessionId ?? '',
        title: button.querySelector('.session-title')?.textContent ?? '',
      })),
    })),
  }));
})()`;

const controlPort = await findFreePort(20170);
const portA = await findFreePort(controlPort + 1);
const portB = await findFreePort(portA + 1);
console.log(`端口：控制平面 ${controlPort}、设备 A ${portA}、设备 B ${portB}`);

const root = tempHome('verify-shell-interactions');
const base = `http://127.0.0.1:${controlPort}`;
const baseA = `http://127.0.0.1:${portA}`;
const baseB = `http://127.0.0.1:${portB}`;

// 两台设备上同名的工作目录：末段都叫 shared，用来验证按显示名合并。
const cwdA = join(root, 'ws-a', 'shared');
const cwdB = join(root, 'ws-b', 'shared');
mkdirSync(cwdA, { recursive: true });
mkdirSync(cwdB, { recursive: true });

const gateway = startProcess(process.execPath, [join(ROOT, 'gateway', 'lib', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    CHATDSH_TELEMETRY: 'off',
    CHATDSH_GATEWAY_HOST: '127.0.0.1',
    CHATDSH_GATEWAY_PORT: String(controlPort),
    CHATDSH_GATEWAY_DB: join(root, 'gateway.sqlite'),
    CHATDSH_PAIRING_CODE: PAIRING_CODE,
    CHATDSH_RUNTIME_URL: 'http://127.0.0.1:1',
  },
});

const runtimes = [];
let browser;

/** 起一台设备的运行时，返回句柄。 */
function spawnRuntime(node, port, home) {
  return startProcess(dshCommand(), ['--profile', 'chatdsh-web', '--port', String(port), '--no-open'], {
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
}

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
  const [nodeA, nodeB] = nodes;
  const ports = [portA, portB];
  const homes = [tempHome('verify-shell-a'), tempHome('verify-shell-b')];
  for (const [index, node] of nodes.entries()) {
    mkdirSync(join(homes[index], 'profiles'), { recursive: true });
    symlinkSync(join(ROOT, 'profiles', 'chatdsh-web'), join(homes[index], 'profiles', 'chatdsh-web'), 'dir');
    runtimes.push({ node, home: homes[index], port: ports[index], runtime: spawnRuntime(node, ports[index], homes[index]) });
  }

  for (const entry of runtimes) {
    const boot = await waitForBoot(entry.runtime, 180_000);
    check(boot.ok, `${entry.node.name} 运行时已启动`, boot.ok ? new URL(boot.detail).origin : boot.detail);
    if (!boot.ok) throw new Error(`${entry.node.name} 没有启动：${entry.runtime.output.slice(-1200)}`);
    entry.bootUrl = boot.detail;
  }

  const online = await waitOnline(base, [nodeA.deviceId, nodeB.deviceId], 90_000);
  check(online.ok, '两台设备的长连接都已建立', online.detail);
  if (!online.ok) throw new Error('长连接没有建立');

  const cookieA = await apiCookie(runtimes[0].bootUrl);
  const cookieB = await apiCookie(runtimes[1].bootUrl);
  const sessionA = await createNamedSession(baseA, cookieA, cwdA, '交互验收甲');
  const sessionB = await createNamedSession(baseB, cookieB, cwdB, '交互验收乙');

  for (const [node, sessionId, cwd] of [[nodeA, sessionA, cwdA], [nodeB, sessionB, cwdB]]) {
    const written = await fetch(`${base}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, deviceId: node.deviceId, cwd, kind: 'work' }),
    });
    if (!written.ok) throw new Error(`归属写入失败：${written.status} ${await written.text()}`);
  }

  // 标题经副本上报流到控制平面，两条都要到位再打开外壳。
  const titled = await waitFor(async () => {
    const snapshot = await sessionsOf(base);
    const titles = new Map();
    for (const device of snapshot.devices) for (const session of device.sessions) titles.set(session.sessionId, session.title);
    return titles.get(sessionA) === '交互验收甲' && titles.get(sessionB) === '交互验收乙'
      ? { ok: true, detail: `${titles.get(sessionA)}、${titles.get(sessionB)}` }
      : { ok: false, detail: '标题未到位' };
  }, 40_000, 800);
  check(titled.ok, '两条会话的标题已流到控制平面', titled.detail);

  browser = await launchBrowser({ executable: '/usr/bin/google-chrome', port: 9227, userDataDir: tempHome('chrome-profile-verify-interactions') });
  const page = await browser.open();
  try {
    // 断言一：同名工作区跨设备合并成一个节点。
    await page.navigate(`${base}/`);
    const merged = await waitFor(async () => {
      const states = await page.evaluate(WORKSPACE_STATE_EXPRESSION);
      if (!Array.isArray(states)) return { ok: false, detail: '左栏还没渲染' };
      const shared = states.filter((section) => section.workspaceName === 'shared');
      const deviceIds = shared.length === 1 ? shared[0].entries.map((entry) => entry.deviceId) : [];
      const ok = shared.length === 1 && deviceIds.includes(nodeA.deviceId) && deviceIds.includes(nodeB.deviceId);
      return { ok, detail: `工作区节点：${states.map((section) => section.workspaceName).join('、') || '空'}；同名节点的位置数 ${String(deviceIds.length)}`, states };
    }, 30_000, 500);
    check(merged.ok, '断言一：同名工作区跨设备合并成一个节点（含两台设备的位置）', merged.detail);

    /** 点一条会话。 */
    const clickSession = async (sessionId) => page.evaluate(`(() => {
      const button = [...document.querySelectorAll('.session')].find((item) => item.dataset.sessionId === ${JSON.stringify(sessionId)});
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);

    /** 读右栏状态。 */
    const frameState = async () => page.evaluate(`(() => {
      const iframe = document.querySelector('.shell-iframe');
      const overlay = document.querySelector('.shell-offline-overlay');
      const input = document.querySelector('.shell-offline-input');
      return JSON.stringify({
        src: iframe?.getAttribute('src') ?? '',
        overlayHidden: overlay?.hasAttribute('hidden') ?? true,
        inputDisabled: input?.disabled ?? false,
        overlayText: document.querySelector('.shell-offline-text')?.textContent ?? '',
      });
    })()`);

    // 断言二：选中设备 A 的会话，iframe 指向 /d/<A>/。
    const clickedA = await clickSession(sessionA);
    const frame = clickedA === true
      ? await waitFor(async () => {
        const state = JSON.parse(String(await frameState()));
        return String(state.src).startsWith(`/d/${nodeA.deviceId}/`)
          ? { ok: true, detail: state }
          : { ok: false, detail: state.src || '还没有 src' };
      }, 15_000, 300)
      : { ok: false, detail: '没找到设备 A 的会话按钮' };
    check(frame.ok, '断言二：选中设备 A 的会话后右栏 iframe 指向 /d/<A>/', JSON.stringify(frame.detail));

    // 杀掉设备 A，等它离线。
    runtimes[0].runtime.child.kill('SIGTERM');
    const offline = await waitFor(async () => {
      const listed = await devicesOf(base);
      const record = listed.devices.find((device) => device.id === nodeA.deviceId);
      return record !== undefined && record.online === false ? { ok: true, detail: JSON.stringify(record) } : { ok: false, detail: '设备 A 仍在线' };
    }, 30_000, 500);
    check(offline.ok, '杀掉设备 A 后它显示离线', offline.detail);

    // 重新打开外壳，选中 A 的会话 → 离线遮罩，输入框 disabled。
    await page.navigate(`${base}/`);
    await waitFor(async () => {
      const states = await page.evaluate(WORKSPACE_STATE_EXPRESSION);
      return Array.isArray(states) && states.length > 0 ? { ok: true } : { ok: false };
    }, 20_000, 400);
    const clickedOffline = await clickSession(sessionA);
    const overlay = clickedOffline === true
      ? await waitFor(async () => {
        const state = JSON.parse(String(await frameState()));
        return state.overlayHidden === false && state.inputDisabled === true
          ? { ok: true, detail: state }
          : { ok: false, detail: state };
      }, 15_000, 300)
      : { ok: false, detail: '没找到设备 A 的会话按钮' };
    check(overlay.ok, '断言三：设备离线时右栏出现离线遮罩且输入框 disabled', JSON.stringify(overlay.detail));

    // 重新拉起 A，等它回到在线。
    runtimes[0].runtime = spawnRuntime(nodeA, ports[0], homes[0]);
    const rebooted = await waitForBoot(runtimes[0].runtime, 180_000);
    check(rebooted.ok, '设备 A 已重启', rebooted.ok ? new URL(rebooted.detail).origin : rebooted.detail);
    const backOnline = await waitOnline(base, [nodeA.deviceId], 90_000);
    check(backOnline.ok, '设备 A 重新回到在线', backOnline.detail);

    // 刷新外壳，选中 A 的会话 → 遮罩消失、iframe 重新加载。
    await page.navigate(`${base}/`);
    await waitFor(async () => {
      const states = await page.evaluate(WORKSPACE_STATE_EXPRESSION);
      return Array.isArray(states) && states.length > 0 ? { ok: true } : { ok: false };
    }, 20_000, 400);
    const clickedBack = await clickSession(sessionA);
    const restored = clickedBack === true
      ? await waitFor(async () => {
        const state = JSON.parse(String(await frameState()));
        return state.overlayHidden === true && String(state.src).startsWith(`/d/${nodeA.deviceId}/`)
          ? { ok: true, detail: state }
          : { ok: false, detail: state };
      }, 20_000, 400)
      : { ok: false, detail: '没找到设备 A 的会话按钮' };
    check(restored.ok, '断言四：设备恢复在线后遮罩消失、iframe 重新加载', JSON.stringify(restored.detail));

    // 断言五：通过「新建会话」选设备与目录，控制平面出现归属记录且 deviceId 正确。
    const before = new Set();
    for (const device of (await sessionsOf(base)).devices) for (const session of device.sessions) before.add(session.sessionId);
    const newCwd = join(root, 'ws-new', 'fresh');
    mkdirSync(newCwd, { recursive: true });
    await page.evaluate(`document.querySelector('.shell-new').click()`);
    await waitFor(async () => {
      const opened = await page.evaluate(`document.querySelector('.new-session-dialog') !== null`);
      return opened === true ? { ok: true } : { ok: false };
    }, 8000, 200);
    await page.evaluate(`(() => {
      const select = document.querySelector('.new-session-device');
      select.value = ${JSON.stringify(nodeB.deviceId)};
      document.querySelector('.new-session-cwd').value = ${JSON.stringify(newCwd)};
      document.querySelector('.new-session-create').click();
      return true;
    })()`);
    const created = await waitFor(async () => {
      const ownership = await (await fetch(`${base}/chatdsh/gateway/ownership`)).json();
      const rows = ownership.sessions ?? [];
      const fresh = rows.find((row) => !before.has(row.sessionId) && row.deviceId === nodeB.deviceId);
      return fresh !== undefined ? { ok: true, detail: fresh } : { ok: false, detail: '还没有新会话的归属记录' };
    }, 20_000, 500);
    check(created.ok, '断言五：新建会话后控制平面出现归属记录且 deviceId 正确', JSON.stringify(created.detail));
  } finally {
    await page.close();
  }
} catch (error) {
  check(false, '验收中断', error instanceof Error ? error.message : String(error));
  if (gateway.output !== '') console.log(`控制平面输出片段：\n${gateway.output.slice(-1200)}`);
  for (const entry of runtimes) {
    if (entry.runtime.output !== '') console.log(`${entry.node.name} 输出片段：\n${entry.runtime.output.slice(-1200)}`);
  }
} finally {
  if (browser !== undefined) await browser.close();
  for (const entry of runtimes) entry.runtime.child.kill('SIGTERM');
  gateway.child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 800));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('外壳交互验收通过');
process.exit(0);
