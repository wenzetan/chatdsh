// WP32 更新源、签名校验与安装闸门。
//
// 用真实 ed25519 密钥签名、真实 sha512 摘要、本机回环 HTTP 服务提供清单与安装包：
// 合法清单通过，签名被篡改、通道不符、版本回退、跨源地址、摘要不符都被拒绝；
// 下载完成后才能进入安装闸门，运行中任务与草稿要在确认文案里出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import {
  INITIAL_UPDATE_STATE, MAX_PACKAGE_BYTES, UpdateError, canonicalManifestPayload, compareVersions,
  createUpdateService, describeRollback, installGate, loadUpdateSource, normalizeUpdateSource,
  reduceUpdateState, updatePresentation, verifyUpdateManifest, verifyUpdatePackage,
} from '../../desktop/electron/updates.mjs';

/** 生成一对真实密钥。 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

/** 计算 sha512 十六进制摘要。 */
function digestOf(bytes) {
  return createHash('sha512').update(bytes).digest('hex');
}

/** 造一份带真实签名的清单。 */
function makeManifest(overrides = {}) {
  const manifest = {
    version: '0.2.0',
    channel: 'stable',
    url: 'https://updates.chatdsh.example/channel/ChatDSH-Setup.exe',
    size: 4096,
    sha512: 'a'.repeat(128),
    notes: '修复审批超时分支',
    ...overrides,
  };
  manifest.signature = sign(null, canonicalManifestPayload(manifest), privateKey).toString('base64');
  return manifest;
}

/** 更新源。 */
function makeSource(overrides = {}) {
  return normalizeUpdateSource({
    url: 'https://updates.chatdsh.example/channel',
    channel: 'stable',
    publicKeyPem: PUBLIC_PEM,
    ...overrides,
  });
}

/** 起一个提供清单与安装包的回环服务。 */
async function startServer() {
  const state = { manifest: undefined, packageBytes: Buffer.alloc(0), hits: [] };
  const server = createServer((request, response) => {
    state.hits.push(request.url);
    if (request.url.endsWith('/latest.json')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(state.manifest));
      return;
    }
    if (request.url.endsWith('.exe')) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(state.packageBytes);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  const port = server.address().port;
  return {
    state,
    port,
    origin: `http://127.0.0.1:${port}`,
    source: () => makeSource({ url: `http://127.0.0.1:${port}/channel` }),
    manifestFor(origin, extra = {}) {
      return makeManifest({ url: `${origin}/channel/ChatDSH-Setup.exe`, ...extra });
    },
    async close() {
      await new Promise((settle) => server.close(settle));
    },
  };
}

test('合法清单通过校验并给出新版本与发布说明', () => {
  const verified = verifyUpdateManifest(makeManifest(), { source: makeSource(), appVersion: '0.1.0' });
  assert.equal(verified.version, '0.2.0');
  assert.equal(verified.channel, 'stable');
  assert.equal(verified.notes, '修复审批超时分支');
  assert.equal(verified.size, 4096);
});

test('签名被篡改时拒绝', () => {
  const manifest = makeManifest();
  manifest.size = 8192;
  assert.throws(
    () => verifyUpdateManifest(manifest, { source: makeSource(), appVersion: '0.1.0' }),
    (error) => error instanceof UpdateError && error.code === 'signature-invalid',
  );
  const missing = makeManifest();
  delete missing.signature;
  assert.throws(
    () => verifyUpdateManifest(missing, { source: makeSource(), appVersion: '0.1.0' }),
    (error) => error.code === 'signature-missing',
  );
});

test('版本回退、通道不符与字段非法都被拒绝', () => {
  const source = makeSource();
  assert.throws(
    () => verifyUpdateManifest(makeManifest({ version: '0.1.0' }), { source, appVersion: '0.1.0' }),
    (error) => error.code === 'downgrade',
  );
  assert.throws(
    () => verifyUpdateManifest(makeManifest({ channel: 'beta' }), { source, appVersion: '0.1.0' }),
    (error) => error.code === 'channel-mismatch',
  );
  assert.throws(
    () => verifyUpdateManifest(makeManifest({ version: 'latest' }), { source, appVersion: '0.1.0' }),
    (error) => error.code === 'version-invalid',
  );
  assert.throws(
    () => verifyUpdateManifest(makeManifest({ size: MAX_PACKAGE_BYTES + 1 }), { source, appVersion: '0.1.0' }),
    (error) => error.code === 'size-invalid',
  );
  assert.throws(
    () => verifyUpdateManifest(makeManifest({ sha512: 'abc' }), { source, appVersion: '0.1.0' }),
    (error) => error.code === 'digest-format',
  );
});

test('安装包地址必须与更新源同源，方案只允许 https 或回环 http', () => {
  const source = makeSource();
  assert.throws(
    () => verifyUpdateManifest(makeManifest({ url: 'https://evil.example/Setup.exe' }), { source, appVersion: '0.1.0' }),
    (error) => error.code === 'url-host',
  );
  assert.throws(
    () => verifyUpdateManifest(makeManifest({ url: 'http://updates.chatdsh.example/channel/Setup.exe' }), { source, appVersion: '0.1.0' }),
    (error) => error.code === 'url-scheme',
  );
  assert.throws(
    () => normalizeUpdateSource({ url: 'http://example.com/channel', publicKeyPem: PUBLIC_PEM }),
    (error) => error.code === 'url-scheme',
  );
});

test('更新源配置缺公钥或公钥非法时拒绝', () => {
  assert.throws(
    () => normalizeUpdateSource({ url: 'https://updates.chatdsh.example/channel' }),
    (error) => error.code === 'public-key-missing',
  );
  assert.throws(
    () => normalizeUpdateSource({ url: 'https://updates.chatdsh.example/channel', publicKeyPem: 'not a key' }),
    (error) => error.code === 'public-key-invalid',
  );
  assert.throws(
    () => normalizeUpdateSource({ url: 'https://updates.chatdsh.example/channel', channel: 'nightly', publicKeyPem: PUBLIC_PEM }),
    (error) => error.code === 'channel-not-allowed',
  );
});

test('配置文件与环境变量都能提供更新源', () => {
  const dir = tempHome('wp32-update-source');
  const file = join(dir, 'update-source.json');
  assert.equal(loadUpdateSource({ file, env: {} }), undefined);
  writeFileSync(file, JSON.stringify({
    url: 'https://updates.chatdsh.example/channel',
    channel: 'beta',
    publicKeyPem: PUBLIC_PEM,
  }));
  const fromFile = loadUpdateSource({ file, env: {} });
  assert.equal(fromFile.channel, 'beta');
  assert.equal(fromFile.baseUrl, 'https://updates.chatdsh.example/channel');
  const fromEnv = loadUpdateSource({
    file,
    env: { CHATDSH_UPDATE_URL: 'https://mirror.chatdsh.example/stable', CHATDSH_UPDATE_CHANNEL: 'stable' },
  });
  assert.equal(fromEnv.channel, 'stable');
  assert.equal(fromEnv.baseUrl, 'https://mirror.chatdsh.example/stable');
});

test('版本号比较与状态机', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), -1);
  let state = INITIAL_UPDATE_STATE;
  state = reduceUpdateState(state, { type: 'checking' });
  state = reduceUpdateState(state, { type: 'available', version: '0.2.0', notes: '说明' });
  state = reduceUpdateState(state, { type: 'downloading', progress: { received: 0, total: 100 } });
  state = reduceUpdateState(state, { type: 'verifying' });
  state = reduceUpdateState(state, { type: 'ready' });
  assert.equal(state.status, 'ready');
  assert.equal(state.version, '0.2.0');
  assert.throws(() => reduceUpdateState(state, { type: 'checking' }), (error) => error.code === 'state-invalid');
});

test('界面文案覆盖检查、下载、等待安装与失败', () => {
  assert.equal(updatePresentation({ status: 'idle' }, '0.1.0').label, '未检查');
  const available = updatePresentation({ status: 'available', version: '0.2.0' }, '0.1.0');
  assert.match(available.detail, /0\.1\.0 → 0\.2\.0/u);
  assert.deepEqual(available.actions, ['download']);
  const downloading = updatePresentation({ status: 'downloading', progress: { received: 10, total: 100 } }, '0.1.0');
  assert.deepEqual(downloading.actions, ['cancel']);
  assert.match(downloading.detail, /10 \/ 100/u);
  const failed = updatePresentation({ status: 'failed', error: { code: 'digest-mismatch', message: '安装包摘要与清单不一致' } }, '0.1.0');
  assert.match(failed.detail, /摘要/u);
  assert.deepEqual(failed.actions, ['check']);
});

test('安装闸门要求已校验、要求确认并列出运行中任务的影响', () => {
  assert.equal(installGate({ state: { status: 'available' }, activity: {} }).allowed, false);
  const clean = installGate({ state: { status: 'ready' }, activity: {}, confirmed: true });
  assert.equal(clean.allowed, true);
  const busy = installGate({ state: { status: 'ready' }, activity: { runningTurns: 2, drafts: 1 }, confirmed: true });
  assert.equal(busy.allowed, true);
  assert.deepEqual(busy.reasons, ['running-turns', 'drafts']);
  assert.match(busy.message, /2 个回合/u);
  assert.match(busy.message, /1 份草稿/u);
  assert.equal(installGate({ state: { status: 'ready' }, activity: {}, confirmed: false }).allowed, false);
});

test('回滚说明写明原版本、暂存包与覆盖安装路径', () => {
  const rollback = describeRollback({ from: '0.1.0', to: '0.2.0', reason: '安装程序无法启动', stagedPath: '/data/updates/0.2.0/ChatDSH-Setup.exe' });
  assert.equal(rollback.title, '更新没有完成');
  assert.match(rollback.lines[0], /安装程序无法启动/u);
  assert.match(rollback.lines.join(' '), /0\.1\.0 继续可以启动/u);
  assert.match(rollback.lines.join(' '), /ChatDSH-Setup\.exe/u);
});

test('下载并校验：合法包进入等待安装，安装需要确认', async () => {
  const server = await startServer();
  const directory = tempHome('wp32-update-download');
  try {
    const goodPackage = Buffer.alloc(4096, 7);
    server.state.manifest = server.manifestFor(server.origin, { size: goodPackage.length, sha512: digestOf(goodPackage) });
    server.state.packageBytes = goodPackage;

    const service = createUpdateService({ source: server.source(), appVersion: '0.1.0', directory });
    assert.equal(service.state().status, 'idle');
    assert.equal(service.state().configured, true);

    await service.check();
    assert.equal(service.state().status, 'available');
    assert.equal(service.state().version, '0.2.0');

    await service.download();
    assert.equal(service.state().status, 'ready');
    assert.equal(existsSync(join(directory, '0.2.0', 'ChatDSH-Setup.exe')), true);

    assert.throws(() => service.install({ runningTurns: 0, drafts: 0 }, false), (error) => error.code === 'install-blocked');
    const plan = service.install({ runningTurns: 0, drafts: 0 }, true);
    assert.equal(plan.version, '0.2.0');
    assert.equal(service.state().status, 'installing');
  } finally {
    await server.close();
  }
});

test('下载到的摘要不符时删除暂存文件并记失败', async () => {
  const server = await startServer();
  const directory = tempHome('wp32-update-tampered');
  try {
    const expected = Buffer.alloc(4096, 1);
    const tampered = Buffer.alloc(4096, 2);
    server.state.manifest = server.manifestFor(server.origin, { size: expected.length, sha512: digestOf(expected) });
    server.state.packageBytes = tampered;

    const service = createUpdateService({ source: server.source(), appVersion: '0.1.0', directory });
    await service.check();
    await assert.rejects(() => service.download(), (error) => error.code === 'digest-mismatch');
    assert.equal(service.state().status, 'failed');
    assert.equal(existsSync(join(directory, '0.2.0', 'ChatDSH-Setup.exe')), false);
    assert.match(service.state().rollback.lines.join(' '), /摘要/u);
  } finally {
    await server.close();
  }
});

test('签名失败时禁止下载与安装', async () => {
  const server = await startServer();
  const directory = tempHome('wp32-update-signature');
  try {
    const manifest = server.manifestFor(server.origin, { size: 2048, sha512: 'b'.repeat(128) });
    manifest.signature = Buffer.from('伪造签名').toString('base64');
    server.state.manifest = manifest;
    const service = createUpdateService({ source: server.source(), appVersion: '0.1.0', directory });
    await assert.rejects(() => service.check(), (error) => error.code === 'signature-invalid');
    assert.equal(service.state().status, 'failed');
    assert.throws(() => service.install({}, true), (error) => error.code === 'install-blocked');
  } finally {
    await server.close();
  }
});

test('校验安装包字节时核对大小与摘要', () => {
  const bytes = Buffer.alloc(2048, 3);
  const verified = { size: 2048, sha512: digestOf(bytes) };
  verifyUpdatePackage(bytes, verified);
  assert.throws(() => verifyUpdatePackage(Buffer.alloc(10), verified), (error) => error.code === 'size-mismatch');
  assert.throws(() => verifyUpdatePackage(Buffer.alloc(2048, 4), verified), (error) => error.code === 'digest-mismatch');
});
