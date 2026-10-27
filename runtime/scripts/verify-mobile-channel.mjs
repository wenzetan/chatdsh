// 手机业务通道的端到端验收：真实控制平面 → 托管运行时 → 真实移动网关插件。
//
// 依次核对：配对签发设备令牌、令牌取启动路径、未带令牌的 WebSocket 升级被拒绝、
// 带令牌的升级到达插件并收到 hello、吊销后 HTTP 与 WebSocket 同时拒绝。
// 全程使用临时数据根，结束后清理；日志只在失败时打印，且由运行时与控制平面自行脱敏。
//
// 用法：node scripts/verify-mobile-channel.mjs [--keep]
// 退出码 0 表示全部通过。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// 控制平面与运行时都要用同一版 node 启动。运行时有最低版本要求，当前 shell 的 node
// 可能低于它，直接复用会把运行时子进程交给另一个大版本、启动阶段退出。这里优先用
// 已安装 dsh 的那一版 node，取不到时退回当前进程。
function nodeRuntime() {
  if (process.env.CHATDSH_NODE !== undefined) return process.env.CHATDSH_NODE;
  const candidates = execFileSync('bash', ['-lc', 'ls -d /usr/local/nvm/versions/node/*/bin/node 2>/dev/null'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  let best;
  for (const candidate of candidates) {
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
    const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
    if (best === undefined || major > best.major) best = { candidate, major };
  }
  return best === undefined ? process.execPath : best.candidate;
}
const NODE = nodeRuntime();
const DSH_BIN = process.env.CHATDSH_DSH_BIN
  ?? '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
const KEEP = process.argv.includes('--keep');
const HOME = join(ROOT, '.run', 'verify-mobile-channel');
const GATEWAY_PORT = Number.parseInt(process.env.CHATDSH_VERIFY_GATEWAY_PORT ?? '3211', 10);
const RUNTIME_PORT = GATEWAY_PORT + 1;
const PAIRING_CODE = 'verify-mobile-channel';

if (!existsSync(DSH_BIN)) throw new Error(`找不到 dsh 入口：${DSH_BIN}；用 CHATDSH_DSH_BIN 指定`);
if (!existsSync(join(ROOT, 'gateway', 'lib', 'main.js'))) {
  throw new Error('控制平面尚未编译：先执行 ./node_modules/.bin/tsc -b tsconfig.build.json');
}

// 托管运行时把 CHATDSH_RUNTIME_HOME 当 DSH_HOME，profile 必须挂在这一层下面。
rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, 'harness', 'profiles'), { recursive: true });
symlinkSync(join(ROOT, 'profiles', 'chatdsh-web'), join(HOME, 'harness', 'profiles', 'chatdsh-web'), 'dir');

let output = '';
const gateway = spawn(NODE, [join(ROOT, 'gateway', 'lib', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    CHATDSH_TELEMETRY: 'off',
    CHATDSH_GATEWAY_HOST: '127.0.0.1',
    CHATDSH_GATEWAY_PORT: String(GATEWAY_PORT),
    CHATDSH_PAIRING_CODE: PAIRING_CODE,
    CHATDSH_GATEWAY_DB: join(HOME, 'gateway.sqlite'),
    CHATDSH_RUNTIME_BIN: DSH_BIN,
    CHATDSH_RUNTIME_PROFILE: 'chatdsh-web',
    CHATDSH_RUNTIME_PORT: String(RUNTIME_PORT),
    CHATDSH_RUNTIME_HOME: join(HOME, 'harness'),
    CHATDSH_RUNTIME_CWD: ROOT,
    CHATDSH_RUNTIME_READY_TIMEOUT_MS: '180000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
gateway.stdout.on('data', (chunk) => { output += chunk.toString(); });
gateway.stderr.on('data', (chunk) => { output += chunk.toString(); });

const base = `http://127.0.0.1:${GATEWAY_PORT}`;

/** 等待配对可用；运行时启动要一到两分钟。 */
async function pairWhenReady() {
  const deadline = Date.now() + 180000;
  let lastError = '没有尝试';
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`控制平面已退出（${gateway.exitCode}）`);
    try {
      const response = await fetch(`${base}/chatdsh/gateway/mobile/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: PAIRING_CODE, deviceName: 'verify', platform: 'android' }),
      });
      if (response.ok) return await response.json();
      const body = await response.text();
      lastError = `${response.status} ${body}`;
      if (response.status !== 503 || !body.includes('runtime-not-ready')) throw new Error(`配对失败：${lastError}`);
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith('配对失败')) lastError = error.message;
      else throw error;
    }
    await new Promise((settle) => setTimeout(settle, 2000));
  }
  throw new Error(`运行时在 180 秒内没有就绪，最后一次：${lastError}`);
}

/** 尝试一次 WebSocket 升级，返回是否被拒绝。 */
function upgradeRejected(token) {
  return new Promise((resolveAttempt) => {
    const options = token === undefined
      ? { protocols: ['dsh-mobile-v1'] }
      : { protocols: ['dsh-mobile-v1'], headers: { 'x-chatdsh-device-token': token } };
    const socket = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/ws/mobile`, options);
    socket.addEventListener('open', () => { socket.close(); resolveAttempt(false); });
    socket.addEventListener('error', () => resolveAttempt(true));
    setTimeout(() => resolveAttempt(true), 8000);
  });
}

/** 用配对子协议升级，返回 paired 帧；失败时返回 undefined。 */
function pairOverWebSocket(code) {
  return new Promise((resolveFrame) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveFrame(value);
    };
    const socket = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/ws/mobile`, {
      protocols: ['dsh-mobile-v1', `dsh-pair.${code}`],
    });
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.kind === 'paired') { socket.close(); finish(frame); }
    });
    socket.addEventListener('error', () => finish(undefined));
    socket.addEventListener('close', () => finish(undefined));
    setTimeout(() => finish(undefined), 10000);
  });
}

/** 错误的配对码必须被拒绝。 */
function pairingRejected(code) {
  return new Promise((resolveAttempt) => {
    const socket = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/ws/mobile`, {
      protocols: ['dsh-mobile-v1', `dsh-pair.${code}`],
    });
    socket.addEventListener('open', () => { socket.close(); resolveAttempt(false); });
    socket.addEventListener('error', () => resolveAttempt(true));
    setTimeout(() => resolveAttempt(true), 8000);
  });
}

/** 带令牌升级并收集到 hello 为止的帧。 */
function collectUntilHello(token) {
  return new Promise((resolveFrames) => {
    const frames = [];
    const socket = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/ws/mobile`, {
      protocols: ['dsh-mobile-v1'],
      headers: { 'x-chatdsh-device-token': token },
    });
    socket.addEventListener('message', (event) => {
      frames.push(JSON.parse(String(event.data)));
      if (frames.some((frame) => frame.kind === 'hello')) { socket.close(); resolveFrames(frames); }
    });
    socket.addEventListener('error', () => resolveFrames(frames));
    setTimeout(() => resolveFrames(frames), 15000);
  });
}

let exitCode = 0;
try {
  const paired = await pairWhenReady();
  if (typeof paired.token !== 'string' || paired.token === '') throw new Error('配对响应缺少设备令牌');
  if (typeof paired.bootPath !== 'string' || paired.bootPath === '') throw new Error('配对响应缺少启动路径');
  console.log(`配对签发设备令牌，设备 ${paired.deviceId}`);

  const session = await fetch(`${base}/chatdsh/gateway/mobile/session`, {
    headers: { 'x-chatdsh-device-token': paired.token },
  });
  if (!session.ok) throw new Error(`令牌取启动路径失败：${session.status}`);
  console.log('设备令牌换取启动路径成功');

  if (!await upgradeRejected(undefined)) throw new Error('未带令牌的 WebSocket 升级没有被拒绝');
  console.log('未带令牌的升级被拒绝');

  // 配对子协议：上游客户端走的是「带 dsh-pair.<code> 升级 → 收到 paired 帧拿令牌」，
  // 这条路径必须与控制平面的配对接口给出同样的结果。
  if (!await pairingRejected('wrong-pairing-code')) throw new Error('错误配对码没有被拒绝');
  const pairedFrame = await pairOverWebSocket(PAIRING_CODE);
  if (pairedFrame === undefined) throw new Error('配对子协议没有返回 paired 帧');
  if (typeof pairedFrame.token !== 'string' || pairedFrame.token === '') throw new Error('paired 帧缺少令牌');
  console.log('配对子协议返回 paired 帧，客户端可零改动接入');

  const frames = await collectUntilHello(paired.token);
  const hello = frames.find((frame) => frame.kind === 'hello');
  if (hello === undefined) throw new Error(`带令牌的升级没有收到 hello：${JSON.stringify(frames).slice(0, 300)}`);
  if (hello.protocol !== 3) throw new Error(`hello 的协议版本不是 3：${hello.protocol}`);
  for (const capability of ['split-channels', 'session-create']) {
    if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes(capability)) {
      throw new Error(`hello 缺少能力 ${capability}`);
    }
  }
  console.log(`带令牌的升级到达插件，hello 协议 ${hello.protocol}，能力 ${hello.capabilities.length} 项`);

  const revoke = await fetch(`${base}/chatdsh/gateway/mobile/devices?id=${encodeURIComponent(paired.deviceId)}`, {
    method: 'DELETE',
  });
  if (!revoke.ok) throw new Error(`吊销设备失败：${revoke.status}`);
  const afterRevoke = await fetch(`${base}/chatdsh/gateway/mobile/session`, {
    headers: { 'x-chatdsh-device-token': paired.token },
  });
  if (afterRevoke.status !== 401) throw new Error(`吊销后取启动路径没有被拒绝：${afterRevoke.status}`);
  if (!await upgradeRejected(paired.token)) throw new Error('吊销后的 WebSocket 升级没有被拒绝');
  console.log('吊销后 HTTP 与 WebSocket 同时拒绝');
  console.log('手机业务通道验收通过');
} catch (error) {
  exitCode = 1;
  console.log(`验收失败：${error instanceof Error ? error.message : String(error)}`);
  console.log('--- 控制平面与运行时日志尾部 ---');
  console.log(output.split('\n').slice(-40).join('\n'));
} finally {
  gateway.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 3000));
  if (!KEEP) rmSync(HOME, { recursive: true, force: true });
}
process.exit(exitCode);
