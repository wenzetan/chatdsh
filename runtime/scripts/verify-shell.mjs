// 客户端外壳的整机验收：一个真实控制平面、两台真实 dsh 运行时与一台真实 Chrome。
//
// 编排同 verify-device-routing.mjs：控制平面不托管运行时，两台设备各跑一个
// `dsh --profile chatdsh-web`，用配对拿到的节点令牌连上控制平面。两台设备各建一条真实
// 会话并改名，再用 `POST /chatdsh/gateway/ownership` 登记归属；标题经副本上报流到控制平面。
//
// 断言按顺序打印：
//   1. 左栏出现两台设备；
//   2. 两台设备各有一条会话时，左栏列出两条；
//   3. 点设备 A 的会话后，右栏 iframe 的 src 以 `/d/<A 的 deviceId>/` 开头；
//   4. 杀掉 A 后重新打开外壳，A 标为离线且它的会话仍在列表里。
// 另有一条端点断言：按设备取插件清单返回真实的组合包与插件行，设备离线时返回 409。
//
// 用法：node scripts/verify-shell.mjs
// 退出码 0 表示全部通过。端口从 20160 起；被占用时顺延，并在输出里写明实际端口。

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
const TITLE_A = '外壳验收甲会话';
const TITLE_B = '外壳验收乙会话';
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

/** 在页面里读左栏的结构化状态：按设备汇总工作区里的条目。 */
const SHELL_STATE_EXPRESSION = `(() => {
  const byDevice = new Map();
  for (const section of document.querySelectorAll('.workspace')) {
    for (const entry of section.querySelectorAll('.workspace-entry')) {
      const deviceId = entry.dataset.deviceId ?? '';
      if (deviceId === '') continue;
      const record = byDevice.get(deviceId) ?? { deviceId, name: '', state: '', sessions: [] };
      record.name = entry.querySelector('.entry-device')?.textContent ?? record.name;
      record.state = entry.querySelector('.device-state')?.textContent ?? record.state;
      for (const button of entry.querySelectorAll('.session')) {
        record.sessions.push({
          sessionId: button.dataset.sessionId ?? '',
          title: button.querySelector('.session-title')?.textContent ?? '',
        });
      }
      byDevice.set(deviceId, record);
    }
  }
  return [...byDevice.values()];
})()`;

const controlPort = await findFreePort(20160);
const portA = await findFreePort(controlPort + 1);
const portB = await findFreePort(portA + 1);
console.log(`端口：控制平面 ${controlPort}、设备 A ${portA}、设备 B ${portB}`);

const root = tempHome('verify-shell');
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
    // 控制平面不托管运行时：默认反代指向一个不监听的端口，外壳与端点都不依赖它。
    CHATDSH_RUNTIME_URL: 'http://127.0.0.1:1',
  },
});

const runtimes = [];
let browser;
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
    const home = tempHome(`verify-shell-${node.name}`);
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
    const listed = await (await fetch(`${base}/chatdsh/gateway/devices`)).json();
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
  const sessionA = await createNamedSession(baseA, cookieA, ROOT, TITLE_A);
  const sessionB = await createNamedSession(baseB, cookieB, join(ROOT, 'gateway'), TITLE_B);
  check(true, '两台设备各建一条真实会话并改名', `A=${sessionA}、B=${sessionB}`);

  for (const [node, sessionId, cwd] of [[nodeA, sessionA, ROOT], [nodeB, sessionB, join(ROOT, 'gateway')]]) {
    const written = await fetch(`${base}/chatdsh/gateway/ownership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, deviceId: node.deviceId, cwd, kind: 'work' }),
    });
    if (!written.ok) throw new Error(`归属写入失败：${written.status} ${await written.text()}`);
  }

  // 标题经副本上报流到控制平面，等它落到聚合会话列表上。
  const titled = await waitFor(async () => {
    const snapshot = await sessionsOf(base);
    const titles = new Map();
    for (const device of snapshot.devices) {
      for (const session of device.sessions) titles.set(session.sessionId, session.title);
    }
    const okA = titles.get(sessionA) === TITLE_A;
    const okB = titles.get(sessionB) === TITLE_B;
    return okA && okB
      ? { ok: true, detail: `A=${titles.get(sessionA)}、B=${titles.get(sessionB)}`, snapshot }
      : { ok: false, detail: `A=${titles.get(sessionA) ?? '缺失'}、B=${titles.get(sessionB) ?? '缺失'}`, snapshot };
  }, 40_000, 1000);
  check(titled.ok, '聚合会话列表从副本的标题事件取到标题', titled.detail);
  const snapshot = titled.snapshot ?? await sessionsOf(base);
  console.log(`聚合会话列表：${JSON.stringify({
    devices: snapshot.devices.map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      online: device.online,
      sessions: device.sessions.map((session) => ({ sessionId: session.sessionId, title: session.title, cwd: session.cwd })),
    })),
  })}`);

  // 外壳页面与脚本由控制平面自己下发。
  const shellPage = await fetch(`${base}/`);
  const shellHtml = await shellPage.text();
  check(shellPage.status === 200 && shellHtml.includes('/shell/shell.js'), '控制平面根路径返回自建外壳页面', `${shellPage.status}，${shellHtml.length} 字符`);
  const shellScript = await fetch(`${base}/shell/shell.js`);
  const shellJs = await shellScript.text();
  check(shellScript.status === 200 && shellJs.includes('chatdsh/gateway/sessions'), '外壳脚本由控制平面托管', `${shellScript.status}，${shellJs.length} 字节`);

  browser = await launchBrowser({
    executable: '/usr/bin/google-chrome',
    port: 9226,
    userDataDir: tempHome('chrome-profile-verify-shell'),
  });
  const page = await browser.open();
  try {
    await page.navigate(`${base}/`);
    const twoDevices = await waitFor(async () => {
      const states = await page.evaluate(SHELL_STATE_EXPRESSION);
      if (!Array.isArray(states)) return { ok: false, detail: '左栏还没渲染' };
      const names = states.map((device) => device.name);
      const present = names.includes('device-a') && names.includes('device-b');
      return present
        ? { ok: true, detail: `左栏设备：${names.join('、')}`, states }
        : { ok: false, detail: `左栏设备：${names.join('、') || '空'}` };
    }, 30_000, 500);
    check(twoDevices.ok, '断言一：左栏出现两台设备', twoDevices.detail);

    const states = (twoDevices.states ?? []);
    const deviceA = states.find((device) => device.deviceId === nodeA.deviceId);
    const deviceB = states.find((device) => device.deviceId === nodeB.deviceId);
    const listedA = deviceA?.sessions.some((session) => session.sessionId === sessionA && session.title === TITLE_A) === true;
    const listedB = deviceB?.sessions.some((session) => session.sessionId === sessionB && session.title === TITLE_B) === true;
    check(listedA && listedB, '断言二：左栏列出两台设备各自的会话', `A：${JSON.stringify(deviceA?.sessions ?? [])}，B：${JSON.stringify(deviceB?.sessions ?? [])}`);

    const clicked = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('.session')].find((item) => item.dataset.sessionId === ${JSON.stringify(sessionA)});
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    const frameSrc = clicked === true
      ? await waitFor(async () => {
        const value = await page.evaluate(`document.querySelector('.shell-iframe')?.getAttribute('src') ?? ''`);
        return typeof value === 'string' && value !== ''
          ? { ok: true, detail: value }
          : { ok: false, detail: '右栏 iframe 还没有 src' };
      }, 15_000, 300)
      : { ok: false, detail: '没找到设备 A 的会话按钮' };
    check(
      frameSrc.ok && String(frameSrc.detail).startsWith(`/d/${nodeA.deviceId}/`),
      '断言三：点设备 A 的会话后右栏 iframe 的 src 指向 /d/<A>/',
      frameSrc.detail,
    );

    // 右栏 iframe 的目标页：设备侧补发本机凭据后应当拿到运行时的索引页。
    const framed = await page.evaluate(`fetch('/d/${nodeA.deviceId}/').then(async (response) => {
      const text = await response.text();
      return JSON.stringify({ status: response.status, length: text.length, index: text.includes('id="root"') });
    })`);
    const framedState = JSON.parse(String(framed));
    check(
      framedState.status === 200 && framedState.index === true,
      '右栏 iframe 的目标页可取到运行时的索引页',
      `状态 ${framedState.status}，${framedState.length} 字符`,
    );

    // 按设备取插件清单：真实的组合包与插件行。
    const pluginsResponse = await fetch(`${base}/chatdsh/gateway/devices/${nodeA.deviceId}/plugins`);
    const plugins = await pluginsResponse.json();
    check(
      pluginsResponse.status === 200 && Array.isArray(plugins.bundles) && plugins.bundles.length > 0 && Array.isArray(plugins.plugins) && plugins.plugins.length > 0,
      '按设备取插件清单返回组合包与插件行',
      `${pluginsResponse.status}，组合包 ${plugins.bundles?.length ?? 0} 个、插件行 ${plugins.plugins?.length ?? 0} 条`,
    );
    console.log(`插件清单样例：${JSON.stringify({
      deviceId: plugins.deviceId,
      bundle: plugins.bundles?.[0] === undefined ? undefined : { name: plugins.bundles[0].name, enabled: plugins.bundles[0].enabled, rows: plugins.bundles[0].rows?.length },
      plugin: plugins.plugins?.[0] === undefined ? undefined : { entryId: plugins.plugins[0].entryId, moduleName: plugins.plugins[0].moduleName, enabled: plugins.plugins[0].enabled, fiberPhase: plugins.plugins[0].fiberPhase },
    })}`);

    // 杀掉设备 A，重新打开外壳。
    runtimes[0].runtime.child.kill('SIGTERM');
    const offline = await waitFor(async () => {
      const listed = await (await fetch(`${base}/chatdsh/gateway/devices`)).json();
      const record = listed.devices.find((device) => device.id === nodeA.deviceId);
      return record !== undefined && record.online === false
        ? { ok: true, detail: JSON.stringify(record) }
        : { ok: false, detail: '设备 A 仍显示在线' };
    }, 30_000, 500);
    check(offline.ok, '杀掉设备 A 后它显示离线', offline.detail);

    await page.navigate(`${base}/`);
    const afterKill = await waitFor(async () => {
      const states = await page.evaluate(SHELL_STATE_EXPRESSION);
      if (!Array.isArray(states)) return { ok: false, detail: '左栏还没渲染' };
      const record = states.find((device) => device.deviceId === nodeA.deviceId);
      if (record === undefined) return { ok: false, detail: '左栏里没有设备 A' };
      const kept = record.sessions.some((session) => session.sessionId === sessionA);
      const offline = record.state.includes('离线');
      return kept && offline
        ? { ok: true, detail: `${record.name}：${record.state}，会话 ${record.sessions.length} 条` }
        : { ok: false, detail: `${record.name}：${record.state}，会话 ${record.sessions.length} 条`, states };
    }, 30_000, 500);
    check(afterKill.ok, '断言四：杀掉 A 后重新打开外壳，A 标为离线且会话仍在列表里', afterKill.detail);

    const pluginsOffline = await fetch(`${base}/chatdsh/gateway/devices/${nodeA.deviceId}/plugins`);
    const pluginsOfflineBody = await pluginsOffline.json();
    check(
      pluginsOffline.status === 409 && pluginsOfflineBody.error === 'device-offline',
      '设备离线时插件清单端点返回 409 device-offline',
      `${pluginsOffline.status} ${JSON.stringify(pluginsOfflineBody)}`,
    );
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
console.log('客户端外壳验收通过');
process.exit(0);
