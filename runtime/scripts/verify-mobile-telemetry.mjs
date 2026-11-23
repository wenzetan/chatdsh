// 手机遥测上报的端到端验收：真实控制平面接收一批记录并核对中转结果。
//
// 依次核对：配对拿令牌、合法批次被接收并按信号分类计数、未登记属性被丢弃并计数、
// 禁止内容被拒绝且返回具体原因、无效令牌被拒绝。
//
// 用法：node scripts/verify-mobile-telemetry.mjs
// 退出码 0 表示全部通过。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOME = join(ROOT, '.run', 'verify-mobile-telemetry');
const GATEWAY_PORT = Number.parseInt(process.env.CHATDSH_VERIFY_TELEMETRY_PORT ?? '3241', 10);
const RUNTIME_PORT = GATEWAY_PORT + 1;
const PAIRING_CODE = 'verify-mobile-telemetry';
// 一个能接受 OTLP 的最小接收端，用来确认中转确实把记录交给了 exporter。
const OTLP_PORT = GATEWAY_PORT + 2;

rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, 'harness', 'profiles'), { recursive: true });
// 控制平面的数据根必须先存在，否则存储初始化会在 mkdir 阶段失败。
mkdirSync(join(HOME, 'gateway'), { recursive: true });
symlinkSync(join(ROOT, 'profiles', 'chatdsh-web'), join(HOME, 'harness', 'profiles', 'chatdsh-web'), 'dir');

// 控制平面与运行时都要用同一版 node 启动；当前 shell 的版本可能低于运行时的要求。
function nodeRuntime() {
  if (process.env.CHATDSH_NODE !== undefined) return process.env.CHATDSH_NODE;
  const candidates = execFileSync('bash', ['-lc', 'ls -d /usr/local/nvm/versions/node/*/bin/node 2>/dev/null'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  let best;
  for (const candidate of candidates) {
    const major = Number.parseInt(execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '').split('.')[0], 10);
    if (best === undefined || major > best.major) best = { candidate, major };
  }
  return best === undefined ? process.execPath : best.candidate;
}

let output = '';
const gateway = spawn(nodeRuntime(), [join(ROOT, 'gateway', 'lib', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_HOME: HOME,
    // 遥测只有配好采集目标才会启用；端点据此决定是转发还是回 404。
    CHATDSH_TELEMETRY_ENDPOINT: `http://127.0.0.1:${OTLP_PORT}`,
    CHATDSH_TELEMETRY_ORG: 'verify',
    CHATDSH_TELEMETRY_USER: 'verify-user',
    CHATDSH_TELEMETRY_PASSWORD: 'verify-password', // gitleaks:allow
    CHATDSH_GATEWAY_HOST: '127.0.0.1',
    CHATDSH_GATEWAY_PORT: String(GATEWAY_PORT),
    CHATDSH_PAIRING_CODE: PAIRING_CODE,
    CHATDSH_GATEWAY_DB: join(HOME, 'gateway', 'gateway.sqlite'),
    CHATDSH_RUNTIME_BIN: process.env.CHATDSH_DSH_BIN
      ?? '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
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
gateway.on('exit', (code) => { output += `\n[exit] ${code}\n`; });

const base = `http://127.0.0.1:${GATEWAY_PORT}`;

async function pairWhenReady() {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`控制平面已退出（${gateway.exitCode}）`);
    const response = await fetch(`${base}/chatdsh/gateway/mobile/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING_CODE, deviceName: 'telemetry', platform: 'android' }),
    });
    if (response.ok) return await response.json();
    const body = await response.text();
    if (response.status !== 503 || !body.includes('runtime-not-ready')) {
      throw new Error(`配对失败：${response.status} ${body}`);
    }
    await new Promise((settle) => setTimeout(settle, 2000));
  }
  throw new Error('运行时在 180 秒内没有就绪');
}

function post(token, body) {
  return fetch(`${base}/chatdsh/telemetry/mobile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-device-token': token },
    body: JSON.stringify(body),
  });
}

let exitCode = 0;
try {
  // 等控制平面把端口监听起来再继续。
  {
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
      if (gateway.exitCode !== null) break;
      try {
        const probe = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (probe.status < 500) { ready = true; break; }
      } catch {}
      await new Promise((settle) => setTimeout(settle, 500));
    }
    if (!ready) throw new Error(`控制平面没有在 ${GATEWAY_PORT} 就绪`);
  }
  const paired = await pairWhenReady();
  console.log(`配对签发了设备令牌，设备 ${paired.deviceId}`);

  const accepted = await post(paired.token, {
    records: [
      { signal: 'span', name: 'chatdsh.mobile.connect', durationMs: 320, attributes: { attempt: 1, outcome: 'ok' } },
      { signal: 'event', name: 'chatdsh.mobile.keystore', attributes: { action: 'write', outcome: 'ok' } },
      { signal: 'metric', name: 'chatdsh_mobile_offline_queue_depth', value: 3, attributes: {} },
    ],
  });
  if (!accepted.ok) throw new Error(`合法批次被拒绝：${accepted.status} ${await accepted.text()}`);
  const acceptedBody = await accepted.json();
  if (acceptedBody.accepted !== true) throw new Error(`响应没有 accepted：${JSON.stringify(acceptedBody)}`);
  if (acceptedBody.counts?.span !== 1 || acceptedBody.counts?.event !== 1 || acceptedBody.counts?.metric !== 1) {
    throw new Error(`按信号计数不正确：${JSON.stringify(acceptedBody.counts)}`);
  }
  console.log(`合法批次被接收，计数 ${JSON.stringify(acceptedBody.counts)}`);

  const dropped = await post(paired.token, {
    records: [{ signal: 'event', name: 'chatdsh.mobile.keystore', attributes: { action: 'read', outcome: 'ok', 'not.registered': 'x' } }],
  });
  if (!dropped.ok) throw new Error(`含未登记属性的批次被拒绝：${dropped.status}`);
  const droppedBody = await dropped.json();
  // dropped 按信号分组计数，这里只发了 event，因此看 event 那一项。
  if (droppedBody.dropped?.event !== 1) throw new Error(`未登记属性没有被计入丢弃：${JSON.stringify(droppedBody)}`);
  console.log('未登记属性被丢弃并计数');

  for (const [label, record, expected] of [
    ['邮箱', { signal: 'event', name: 'chatdsh.mobile.keystore', attributes: { action: 'read@example.com', outcome: 'ok' } }, 'email'],
    // 这一项就是要让中转端点识别出私有网段并拒绝，因此必须用真实私有地址作为夹具。
    ['内网地址', { signal: 'event', name: 'chatdsh.mobile.keystore', attributes: { action: '10.1.1.11', outcome: 'ok' } }, 'internal-address'], // gitleaks:allow
    ['未登记名称', { signal: 'event', name: 'chatdsh.mobile.unknown', attributes: { outcome: 'ok' } }, 'invalid-name'],
  ]) {
    const response = await post(paired.token, { records: [record] });
    if (response.status !== 422 && response.status !== 400) {
      throw new Error(`${label} 没有被拒绝：${response.status}`);
    }
    const body = await response.json();
    if (body.error !== expected) throw new Error(`${label} 的拒绝原因是 ${body.error}，期望 ${expected}`);
    console.log(`${label} 被拒绝，原因 ${body.error}`);
  }

  const unauthorized = await post('not-a-valid-token', {
    records: [{ signal: 'event', name: 'chatdsh.mobile.keystore', attributes: { outcome: 'ok' } }],
  });
  if (unauthorized.status !== 401) throw new Error(`无效令牌没有被拒绝：${unauthorized.status}`);
  console.log('无效令牌被拒绝');
  console.log('手机遥测上报验收通过');
} catch (error) {
  exitCode = 1;
  console.log(`验收失败：${error instanceof Error ? error.message : String(error)}`);
  console.log('--- 控制平面日志尾部 ---');
  console.log(output.split('\n').slice(-30).join('\n'));
} finally {
  gateway.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 3000));
  rmSync(HOME, { recursive: true, force: true });
}
process.exit(exitCode);
