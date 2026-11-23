// 按设备分派的验收。
//
// 两台真实 dsh 运行时各自以节点令牌连上控制平面，控制平面按 `/d/<deviceId>/` 前缀把请求
// 分派到对应设备；没有前缀的请求不属于设备路由，返回 404，不回退到任何设备。
//
// 用法：node scripts/verify-routing.mjs [--port 3190]
// 退出码 0 表示两台设备各自命中自己的运行时、未知设备不回退、Remote mux 隧道可用。

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { installRuntimeProfile } from './lib/dsh-runtime.mjs';
import { findFreePort } from './lib/ports.mjs';
import { probeRemoteMux, upgradeStatus } from './lib/remote-mux.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const controlPort = await findFreePort(portFlag < 0 ? 3190 : Number.parseInt(argv[portFlag + 1], 10));
const portA = await findFreePort(controlPort + 1);
const portB = await findFreePort(portA + 1);
const pairingCode = randomBytes(9).toString('base64url');
const failures = [];

/** 记一条断言结果。 */
function check(ok, label, detail) {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail === undefined ? '' : ` → ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 等到条件成立。 */
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

const home = tempHome('routing-home');
const base = `http://127.0.0.1:${controlPort}`;

const gateway = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
  env: {
    ...process.env,
    DSH_HOME: home,
    CHATDSH_TELEMETRY: 'off',
    CHATDSH_GATEWAY_PORT: String(controlPort),
    CHATDSH_GATEWAY_DB: join(home, 'gateway.sqlite'),
    CHATDSH_PAIRING_CODE: pairingCode,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
gateway.stdout.on('data', (chunk) => { output += chunk; });
gateway.stderr.on('data', (chunk) => { output += chunk; });

const runtimes = [];
try {
  const ready = await waitFor(async () => {
    if (gateway.exitCode !== null) return { ok: false, detail: `控制平面已退出（${gateway.exitCode}）\n${output.slice(-800)}` };
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      return { ok: response.ok, detail: `${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }, 30_000);
  check(ready.ok, '控制平面已监听', ready.detail);
  if (!ready.ok) throw new Error('控制平面没有就绪');
  console.log(`端口：控制平面 ${controlPort}、设备 A ${portA}、设备 B ${portB}`);

  const nodes = [];
  for (const name of ['device-a', 'device-b']) {
    const response = await fetch(`${base}/chatdsh/gateway/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, name, platform: 'linux', role: 'both', capabilities: [] }),
    });
    if (!response.ok) throw new Error(`配对 ${name} 失败：${response.status}`);
    nodes.push({ name, ...(await response.json()) });
  }

  for (const [index, node] of nodes.entries()) {
    const runtimeHome = tempHome(`routing-${node.name}`);
    installRuntimeProfile(runtimeHome);
    const child = spawn(dshCommand(), ['--profile', 'web', '--port', String(index === 0 ? portA : portB), '--no-open'], {
      env: {
        ...process.env,
        DSH_HOME: runtimeHome,
        CHATDSH_TELEMETRY: 'off',
        CHATDSH_CONTROL_URL: base,
        CHATDSH_NODE_TOKEN: node.token,
        CHATDSH_DEVICE_ID: node.deviceId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state = { node, child, output: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { state.output += chunk; });
    child.stderr.on('data', (chunk) => { state.output += chunk; });
    runtimes.push(state);
  }

  for (const state of runtimes) {
    const booted = await waitFor(() => {
      if (state.child.exitCode !== null) return { ok: false, detail: `运行时已退出（${state.child.exitCode}）` };
      const match = state.output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
      return match === null ? { ok: false, detail: '还没打印启动地址' } : { ok: true, detail: match[1].split('?')[0] };
    }, 180_000, 1000);
    check(booted.ok, `${state.node.name} 运行时已启动`, booted.detail);
    if (!booted.ok) throw new Error(`${state.node.name} 没有启动：${state.output.slice(-800)}`);
  }

  const online = await waitFor(async () => {
    const listed = await (await fetch(`${base}/chatdsh/gateway/devices`)).json();
    const onlineIds = new Set(listed.devices.filter((device) => device.online).map((device) => device.id));
    const missing = nodes.filter((node) => !onlineIds.has(node.deviceId)).map((node) => node.name);
    return missing.length === 0 ? { ok: true, detail: '两台都在线' } : { ok: false, detail: `还没上线：${missing.join('、')}` };
  }, 90_000, 1000);
  check(online.ok, '两台设备的长连接都已建立', online.detail);
  if (!online.ok) throw new Error('长连接没有建立');

  const [nodeA, nodeB] = nodes;
  const healthA = await fetch(`${base}/d/${nodeA.deviceId}/healthz`);
  const bodyA = await healthA.json();
  check(healthA.status === 200 && bodyA.service === 'chatdsh-device-link', '经 /d/A/ 落到设备 A', `${healthA.status} ${JSON.stringify(bodyA)}`);

  const healthB = await fetch(`${base}/d/${nodeB.deviceId}/healthz`);
  const bodyB = await healthB.json();
  check(healthB.status === 200 && bodyB.service === 'chatdsh-device-link', '经 /d/B/ 落到设备 B', `${healthB.status} ${JSON.stringify(bodyB)}`);

  const unknown = await fetch(`${base}/d/not-a-device/healthz`);
  const unknownBody = await unknown.json();
  check(unknown.status === 404 && unknownBody.error === 'device-not-found', '未知设备不回退到默认运行时', `${unknown.status} ${JSON.stringify(unknownBody)}`);

  const noPrefix = await fetch(`${base}/probe`);
  check(noPrefix.status === 404, '没有 /d/ 前缀的请求不被转发到任何设备', `${noPrefix.status}`);

  for (const node of nodes) {
    const probe = await probeRemoteMux(base, node.deviceId);
    const item = probe.frames.find((frame) => frame.type === 'item');
    const value = item?.value;
    const ok = probe.terminal.type === 'item'
      && typeof value === 'object' && value !== null
      && value.type === 'rows'
      && Array.isArray(value.jobs);
    check(ok, `${node.name} 的 Remote mux 双向收发`, JSON.stringify({ request: probe.request, frames: probe.frames }));
  }

  const pathRejected = await upgradeStatus(`${base}/d/${nodeA.deviceId}/other`);
  check(
    pathRejected.status === 403 && JSON.parse(pathRejected.body).error === 'path-invalid',
    '非白名单 WebSocket 路径回 403',
    `${pathRejected.status} ${pathRejected.body}`,
  );

  let tunnelClosed = false;
  const tunnel = new WebSocket(`${base.replace(/^http/, 'ws')}/d/${nodeA.deviceId}/api/remote.mux`);
  tunnel.addEventListener('close', () => { tunnelClosed = true; });
  await new Promise((resolve, reject) => {
    tunnel.addEventListener('open', resolve, { once: true });
    tunnel.addEventListener('error', () => reject(new Error('设备 A 的隧道升级失败')), { once: true });
  });

  runtimes[0].child.kill('SIGTERM');
  const tunnelResult = await waitFor(() => ({ ok: tunnelClosed, detail: tunnelClosed ? '已关闭' : '仍打开' }), 10_000, 100);
  check(tunnelResult.ok, '设备被终止后浏览器隧道关闭', tunnelResult.detail);

  const offline = await waitFor(async () => {
    const listed = await (await fetch(`${base}/chatdsh/gateway/devices`)).json();
    const record = listed.devices.find((device) => device.id === nodeA.deviceId);
    return record !== undefined && record.online === false ? { ok: true, detail: '已离线' } : { ok: false, detail: '仍在线' };
  }, 30_000);
  check(offline.ok, '杀掉设备 A 后它显示离线', offline.detail);

  const offlineHit = await fetch(`${base}/d/${nodeA.deviceId}/healthz`);
  check(offlineHit.status === 409, '设备离线时 /d/A/ 返回 409', `${offlineHit.status}`);

  const offlineUpgrade = await upgradeStatus(`${base}/d/${nodeA.deviceId}/api/remote.mux`);
  check(
    offlineUpgrade.status === 409 && JSON.parse(offlineUpgrade.body).error === 'device-offline',
    '设备离线时 WebSocket 升级返回 409',
    `${offlineUpgrade.status} ${offlineUpgrade.body}`,
  );

  const stillB = await fetch(`${base}/d/${nodeB.deviceId}/healthz`);
  check(stillB.status === 200, '设备 B 不受影响', `${stillB.status}`);
} catch (error) {
  check(false, '验收中断', error instanceof Error ? error.message : String(error));
  if (output !== '') console.log(`控制平面输出片段：\n${output.slice(-1000)}`);
  for (const state of runtimes) {
    if (state.output !== '') console.log(`${state.node.name} 输出片段：\n${state.output.slice(-800)}`);
  }
} finally {
  for (const state of runtimes) state.child.kill('SIGTERM');
  gateway.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 800));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('按设备分派验收通过');
process.exit(0);
