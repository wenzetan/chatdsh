import { createHash, createHmac, randomBytes } from 'node:crypto';
import { cursorSchema } from '../../packages/core/contracts/lib/primitives.js';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createClientHttpHandler } from '../../gateway/lib/client-http.js';
import { authorizeClientRequest } from '../../gateway/lib/client-security.js';
import { sendClientError } from '../../gateway/lib/client-errors.js';
import { GatewayStore, ReplicaStore, ReceiptStore } from '../../gateway/lib/store.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

async function start() {
  const home = allocateIndependentHome('wp03-http');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }), component: '@chatdsh/gateway', env: { CHATDSH_TELEMETRY: 'off' },
  });
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  store.registerMobileDevice({ id: 'reader', name: '验收客户端', platform: 'linux', tokenHash: hash(token) });
  for (const id of ['device-a', 'device-b']) {
    store.registerNode({ id, name: id, platform: 'linux', role: 'both', capabilities: [], tokenHash: hash(id) });
  }
  for (const [index, id] of ['one', 'two', 'three'].entries()) {
    store.upsertSession({ sessionId: id, deviceId: index < 2 ? 'device-a' : 'device-b', cwd: '/workspace/project', kind: 'work', createdAt: index + 1 });
    replica.append(id, [
      { seq: 0, kind: 'session/title', time: index + 10, bytes: 12, payload: { data: { title: `标题 ${id}` } } },
      { seq: 1, kind: 'assistant/message', time: index + 20, bytes: 12, payload: { data: {} } },
      { seq: 2, kind: 'tool/result', time: index + 30, bytes: 12, payload: { data: {} } },
    ]);
  }
  receipts.mark({ sessionId: 'one', deviceId: 'reader', readUpToSeq: 1 });
  let handler;
  let security;
  const server = createServer(async (request, response) => {
    if (request.url === '/csrf-check') {
      try {
        await authorizeClientRequest(request, security);
        response.writeHead(204).end();
      } catch (error) { sendClientError(response, error, 'csrf-check'); }
      return;
    }
    if (!await handler(request, response)) response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  security = {
    origin,
    authenticate(request) {
      const bearer = request.headers.authorization;
      const cookie = request.headers.cookie;
      const credential = typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : cookie === `access=${token}` ? token : undefined;
      if (credential === undefined) return undefined;
      const device = store.mobileDeviceByTokenHash(hash(credential));
      if (device === undefined || device.revokedAt !== undefined) return undefined;
      return { clientId: device.id, authentication: typeof bearer === 'string' && bearer.startsWith('Bearer ') ? 'bearer' : 'cookie', expiresAt: Date.now() + 60000, deviceIds: ['device-a'], csrfToken: csrf };
    },
  };
  let databaseClosed = false;
  const cursorKey = randomBytes(32);
  handler = createClientHttpHandler({ ...security, store, replica, receipts, telemetry, cursorKey, online: () => false });
  return {
    origin, token, csrf, store, replica, cursorKey,
    headers: { authorization: `Bearer ${token}` },
    closeDatabase() { store.close(); databaseClosed = true; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await telemetry.shutdown();
      if (!databaseClosed) store.close();
      releaseIndependentHome(home);
    },
  };
}

test('真实 HTTP 与 SQLite 验证认证、范围、分页与业务未读数量', async () => {
  const app = await start();
  try {
    const base = `${app.origin}/chatdsh/client/sessions`;
    const anonymous = await fetch(base);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'auth-required');
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    const forged = await fetch(base, { headers: { 'x-chatdsh-device-id': 'reader' } });
    assert.equal(forged.status, 401);
    const crossOrigin = await fetch(base, { headers: { ...app.headers, origin: 'https://attacker.invalid' } });
    assert.equal(crossOrigin.status, 403);
    const forbidden = await fetch(`${base}?deviceId=device-b`, { headers: app.headers });
    assert.equal(forbidden.status, 403);
    const first = await fetch(`${base}?limit=1`, { headers: app.headers });
    assert.equal(first.status, 200);
    const page = await first.json();
    assert.equal(page.items[0].sessionId, 'two');
    assert.equal(page.items[0].title, '标题 two');
    assert.equal(page.items[0].unreadMessages, 1);
    assert.equal(page.items[0].online, false);
    assert.equal(page.page.hasMore, true);
    assert.equal(first.headers.get('x-request-id'), page.requestId);
    const second = await fetch(`${base}?limit=1&cursor=${page.page.nextCursor}`, { headers: app.headers });
    const next = await second.json();
    assert.equal(next.items[0].sessionId, 'one');
    assert.equal(next.items[0].unreadMessages, 0);
    assert.equal(next.page.hasMore, false);
    assert.doesNotMatch(JSON.stringify(next), /watermark|readUpToSeq|"seq"/i);
    const changedQuery = await fetch(`${base}?limit=1&q=one&cursor=${page.page.nextCursor}`, { headers: app.headers });
    assert.equal(changedQuery.status, 400);
    assert.equal((await changedQuery.json()).error.code, 'cursor-invalid');
    const tampered = await fetch(`${base}?cursor=invalid`, { headers: app.headers });
    assert.equal(tampered.status, 400);
    const duplicate = await fetch(`${base}?limit=1&limit=2`, { headers: app.headers });
    assert.equal(duplicate.status, 400);
    const unknown = await fetch(`${app.origin}/chatdsh/client/unknown`, { headers: app.headers });
    assert.equal(unknown.status, 404);
    const searched = await fetch(`${base}?q=one`, { headers: app.headers });
    assert.deepEqual((await searched.json()).items.map((item) => item.sessionId), ['one']);
    const oversized = await fetch(`${base}?limit=201`, { headers: app.headers });
    assert.equal(oversized.status, 400);
    const sameSite = await fetch(base, { headers: { ...app.headers, 'sec-fetch-site': 'same-site' } });
    assert.equal(sameSite.status, 403);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(base, { headers: { ...app.headers, host: 'attacker.invalid' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal(app.store.listSessions().length, 3);
    app.store.handle().prepare('update mobile_devices set revoked_at = ? where id = ?').run(Date.now(), 'reader');
    const revoked = await fetch(base, { headers: app.headers });
    assert.equal(revoked.status, 401);
  } finally { await app.close(); }
});

test('真实数据库关闭后返回脱敏内部失败和请求标识', async () => {
  const app = await start();
  try {
    app.closeDatabase();
    const response = await fetch(`${app.origin}/chatdsh/client/sessions`, { headers: app.headers });
    assert.equal(response.status, 500);
    const result = await response.json();
    assert.equal(result.error.code, 'internal-error');
    assert.equal(result.error.requestId, response.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(result), /sqlite|database|select|workspace|closed/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await app.close(); }
});

test('最长多字节标识与 Unicode 等价标识的游标可以完整续页', async () => {
  const app = await start();
  try {
    const ids = ['中'.repeat(200), 'é', 'e\u0301'];
    for (const id of ids) app.store.upsertSession({ sessionId: id, deviceId: 'device-a', cwd: '/project', kind: 'work', createdAt: 100 });
    let cursor;
    const seen = [];
    let firstCursor;
    do {
      const url = new URL('/chatdsh/client/sessions?limit=1', app.origin);
      if (cursor !== undefined) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, { headers: app.headers });
      assert.equal(response.status, 200);
      const page = await response.json();
      seen.push(...page.items.map((row) => row.sessionId));
      cursor = page.page.nextCursor;
      if (cursor !== undefined) {
        assert.equal(cursorSchema.safeParse(cursor).success, true);
        firstCursor ??= cursor;
      }
    } while (cursor !== undefined);
    assert.equal(new Set(seen).size, 5);
    for (const id of ids) assert.ok(seen.includes(id));
    const bytes = Buffer.from(firstCursor, 'base64url');
    const fields = JSON.parse(bytes.subarray(32).toString('utf8'));
    fields[1] = Date.now() - 1;
    const expiredPayload = Buffer.from(JSON.stringify(fields));
    const expired = Buffer.concat([createHmac('sha256', app.cursorKey).update(expiredPayload).digest(), expiredPayload]).toString('base64url');
    const expiry = await fetch(`${app.origin}/chatdsh/client/sessions?limit=1&cursor=${expired}`, { headers: app.headers });
    assert.equal(expiry.status, 400);
    assert.equal((await expiry.json()).error.code, 'cursor-invalid');
    const anchor = seen[0];
    app.store.handle().prepare('update sessions set deleted_at = ? where session_id = ?').run(Date.now(), anchor);
    const deleted = await fetch(`${app.origin}/chatdsh/client/sessions?limit=1&cursor=${firstCursor}`, { headers: app.headers });
    assert.equal(deleted.status, 400);
    assert.equal((await deleted.json()).error.code, 'cursor-invalid');
  } finally { await app.close(); }
});

test('真实 HTTP 写入校验要求精确来源与会话绑定 CSRF', async () => {
  const app = await start();
  try {
    const headers = { cookie: `access=${app.token}`, origin: app.origin };
    const missing = await fetch(`${app.origin}/csrf-check`, { method: 'POST', headers });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error.code, 'csrf-rejected');
    const mixed = await fetch(`${app.origin}/csrf-check`, { method: 'POST', headers: { ...headers, authorization: 'Basic arbitrary' } });
    assert.equal(mixed.status, 403);
    assert.equal((await mixed.json()).error.code, 'csrf-rejected');
    const bearer = await fetch(`${app.origin}/csrf-check`, { method: 'POST', headers: { ...app.headers, origin: app.origin } });
    assert.equal(bearer.status, 204);
    const wrong = await fetch(`${app.origin}/csrf-check`, { method: 'POST', headers: { ...headers, 'x-chatdsh-csrf': 'wrong' } });
    assert.equal(wrong.status, 403);
    const accepted = await fetch(`${app.origin}/csrf-check`, { method: 'POST', headers: { ...headers, 'x-chatdsh-csrf': app.csrf } });
    assert.equal(accepted.status, 204);
    const foreign = await fetch(`${app.origin}/csrf-check`, { method: 'POST', headers: { ...headers, origin: 'https://foreign.invalid', 'x-chatdsh-csrf': app.csrf } });
    assert.equal(foreign.status, 403);
  } finally { await app.close(); }
});
