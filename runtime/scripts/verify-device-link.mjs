// 设备长连接的整机验收：一个真实控制平面加两台真实 dsh 运行时。
//
// 链路全部是真实进程：控制平面按 `gateway/lib/main.js` 启动，不托管运行时；两台设备各跑
// 一个官方 `dsh --profile web` 并安装 `@chatdsh/bundle`，用配对的节点令牌主动连到控制平面。
// 断言覆盖两台在线、各自自检、经 `/d/<deviceId>/api/remote.mux` 的 WebSocket 双向收发、
// 非白名单路径拒绝、杀掉一台后隧道关闭与离线 409，以及另一台仍在线。
//
// 用法：node scripts/verify-device-link.mjs
// 退出码 0 表示全部通过。端口从 20140 起；被占用时顺延，并在输出里写明实际端口。

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { installRuntimeProfile } from './lib/dsh-runtime.mjs';
import { findFreePort } from './lib/ports.mjs';
import { probeRemoteMux, upgradeStatus } from './lib/remote-mux.mjs';

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
  const found = await waitFor(() => {
    if (runtime.child.exitCode !== null) {
      return { ok: false, detail: `运行时已退出（${runtime.child.exitCode}）\n${runtime.output.slice(-800)}` };
    }
    const match = runtime.output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    return match === null
      ? { ok: false, detail: '还没打印启动地址' }
      : { ok: true, detail: match[1].split('?')[0] };
  }, timeoutMs, 1000);
  return found;
}

/** 读设备列表。 */
async function devices(base) {
  const response = await fetch(`${base}/chatdsh/gateway/devices`);
  if (!response.ok) throw new Error(`设备列表返回 ${response.status}`);
  return response.json();
}

// 端口：先按约定取 20140 到 20142，被占用时顺延。
const controlPort = await findFreePort(20140);
const portA = await findFreePort(controlPort + 1);
const portB = await findFreePort(portA + 1);
if (controlPort !== 20140 || portA !== 20141 || portB !== 20142) {
  console.log(`端口 20140 到 20142 有占用，实际使用 控制平面 ${controlPort}、设备 A ${portA}、设备 B ${portB}`);
} else {
  console.log(`端口：控制平面 ${controlPort}、设备 A ${portA}、设备 B ${portB}`);
}

const root = tempHome('verify-device-link');
const base = `http://127.0.0.1:${controlPort}`;
const gateway = startProcess(process.execPath, [join(ROOT, 'gateway', 'lib', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_HOME: root,
    CHATDSH_TELEMETRY: 'off',
    CHATDSH_GATEWAY_HOST: '127.0.0.1',
    CHATDSH_GATEWAY_PORT: String(controlPort),
    CHATDSH_GATEWAY_DB: join(root, 'gateway.sqlite'),
    CHATDSH_PAIRING_CODE: PAIRING_CODE,
    CHATDSH_RUNTIME_URL: 'http://127.0.0.1:9',
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

  // 两台设备各取一个节点令牌。
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
    const home = tempHome(`verify-device-link-${node.name}`);
    installRuntimeProfile(home);
    const runtime = startProcess(dshCommand(), ['--profile', 'web', '--port', String(ports[index]), '--no-open'], {
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
    check(boot.ok, `${entry.node.name} 运行时已启动`, boot.detail);
    if (!boot.ok) throw new Error(`${entry.node.name} 没有启动：${entry.runtime.output.slice(-1200)}`);
  }

  // 两台的长连接都要连上。
  const online = await waitFor(async () => {
    const listed = await devices(base);
    const onlineIds = new Set(listed.devices.filter((device) => device.online).map((device) => device.id));
    const missing = nodes.filter((node) => !onlineIds.has(node.deviceId)).map((node) => node.name);
    return missing.length === 0
      ? { ok: true, detail: JSON.stringify(listed) }
      : { ok: false, detail: `还没上线：${missing.join('、')}` };
  }, 90_000, 1000);
  check(online.ok, '两台设备的在线状态都是 true', online.ok ? online.detail : online.detail);
  if (!online.ok) throw new Error('长连接没有建立');

  console.log(`设备列表响应：${online.detail}`);

  for (const node of nodes) {
    const response = await fetch(`${base}/chatdsh/gateway/devices/${node.deviceId}/probe`);
    const payload = await response.json();
    check(response.status === 200 && payload.status === 200, `${node.name} 自检返回 200`, JSON.stringify(payload));
  }

  // 经 /d/<deviceId>/api/remote.mux 完成真实的 WebSocket 双向收发。
  for (const node of nodes) {
    const frame = await probeRemoteMux(base, node.deviceId);
    check(frame.type === 'error' && frame.streamId === 'chatdsh-probe', `${node.name} 的 Remote mux 双向收发`, JSON.stringify(frame));
  }

  const pathRejected = await upgradeStatus(`${base}/d/${nodes[0].deviceId}/other`);
  check(
    pathRejected.status === 403 && JSON.parse(pathRejected.body).error === 'path-invalid',
    '非白名单 WebSocket 路径回 403',
    `${pathRejected.status} ${pathRejected.body}`,
  );

  // 打开一条真实隧道，然后杀掉设备：浏览器侧必须被关闭。
  const target = runtimes[0];
  let tunnelClosed = false;
  const tunnel = new WebSocket(`${base.replace(/^http/, 'ws')}/d/${target.node.deviceId}/api/remote.mux`);
  tunnel.addEventListener('close', () => { tunnelClosed = true; });
  await new Promise((resolve, reject) => {
    tunnel.addEventListener('open', resolve, { once: true });
    tunnel.addEventListener('error', () => reject(new Error('设备 A 的隧道升级失败')), { once: true });
  });

  // 杀掉设备 A：它立刻离线，探测被拒绝；设备 B 仍然在线。
  target.runtime.child.kill('SIGTERM');
  const tunnelResult = await waitFor(() => ({ ok: tunnelClosed, detail: tunnelClosed ? '已关闭' : '仍打开' }), 10_000, 100);
  check(tunnelResult.ok, '设备被终止后浏览器隧道关闭', tunnelResult.detail);

  const offline = await waitFor(async () => {
    const listed = await devices(base);
    const record = listed.devices.find((device) => device.id === target.node.deviceId);
    return record !== undefined && record.online === false
      ? { ok: true, detail: JSON.stringify(record) }
      : { ok: false, detail: '设备 A 仍显示在线' };
  }, 30_000, 500);
  check(offline.ok, '杀掉设备 A 后它显示离线', offline.detail);

  const rejected = await fetch(`${base}/chatdsh/gateway/devices/${target.node.deviceId}/probe`);
  const rejectedBody = await rejected.json();
  check(rejected.status === 409 && rejectedBody.error === 'device-offline', '设备 A 的探测返回 409', `${rejected.status} ${JSON.stringify(rejectedBody)}`);

  const rejectedUpgrade = await upgradeStatus(`${base}/d/${target.node.deviceId}/api/remote.mux`);
  check(
    rejectedUpgrade.status === 409 && JSON.parse(rejectedUpgrade.body).error === 'device-offline',
    '设备 A 离线时 WebSocket 升级返回 409',
    `${rejectedUpgrade.status} ${rejectedUpgrade.body}`,
  );

  const stillOnline = await fetch(`${base}/chatdsh/gateway/devices/${runtimes[1].node.deviceId}/probe`);
  const stillBody = await stillOnline.json();
  check(stillOnline.status === 200 && stillBody.status === 200, '设备 B 仍然可以自检', JSON.stringify(stillBody));

  const finalList = await devices(base);
  const deviceB = finalList.devices.find((device) => device.id === runtimes[1].node.deviceId);
  check(deviceB !== undefined && deviceB.online === true, '设备 B 仍然在线', JSON.stringify(deviceB));
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
console.log('设备长连接验收通过');
process.exit(0);
