// WP25 访问认证的会话、CSRF、来源与限流验收测试。
//
// 覆盖访问会话令牌只保存摘要、过期拒绝、活动续期、撤销后拒绝继续活动、CSRF 令牌的稳定派生
// 与校验、Host/Origin/Sec-Fetch-Site 的精确来源校验以及来源维度的限流窗口。
//
// 请求级校验在进程内启动真实 HTTP 服务，用真实 `http.request` 产生的真实 `IncomingMessage`
// 执行被测函数，判定结果由响应体回报。每个测试在 runtime/.run 下分配独立数据根，使用真实
// SQLite 文件与真实 HKDF、HMAC、SHA-256 计算。
//
// 运行：node --test e2e/unit/client-complete-wp25-session.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ACCESS_SECURITY, CHATDSH_ERROR_CODES } from '../../packages/core/contracts/lib/index.js';
import { deriveAccessKey, loadAccessMasterKey } from '../../gateway/lib/access/keys.js';
import { AccessStore } from '../../gateway/lib/access/store.js';
import { createAccessLimiter } from '../../gateway/lib/access/limit.js';
import {
  ACCESS_SESSION_RENEW_WINDOW_MS,
  ACCESS_SESSION_TTL_MS,
  accessSessionView,
  accessTokenHash,
  newAccessToken,
  newSessionId,
  renewalOf,
} from '../../gateway/lib/access/session.js';
import { assertCsrfToken, assertExactOrigin, issueCsrfToken, verifyCsrfToken } from '../../gateway/lib/access/csrf.js';

/** 建立独立数据根与真实 SQLite 文件上的访问存储。 */
async function withAccessStore(prefix, run) {
  const home = allocateIndependentHome(prefix);
  const databasePath = join(home, 'access.sqlite');
  const database = new DatabaseSync(databasePath);
  const store = new AccessStore(database);
  try {
    await run({ home, databasePath, database, store });
  } finally {
    database.close();
    releaseIndependentHome(home);
  }
}

/**
 * 在真实 HTTP 请求上执行一次请求校验。
 *
 * 校验函数在服务的请求处理函数里执行，抛出的错误连同错误码一起回到测试进程；返回值必须是
 * 可以序列化的简单值。
 * @param {{ method: string, headers?: Record<string, string> }} spec - 请求方法与请求头。
 * @param {(request: import('node:http').IncomingMessage) => unknown} run - 被测的请求校验函数。
 */
async function verifyRequest(spec, run) {
  const server = createServer(async (request, response) => {
    let payload;
    try {
      payload = { ok: true, value: (await run(request)) ?? null };
    } catch (error) {
      payload = { ok: false, name: error.name, code: error.code, message: error.message };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  const { port } = server.address();
  const body = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: spec.method, headers: spec.headers ?? {} },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => {
          text += chunk;
        });
        incoming.on('end', () => resolve(text));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
  await new Promise((settle) => server.close(settle));
  return JSON.parse(body);
}

/** 登记一条尚未撤销的会话。 */
function insertSession(store, overrides = {}) {
  const createdAt = 1_700_000_000_000;
  const record = {
    sessionId: newSessionId(),
    tokenHash: accessTokenHash(newAccessToken()),
    clientName: 'Chrome on Linux',
    createdAt,
    lastActiveAt: createdAt,
    expiresAt: createdAt + ACCESS_SESSION_TTL_MS,
    ...overrides,
  };
  store.insertSession(record);
  return record;
}

test('会话令牌只保存摘要：库里不出现原值，按原值查不到会话', async () => {
  await withAccessStore('wp25-session', async ({ databasePath, database, store }) => {
    const token = newAccessToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, '会话令牌是 256 位随机值的 base64url 写法');
    const tokenHash = accessTokenHash(token);
    assert.equal(tokenHash, createHash('sha256').update(token, 'utf8').digest('hex'), '摘要应当是令牌的 SHA-256');
    assert.notEqual(accessTokenHash(newAccessToken()), tokenHash);

    const record = insertSession(store, { tokenHash });
    const row = store.sessionByTokenHash(tokenHash);
    assert.equal(row.sessionId, record.sessionId);
    assert.equal(row.tokenHash, tokenHash);
    assert.equal(store.sessionByTokenHash(token), undefined, '把令牌原值当摘要查询应当查不到');

    const rows = database.prepare('select token_hash from access_sessions').all();
    assert.deepEqual(rows.map((entry) => entry.token_hash), [tokenHash]);

    const bytes = readFileSync(databasePath).toString('latin1');
    const tokenBytes = Buffer.from(token, 'utf8').toString('latin1');
    assert.ok(!bytes.includes(tokenBytes), '数据库文件里不得出现会话令牌原值');
  });
});

test('会话过期拒绝，续期窗口内活动把到期时刻推后', async () => {
  await withAccessStore('wp25-renewal', async ({ store }) => {
    const record = insertSession(store);
    const fresh = store.sessionByTokenHash(record.tokenHash);

    assert.deepEqual(renewalOf(fresh, record.createdAt + 1000), {
      expired: false,
      renew: false,
      expiresAt: record.expiresAt,
    }, '距离到期尚早时既不续期也不拒绝');

    const windowStart = record.expiresAt - ACCESS_SESSION_RENEW_WINDOW_MS;
    assert.deepEqual(renewalOf(fresh, windowStart - 1), {
      expired: false,
      renew: false,
      expiresAt: record.expiresAt,
    }, '续期窗口之前不续期');

    const renewAt = windowStart + 1000;
    const renewal = renewalOf(fresh, renewAt);
    assert.equal(renewal.expired, false);
    assert.equal(renewal.renew, true, '续期窗口内的活动应当续期');
    assert.equal(renewal.expiresAt, renewAt + ACCESS_SESSION_TTL_MS);

    store.touchSession(record.sessionId, renewAt, renewal.expiresAt);
    const renewed = store.sessionByTokenHash(record.tokenHash);
    assert.equal(renewed.expiresAt, renewal.expiresAt, '续期后的到期时刻应当落库');
    assert.equal(renewed.lastActiveAt, renewAt);

    assert.deepEqual(renewalOf(renewed, renewed.expiresAt), {
      expired: true,
      renew: false,
      expiresAt: renewed.expiresAt,
    }, '到期时刻本身即过期');
    assert.equal(renewalOf(renewed, renewed.expiresAt + 1).expired, true, '过期之后的请求一律拒绝');
  });
});

test('会话撤销后拒绝继续活动，令牌摘要仍然只能命中已撤销的记录', async () => {
  await withAccessStore('wp25-revoke', async ({ store }) => {
    const record = insertSession(store);
    const revokeAt = record.createdAt + 60_000;

    assert.equal(store.revokeSession(record.sessionId, revokeAt), true, '有效会话第一次撤销应当生效');
    assert.equal(store.revokeSession(record.sessionId, revokeAt + 1), false, '重复撤销不再产生变更');

    const revoked = store.sessionByTokenHash(record.tokenHash);
    assert.equal(revoked.revokedAt, revokeAt);

    // 撤销之后的活动写入不再推进任何时刻：存储层的条件更新拒绝已撤销的会话。
    store.touchSession(record.sessionId, revokeAt + 600_000, revoked.expiresAt + ACCESS_SESSION_TTL_MS);
    const afterTouch = store.sessionById(record.sessionId);
    assert.equal(afterTouch.lastActiveAt, record.lastActiveAt, '已撤销会话的活动时刻不得被推进');
    assert.equal(afterTouch.expiresAt, record.expiresAt, '已撤销会话的到期时刻不得被推进');

    const view = accessSessionView(afterTouch, { currentSessionId: record.sessionId });
    assert.equal(view.revokedAt, revokeAt);
    assert.equal(view.current, true);
    assert.equal(view.renewableFrom, record.expiresAt - ACCESS_SESSION_RENEW_WINDOW_MS);

    const kept = insertSession(store);
    const other = insertSession(store);
    assert.equal(store.revokeAllSessions(revokeAt + 2, kept.sessionId), 1, '保留当前会话时只撤销其余会话');
    assert.equal(store.sessionById(other.sessionId).revokedAt, revokeAt + 2);
    assert.equal(store.sessionById(kept.sessionId).revokedAt, undefined);
    assert.equal(store.revokeAllSessions(revokeAt + 3), 1, '不带保留标识时撤销剩余全部会话');
    assert.equal(store.sessionById(kept.sessionId).revokedAt, revokeAt + 3);
  });
});

test('CSRF 令牌派生稳定，错误令牌拒绝，安全方法跳过', async () => {
  const home = allocateIndependentHome('wp25-csrf');
  const keyPath = join(home, 'access.key');
  try {
    const masterKey = loadAccessMasterKey(keyPath);
    assert.equal(masterKey.length, 32, '部署主密钥为 32 字节');
    const mode = statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600, `主密钥文件权限应当是 0600，实际 ${mode.toString(8)}`);

    const csrfKey = deriveAccessKey(masterKey, 'csrf');
    const envelopeKey = deriveAccessKey(masterKey, 'envelope');
    assert.equal(csrfKey.length, 32);
    assert.notDeepEqual(csrfKey, envelopeKey, '不同用途派生的子密钥互不相同');

    const sessionHash = accessTokenHash(newAccessToken());
    const otherHash = accessTokenHash(newAccessToken());
    const token = issueCsrfToken(csrfKey, sessionHash);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, 'CSRF 令牌是 HMAC-SHA256 的 base64url 写法');
    assert.equal(issueCsrfToken(csrfKey, sessionHash), token, '同一会话重复派生应当得到同一个令牌');
    assert.notEqual(issueCsrfToken(csrfKey, otherHash), token, '不同会话派生的令牌不同');
    assert.notEqual(issueCsrfToken(envelopeKey, sessionHash), token, '换用其他子密钥派生的令牌不同');

    assert.equal(verifyCsrfToken(token, token), true);
    assert.equal(verifyCsrfToken(issueCsrfToken(csrfKey, otherHash), token), false);
    assert.equal(verifyCsrfToken(undefined, token), false);
    assert.equal(verifyCsrfToken(token, undefined), false);
    assert.equal(verifyCsrfToken('x'.repeat(513), token), false, '超长令牌直接拒绝');

    const safe = await verifyRequest(
      { method: 'GET', headers: { [ACCESS_SECURITY.csrfHeader]: 'wrong-token' } },
      (request) => assertCsrfToken(request, token),
    );
    assert.equal(safe.ok, true, '安全方法跳过 CSRF 校验');

    const accepted = await verifyRequest(
      { method: 'POST', headers: { [ACCESS_SECURITY.csrfHeader]: token } },
      (request) => assertCsrfToken(request, token),
    );
    assert.equal(accepted.ok, true, '携带正确 CSRF 令牌的写入请求应当通过');

    const rejected = await verifyRequest(
      { method: 'POST', headers: { [ACCESS_SECURITY.csrfHeader]: 'wrong-token' } },
      (request) => assertCsrfToken(request, token),
    );
    assert.equal(rejected.ok, false, '携带错误 CSRF 令牌的写入请求应当被拒绝');
    assert.equal(rejected.name, 'ChatdshError');
    assert.equal(rejected.code, CHATDSH_ERROR_CODES.csrfRejected, '拒绝码应当是 csrf-rejected');

    const missing = await verifyRequest({ method: 'POST' }, (request) => assertCsrfToken(request, token));
    assert.equal(missing.ok, false, '缺少 CSRF 令牌的写入请求应当被拒绝');
    assert.equal(missing.code, CHATDSH_ERROR_CODES.csrfRejected);
  } finally {
    releaseIndependentHome(home);
  }
});

test('精确来源校验：Host、Origin 与 Sec-Fetch-Site 不匹配都拒绝', async () => {
  const origin = 'https://chatdsh.example';
  const matching = { host: 'chatdsh.example', origin, 'sec-fetch-site': 'same-origin' };

  const accepted = await verifyRequest({ method: 'POST', headers: matching }, (request) => assertExactOrigin(request, origin));
  assert.equal(accepted.ok, true, 'Host、Origin 与 Sec-Fetch-Site 同时匹配时写入请求通过');

  const cases = [
    { name: 'Host 与部署来源不符', headers: { ...matching, host: 'evil.example' } },
    { name: 'Origin 与部署来源不符', headers: { ...matching, origin: 'https://evil.example' } },
    { name: '写入请求缺少 Origin', headers: { host: 'chatdsh.example', 'sec-fetch-site': 'same-origin' } },
    { name: 'Sec-Fetch-Site 为 cross-site', headers: { ...matching, 'sec-fetch-site': 'cross-site' } },
    { name: 'Sec-Fetch-Site 为 same-site', headers: { ...matching, 'sec-fetch-site': 'same-site' } },
  ];

  for (const item of cases) {
    const verdict = await verifyRequest({ method: 'POST', headers: item.headers }, (request) => assertExactOrigin(request, origin));
    assert.equal(verdict.ok, false, `${item.name} 时写入请求应当被拒绝`);
    assert.equal(verdict.code, CHATDSH_ERROR_CODES.originRejected, `${item.name} 的拒绝码应当是 origin-rejected`);
  }

  const read = await verifyRequest(
    { method: 'GET', headers: { host: 'chatdsh.example' } },
    (request) => assertExactOrigin(request, origin),
  );
  assert.equal(read.ok, true, '读取请求不携带 Origin 时仍然通过');

  const readWrongHost = await verifyRequest(
    { method: 'GET', headers: { host: 'evil.example' } },
    (request) => assertExactOrigin(request, origin),
  );
  assert.equal(readWrongHost.ok, false, '读取请求的 Host 不符同样拒绝');
  assert.equal(readWrongHost.code, CHATDSH_ERROR_CODES.originRejected);
});

test('来源限流：同一窗口超过允许次数后拒绝，下一窗口重新计数', async () => {
  await withAccessStore('wp25-rate', async ({ store }) => {
    const limiter = createAccessLimiter(store);
    const now = 1_700_000_000_000;
    const source = '198.51.100.9';
    const sourceLimit = 10;

    for (let attempt = 1; attempt <= sourceLimit; attempt += 1) {
      const decision = limiter.guard(source, now);
      assert.equal(decision.allowed, true, `窗口内第 ${attempt} 次尝试应当放行`);
      assert.equal(decision.attemptsLeft, 5, '尚未失败时剩余次数为锁定阈值');
    }

    const limited = limiter.guard(source, now);
    assert.equal(limited.allowed, false);
    assert.equal(limited.code, CHATDSH_ERROR_CODES.authRateLimited, '超出窗口次数的拒绝码应当是 auth-rate-limited');

    const nextWindow = limiter.guard(source, now + 60_000);
    assert.equal(nextWindow.allowed, true, '下一窗口重新计数');
  });
});
