// 中继 Docker Compose 引导脚本（relay-up.sh）与设备一行接入脚本（device-join.sh）单元测试。
//
// 验证域名必填校验与归一化、首次运行自动生成随机口令并落盘、二次运行复用口令、
// `--print-join-command` 输出以及真实中继 HTTP 配对与凭据复用。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execFileAsync = promisify(execFile);
import { createGatewayServer, createPushHub, DeviceLinkHub, GatewayStore, PushQueue, ReceiptStore, ReplicaStore, SettingsStore } from '../../gateway/lib/index.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const RELAY_UP = join(REPO_ROOT, 'scripts/relay-up.sh');
const DEVICE_JOIN = join(REPO_ROOT, 'scripts/device-join.sh');

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
  return spawnSync('bash', [RELAY_UP, ...args], {
    cwd: REPO_ROOT,
    env,
    input: options.input ?? '',
    encoding: 'utf8',
  });
}

test('relay-up.sh 归一化裸域名与精确 origin，并拒绝空值、路径、查询串、片段与凭据', () => {
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
  } finally {
    releaseIndependentHome(home);
  }
});

test('relay-up.sh 首次运行询问必填域名、自动生成随机口令保存，二次运行复用且支持 --print-join-command', () => {
  const home = allocateIndependentHome('relay-sh-lifecycle');
  const envFile = join(home, '.env');
  try {
    // 非交互空输入必须失败（域名必填）
    const empty = runRelayUp(['--prepare-only', '--config', envFile], { input: '\n' });
    assert.notEqual(empty.status, 0);
    assert.equal(existsSync(envFile), false);

    // 首次运行：从 stdin 读取域名，自动生成 32 位 base64url 随机口令并保存 0600
    const first = runRelayUp(['--prepare-only', '--config', envFile], { input: 'relay.example.com\n' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);

    const parsed1 = parseSimpleEnv(readFileSync(envFile, 'utf8'));
    const code = parsed1.get('CHATDSH_PAIRING_CODE');
    assert.equal(parsed1.get('CHATDSH_PUBLIC_URL'), 'https://relay.example.com');
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(first.stdout.includes(`bash scripts/device-join.sh --relay https://relay.example.com --code ${code}`));
    assert.ok(first.stdout.includes('--print-join-command'));

    // 追加用户自定义配置并验证二次运行保留
    writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}CUSTOM_KEEP_ME=hello-world\n`, { mode: 0o600 });

    const second = runRelayUp(['--prepare-only', '--config', envFile], { input: '' });
    assert.equal(second.status, 0, second.stderr);
    const parsed2 = parseSimpleEnv(readFileSync(envFile, 'utf8'));
    assert.equal(parsed2.get('CHATDSH_PAIRING_CODE'), code);
    assert.equal(parsed2.get('CUSTOM_KEEP_ME'), 'hello-world');

    // --print-join-command 直接输出接入命令与再次打印提示
    const printed = runRelayUp(['--print-join-command', '--config', envFile]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.ok(printed.stdout.includes(`bash scripts/device-join.sh --relay https://relay.example.com --code ${code}`));
    assert.ok(printed.stdout.includes('--print-join-command'));
  } finally {
    releaseIndependentHome(home);
  }
});

test('device-join.sh 与真实中继配对并持久化凭据，再次运行复用不重复配对', async () => {
  const home = allocateIndependentHome('device-sh-pair');
  const dbPath = join(home, 'gateway.sqlite');
  const deviceHome = join(home, 'device-home');
  const pairingCode = 'test-shell-join-code-2026';

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
    const envFile = join(deviceHome, 'chatdsh-device.env');

    // 首次配对（使用异步 execFile 避免阻塞同进程内的测试 HTTP 服务器事件循环）
    await execFileAsync(
      'bash',
      [DEVICE_JOIN, '--skip-install', '--no-start', '--relay', relayUrl, '--code', pairingCode, '--name', 'shell-device-a'],
      { cwd: REPO_ROOT, env: { ...process.env, DSH_HOME: deviceHome }, encoding: 'utf8' },
    );
    assert.equal(existsSync(envFile), true);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    const saved1 = parseSimpleEnv(readFileSync(envFile, 'utf8'));
    assert.equal(saved1.get('CHATDSH_CONTROL_URL'), relayUrl);
    assert.ok((saved1.get('CHATDSH_DEVICE_ID') ?? '').length > 0);
    assert.ok((saved1.get('CHATDSH_NODE_TOKEN') ?? '').length > 0);
    assert.equal(store.listNodes().length, 1);

    // 二次运行不传 --relay 与 --code，直接复用已保存凭据
    const second = await execFileAsync(
      'bash',
      [DEVICE_JOIN, '--skip-install', '--no-start'],
      { cwd: REPO_ROOT, env: { ...process.env, DSH_HOME: deviceHome }, encoding: 'utf8' },
    );
    assert.equal(store.listNodes().length, 1);
    assert.ok(second.stdout.includes('复用已保存的设备凭据'));
  } finally {
    deviceLink.stop();
    await server.stop();
    await telemetry.shutdown();
    store.close();
    releaseIndependentHome(home);
  }
});
