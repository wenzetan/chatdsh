// 双设备分派的整机验收。
//
// 起两个真实的 dsh 实例（各自独立的数据根与端口，一个 Web 形态、一个桌面形态），各自以
// 节点令牌连上控制平面。控制平面按 `/d/<deviceId>/` 前缀分派：同一设备两次请求应当落到
// 同一个实例，两台设备的请求应当落到不同实例——用页面指纹判定，两种形态的内联启动条目
// 不同，指纹因此可区分。
//
// 用法：node scripts/verify-routing-live.mjs [--port 3191]
// 退出码 0 表示两台设备各自稳定落到自己的实例，且互不相同。

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { findFreePort } from '../gateway/lib/runtime.js';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * 在数据根里挂上 profile。
 * @param home - 该实例的数据根。
 * @param profileName - profile 名称。
 */
function ensureProfile(home, profileName) {
  mkdirSync(join(home, 'profiles'), { recursive: true });
  const link = join(home, 'profiles', profileName);
  if (!existsSync(link)) symlinkSync(join(ROOT, 'profiles', profileName), link);
}

const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const controlPort = await findFreePort(portFlag < 0 ? 3191 : Number.parseInt(argv[portFlag + 1], 10));
// 三个数据根都走 tempHome：正常结束、异常退出、信号中断时都会清理。
const runtimes = [
  { name: 'a', port: await findFreePort(controlPort + 1), profile: 'chatdsh-web', home: tempHome('route-a') },
  // 第二个实例用桌面形态：它多启用一个侧栏面板，页面内联的启动条目因此与 web 形态不同，
  // 这正是区分两者落点的依据。
  { name: 'b', port: await findFreePort(controlPort + 2), profile: 'chatdsh-desktop', home: tempHome('route-b') },
];
const GATEWAY_HOME = tempHome('routing-live');
const pairingCode = randomBytes(9).toString('base64url');

const children = [];
const failures = [];

/** 记一条断言结果。 */
function check(ok, label, detail) {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail === undefined ? '' : ` → ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 起一个 dsh 实例，等它的启动行。 */
async function startRuntime(runtime) {
  ensureProfile(runtime.home, runtime.profile); // gitleaks:allow
  const child = spawn(dshCommand(), ['--profile', runtime.profile, '--port', String(runtime.port), '--no-open'], {
    env: {
      ...process.env,
      DSH_HOME: runtime.home, // gitleaks:allow
      CHATDSH_TELEMETRY: 'off',
      CHATDSH_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
      CHATDSH_NODE_TOKEN: runtime.token,
      CHATDSH_DEVICE_ID: runtime.deviceId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    if (match) return match[1];
    if (child.exitCode !== null) throw new Error(`实例 ${runtime.name} 提前退出：\n${output.slice(-800)}`);
    await delay(400);
  }
  throw new Error(`实例 ${runtime.name} 启动超时：\n${output.slice(-800)}`);
}

let gateway;
try {
  gateway = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
    env: {
      ...process.env,
      DSH_HOME: GATEWAY_HOME,
      CHATDSH_TELEMETRY: 'off',
      CHATDSH_GATEWAY_PORT: String(controlPort),
      CHATDSH_GATEWAY_DB: join(GATEWAY_HOME, 'gateway.sqlite'),
      CHATDSH_PAIRING_CODE: pairingCode,
      CHATDSH_RUNTIME_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(gateway);
  let output = '';
  gateway.stdout.on('data', (chunk) => { output += chunk; });
  gateway.stderr.on('data', (chunk) => { output += chunk; });

  const base = `http://127.0.0.1:${controlPort}`;
  const readyDeadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch {
      // 还没起来。
    }
    await delay(300);
  }
  if (!ready) throw new Error(`控制平面未就绪：\n${output.slice(-500)}`);
  console.log(`控制平面已就绪：${base}`);

  for (const runtime of runtimes) {
    const response = await fetch(`${base}/chatdsh/gateway/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, name: `device-${runtime.name}`, platform: 'linux', role: 'both', capabilities: [] }),
    });
    if (!response.ok) throw new Error(`配对 ${runtime.name} 失败：${response.status}`);
    const paired = await response.json();
    runtime.deviceId = paired.deviceId;
    runtime.token = paired.token;
  }

  for (const runtime of runtimes) {
    runtime.bootUrl = await startRuntime(runtime);
    console.log(`实例 ${runtime.name} 已启动：${runtime.bootUrl.split('?')[0]}`);
  }

  // 两台设备都连上之后分派才会生效。
  const onlineDeadline = Date.now() + 90_000;
  let allOnline = false;
  while (Date.now() < onlineDeadline) {
    const listed = await (await fetch(`${base}/chatdsh/gateway/devices`)).json();
    allOnline = runtimes.every((runtime) => listed.devices.some((device) => device.id === runtime.deviceId && device.online));
    if (allOnline) break;
    await delay(500);
  }
  check(allOnline, '两台设备的长连接都已建立');
  if (!allOnline) throw new Error('长连接没有建立');

  /** 经 /d/<deviceId>/ 取一次首页并算指纹。 */
  async function fingerprint(runtime) {
    const prefix = `${base}/d/${runtime.deviceId}`;
    const token = new URL(runtime.bootUrl).searchParams.get('token') ?? '';
    // 第一次带令牌拿到 cookie；cookie 的名字按设备自己的地址生成，因此只能经同一设备的
    // 前缀回传。
    const login = await fetch(`${prefix}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0];
    if (cookie === '') throw new Error(`没有拿到会话 cookie（${runtime.name}）`);
    const response = await fetch(`${prefix}/`, { headers: { cookie }, redirect: 'manual' });
    const body = await response.text();
    return {
      status: response.status,
      digest: createHash('sha256').update(body).digest('hex').slice(0, 12),
      length: body.length,
    };
  }

  const [a, b] = runtimes;
  const aOne = await fingerprint(a);
  const aTwo = await fingerprint(a);
  const bOne = await fingerprint(b);

  console.log(`设备 a 两次：${aOne.digest}/${aOne.status} 与 ${aTwo.digest}/${aTwo.status}`);
  console.log(`设备 b 一次：${bOne.digest}/${bOne.status}`);
  check(aOne.status === 200 && bOne.status === 200, '两台设备的首页都取到了');
  check(aOne.digest === aTwo.digest, '同一设备的两次请求落到同一实例');
  check(aOne.digest !== bOne.digest, '两台设备的请求落到不同实例');
} catch (error) {
  check(false, '验收中断', error instanceof Error ? error.message : String(error));
} finally {
  for (const child of children) child.kill('SIGTERM');
  await delay(800);
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('双设备分派验收通过');
process.exit(0);
