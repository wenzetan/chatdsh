// WP26 访问界面的逻辑与接口验收：网关、登录结果、会话、恢复码、再次认证与安全返回。
//
// 访问服务用 WP25 交付的真实模块装配：真实 `AccessStore`（SQLite 文件）、真实密码哈希与校验、
// 真实限流与锁定、真实会话令牌摘要、真实 CSRF 派生、真实恢复码生成与一次性消费。浏览器侧
// 数据入口直接使用包内真实源码，通过真实 HTTP 与真实 `fetch` 调用上面的服务。数据根在
// runtime/.run 下独立分配，测试结束释放。
//
// 运行：node --test e2e/unit/client-complete-wp26-logic.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ChatdshError, CHATDSH_ERROR_CODES } from '../../packages/core/contracts/lib/index.js';
import { AccessStore } from '../../gateway/lib/access/store.js';
import { hashAccessPassword, verifyAccessPassword } from '../../gateway/lib/access/password.js';
import { createAccessLimiter } from '../../gateway/lib/access/limit.js';
import { deriveAccessKey, loadAccessMasterKey } from '../../gateway/lib/access/keys.js';
import {
  ACCESS_SESSION_TTL_MS,
  SECOND_FACTOR_TICKET_TTL_MS,
  accessSessionView,
  accessTicketHash,
  accessTokenHash,
  accessTokenOf,
  newAccessToken,
  newSessionId,
  newTicket,
  renewalOf,
  serializeAccessCookie,
} from '../../gateway/lib/access/session.js';
import { assertCsrfToken, issueCsrfToken } from '../../gateway/lib/access/csrf.js';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  recoveryCodeDigest,
  recoveryCodesRemaining,
} from '../../gateway/lib/access/recovery.js';
import { totpEnrolled } from '../../gateway/lib/access/totp.js';

const { AccessCallError, createAccessGateway } = await import('../../packages/client/access/src/client/gateway.ts');
const { createAccessTelemetry } = await import('../../packages/client/access/src/client/telemetry.ts');
const { safeReturnTarget, returnTargetFromSearch } = await import('../../packages/client/access/src/client/return-target.ts');

/** 访问服务使用的密码。 */
const PASSWORD = 'wp26-access-pass-1';

/** 访问服务的来源标签，取回环地址。 */
const SOURCE = '127.0.0.1';

/** 接上真实的访问服务。 */
async function startAccessService() {
  const home = allocateIndependentHome('wp26-logic');
  const database = new DatabaseSync(join(home, 'access.sqlite'));
  const store = new AccessStore(database);
  const masterKey = loadAccessMasterKey(join(home, 'access.key'));
  const csrfKey = deriveAccessKey(masterKey, 'csrf');
  const limiter = createAccessLimiter(store, {
    windowMs: 60_000,
    sourceLimit: 200,
    deploymentLimit: 400,
    lockoutThreshold: 2,
    lockoutBaseMs: 800,
    lockoutMaxMs: 5_000,
  });
  store.writeCredential('password', await hashAccessPassword(PASSWORD), Date.now());
  const telemetryBatches = [];
  let origin;

  /** 当前时刻。 */
  const now = () => Date.now();

  /** 取请求体。 */
  const bodyOf = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? undefined : JSON.parse(text);
  };

  /** 写一个 JSON 响应。 */
  const respond = (response, status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
  };

  /** 取当前请求的访问会话。 */
  const sessionOf = (request) => {
    const token = accessTokenOf(request);
    if (token === undefined) return undefined;
    const row = store.sessionByTokenHash(accessTokenHash(token));
    if (row === undefined || row.revokedAt !== undefined) return undefined;
    if (renewalOf(row, now()).expired) return undefined;
    return row;
  };

  /** 从请求头取客户端名称。 */
  const clientNameOf = (request) => {
    const agent = request.headers['user-agent'] ?? '验收客户端';
    const chrome = /Chrome\/(\d+)/.exec(agent);
    return chrome === null ? String(agent) : `Chrome ${chrome[1]} on Linux`;
  };

  /** 建立一条访问会话。 */
  const startSession = (request) => {
    const at = now();
    const token = newAccessToken();
    const row = {
      sessionId: newSessionId(),
      tokenHash: accessTokenHash(token),
      clientName: clientNameOf(request),
      createdAt: at,
      lastActiveAt: at,
      expiresAt: at + ACCESS_SESSION_TTL_MS,
    };
    store.insertSession(row);
    return { token, row };
  };

  /** 是否需要第二因素。 */
  const twoFactorRequired = () => totpEnrolled(store) || recoveryCodesRemaining(store) > 0;

  /** 生成第二因素票据。 */
  const issueSecondFactorTicket = () => {
    const ticket = newTicket();
    const expiresAt = now() + SECOND_FACTOR_TICKET_TTL_MS;
    store.insertTicket('second-factor', accessTicketHash(ticket), expiresAt, now());
    return { ticket, expiresAt };
  };

  /** 完成登录：写 Cookie 并返回契约结果。 */
  const completeSignIn = (request, response) => {
    const session = startSession(request);
    response.setHeader('set-cookie', serializeAccessCookie(session.token, ACCESS_SESSION_TTL_MS / 1000));
    return {
      outcome: 'authenticated',
      session: accessSessionView(session.row, { currentSessionId: session.row.sessionId }),
      tokenWritten: true,
    };
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    try {
      if (url.pathname === '/chatdsh/telemetry/browser') {
        telemetryBatches.push(await bodyOf(request) ?? {});
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === '/chatdsh/access/status') {
        const row = sessionOf(request);
        respond(response, 200, {
          required: true,
          methods: ['password'],
          signedIn: row !== undefined,
          secondFactorPending: false,
          totpEnrolled: totpEnrolled(store),
          recoveryCodesRemaining: recoveryCodesRemaining(store),
          lockedUntil: limiter.lockedUntil(SOURCE, now()),
          passkeyUnavailableReason: 'verifier-library-missing',
          ...(row === undefined ? {} : { csrfToken: issueCsrfToken(csrfKey, row.tokenHash) }),
        });
        return;
      }
      if (url.pathname === '/chatdsh/access/sign-in' && request.method === 'POST') {
        const body = await bodyOf(request);
        const decision = limiter.guard(SOURCE, now());
        if (!decision.allowed) {
          respond(response, 200, {
            outcome: 'rejected',
            code: decision.code,
            attemptsLeft: decision.attemptsLeft,
            ...(decision.code === 'auth-locked' ? { lockedUntil: decision.lockedUntil } : {}),
          });
          return;
        }
        if (body?.method === 'password') {
          const credential = store.credential('password');
          const matched = credential !== undefined && await verifyAccessPassword(String(body.password ?? ''), credential.digest);
          if (!matched) {
            const counted = limiter.fail(SOURCE, now());
            respond(response, 200, { outcome: 'rejected', code: CHATDSH_ERROR_CODES.authInvalid, ...counted });
            return;
          }
          limiter.succeed(SOURCE, now());
          if (twoFactorRequired()) {
            const second = issueSecondFactorTicket();
            respond(response, 200, {
              outcome: 'second-factor-required',
              partialTicket: second.ticket,
              methods: totpEnrolled(store) ? ['totp', 'recovery-code'] : ['recovery-code'],
              expiresAt: second.expiresAt,
            });
            return;
          }
          respond(response, 200, completeSignIn(request, response));
          return;
        }
        if (body?.method === 'recovery-code' || body?.method === 'totp') {
          const ticket = store.consumeTicket('second-factor', accessTicketHash(String(body.partialTicket ?? '')), now());
          if (ticket === undefined) {
            respond(response, 200, { outcome: 'rejected', code: CHATDSH_ERROR_CODES.ticketExpired });
            return;
          }
          if (body.method === 'totp') {
            respond(response, 200, { outcome: 'rejected', code: CHATDSH_ERROR_CODES.totpInvalid });
            return;
          }
          const submitted = String(body.code ?? '');
          if (consumeRecoveryCode(store, submitted, now())) {
            limiter.succeed(SOURCE, now());
            respond(response, 200, completeSignIn(request, response));
            return;
          }
          const consumed = database
            .prepare('select consumed_at from access_recovery_codes where code_hash = ?')
            .get(recoveryCodeDigest(submitted));
          const counted = limiter.fail(SOURCE, now());
          respond(response, 200, {
            outcome: 'rejected',
            code: CHATDSH_ERROR_CODES.recoveryCodeInvalid,
            ...(consumed?.consumed_at === null || consumed?.consumed_at === undefined ? {} : { used: true }),
            ...counted,
          });
          return;
        }
        respond(response, 400, { error: CHATDSH_ERROR_CODES.requestInvalid });
        return;
      }
      if (url.pathname.startsWith('/chatdsh/access/')) {
        const row = sessionOf(request);
        if (row === undefined) {
          respond(response, 401, { error: CHATDSH_ERROR_CODES.authRequired });
          return;
        }
        if (request.method === 'POST') assertCsrfToken(request, issueCsrfToken(csrfKey, row.tokenHash));
        if (url.pathname === '/chatdsh/access/sessions') {
          respond(response, 200, {
            items: store.sessions().map((item) => accessSessionView(item, { currentSessionId: row.sessionId })),
            currentSessionId: row.sessionId,
          });
          return;
        }
        if (url.pathname === '/chatdsh/access/sessions/revoke') {
          const body = await bodyOf(request);
          const revoked = store.revokeSession(String(body?.sessionId ?? ''), now());
          respond(response, revoked ? 200 : 409, revoked
            ? { sessionId: body.sessionId, revokedAt: now() }
            : { error: CHATDSH_ERROR_CODES.alreadyHandled });
          return;
        }
        if (url.pathname === '/chatdsh/access/sessions/revoke-all') {
          const body = await bodyOf(request);
          const revokedCount = store.revokeAllSessions(now(), body?.keepCurrent === true ? row.sessionId : undefined);
          respond(response, 200, { revokedCount, revokedAt: now() });
          return;
        }
        if (url.pathname === '/chatdsh/access/reauth') {
          const body = await bodyOf(request);
          const credential = store.credential('password');
          const matched = body?.method === 'password'
            && credential !== undefined
            && await verifyAccessPassword(String(body.credential ?? ''), credential.digest);
          if (!matched) {
            respond(response, 200, { outcome: 'rejected', code: CHATDSH_ERROR_CODES.authInvalid });
            return;
          }
          const validUntil = now() + 300_000;
          store.recordReauth(row.sessionId, String(body.action), now());
          respond(response, 200, { outcome: 'authorized', validUntil });
          return;
        }
        if (url.pathname === '/chatdsh/access/recovery' && request.method === 'GET') {
          const stats = store.recoveryCodeStats();
          respond(response, 200, { total: stats.total, remaining: stats.remaining });
          return;
        }
        if (url.pathname === '/chatdsh/access/recovery' && request.method === 'POST') {
          const codes = generateRecoveryCodes(store, now());
          store.writeCredential('recovery-codes', JSON.stringify({ generatedAt: now(), savedConfirmed: false }), now());
          respond(response, 200, { codes, generatedAt: now(), savedConfirmed: false });
          return;
        }
        if (url.pathname === '/chatdsh/access/recovery/saved') {
          store.writeCredential('recovery-codes', JSON.stringify({ generatedAt: now(), savedConfirmed: true }), now());
          respond(response, 200, { savedConfirmed: true });
          return;
        }
        respond(response, 404, { error: CHATDSH_ERROR_CODES.objectNotFound });
        return;
      }
      respond(response, 404, { error: CHATDSH_ERROR_CODES.objectNotFound });
    } catch (error) {
      if (error instanceof ChatdshError) {
        respond(response, 403, { error: error.code });
        return;
      }
      throw error;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    home,
    origin,
    store,
    database,
    limiter,
    telemetryBatches,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      database.close();
      releaseIndependentHome(home);
    },
  };
}

/** 浏览器侧的数据入口，带一个最小的 Cookie 容器。 */
function browserGateway(service, cookieJar, telemetry) {
  const fetchImpl = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookieJar.value !== undefined) headers.set('cookie', cookieJar.value);
    const response = await fetch(new URL(String(input), service.origin), { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) cookieJar.value = setCookie.split(';')[0];
    return response;
  };
  return createAccessGateway({ fetchImpl, telemetry });
}

test('安全返回目标只接受同源相对路径', () => {
  assert.equal(safeReturnTarget('/workspace/chat?session=abc#top'), '/workspace/chat?session=abc#top');
  assert.equal(safeReturnTarget('  /settings  '), '/settings');
  for (const raw of [
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example/steal',
    'javascript:alert(1)',
    'workspace/chat',
    '',
    '/chatdsh/access',
    '/chatdsh/access?next=/workspace',
    '/line\nbreak',
  ]) {
    assert.equal(safeReturnTarget(raw), undefined, `应当拒绝返回目标：${String(raw)}`);
  }
  assert.equal(returnTargetFromSearch('?next=%2Fworkspace%2Fchat%3Fsession%3D1'), '/workspace/chat?session=1');
  assert.equal(returnTargetFromSearch('?next=https%3A%2F%2Fevil.example'), undefined);
  assert.equal(returnTargetFromSearch(''), undefined);
});

test('访问界面源码不触碰任何持久存储', () => {
  const root = resolve(import.meta.dirname, '../../packages/client/access/src');
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length >= 8, `访问界面源码文件数应当不少于 8 个，实际 ${files.length} 个`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      assert.equal(text.includes(api), false, `${file} 不得使用 ${api}`);
    }
  }
});

test('密码登录、锁定倒计时、双因素、恢复码一次使用、会话撤销与再次认证', async () => {
  const service = await startAccessService();
  const cookieJar = { value: undefined };
  const telemetry = createAccessTelemetry({
    fetchImpl: (input, init) => fetch(new URL(String(input), service.origin), init),
  });
  const gateway = browserGateway(service, cookieJar, telemetry);
  try {
    const status = await gateway.status();
    assert.equal(status.required, true);
    assert.deepEqual(status.methods, ['password']);
    assert.equal(status.signedIn, false);
    assert.equal(status.totpEnrolled, false);
    assert.equal(status.recoveryCodesRemaining, 0);
    assert.equal(status.passkeyUnavailableReason, 'verifier-library-missing');
    assert.equal(status.csrfToken, undefined);

    const wrong = await gateway.signIn({ method: 'password', password: 'wrong-pass' });
    assert.equal(wrong.outcome, 'rejected');
    assert.equal(wrong.code, CHATDSH_ERROR_CODES.authInvalid);
    assert.equal(wrong.attemptsLeft, 1, '第一次失败后还剩一次尝试');

    const lockedResult = await gateway.signIn({ method: 'password', password: 'wrong-pass-again' });
    assert.equal(lockedResult.outcome, 'rejected');
    assert.equal(lockedResult.attemptsLeft, 0);
    assert.ok(lockedResult.lockedUntil > Date.now() - 1, '第二次失败应当进入锁定期');

    const duringLock = await gateway.signIn({ method: 'password', password: PASSWORD });
    assert.equal(duringLock.outcome, 'rejected');
    assert.equal(duringLock.code, CHATDSH_ERROR_CODES.authLocked);
    assert.ok(duringLock.lockedUntil > Date.now(), '锁定期内正确密码同样被拒绝');

    await new Promise((done) => setTimeout(done, 900));
    const signedIn = await gateway.signIn({ method: 'password', password: PASSWORD });
    assert.equal(signedIn.outcome, 'authenticated');
    assert.equal(signedIn.tokenWritten, true);
    assert.match(cookieJar.value, /^chatdsh-access=/);
    assert.equal(signedIn.session.current, true);
    assert.match(signedIn.session.clientName, /Chrome|node/, '客户端名称取请求头');

    await gateway.status();
    const generated = await gateway.generateRecoveryCodes();
    assert.equal(generated.codes.length, 10);
    assert.equal(generated.savedConfirmed, false);
    const saved = await gateway.confirmRecoveryCodesSaved();
    assert.equal(saved.savedConfirmed, true);

    const secondStage = await gateway.signIn({ method: 'password', password: PASSWORD });
    assert.equal(secondStage.outcome, 'second-factor-required');
    assert.deepEqual(secondStage.methods, ['recovery-code'], '没有 TOTP 绑定时只提供恢复码');
    assert.ok(secondStage.expiresAt > Date.now());

    const badCode = await gateway.signIn({ method: 'recovery-code', code: 'f'.repeat(32), partialTicket: secondStage.partialTicket });
    assert.equal(badCode.outcome, 'rejected');
    assert.equal(badCode.code, CHATDSH_ERROR_CODES.recoveryCodeInvalid);

    const retryStage = await gateway.signIn({ method: 'password', password: PASSWORD });
    assert.equal(retryStage.outcome, 'second-factor-required');
    const used = await gateway.signIn({ method: 'recovery-code', code: generated.codes[0], partialTicket: retryStage.partialTicket });
    assert.equal(used.outcome, 'authenticated');

    const secondStageAgain = await gateway.signIn({ method: 'password', password: PASSWORD });
    assert.equal(secondStageAgain.outcome, 'second-factor-required');
    const reused = await gateway.signIn({ method: 'recovery-code', code: generated.codes[0], partialTicket: secondStageAgain.partialTicket });
    assert.equal(reused.outcome, 'rejected');
    assert.equal(reused.code, CHATDSH_ERROR_CODES.recoveryCodeInvalid);
    assert.equal(reused.used, true, '重复使用的恢复码要能识别为已经使用');

    const thirdStage = await gateway.signIn({ method: 'password', password: PASSWORD });
    assert.equal(thirdStage.outcome, 'second-factor-required');
    const signedInAgain = await gateway.signIn({ method: 'recovery-code', code: generated.codes[1], partialTicket: thirdStage.partialTicket });
    assert.equal(signedInAgain.outcome, 'authenticated');
    await gateway.status();

    const otherToken = newAccessToken();
    const otherAt = Date.now() - 60_000;
    const otherSession = {
      sessionId: randomUUID(),
      tokenHash: accessTokenHash(otherToken),
      clientName: '第二访问客户端',
      createdAt: otherAt,
      lastActiveAt: otherAt,
      expiresAt: otherAt + ACCESS_SESSION_TTL_MS,
    };
    service.store.insertSession(otherSession);

    const list = await gateway.sessions();
    assert.equal(list.items.length >= 3, true, `会话列表应当包含全部记录，实际 ${list.items.length} 条`);
    const current = list.items.find((item) => item.sessionId === list.currentSessionId);
    assert.ok(current !== undefined);
    assert.equal(current.current, true);
    assert.ok(current.createdAt > 0 && current.lastActiveAt > 0 && current.expiresAt > 0 && current.renewableFrom > 0);
    const other = list.items.find((item) => item.sessionId === otherSession.sessionId);
    assert.ok(other !== undefined);
    assert.equal(other.current, false);

    const revoked = await gateway.revokeSession(otherSession.sessionId);
    assert.ok(revoked.revokedAt > 0);
    const afterRevoke = await gateway.sessions();
    assert.ok(afterRevoke.items.find((item) => item.sessionId === otherSession.sessionId).revokedAt !== undefined);

    const revokedAll = await gateway.revokeAllSessions(true);
    assert.ok(revokedAll.revokedCount >= 1, '保留当前会话时仍然撤销其他会话');
    assert.equal(service.store.sessionById(current.sessionId).revokedAt, undefined);

    const rejected = await gateway.reauth({ action: 'regenerate-recovery-codes', method: 'password', credential: 'wrong-pass' });
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.code, CHATDSH_ERROR_CODES.authInvalid);
    const authorized = await gateway.reauth({ action: 'regenerate-recovery-codes', method: 'password', credential: PASSWORD });
    assert.equal(authorized.outcome, 'authorized');
    assert.ok(authorized.validUntil - Date.now() > 250_000, '再次认证窗口为 5 分钟');

    const freeGateway = createAccessGateway({
      fetchImpl: async (input, init = {}) => {
        const headers = new Headers(init.headers);
        if (cookieJar.value !== undefined) headers.set('cookie', cookieJar.value);
        return fetch(new URL(String(input), service.origin), { ...init, headers });
      },
      telemetry,
    });
    await assert.rejects(
      freeGateway.generateRecoveryCodes(),
      (error) => {
        assert.equal(error.code, CHATDSH_ERROR_CODES.csrfRejected, '没有状态响应下发的 CSRF 令牌时写操作被拒绝');
        return true;
      },
    );

    const remaining = await gateway.recoveryStatus();
    assert.equal(remaining.total, 10);
    assert.equal(remaining.remaining, 8);

    const serializedTelemetry = JSON.stringify(service.telemetryBatches);
    for (const secret of [PASSWORD, ...generated.codes, cookieJar.value.split('=')[1]]) {
      assert.equal(serializedTelemetry.includes(secret), false, '遥测里不得出现密码、恢复码或会话令牌');
    }
    for (let attempt = 0; attempt < 40 && service.telemetryBatches.length === 0; attempt += 1) {
      await new Promise((done) => setTimeout(done, 50));
    }
    const spans = [];
    const logBodies = [];
    for (const batch of service.telemetryBatches) {
      for (const resource of batch.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            const attributes = Object.fromEntries((span.attributes ?? []).map((entry) => [entry.key, entry.value?.stringValue]));
            spans.push(`${span.name}:${attributes['rpc.method']}:${attributes.outcome}`);
          }
        }
      }
      for (const resource of batch.resourceLogs ?? []) {
        for (const scope of resource.scopeLogs ?? []) {
           for (const record of scope.logRecords ?? []) {
            const attributes = Object.fromEntries((record.attributes ?? []).map((entry) => [entry.key, entry.value?.stringValue]));
            logBodies.push(`${record.body?.stringValue}:${attributes['error.code'] ?? ''}`);
          }
        }
      }
    }
    assert.ok(spans.length > 0, '远端调用必须产生 span');
    for (const expected of [
      'chatdsh.client.remote.call:access/status:ok',
      'chatdsh.client.remote.call:access/sign-in:ok',
      'chatdsh.client.remote.call:access/sessions:ok',
      'chatdsh.client.remote.call:access/session-revoke:ok',
      'chatdsh.client.remote.call:access/sessions-revoke-all:ok',
      'chatdsh.client.remote.call:access/reauth:ok',
      'chatdsh.client.remote.call:access/recovery-generate:failed',
    ]) {
      assert.ok(spans.includes(expected), `缺少调用遥测 ${expected}，实际 ${spans.join('、')}`);
    }
    assert.ok(logBodies.includes('chatdsh.client.error:csrf-rejected'), '写操作被拒绝时必须记一条带错误码的事件');

    const databaseBytes = readFileSync(join(service.home, 'access.sqlite')).toString('latin1');
    assert.equal(databaseBytes.includes(Buffer.from(PASSWORD, 'utf8').toString('latin1')), false, '数据库文件里不得出现密码原值');
    for (const code of generated.codes) {
      assert.equal(databaseBytes.includes(Buffer.from(code, 'utf8').toString('latin1')), false, '数据库文件里不得出现恢复码原值');
    }
  } finally {
    await service.close();
  }
});
