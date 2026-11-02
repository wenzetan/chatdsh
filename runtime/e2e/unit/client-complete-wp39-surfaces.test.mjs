// WP39 第二批集成验收：八类公共入口经真实控制平面进程与真实 HTTP 逐条打通。
//
// 控制平面用 `node gateway/lib/main.js` 单独启动，数据根、数据库、端口与对外地址都来自本次
// 运行的独立环境。访问密码、备份主密钥与迁移源库在启动之前由本次执行准备：密码写进真实的
// SQLite 访问表，备份主密钥是权限 0600 的 32 字节文件，迁移源是一个独立的 SQLite 文件。
//
// 运行：node --test e2e/unit/client-complete-wp39-surfaces.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { AccessStore } from '../../gateway/lib/access/store.js';
import { hashAccessPassword } from '../../gateway/lib/access/password.js';

const RUNTIME = resolve(import.meta.dirname, '../..');
const GATEWAY_ENTRY = join(RUNTIME, 'gateway', 'lib', 'main.js');
const PWA_ICONS = join(RUNTIME, 'packages', 'client', 'pwa', 'assets', 'icons');

/** 配对码、访问密码与 PWA 版本。 */
const PAIRING_CODE = 'wp39-surfaces-pair';
const ACCESS_PASSWORD = 'wp39-surfaces-pass';
const PWA_VERSION = '39';

/** 一条会话与它的副本事件。 */
const SESSION_ID = 'wp39-surfaces-session';
const CWD = '/workspace/chatdsh';

/** 分配一个可用的本机端口。 */
async function freePort() {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** 等待条件成立。 */
async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== undefined && result !== false) return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`等待超时：${label}`);
}

/** 造一条副本事件，载荷形状与设备写入的一致。 */
function event(seq, kind, time, data) {
  const payload = { type: kind, seq, time, data };
  return { seq, kind, time, bytes: Buffer.byteLength(JSON.stringify(payload)), payload };
}

test('真实控制平面进程：八类公共入口逐条可访问', { timeout: 240_000 }, async (t) => {
  const home = allocateIndependentHome('wp39-surfaces');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const databasePath = join(home, 'gateway', 'gateway.sqlite');
  const backupRoot = join(home, 'backups');

  // 启动之前准备访问密码：真实的 scrypt 摘要写进真实的访问表。
  mkdirSync(join(home, 'gateway'), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const accessStore = new AccessStore(database);
  accessStore.writeCredential('password', await hashAccessPassword(ACCESS_PASSWORD), Date.now());
  database.close();

  // 备份主密钥：模块不创建它，部署提供 32 字节、权限 0600 的文件。
  const backupKeyPath = join(home, 'backup-master.key');
  writeFileSync(backupKeyPath, randomBytes(32), { mode: 0o600 });
  chmodSync(backupKeyPath, 0o600);

  // 迁移源：一个独立的 SQLite 文件，没有任何进程以可写方式打开它；里面放一张控制平面表。
  const migrationSource = join(home, 'migration-source.sqlite');
  const sourceDatabase = new DatabaseSync(migrationSource);
  sourceDatabase.exec(`create table sessions (
    session_id text primary key,
    workspace_id text,
    device_id text not null,
    cwd text not null,
    kind text not null,
    created_at integer not null,
    deleted_at integer
  )`);
  sourceDatabase.prepare(
    'insert into sessions (session_id, workspace_id, device_id, cwd, kind, created_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run('migration-source-session', null, 'migration-source-device', CWD, 'work', 1_700_000_000_000, null);
  sourceDatabase.close();

  const child = spawn(process.execPath, [GATEWAY_ENTRY], {
    env: {
      ...process.env,
      DSH_HOME: home,
      CHATDSH_GATEWAY_HOST: '127.0.0.1',
      CHATDSH_GATEWAY_PORT: String(port),
      CHATDSH_GATEWAY_DB: databasePath,
      CHATDSH_PUBLIC_URL: origin,
      CHATDSH_RUNTIME_URL: 'http://127.0.0.1:9',
      CHATDSH_PAIRING_CODE: PAIRING_CODE,
      CHATDSH_ACCESS_MODE: 'required',
      CHATDSH_BACKUP_ROOT: backupRoot,
      CHATDSH_BACKUP_INTERVAL_MS: '0',
      CHATDSH_PWA_VERSION: PWA_VERSION,
      CHATDSH_TELEMETRY: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  let deviceCookie = '';
  let accessCookie = '';
  let csrfToken = '';
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${origin}/healthz`);
        return response.ok;
      } catch {
        return false;
      }
    }, '控制平面启动');

    const cookieResponse = await fetch(`${origin}/healthz`);
    const issued = cookieResponse.headers.getSetCookie().find((value) => value.startsWith('chatdsh-device='));
    assert.ok(issued, '控制平面应当签发浏览器设备标识');
    deviceCookie = issued.split(';')[0];

    /** 发一次请求；写动作自动带同源与访问会话的写令牌。 */
    const call = async (path, options = {}) => {
      const method = options.method ?? 'GET';
      const headers = {
        ...(options.cookie === false ? {} : { cookie: deviceCookie }),
        ...(method === 'GET' || method === 'HEAD' ? {} : { origin }),
        ...(options.headers ?? {}),
      };
      if (options.access === true) {
        headers.cookie = accessCookie;
        if (method !== 'GET' && method !== 'HEAD') headers['x-chatdsh-csrf'] = csrfToken;
      }
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${origin}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      const json = contentType.includes('application/json') && text !== '' ? JSON.parse(text) : undefined;
      return { status: response.status, headers: response.headers, text, json };
    };

    // 设备：真实配对一次执行节点，拿到节点令牌。
    const paired = await call('/chatdsh/gateway/devices/pair', {
      method: 'POST',
      cookie: false,
      body: { code: PAIRING_CODE, name: '入口核对节点', platform: 'linux', role: 'both', capabilities: ['shell'] },
    });
    assert.equal(paired.status, 200, paired.text);
    const { deviceId, token } = paired.json;

    await t.test('设备：配对、列表、配对码签发与链路检查', async () => {
      const listed = await call('/chatdsh/gateway/devices');
      assert.equal(listed.status, 200, listed.text);
      const row = listed.json.devices.find((entry) => entry.id === deviceId);
      assert.ok(row, '设备列表里出现刚配对的节点');
      assert.equal(row.name, '入口核对节点');
      assert.equal(row.online, false);

      const issuedCode = await call('/chatdsh/gateway/devices/pairing', {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(issuedCode.status, 200, issuedCode.text);
      assert.equal(issuedCode.json.kind, 'manual');
      assert.equal(issuedCode.json.controlUrl, origin);
      assert.match(issuedCode.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const decoded = JSON.parse(Buffer.from(issuedCode.json.encoded, 'base64url').toString('utf8'));
      assert.equal(decoded.pairingCode, issuedCode.json.code);

      const link = await call(`/chatdsh/gateway/devices/link-check?deviceId=${encodeURIComponent(deviceId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(link.status, 200, link.text);
      assert.equal(link.json.reachable, false);
      assert.equal(link.json.code, 'device-offline');

      const anonymous = await call('/chatdsh/gateway/devices/pairing', { cookie: false });
      assert.equal(anonymous.status, 401, '没有节点令牌时不签发配对码');
    });

    await t.test('通知：列表与设置读写', async () => {
      const listed = await call('/chatdsh/gateway/notifications?filter=all&limit=10');
      assert.equal(listed.status, 200, listed.text);
      assert.deepEqual(listed.json.items, []);
      assert.equal(listed.json.unread, 0);
      assert.equal(listed.json.handled, 0);

      const settings = await call('/chatdsh/gateway/notifications/settings');
      assert.equal(settings.status, 200, settings.text);
      assert.equal(settings.json.deliveryMode, 'two-stage');
      assert.equal(settings.json.revision, 0);

      const saved = await call('/chatdsh/gateway/notifications/settings', {
        method: 'PUT',
        body: { deliveryMode: 'all-at-once', revision: settings.json.revision },
      });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.json.deliveryMode, 'all-at-once');
      assert.equal(saved.json.revision, 1);

      const reread = await call('/chatdsh/gateway/notifications/settings');
      assert.equal(reread.json.deliveryMode, 'all-at-once');
    });

    await t.test('访问：状态、登录与会话列表', async () => {
      const before = await call('/chatdsh/access/status', { cookie: false });
      assert.equal(before.status, 200, before.text);
      assert.equal(before.json.required, true);
      assert.deepEqual(before.json.methods, ['password']);
      assert.equal(before.json.signedIn, false);
      assert.equal(before.json.secondFactorPending, false);
      assert.equal(before.json.totpEnrolled, false);
      assert.equal(before.json.recoveryCodesRemaining, 0);
      assert.equal(before.json.passkeyUnavailableReason, 'verifier-library-missing');
      assert.equal(before.headers.get('cache-control'), 'no-store');

      const wrong = await call('/chatdsh/access/sign-in', {
        method: 'POST',
        cookie: false,
        body: { method: 'password', password: 'not-the-password' },
      });
      assert.equal(wrong.status, 401, wrong.text);
      assert.equal(wrong.json.error, 'auth-invalid');
      assert.equal(typeof wrong.json.attemptsLeft, 'number');

      const signedIn = await call('/chatdsh/access/sign-in', {
        method: 'POST',
        cookie: false,
        body: { method: 'password', password: ACCESS_PASSWORD },
      });
      assert.equal(signedIn.status, 200, signedIn.text);
      assert.equal(signedIn.json.outcome, 'authenticated');
      assert.equal(signedIn.json.tokenWritten, true);
      assert.match(signedIn.json.session.sessionId, /^[0-9a-f-]{36}$/);
      assert.equal(signedIn.json.session.current, true);
      const cookie = signedIn.headers.getSetCookie().find((value) => value.startsWith('chatdsh-access='));
      assert.ok(cookie, '登录成功应当写访问会话 Cookie');
      accessCookie = cookie.split(';')[0];

      const after = await call('/chatdsh/access/status', { access: true });
      assert.equal(after.status, 200, after.text);
      assert.equal(after.json.signedIn, true);
      assert.equal(typeof after.json.csrfToken, 'string');
      csrfToken = after.json.csrfToken;

      const sessions = await call('/chatdsh/access/sessions', { access: true });
      assert.equal(sessions.status, 200, sessions.text);
      assert.equal(sessions.json.items.length, 1);
      assert.equal(sessions.json.currentSessionId, signedIn.json.session.sessionId);
      assert.equal(sessions.json.items[0].current, true);
    });

    await t.test('备份：创建、校验与备份集列表', async () => {
      const created = await call('/chatdsh/gateway/backup/create', {
        method: 'POST',
        access: true,
        body: { set: 'set-wp39', external: [] },
      });
      assert.equal(created.status, 200, created.text);
      assert.equal(created.json.setName, 'set-wp39');
      assert.match(created.json.manifestId, /^[A-Za-z0-9_-]+$/);
      assert.ok(created.json.objects > 0, '备份至少写入一个对象');
      assert.ok(created.json.cipherBytes > 0);

      const verified = await call('/chatdsh/gateway/backup/verify', {
        method: 'POST',
        access: true,
        body: { set: 'set-wp39' },
      });
      assert.equal(verified.status, 200, verified.text);
      assert.equal(verified.json.manifestId, created.json.manifestId);
      assert.equal(verified.json.objects, created.json.objects);
      assert.ok(verified.json.plaintextBytes > 0);
      assert.equal(typeof verified.json.keyId, 'string');

      const sets = await call('/chatdsh/gateway/backup/sets');
      assert.equal(sets.status, 200, sets.text);
      assert.equal(sets.json.setsRoot, backupRoot);
      assert.ok(sets.json.sets.some((entry) => entry.name === 'set-wp39' && entry.manifestId === created.json.manifestId));

      const unauthenticated = await call('/chatdsh/gateway/backup/create', {
        method: 'POST',
        body: { set: 'set-other' },
      });
      assert.equal(unauthenticated.status, 401, '访问认证启用时备份写动作要求会话');
    });

    await t.test('副本：上报、游标与保留策略', async () => {
      const base = Date.now() - 60_000;
      const events = [
        event(1, 'session/title', base, { title: 'WP39 公共入口' }),
        event(2, 'user/message', base + 1_000, { content: [{ type: 'text', text: '第二批入口都要通。' }] }),
        event(3, 'assistant/message', base + 2_000, { message: { content: [{ type: 'text', text: '八类入口已逐条核对。' }] } }),
      ];
      const appended = await call('/chatdsh/gateway/replica', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: { sessionId: SESSION_ID, events },
      });
      assert.equal(appended.status, 200, appended.text);
      assert.equal(appended.json.written, 3);
      assert.equal(appended.json.watermark, 3);

      const cursor = await call(`/chatdsh/gateway/replica?sessionId=${encodeURIComponent(SESSION_ID)}`);
      assert.equal(cursor.status, 200, cursor.text);
      assert.equal(cursor.json.sessionId, SESSION_ID);
      assert.equal(cursor.json.watermark, 3);
      assert.equal(cursor.json.events.length, 3);
      assert.equal(cursor.json.events[0].kind, 'session/title');

      const retentionTarget = 'wp39-surfaces-retention-session';
      const retained = await call('/chatdsh/gateway/replica', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: { sessionId: retentionTarget, events: [event(1, 'session/title', base, { title: '保留策略核对' })] },
      });
      assert.equal(retained.status, 200, retained.text);
      assert.equal(retained.json.watermark, 1);

      const cleared = await call('/chatdsh/gateway/replica/retention', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: { sessionId: retentionTarget, action: 'clear' },
      });
      assert.equal(cleared.status, 200, cleared.text);
      assert.equal(cleared.json.sessionId, retentionTarget);
      assert.equal(cleared.json.state, 'cleared');
      assert.equal(typeof cleared.json.generation, 'number');

      const afterClear = await call(`/chatdsh/gateway/replica?sessionId=${encodeURIComponent(retentionTarget)}`);
      assert.equal(afterClear.status, 200, afterClear.text);
      assert.deepEqual(afterClear.json.events, [], '保留策略清理之后副本事件不再返回');

      const anonymous = await call('/chatdsh/gateway/replica/retention', {
        method: 'POST',
        cookie: false,
        body: { sessionId: retentionTarget, action: 'clear' },
      });
      assert.equal(anonymous.status, 401);
    });

    await t.test('分享与导出的写动作按访问会话校验', async () => {
      const anonymous = await call('/chatdsh/gateway/share', {
        method: 'POST',
        body: { sessionId: SESSION_ID, range: { mode: 'session' } },
      });
      assert.equal(anonymous.status, 401, '访问认证启用时没有会话的写动作被拒绝');

      const created = await call('/chatdsh/gateway/share', {
        method: 'POST',
        access: true,
        body: { sessionId: SESSION_ID, range: { mode: 'session' } },
      });
      assert.equal(created.status, 200, created.text);
      assert.equal(created.json.status, 'active');
      assert.equal(created.json.path, `/s/${created.json.shareId}`);

      const page = await call(created.json.path, { cookie: false });
      assert.equal(page.status, 200, page.text);
      assert.ok(page.text.includes('第二批入口都要通。'));

      const revoked = await call(`/chatdsh/gateway/share/${encodeURIComponent(created.json.shareId)}`, {
        method: 'DELETE',
        access: true,
      });
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal(revoked.json.revoked, true);
    });

    await t.test('数据管理：用量、保留策略与清理', async () => {
      const usage = await call('/chatdsh/client/data/usage');
      assert.equal(usage.status, 200, usage.text);
      assert.ok(usage.json.totalBytes > 0, '数据根上有真实文件');
      assert.ok(usage.json.fileCount > 0);
      assert.equal(usage.json.root, home);
      assert.equal(usage.json.replicaSource, 'measured');
      assert.ok(usage.json.replica.payloadBytes > 0, '副本载荷字节取自真实存储');
      assert.ok(usage.json.rows.some((row) => row.dimension === 'device'), '给出设备维度的用量行');
      assert.equal(JSON.stringify(usage.json).includes('session_id'), false, '对外形状不带内部列名');

      const retention = await call('/chatdsh/client/data/retention');
      assert.equal(retention.status, 200, retention.text);
      assert.equal(typeof retention.json.days, 'number');

      const estimate = await call('/chatdsh/client/data/cleanup/estimate', { method: 'POST', access: true, body: {} });
      assert.equal(estimate.status, 200, estimate.text);
      assert.match(estimate.json.estimateId, /^[A-Za-z0-9_-]+$/);
      assert.equal(typeof estimate.json.reclaimableBytes, 'number');
      assert.equal(estimate.json.retentionDays, retention.json.days);

      const executed = await call('/chatdsh/client/data/cleanup/execute', {
        method: 'POST',
        access: true,
        body: { estimateId: estimate.json.estimateId, confirmDependencies: true },
      });
      assert.equal(executed.status, 200, executed.text);
      assert.equal(typeof executed.json.cleanupId, 'string');
      assert.equal(executed.json.authoritativeLogsPreserved, true);
      assert.equal(typeof executed.json.reclaimedBytes, 'number');

      const unauthenticated = await call('/chatdsh/client/data/cleanup/estimate', { method: 'POST', body: {} });
      assert.equal(unauthenticated.status, 401, '访问认证启用时清理写动作要求会话');
    });

    await t.test('SYS01 迁移：预检查通过并回报每一项核对', async () => {
      const preflight = await call('/chatdsh/gateway/migration/preflight', {
        method: 'POST',
        access: true,
        body: {
          sourcePath: migrationSource,
          sourceFormat: 'sqlite',
          targetRoot: join(home, 'migration-target'),
          requiredFreeBytes: 0,
        },
      });
      assert.equal(preflight.status, 200, preflight.text);
      assert.equal(preflight.json.sourcePath, migrationSource);
      assert.equal(preflight.json.sourceFormat, 'sqlite');
      assert.equal(preflight.json.targetRoot, join(home, 'migration-target'));
      assert.ok(preflight.json.sourceBytes > 0);
      assert.ok(preflight.json.freeBytes > 0);
      assert.deepEqual(preflight.json.checks, ['source', 'source-format', 'target-directory', 'disk-space', 'active-writer']);
      assert.equal(preflight.json.writerScan, 'procfs');

      const missing = await call('/chatdsh/gateway/migration/preflight', {
        method: 'POST',
        access: true,
        body: { sourcePath: join(home, 'missing.sqlite'), sourceFormat: 'sqlite', targetRoot: join(home, 'migration-target'), requiredFreeBytes: 0 },
      });
      assert.equal(missing.status, 409, missing.text);
      assert.equal(missing.json.error, 'preflight-failed');
    });

    await t.test('SYS01 迁移：分批复制写进目标库，切换要求确认', async () => {
      const targetPath = join(home, 'migration-target', 'migration.sqlite');
      const copied = await call('/chatdsh/gateway/migration/copy', {
        method: 'POST',
        access: true,
        body: {
          jobId: 'wp39-migration',
          schemaVersion: 1,
          sourceDigest: 'a'.repeat(64),
          targetDigest: 'b'.repeat(64),
          sourcePath: migrationSource,
          targetPath,
        },
      });
      assert.equal(copied.status, 200, copied.text);
      assert.equal(copied.json.jobId, 'wp39-migration');
      assert.equal(copied.json.batches, 1, '会话表按一批搬完');
      assert.equal(copied.json.position, 1);
      assert.equal(copied.json.confirmed, 1, '已确认的记录条数等于搬完的行数');

      const target = new DatabaseSync(targetPath, { readOnly: true });
      try {
        const row = target.prepare('select session_id, cwd from sessions').get();
        assert.equal(row.session_id, 'migration-source-session');
        assert.equal(row.cwd, CWD);
      } finally {
        target.close();
      }

      const plan = await call('/chatdsh/gateway/backup/switch/plan', {
        method: 'POST',
        access: true,
        body: { set: 'set-wp39' },
      });
      assert.equal(plan.status, 200, plan.text);
      assert.equal(plan.json.canActivate, false);
      assert.ok(plan.json.blockers.includes('restore-incomplete'), '备份集不是恢复目录');

      const refused = await call('/chatdsh/gateway/backup/switch', {
        method: 'POST',
        access: true,
        body: { set: 'set-wp39', confirmed: false },
      });
      assert.equal(refused.status, 400, refused.text);
      assert.equal(refused.json.error, 'restore-switch-not-confirmed');
    });

    await t.test('设备：撤销立即失效并保留会话', async () => {
      const revoked = await call('/chatdsh/gateway/devices/revoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: { deviceId, reason: 'lost' },
      });
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal(revoked.json.deviceId, deviceId);
      assert.equal(revoked.json.sessionsPreserved, true);
      assert.ok(revoked.json.revokedAt > 0);

      const afterRevoke = await call('/chatdsh/gateway/devices/pairing', {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(afterRevoke.status, 401, '撤销之后节点令牌不再可用');
      assert.equal(afterRevoke.json.error, 'device-token-revoked');

      const listed = await call('/chatdsh/gateway/devices');
      assert.ok(listed.json.devices.some((entry) => entry.id === deviceId), '设备记录与会话都保留');
    });

    await t.test('PWA：清单、Service Worker、离线页与图标', async () => {
      const manifest = await call('/manifest.webmanifest', { cookie: false });
      assert.equal(manifest.status, 200, manifest.text);
      assert.match(manifest.headers.get('content-type') ?? '', /^application\/manifest\+json/);
      const parsed = JSON.parse(manifest.text);
      assert.equal(parsed.name, 'ChatDSH 会话客户端');
      assert.equal(parsed.start_url, '/');
      assert.equal(parsed.icons.length, 3);
      assert.equal(parsed.icons[0].src, `/assets/icons/icon-192.png?v=${PWA_VERSION}`);

      const worker = await call('/sw.js', { cookie: false });
      assert.equal(worker.status, 200, worker.text);
      assert.match(worker.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.ok(worker.text.includes(`const VERSION = "${PWA_VERSION}";`), '缓存版本取发布的版本号');
      assert.ok(worker.text.includes('const CACHE_PREFIX = "chatdsh-pwa";'), '缓存名前缀来自客户端包');
      assert.ok(worker.text.includes('const OFFLINE_PATH = "/offline.html";'), '离线回退页登记在缓存规则里');

      const offline = await call('/offline.html', { cookie: false });
      assert.equal(offline.status, 200, offline.text);
      assert.match(offline.headers.get('content-type') ?? '', /^text\/html/);
      assert.ok(offline.text.includes('ChatDSH'));

      const iconResponse = await fetch(`${origin}/assets/icons/icon-192.png`);
      assert.equal(iconResponse.status, 200);
      assert.equal(iconResponse.headers.get('content-type'), 'image/png');
      const iconBytes = Buffer.from(await iconResponse.arrayBuffer());
      const expected = readFileSync(join(PWA_ICONS, 'icon-192.png'));
      assert.deepEqual(iconBytes, expected, '图标字节与客户端包里的文件一致');

      const unknownIcon = await call('/assets/icons/not-there.png', { cookie: false });
      assert.equal(unknownIcon.status, 404);
    });
  } finally {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((done) => child.once('exit', () => done(true))),
      new Promise((done) => setTimeout(() => done(false), 10_000)),
    ]);
    if (!exited) child.kill('SIGKILL');
    if (child.exitCode !== null && child.exitCode !== 0 && child.exitCode !== 143) {
      console.log(`控制平面退出码 ${String(child.exitCode)}\n${output.slice(-3000)}`);
    }
    releaseIndependentHome(home);
  }
});
