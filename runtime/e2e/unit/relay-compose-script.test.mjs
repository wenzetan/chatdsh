// 中继 Docker Compose 引导脚本、配对审批机制与设备一行接入脚本的单元测试。
//
// 验证域名归一化、禁止绑定 0.0.0.0/:: 通配地址、首次自动生成随机口令与二次复用、
// 脱敏输出、`--disable-pairing` / `--rotate-pairing-code`、以及配对审批状态机
// （202 pending -> 管理员回环审批 -> 一次性领取 -> 409 重领拒绝 / 403 拒绝）与 device-join.sh 轮询。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createGatewayServer, createPushHub, DeviceLinkHub, GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/index.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const RELAY_UP = join(REPO_ROOT, 'scripts/relay-up.sh');
const DEVICE_JOIN = join(REPO_ROOT, 'scripts/device-join.sh');
const PACK_BUNDLE = join(REPO_ROOT, 'scripts/pack-plugin-bundle.mjs');

function parseSimpleEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let val = match[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    map.set(match[1], val);
  }
  return map;
}

function runRelayUp(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  delete env.CHATDSH_PAIRING_CODE;
  delete env.CHATDSH_PUBLIC_URL;
  delete env.CHATDSH_GATEWAY_BIND_HOST;
  delete env.CHATDSH_PAIRING_APPROVAL;
  if (options.env) Object.assign(env, options.env);
  return spawnSync('bash', [RELAY_UP, ...args], {
    cwd: REPO_ROOT,
    env,
    input: options.input ?? '',
    encoding: 'utf8',
  });
}

test('relay-up.sh 归一化裸域名与精确 origin，并拒绝非法域名与 0.0.0.0/:: 通配绑定', () => {
  const home = allocateIndependentHome('relay-sh-domain');
  try {
    const cases = [
      ['relay.example.com', 'https://relay.example.com'],
      ['relay.example.com:8443', 'https://relay.example.com:8443'],
      ['https://relay.example.com/', 'https://relay.example.com'],
      ['http://127.0.0.1:3170', 'http://127.0.0.1:3170'],
    ];
    for (const [idx, [input, expected]] of cases.entries()) {
      const cfg = join(home, `ok-${idx}.env`);
      const res = runRelayUp(['--prepare-only', '--config', cfg, '--domain', input]);
      assert.equal(res.status, 0, res.stderr);
      const parsed = parseSimpleEnv(readFileSync(cfg, 'utf8'));
      assert.equal(parsed.get('CHATDSH_PUBLIC_URL'), expected);
      assert.equal(parsed.get('CHATDSH_PAIRING_APPROVAL'), 'required');
      assert.equal(parsed.get('CHATDSH_GATEWAY_BIND_HOST'), '127.0.0.1');
    }

    const bad = [
      '',
      '   ',
      'https://relay.example.com/sub',
      'https://relay.example.com?a=1',
      'https://relay.example.com#frag',
      'https://user:pass@relay.example.com', // gitleaks:allow
      'ftp://relay.example.com',
    ];
    for (const [idx, input] of bad.entries()) {
      const cfg = join(home, `bad-${idx}.env`);
      const res = runRelayUp(['--prepare-only', '--config', cfg, '--domain', input]);
      assert.notEqual(res.status, 0, `非法域名应当被拒绝：${input}`);
      assert.equal(existsSync(cfg), false);
    }

    // 严禁绑定 0.0.0.0 或 ::
    for (const badHost of ['0.0.0.0', '::', '[::]', '*']) {
      const cfg = join(home, `bad-host-${badHost.replaceAll(/[^a-z0-9]/gi, '_')}.env`);
      const res = runRelayUp(['--prepare-only', '--config', cfg, '--domain', 'relay.example.com', '--bind-host', badHost]);
      assert.notEqual(res.status, 0, `通配绑定地址应当被拒绝：${badHost}`);
      assert.equal(existsSync(cfg), false);
    }

    // 允许绑定具体内网穿透网卡 IP（RFC5737 示例地址），且后续不传 --bind-host 重跑时保留原绑定地址不被重置为 127.0.0.1
    const specificCfg = join(home, 'specific-host.env');
    const okHost = runRelayUp(['--prepare-only', '--config', specificCfg, '--domain', 'relay.example.com', '--bind-host', '192.0.2.10']);
    assert.equal(okHost.status, 0, okHost.stderr);
    assert.equal(parseSimpleEnv(readFileSync(specificCfg, 'utf8')).get('CHATDSH_GATEWAY_BIND_HOST'), '192.0.2.10');
    const keepHost = runRelayUp(['--prepare-only', '--config', specificCfg]);
    assert.equal(keepHost.status, 0, keepHost.stderr);
    assert.equal(parseSimpleEnv(readFileSync(specificCfg, 'utf8')).get('CHATDSH_GATEWAY_BIND_HOST'), '192.0.2.10');
  } finally {
    releaseIndependentHome(home);
  }
});

test('relay-up.sh 支持自动生成口令、二次复用、脱敏输出、轮换口令与关闭配对', () => {
  const home = allocateIndependentHome('relay-sh-lifecycle');
  const envFile = join(home, '.env');
  try {
    const empty = runRelayUp(['--prepare-only', '--config', envFile], { input: '\n' });
    assert.notEqual(empty.status, 0);
    assert.equal(existsSync(envFile), false);

    const first = runRelayUp(['--prepare-only', '--config', envFile], { input: 'relay.example.com\n' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);

    const parsed1 = parseSimpleEnv(readFileSync(envFile, 'utf8'));
    const code = parsed1.get('CHATDSH_PAIRING_CODE');
    assert.equal(parsed1.get('CHATDSH_PUBLIC_URL'), 'https://relay.example.com');
    assert.equal(parsed1.get('CHATDSH_PAIRING_APPROVAL'), 'required');
    assert.equal(parsed1.get('CHATDSH_RELAY_IMAGE'), 'ghcr.io/wenzetan/chatdsh-relay:latest');
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(first.stdout.includes('Linux / macOS（Shell）'));
    assert.ok(first.stdout.includes('curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.sh | bash -s -- --relay https://relay.example.com'));
    assert.ok(first.stdout.includes('Windows（PowerShell，供 Windows 客户端使用）'));
    assert.ok(first.stdout.includes('& ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.ps1))) -Relay https://relay.example.com'));
    assert.ok(first.stdout.includes(code));
    assert.ok(first.stdout.includes('bash scripts/relay-approve.sh'));
    assert.ok(first.stdout.includes('--print-join-command'));
    assert.ok(first.stdout.includes('域名解析'));
    assert.ok(first.stdout.includes('反向代理'));
    assert.ok(first.stdout.includes('http://127.0.0.1:3170'));

    writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}CUSTOM_KEEP_ME=hello-world\n`, { mode: 0o600 });

    const second = runRelayUp(['--prepare-only', '--config', envFile], { input: '' });
    assert.equal(second.status, 0, second.stderr);
    const parsed2 = parseSimpleEnv(readFileSync(envFile, 'utf8'));
    assert.equal(parsed2.get('CHATDSH_PAIRING_CODE'), code);
    assert.equal(parsed2.get('CUSTOM_KEEP_ME'), 'hello-world');

    const redacted = runRelayUp(['--prepare-only', '--redact-secrets', '--config', envFile], { input: '' });
    assert.equal(redacted.status, 0, redacted.stderr);
    assert.equal(redacted.stdout.includes(code), false, '脱敏模式不得输出配对口令');
    assert.equal(redacted.stderr.includes(code), false);
    assert.equal(redacted.stdout.includes('relay.example.com'), false, '脱敏模式不得输出真实域名');
    assert.equal(redacted.stderr.includes('relay.example.com'), false);
    assert.ok(redacted.stdout.includes('--print-join-command'));
    assert.ok(redacted.stdout.includes('--from-relay-env'));

    // 轮换配对口令
    const rotated = runRelayUp(['--prepare-only', '--rotate-pairing-code', '--redact-secrets', '--config', envFile]);
    assert.equal(rotated.status, 0, rotated.stderr);
    const rotatedCode = parseSimpleEnv(readFileSync(envFile, 'utf8')).get('CHATDSH_PAIRING_CODE');
    assert.match(rotatedCode, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(rotatedCode, code);

    // 关闭配对口令
    const disabled = runRelayUp(['--prepare-only', '--disable-pairing', '--config', envFile]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(parseSimpleEnv(readFileSync(envFile, 'utf8')).get('CHATDSH_PAIRING_CODE'), '');
    const printWhenDisabled = runRelayUp(['--print-join-command', '--config', envFile]);
    assert.notEqual(printWhenDisabled.status, 0);
  } finally {
    releaseIndependentHome(home);
  }
});

test('配对审批模式：客户端 202 等待审批，拒绝转发头冒充，批准后一次性领取并支持 device-join.sh 轮询', async () => {
  const home = allocateIndependentHome('pairing-approval-flow');
  const dbPath = join(home, 'gateway.sqlite');
  const deviceHome = join(home, 'device-home');
  const pairingCode = 'test-approval-code-2026';

  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(dbPath);
  const replica = new ReplicaStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const settings = new SettingsStore(store.handle());
  const push = createPushHub({
    queue: new PushQueue(store.handle()),
    devices: store,
    mode: 'two-stage',
    escalationMs: 120_000,
    telemetry: { counter: (name, options) => telemetry.counter(name, options) },
  });
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const server = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      databasePath: dbPath,
      environment: 'test',
      version: '0.1.0',
      pushMode: 'two-stage',
      pushEscalationMs: 120_000,
      accessMode: 'disabled',
      pairingApproval: 'required',
      pwaVersion: '0.1.0',
      pairingCode,
    },
    store,
    replica,
    receipts,
    settings,
    push,
    telemetry,
    deviceLink,
    telemetryRelay: (signal, body) => telemetry.relay(signal, body),
  });

  await server.start();
  try {
    const relayUrl = server.url();
    const adminHeaders = { 'x-chatdsh-pairing-code': pairingCode };

    // 1. 客户端发起配对申请 -> 返回 202 pending，尚未登记节点
    const req1 = await fetch(`${relayUrl}/chatdsh/gateway/devices/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, name: 'approval-node-1', platform: 'linux' }),
    });
    assert.equal(req1.status, 202);
    const pending1 = await req1.json();
    assert.equal(pending1.status, 'pending');
    assert.ok(pending1.requestId && pending1.pollToken);
    assert.equal(store.listNodes().length, 0, '审批前不得登记设备');

    // 2. 带 X-Forwarded-For 的代理请求访问审批端点被拒绝 403
    const spoofed = await fetch(`${relayUrl}/chatdsh/gateway/pairing/requests`, {
      headers: { ...adminHeaders, 'x-forwarded-for': '192.0.2.50' },
    });
    assert.equal(spoofed.status, 403);

    // 3. 缺少或错误管理员头被拒绝 401
    const unauth = await fetch(`${relayUrl}/chatdsh/gateway/pairing/requests`);
    assert.equal(unauth.status, 401);

    // 4. 审批前列举可见待审批申请，客户端错误 pollToken 返回 401，正确 pollToken 返回 202 pending
    const listed = await (await fetch(`${relayUrl}/chatdsh/gateway/pairing/requests?status=pending`, { headers: adminHeaders })).json();
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.requests[0].id, pending1.requestId);
    assert.equal(listed.requests[0].pollSecretHash, undefined);

    const badClaim = await fetch(`${relayUrl}/chatdsh/gateway/devices/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: pending1.requestId, pollToken: 'wrong-token' }),
    });
    assert.equal(badClaim.status, 401);

    const { requestId: reqId1, pollToken: poll1 } = pending1;

    const stillPending = await fetch(`${relayUrl}/chatdsh/gateway/devices/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: reqId1, pollToken: poll1 }),
    });
    assert.equal(stillPending.status, 202);

    // 5. 本机管理员批准申请 -> 客户端一次性领取令牌，再次领取返回 409
    const approvedRes = await fetch(`${relayUrl}/chatdsh/gateway/pairing/requests/${reqId1}/approve`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(approvedRes.status, 200);
    const approvedBody = await approvedRes.json();
    assert.equal(approvedBody.status, 'approved');
    assert.equal(approvedBody.token, undefined, '审批响应不得回显明文令牌');
    assert.equal(store.listNodes().length, 1);

    const claimed = await fetch(`${relayUrl}/chatdsh/gateway/devices/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: reqId1, pollToken: poll1 }),
    });
    assert.equal(claimed.status, 200);
    const claimedBody = await claimed.json();
    assert.equal(claimedBody.status, 'approved');
    assert.equal(claimedBody.deviceId, approvedBody.deviceId);
    assert.ok(typeof claimedBody.token === 'string' && claimedBody.token.length >= 32);

    const reclaim = await fetch(`${relayUrl}/chatdsh/gateway/devices/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: reqId1, pollToken: poll1 }),
    });
    assert.equal(reclaim.status, 409);

    // 6. 拒绝路径：管理员拒绝后客户端领取返回 403 且设备数不增加
    const req2 = await (await fetch(`${relayUrl}/chatdsh/gateway/devices/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, name: 'rejected-node', platform: 'linux' }),
    })).json();
    const rejRes = await fetch(`${relayUrl}/chatdsh/gateway/pairing/requests/${req2.requestId}/reject`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(rejRes.status, 200);
    const rejClaim = await fetch(`${relayUrl}/chatdsh/gateway/devices/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: req2.requestId, pollToken: req2.pollToken }),
    });
    assert.equal(rejClaim.status, 403);
    assert.equal(store.listNodes().length, 1);

    // 7. device-join.sh --code-stdin + --redact-secrets 等待审批，后台批准后自动领取落盘
    const child = spawn(
      'bash',
      [DEVICE_JOIN, '--skip-install', '--no-start', '--relay', relayUrl, '--code-stdin', '--redact-secrets', '--name', 'shell-approved-node'],
      { cwd: REPO_ROOT, env: { ...process.env, DSH_HOME: deviceHome, CHATDSH_PAIRING_POLL_SEC: '0.2' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdin.end(`${pairingCode}\n`);

    const requestId = await new Promise((resolveId, rejectId) => {
      const timer = setTimeout(() => rejectId(new Error(`等待待审批 requestId 超时：${stderr}`)), 10_000);
      const check = () => {
        const match = stderr.match(/requestId=([0-9a-f-]{36})/);
        if (match) {
          clearTimeout(timer);
          resolveId(match[1]);
        }
      };
      child.stderr.on('data', check);
      child.once('exit', (code) => {
        clearTimeout(timer);
        rejectId(new Error(`device-join.sh 提前退出（${code}）：${stderr}`));
      });
    });

    const approveChild = await fetch(`${relayUrl}/chatdsh/gateway/pairing/requests/${requestId}/approve`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(approveChild.status, 200);

    const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
    assert.equal(exitCode, 0, stderr);

    const envFile = join(deviceHome, 'chatdsh-device.env');
    assert.equal(existsSync(envFile), true);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    const saved = parseSimpleEnv(readFileSync(envFile, 'utf8'));
    assert.equal(saved.get('CHATDSH_CONTROL_URL'), relayUrl);
    assert.ok((saved.get('CHATDSH_NODE_TOKEN') ?? '').length >= 32);
    assert.equal(stdout.includes(pairingCode), false, '脱敏模式不得输出配对口令');
    assert.equal(stdout.includes(saved.get('CHATDSH_NODE_TOKEN')), false, '脱敏模式不得输出节点令牌');
    assert.equal(stdout.includes(relayUrl), false, '脱敏模式不得输出中继地址');
    assert.equal(store.listNodes().length, 2);

    // 二次运行直接复用已保存凭据，不重复申请审批
    const reuse = await execFileAsync(
      'bash',
      [DEVICE_JOIN, '--skip-install', '--no-start', '--redact-secrets'],
      { cwd: REPO_ROOT, env: { ...process.env, DSH_HOME: deviceHome }, encoding: 'utf8' },
    );
    assert.ok(reuse.stdout.includes('复用已保存的设备凭据'));
    assert.equal(store.listNodes().length, 2);
  } finally {
    deviceLink.stop();
    await server.stop();
    await telemetry.shutdown();
    store.close();
    releaseIndependentHome(home);
  }
});

test('远程免克隆模式：relay-up.sh 自动拉取 compose 与脚本，pack-plugin-bundle + device-join.sh 支持校验与安装', async () => {
  const home = allocateIndependentHome('remote-github-flow');
  const distDir = join(home, 'dist');
  const relayDir = join(home, 'relay-deploy');
  const standaloneRelayScript = join(home, 'downloaded-relay-up.sh');
  const standaloneDeviceScript = join(home, 'downloaded-device-join.sh');
  const deviceHome = join(home, 'dsh-home');
  const tamperedHome = join(home, 'dsh-home-tampered');

  // 1. 生成真实的自包含插件发布归档与 SHA256SUMS.txt
  const packRes = await execFileAsync('node', [PACK_BUNDLE, '--out-dir', distDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const archiveFile = join(distDir, 'chatdsh-plugin-bundle.tar.gz');
  const checksumFile = join(distDir, 'SHA256SUMS.txt');
  assert.equal(existsSync(archiveFile), true, packRes.stdout);
  assert.equal(existsSync(checksumFile), true);

  copyFileSync(RELAY_UP, standaloneRelayScript);
  copyFileSync(DEVICE_JOIN, standaloneDeviceScript);

  // 2. 启动本地 HTTP 服务模拟 raw.githubusercontent.com 与 GitHub Releases
  let serveBadChecksum = false;
  const httpServer = createServer((req, res) => {
    const reqPath = (req.url ?? '/').split('?')[0];
    if (reqPath === '/raw/docker-compose.yml') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(join(REPO_ROOT, 'docker-compose.yml')));
      return;
    }
    if (reqPath === '/raw/scripts/relay-up.sh') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(RELAY_UP));
      return;
    }
    if (reqPath === '/raw/scripts/relay-approve.sh') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(join(REPO_ROOT, 'scripts/relay-approve.sh')));
      return;
    }
    if (reqPath === '/raw/scripts/device-join.sh') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(DEVICE_JOIN));
      return;
    }
    if (reqPath === '/releases/chatdsh-plugin-bundle.tar.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(readFileSync(archiveFile));
      return;
    }
    if (reqPath === '/releases/SHA256SUMS.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      if (serveBadChecksum) {
        res.end('0000000000000000000000000000000000000000000000000000000000000000  chatdsh-plugin-bundle.tar.gz\n');
      } else {
        res.end(readFileSync(checksumFile));
      }
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen));
  const { port } = httpServer.address();
  const rawBase = `http://127.0.0.1:${port}/raw`;
  const releaseBase = `http://127.0.0.1:${port}/releases`;

  try {
    // 3. 通过 POSIX sh 执行 `curl -fsSL ... | bash -s -- ...`（验证 zsh / bash / fish / sh 通用的管道调用）
    const relayRes = await execFileAsync(
      'sh',
      ['-c', `curl -fsSL "${rawBase}/scripts/relay-up.sh" | bash -s -- --prepare-only --dir "${relayDir}" --domain relay.example.com`],
      {
        cwd: home,
        env: {
          ...process.env,
          CHATDSH_RAW_BASE: rawBase,
          CHATDSH_PAIRING_CODE: '',
          CHATDSH_PUBLIC_URL: '',
          CHATDSH_GATEWAY_BIND_HOST: '',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(existsSync(join(relayDir, 'docker-compose.yml')), true);
    assert.equal(existsSync(join(relayDir, 'relay-up.sh')), true);
    assert.equal(existsSync(join(relayDir, 'relay-approve.sh')), true);
    assert.equal(existsSync(join(relayDir, '.env')), true);
    assert.equal(statSync(join(relayDir, '.env')).mode & 0o777, 0o600);
    assert.ok(relayRes.stdout.includes(`curl -fsSL ${rawBase}/scripts/device-join.sh | bash -s -- --relay https://relay.example.com`), relayRes.stdout);
    assert.ok(relayRes.stdout.includes(`& ([scriptblock]::Create((irm ${rawBase}/scripts/device-join.ps1))) -Relay https://relay.example.com`), relayRes.stdout);

    // 校验 Windows PowerShell 脚本不含 UTF-8 BOM，避免 PowerShell 7+ 通过 [scriptblock]::Create((irm ...)) 解析失败
    for (const psRel of ['scripts/device-join.ps1', 'scripts/uninstall.ps1']) {
      const rawBuf = readFileSync(join(REPO_ROOT, psRel));
      assert.equal(rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf, false, `${psRel} 不得包含 UTF-8 BOM`);
    }
    assert.ok(relayRes.stdout.includes(join(relayDir, 'relay-approve.sh')), relayRes.stdout);

    // 4. 通过 POSIX sh 执行 `curl -fsSL ... | bash -s -- --install-only` 下载归档、校验 SHA-256 并真实装入 DSH web profile
    const installRes = await execFileAsync(
      'sh',
      ['-c', `curl -fsSL "${rawBase}/scripts/device-join.sh" | bash -s -- --install-only`],
      {
        cwd: home,
        env: {
          ...process.env,
          DSH_HOME: deviceHome,
          CHATDSH_RAW_BASE: rawBase,
          CHATDSH_RELEASE_BASE: releaseBase,
          CHATDSH_PNPM_STORE: join(REPO_ROOT, 'runtime/.run/pnpm-store'),
        },
        encoding: 'utf8',
      },
    );
    assert.ok(installRes.stdout.includes('SHA-256 校验通过'), installRes.stdout);
    assert.equal(existsSync(join(deviceHome, 'chatdsh-device-join.sh')), true);
    assert.equal(existsSync(join(deviceHome, 'profiles/web/pnpm-workspace.yaml')), true);

    const dumpRes = await execFileAsync('dsh', ['--profile', 'web', '--dump-config'], {
      cwd: home,
      env: { ...process.env, DSH_HOME: deviceHome },
      encoding: 'utf8',
    });
    assert.ok(dumpRes.stdout.includes('chatdsh'), '安装后 --dump-config 应包含 ChatDSH 插件配置');

    // 5. 篡改 SHA256SUMS.txt 时 device-join.sh 必须拒绝安装并快速失败
    serveBadChecksum = true;
    await assert.rejects(
      execFileAsync('bash', [standaloneDeviceScript, '--install-only'], {
        cwd: home,
        env: {
          ...process.env,
          DSH_HOME: tamperedHome,
          CHATDSH_RAW_BASE: rawBase,
          CHATDSH_RELEASE_BASE: releaseBase,
          CHATDSH_PNPM_STORE: join(REPO_ROOT, 'runtime/.run/pnpm-store'),
        },
        encoding: 'utf8',
      }),
      /SHA-256 校验失败/,
    );
  } finally {
    await new Promise((resolveClose) => httpServer.close(resolveClose));
    releaseIndependentHome(home);
  }
});
