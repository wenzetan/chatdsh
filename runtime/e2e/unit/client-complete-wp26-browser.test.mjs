// WP26 访问界面的真实浏览器验收：登录、粘贴、键盘与焦点、双因素、TOTP 绑定、恢复码、
// 访问会话、再次认证、返回目标、持久存储隔离与遥测内容边界。
//
// 访问服务用 WP25 交付的真实模块装配：真实 `AccessStore`（SQLite 文件）、真实密码哈希与校验、
// 真实限流与锁定、真实会话令牌摘要、真实 CSRF 派生、真实恢复码一次性消费、真实 TOTP 绑定与
// 校验（`TotpLibrary` 端口由测试装配的 RFC 6238 实现提供，本机没有成熟的 TOTP 库）。页面由
// esbuild 打包 `packages/client/access/src` 下的真实源码，浏览器是 agent-browser 独立会话里的
// 真实 Chrome，使用独立 HOME、TMPDIR 与 profile，全程不截图。断言来自 DOM、可访问属性、真实
// HTTP 响应、SQLite 记录与浏览器存储。
//
// 运行：node --test e2e/unit/client-complete-wp26-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
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
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  totpEnrolled,
  verifyTotpCode,
} from '../../gateway/lib/access/totp.js';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const RUNTIME = resolve(import.meta.dirname, '../..');
const PASSWORD = 'wp26-browser-pass-1';
const SOURCE = '127.0.0.1';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 页面入口：真实登录页与真实访问区段共用同一份源码。 */
const PAGE_ENTRY = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccessSignInPage } from './packages/client/access/src/client/signin.tsx';
import { AccessSection } from './packages/client/access/src/client/index.tsx';
import { returnTargetFromSearch } from './packages/client/access/src/client/return-target.ts';
window.__wp26Errors = [];
window.addEventListener('error', (event) => window.__wp26Errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__wp26Errors.push('rejection:' + String(event.reason)));
const returnTarget = returnTargetFromSearch(window.location.search);
function App() {
  const [mode, setMode] = useState('signin');
  return mode === 'section'
    ? <AccessSection onSignedOut={() => setMode('signin')} />
    : <AccessSignInPage returnTarget={returnTarget} onAuthenticated={() => setMode('section')} />;
}
createRoot(document.getElementById('root')).render(<App />);
`;

/** base32 编码。 */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/** base32 解码。 */
function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of text.toUpperCase()) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error(`base32 字符不合法：${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 按 RFC 6238 计算某一时间片的验证码。 */
function totpCodeAt(secret, step) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** 当前时间片的验证码。 */
function currentTotpCode(secret) {
  return totpCodeAt(secret, Math.floor(Date.now() / 1000 / 30));
}

/** 本次验收已经消费过的时间片；同一时间片只能被接受一次。 */
const consumedTotpSteps = new Set();

/**
 * 取一个尚未消费、并且落在允许窗口内的时间片的验证码。
 * @param secret - base32 密钥。
 * @returns 验证码与时间片。
 */
function nextTotpCode(secret) {
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const candidate of [step, step - 1, step + 1]) {
    if (consumedTotpSteps.has(candidate)) continue;
    consumedTotpSteps.add(candidate);
    return { code: totpCodeAt(secret, candidate), step: candidate };
  }
  throw new Error('当前窗口内没有可以使用的验证码时间片');
}

/** 不存在的验证码，用于验证错误分支。 */
function wrongTotpCode(secret) {
  const actual = currentTotpCode(secret);
  return actual === '000000' ? '000001' : '000000';
}

/** 测试装配的 TOTP 库端口实现；本机没有成熟 TOTP 库，生产实现由 WP39 接入。 */
function totpLibrary() {
  return {
    generateSecret: () => base32Encode(randomBytes(20)),
    keyUri: ({ issuer, label, secret }) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
    match: ({ secret, code, at, window, periodSeconds }) => {
      const step = Math.floor(at / 1000 / periodSeconds);
      for (let delta = -window; delta <= window; delta += 1) {
        if (totpCodeAt(secret, step + delta) === code) return step + delta;
      }
      return undefined;
    },
  };
}

/**
 * 装配真实访问服务。
 * @returns 服务句柄。
 */
async function startAccessService() {
  const home = allocateIndependentHome('wp26-browser');
  const database = new (await import('node:sqlite')).DatabaseSync(join(home, 'access.sqlite'));
  const store = new AccessStore(database);
  const masterKey = loadAccessMasterKey(join(home, 'access.key'));
  const csrfKey = deriveAccessKey(masterKey, 'csrf');
  const envelopeKey = deriveAccessKey(masterKey, 'envelope');
  const library = totpLibrary();
  const limiter = createAccessLimiter(store, {
    windowMs: 60_000,
    sourceLimit: 300,
    deploymentLimit: 600,
    lockoutThreshold: 2,
    lockoutBaseMs: 1_500,
    lockoutMaxMs: 5_000,
  });
  store.writeCredential('password', await hashAccessPassword(PASSWORD), Date.now());
  const telemetryBatches = [];
  const issuedCookies = [];
  let origin;

  const now = () => Date.now();

  const bodyOf = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? undefined : JSON.parse(text);
  };

  const respond = (response, status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
  };

  const sessionOf = (request) => {
    const token = accessTokenOf(request);
    if (token === undefined) return undefined;
    const row = store.sessionByTokenHash(accessTokenHash(token));
    if (row === undefined || row.revokedAt !== undefined) return undefined;
    if (renewalOf(row, now()).expired) return undefined;
    return row;
  };

  const clientNameOf = (request) => {
    const agent = request.headers['user-agent'] ?? '验收浏览器';
    const chrome = /Chrome\/(\d+)/.exec(agent);
    return chrome === null ? String(agent) : `Chrome ${chrome[1]} on Linux`;
  };

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

  const twoFactorRequired = () => totpEnrolled(store) || recoveryCodesRemaining(store) > 0;

  const issueSecondFactorTicket = () => {
    const ticket = newTicket();
    const expiresAt = now() + SECOND_FACTOR_TICKET_TTL_MS;
    store.insertTicket('second-factor', accessTicketHash(ticket), expiresAt, now());
    return { ticket, expiresAt };
  };

  const completeSignIn = (request, response) => {
    const session = startSession(request);
    const cookie = serializeAccessCookie(session.token, ACCESS_SESSION_TTL_MS / 1000);
    response.setHeader('set-cookie', cookie);
    issuedCookies.push(session.token);
    return {
      outcome: 'authenticated',
      session: accessSessionView(session.row, { currentSessionId: session.row.sessionId }),
      tokenWritten: true,
    };
  };

  const rejectSignIn = (response, code, extra = {}) => {
    respond(response, 200, { outcome: 'rejected', code, ...extra });
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
          rejectSignIn(response, decision.code, {
            attemptsLeft: decision.attemptsLeft,
            ...(decision.code === 'auth-locked' ? { lockedUntil: decision.lockedUntil } : {}),
          });
          return;
        }
        if (body?.method === 'password') {
          const credential = store.credential('password');
          const matched = credential !== undefined && await verifyAccessPassword(String(body.password ?? ''), credential.digest);
          if (!matched) {
            rejectSignIn(response, CHATDSH_ERROR_CODES.authInvalid, limiter.fail(SOURCE, now()));
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
            rejectSignIn(response, CHATDSH_ERROR_CODES.ticketExpired);
            return;
          }
          if (body.method === 'totp') {
            try {
              verifyTotpCode(store, envelopeKey, library, String(body.code ?? ''), now());
              limiter.succeed(SOURCE, now());
              respond(response, 200, completeSignIn(request, response));
            } catch (error) {
              if (!(error instanceof ChatdshError)) throw error;
              rejectSignIn(response, CHATDSH_ERROR_CODES.totpInvalid, limiter.fail(SOURCE, now()));
            }
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
          rejectSignIn(response, CHATDSH_ERROR_CODES.recoveryCodeInvalid, {
            ...(consumed?.consumed_at === null || consumed?.consumed_at === undefined ? {} : { used: true }),
            ...limiter.fail(SOURCE, now()),
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
          let matched = body?.method === 'password'
            && await verifyAccessPassword(String(body.credential ?? ''), store.credential('password')?.digest ?? '');
          if (!matched && body?.method === 'totp') {
            try {
              verifyTotpCode(store, envelopeKey, library, String(body.credential ?? ''), now());
              matched = true;
            } catch (error) {
              if (!(error instanceof ChatdshError)) throw error;
            }
          }
          if (!matched) {
            respond(response, 200, { outcome: 'rejected', code: CHATDSH_ERROR_CODES.authInvalid });
            return;
          }
          const validUntil = now() + 300_000;
          store.recordReauth(row.sessionId, String(body.action), now());
          respond(response, 200, { outcome: 'authorized', validUntil });
          return;
        }
        if (url.pathname === '/chatdsh/access/totp/enroll' && request.method === 'POST') {
          const enrollment = beginTotpEnrollment(store, envelopeKey, library, { issuer: 'ChatDSH', label: 'chatdsh.local' }, now());
          respond(response, 200, enrollment);
          return;
        }
        if (url.pathname === '/chatdsh/access/totp/confirm' && request.method === 'POST') {
          const body = await bodyOf(request);
          confirmTotpEnrollment(store, envelopeKey, library, String(body?.code ?? ''), now());
          respond(response, 200, { confirmed: true });
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
    library,
    telemetryBatches,
    issuedCookies,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      database.close();
      releaseIndependentHome(home);
    },
  };
}

/**
 * 起一个页面服务：页面与访问接口同源，接口转发到真实访问服务。
 * @param service - 访问服务句柄。
 * @returns 页面服务句柄。
 */
async function startPageServer(service) {
  const bundle = await build({
    stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME, loader: 'tsx', sourcefile: 'wp26-page.tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    alias: { '@chatdsh/core-ui-kit': join(RUNTIME, 'packages/core/ui-kit/src/index.ts') },
    logLevel: 'warning',
  });
  const tokens = readFileSync(new URL('../../packages/client/theme/src/client/styles/tokens.css', import.meta.url), 'utf8');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><main id="root"></main><script>${bundle.outputFiles[0].text}</script></body></html>`;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/chatdsh/telemetry/browser') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        service.telemetryBatches.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(204).end();
      });
      return;
    }
    if (url.pathname.startsWith('/chatdsh/access/')) {
      const target = new URL(service.origin);
      const forwarded = httpRequest({
        host: target.hostname,
        port: target.port,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: target.host },
      }, (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      });
      forwarded.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'upstream-unavailable' }));
      });
      request.pipe(forwarded);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('访问界面：密码管理器、粘贴、键盘焦点、双因素、TOTP 绑定、恢复码、会话、再次认证与返回目标', async () => {
  const service = await startAccessService();
  const page = await startPageServer(service);
  const session = `wp26-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    PATH: `${NODE_BIN}:${process.env.PATH}`,
    HOME: service.home,
    TMPDIR: service.home,
    DSH_HOME: service.home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(service.home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  const waitFor = async (expression, message, attempts = 200) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { data } = await cli('eval', `Boolean(${expression})`);
      if (data.result === true) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    const state = await evaluate('JSON.stringify({ text: document.getElementById("root").textContent, errors: window.__wp26Errors })');
    assert.fail(`等待超时：${message}\n页面状态：${state}`);
  };
  const focus = async (selector) => {
    const found = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.focus(); return document.activeElement === node; })()`);
    assert.equal(found, true, `找不到可以聚焦的控件：${selector}`);
  };
  const activate = async (selector) => {
    await focus(selector);
    await cli('press', 'Enter');
  };
  const typeInto = async (selector, text) => {
    await cli('fill', selector, '');
    await focus(selector);
    await cli('keyboard', 'type', text);
  };
  const activeId = async () => evaluate('document.activeElement === null ? null : document.activeElement.id');
  const dialogText = async () => evaluate('document.querySelector("dialog[open]") === null ? null : document.querySelector("dialog[open]").textContent');

  const pageUrl = `${page.origin}/chatdsh/access?next=${encodeURIComponent('/workspace/chat?session=abc')}`;
  let opened = false;
  try {
    await cli('open', pageUrl);
    opened = true;
    await waitFor('document.getElementById("chdsh-access-password") !== null', '登录页载入');

    // 1. 密码字段供密码管理器识别，通行密钥不可用时说明原因。
    const passwordAttributes = await evaluate('(() => { const node = document.getElementById("chdsh-access-password"); return { type: node.type, name: node.name, autocomplete: node.autocomplete, label: document.querySelector("label[for=\\"chdsh-access-password\\"]").textContent }; })()');
    assert.equal(passwordAttributes.type, 'password');
    assert.equal(passwordAttributes.name, 'password');
    assert.equal(passwordAttributes.autocomplete, 'current-password');
    assert.match(passwordAttributes.label, /密码/);
    assert.match(await evaluate('document.getElementById("chdsh-access-password").getAttribute("aria-describedby")'), /chdsh-access-password-help/);
    assert.match(await evaluate('document.getElementById("chdsh-access-password-help").textContent'), /密码管理器/);
    assert.equal(await evaluate('document.querySelector("[data-access-announcer]").getAttribute("role")'), 'status');
    assert.equal(await evaluate('document.querySelector("[data-access-announcer]").getAttribute("aria-live")'), 'polite');
    const passkeyText = await evaluate('document.querySelector("[data-access-passkey-unavailable]").textContent');
    assert.match(passkeyText, /通行密钥/);
    assert.match(passkeyText, /校验库/);
    assert.equal(await evaluate('document.getElementById("chdsh-access-passkey-signin") === null'), true, '通行密钥不可用时不能给出登录按钮');

    // 2. 表单焦点顺序：密码、显示密码、登录。
    await focus('#chdsh-access-password');
    await cli('press', 'Tab');
    assert.equal(await activeId(), 'chdsh-access-password-reveal');
    await cli('press', 'Tab');
    assert.equal(await activeId(), 'chdsh-access-signin-submit');

    // 3. 显示与隐藏密码是可访问的开关。
    await activate('#chdsh-access-password-reveal');
    await waitFor('document.getElementById("chdsh-access-password").type === "text"', '密码切换为可见');
    assert.equal(await evaluate('document.getElementById("chdsh-access-password-reveal").getAttribute("aria-pressed")'), 'true');
    await activate('#chdsh-access-password-reveal');
    await waitFor('document.getElementById("chdsh-access-password").type === "password"', '密码恢复隐藏');

    // 4. 粘贴可用：剪贴板写入后按 Control+V。
    await cli('clipboard', 'write', PASSWORD);
    await focus('#chdsh-access-password');
    await cli('press', 'Control+v');
    await waitFor(`document.getElementById("chdsh-access-password").value === ${JSON.stringify(PASSWORD)}`, '粘贴的密码进入输入框');

    // 5. 失败一次：错误摘要获得焦点并给出剩余次数。
    await typeInto('#chdsh-access-password', 'wrong-password-1');
    await cli('press', 'Enter');
    await waitFor('document.getElementById("chdsh-access-error-summary") !== null', '错误摘要出现');
    assert.equal(await activeId(), 'chdsh-access-error-summary', '失败后焦点移到错误摘要');
    assert.equal(await evaluate('document.getElementById("chdsh-access-error-summary").getAttribute("role")'), 'alert');
    assert.match(await evaluate('document.getElementById("chdsh-access-error-summary").textContent'), /密码或验证码不正确/);
    await waitFor('document.querySelector("[data-access-attempts]") !== null', '剩余次数提示出现');
    assert.match(await evaluate('document.querySelector("[data-access-attempts]").textContent'), /还可以尝试 1 次/);
    assert.equal(await evaluate('document.getElementById("chdsh-access-password").value'), '', '失败后密码字段清空');

    // 6. 再失败一次进入锁定期，倒计时结束后自动恢复。
    await typeInto('#chdsh-access-password', 'wrong-password-2');
    await cli('press', 'Enter');
    await waitFor('document.querySelector("[data-access-lock]") !== null', '锁定倒计时出现');
    assert.match(await evaluate('document.querySelector("[data-access-lock]").textContent'), /剩余等待时间 \d{2}:\d{2}（\d+ 秒）/);
    assert.equal(await evaluate('document.getElementById("chdsh-access-signin-submit").disabled'), true, '锁定期内不允许提交');
    await waitFor('document.getElementById("chdsh-access-signin-submit").disabled === false', '锁定期结束', 120);
    assert.match(await evaluate('document.querySelector("[data-access-announcer]").textContent'), /等待期已经结束/);

    // 7. 正确密码登录，进入访问区段。
    await typeInto('#chdsh-access-password', PASSWORD);
    await cli('press', 'Enter');
    await waitFor('document.getElementById("chdsh-access-sessions-refresh") !== null', '登录后进入访问区段');
    assert.match(await evaluate('document.getElementById("root").textContent'), /当前访问会话有效/);
    assert.equal(await evaluate('new URL(location.href).pathname'), '/chatdsh/access', '登录成功后停留在接入页，不会自动跳转或重发业务动作');
    assert.equal(await evaluate('Object.keys(localStorage).length'), 0, '登录过程不得写入 localStorage');
    assert.equal(await evaluate('document.cookie'), '', '访问状态只使用 HttpOnly Cookie');

    // 8. TOTP 绑定：密钥、otpauth 地址、二维码不可用说明与确认输入。
    await activate('#chdsh-access-totp-start');
    await waitFor('document.getElementById("chdsh-access-totp-secret") !== null', '绑定密钥出现');
    const totpSecret = await evaluate('document.getElementById("chdsh-access-totp-secret").value');
    assert.match(totpSecret, /^[A-Z2-7]{16,}$/);
    assert.equal(await evaluate('document.getElementById("chdsh-access-totp-secret").readOnly'), true);
    const otpauthUri = await evaluate('document.getElementById("chdsh-access-totp-uri").value');
    assert.match(otpauthUri, /^otpauth:\/\/totp\/ChatDSH/);
    assert.ok(otpauthUri.includes(totpSecret));
    assert.match(await evaluate('document.querySelector("[data-totp-qr-unavailable]").textContent'), /二维码生成库|无法显示二维码/);
    await activate('#chdsh-access-totp-copy');
    await waitFor('/已复制到剪贴板|无法访问剪贴板/.test(document.getElementById("root").textContent)', '复制结果出现');
    const enrollmentStep = Math.floor(Date.now() / 1000 / 30);
    consumedTotpSteps.add(enrollmentStep);
    const confirmCode = totpCodeAt(totpSecret, enrollmentStep);
    await typeInto('#chdsh-access-totp-confirm-code', confirmCode);
    await activate('#chdsh-access-totp-confirm');
    await waitFor('document.querySelector("[data-totp-enrolled]") !== null', '绑定确认完成');
    assert.match(await evaluate('document.querySelector("[data-totp-enrolled]").textContent'), /已绑定/);
    assert.equal(totpEnrolled(service.store), true, '绑定确认写入真实访问存储');

    // 9. 重新生成恢复码之前再次认证：说明窗口，对话框约束焦点，验证码方式可用。
    await activate('#chdsh-access-recovery-generate');
    await waitFor('document.querySelector("dialog[open] #chdsh-access-reauth-form") !== null', '再次认证对话框出现');
    const reauthText = await dialogText();
    assert.match(reauthText, /再次认证/);
    assert.match(reauthText, /5 分钟内有效/);
    assert.match(reauthText, /重新生成恢复码/);
    for (let index = 0; index < 8; index += 1) {
      await cli('press', 'Tab');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, 'Tab 不能离开再次认证对话框');
    }
    await activate('#chdsh-access-reauth-method-totp');
    const reauthCode = nextTotpCode(totpSecret);
    await typeInto('#chdsh-access-reauth-credential', reauthCode.code);
    await activate('#chdsh-access-reauth-submit');
    await waitFor('document.querySelector("dialog[open] #chdsh-access-reauth-form") === null', '再次认证完成后对话框关闭');
    await waitFor('document.querySelector("[data-recovery-set]") !== null', '恢复码生成完成');
    const recoveryCodes = await evaluate('[...document.querySelectorAll("[data-recovery-code] code")].map((node) => node.textContent)');
    assert.equal(recoveryCodes.length, 10, '恢复码固定 10 条');
    for (const code of recoveryCodes) assert.match(code, /^[0-9a-f]{32}$/);
    assert.equal(await evaluate('document.getElementById("chdsh-access-recovery-download").getAttribute("href").startsWith("blob:")'), true);
    assert.match(await evaluate('document.getElementById("chdsh-access-recovery-download").getAttribute("download")'), /^chatdsh-recovery-codes-\d{4}-\d{2}-\d{2}\.txt$/);
    await evaluate('window.__wp26Download = undefined; fetch(document.getElementById("chdsh-access-recovery-download").href).then((r) => r.text()).then((text) => { window.__wp26Download = text; })');
    await waitFor('typeof window.__wp26Download === "string"', '下载文本可读');
    const downloadText = await evaluate('window.__wp26Download');
    assert.match(downloadText, /ChatDSH 一次性恢复码/);
    for (const code of recoveryCodes) assert.ok(downloadText.includes(code), '下载文件包含每条恢复码');
    const printSheet = await evaluate('document.querySelector("[data-print-sheet]").textContent');
    for (const code of recoveryCodes) assert.ok(printSheet.includes(code), '打印视图包含每条恢复码');
    assert.match(await evaluate('document.querySelector("style[data-access-print]").textContent'), /@media print/);
    assert.equal(await evaluate('document.querySelector("[data-recovery-unsaved]") !== null'), true, '未确认保存时给出提醒');
    await cli('check', '#chdsh-access-recovery-saved');
    await activate('#chdsh-access-recovery-saved-confirm');
    await waitFor('document.querySelector("[data-recovery-unsaved]") === null', '确认保存后提醒消失');
    assert.match(await evaluate('document.querySelector("[data-recovery-remaining]").textContent'), /剩余 10 条未使用/);

    // 10. 会话列表：当前设备标记、时间字段、撤销确认与焦点恢复。
    const extraToken = newAccessToken();
    const extraId = randomUUID();
    const extraAt = Date.now() - 120_000;
    service.store.insertSession({
      sessionId: extraId,
      tokenHash: accessTokenHash(extraToken),
      clientName: '第二访问客户端',
      createdAt: extraAt,
      lastActiveAt: extraAt,
      expiresAt: extraAt + ACCESS_SESSION_TTL_MS,
    });
    await activate('#chdsh-access-sessions-refresh');
    await waitFor(`document.querySelector('[data-session-client="${extraId}"]') !== null`, '第二访问客户端出现在列表');
    const sessionsText = await evaluate('document.getElementById("root").textContent');
    assert.match(sessionsText, /当前设备/);
    assert.match(sessionsText, /建立于 \d{4}年\d{2}月\d{2}日/);
    assert.match(sessionsText, /最近活动/);
    assert.match(sessionsText, /续期窗口从/);
    await activate(`#chdsh-access-session-revoke-${extraId}`);
    await waitFor('document.querySelector("dialog[open] #chdsh-access-session-revoke-confirm") !== null', '撤销确认对话框出现');
    assert.match(await dialogText(), /立即失效/);
    await cli('press', 'Escape');
    await waitFor('document.querySelector("dialog[open]") === null', 'Escape 关闭撤销确认');
    assert.equal(await activeId(), `chdsh-access-session-revoke-${extraId}`, '关闭后焦点回到撤销按钮');
    await activate(`#chdsh-access-session-revoke-${extraId}`);
    await activate('#chdsh-access-session-revoke-confirm');
    await waitFor('/已撤销 第二访问客户端/.test(document.getElementById("root").textContent)', '撤销结果出现');
    assert.ok(service.store.sessionById(extraId).revokedAt > 0);

    // 11. 退出其他客户端：确认对话框之后用密码再次认证。
    const otherId = randomUUID();
    const otherAt = Date.now() - 60_000;
    service.store.insertSession({
      sessionId: otherId,
      tokenHash: accessTokenHash(newAccessToken()),
      clientName: '第三访问客户端',
      createdAt: otherAt,
      lastActiveAt: otherAt,
      expiresAt: otherAt + ACCESS_SESSION_TTL_MS,
    });
    await activate('#chdsh-access-sessions-refresh');
    await waitFor(`document.querySelector('[data-session-client="${otherId}"]') !== null`, '第三访问客户端出现在列表');
    await activate('#chdsh-access-sessions-revoke-others');
    await waitFor('document.querySelector("dialog[open] #chdsh-access-sessions-revoke-all-confirm") !== null', '退出其他客户端确认出现');
    await activate('#chdsh-access-sessions-revoke-all-confirm');
    await waitFor('document.querySelector("dialog[open] #chdsh-access-reauth-form") !== null', '再次认证对话框接着出现');
    await typeInto('#chdsh-access-reauth-credential', PASSWORD);
    await activate('#chdsh-access-reauth-submit');
    await waitFor('/已退出其他客户端，撤销 [0-9]+ 条访问会话/.test(document.getElementById("root").textContent)', '退出其他客户端完成');
    assert.ok(service.store.sessionById(otherId).revokedAt > 0);
    assert.equal(service.store.sessionById(otherId).revokedAt === undefined, false);

    // 12. 退出全部客户端：回到登录入口。
    const currentId = await evaluate('[...document.querySelectorAll("[data-session-client]")].find((node) => node.closest("li").textContent.includes("当前设备"))?.dataset.sessionClient');
    assert.ok(typeof currentId === 'string' && currentId.length > 0, '当前会话标识可读');
    await activate('#chdsh-access-sessions-revoke-all');
    await waitFor('document.querySelector("dialog[open] #chdsh-access-sessions-revoke-all-confirm") !== null', '退出全部客户端确认出现');
    await activate('#chdsh-access-sessions-revoke-all-confirm');
    await waitFor('document.querySelector("dialog[open] #chdsh-access-reauth-form") !== null', '退出全部客户端需要再次认证');
    await typeInto('#chdsh-access-reauth-credential', PASSWORD);
    await activate('#chdsh-access-reauth-submit');
    await waitFor('document.getElementById("chdsh-access-password") !== null', '撤销全部会话后回到登录页');
    assert.ok(service.store.sessionById(currentId).revokedAt > 0);

    // 13. 双因素：输入格式与时间片提示，切换到恢复码完成登录。
    await typeInto('#chdsh-access-password', PASSWORD);
    await cli('press', 'Enter');
    await waitFor('document.getElementById("chdsh-access-factor") !== null', '第二因素步骤出现');
    assert.equal(await evaluate('document.getElementById("chdsh-access-factor").autocomplete'), 'one-time-code');
    assert.match(await evaluate('document.getElementById("chdsh-access-factor").getAttribute("aria-describedby")'), /chdsh-access-factor-help/);
    assert.match(await evaluate('document.getElementById("chdsh-access-factor-help").textContent'), /30 秒/);
    assert.match(await evaluate('document.querySelector("[data-access-time-step]").textContent'), /当前时间片还剩 \d+ 秒/);
    await activate('#chdsh-access-use-recovery');
    await waitFor('document.getElementById("chdsh-access-recovery-code") !== null', '恢复码输入出现');
    assert.equal(await evaluate('document.getElementById("chdsh-access-recovery-code").autocomplete'), 'off');
    await typeInto('#chdsh-access-recovery-code', recoveryCodes[3]);
    await activate('#chdsh-access-recovery-submit');
    await waitFor('document.getElementById("chdsh-access-sessions-refresh") !== null', '恢复码登录成功进入访问区段');
    await waitFor('/剩余 \\d+ 条未使用/.test(document.getElementById("root").textContent)', '剩余恢复码条数刷新');
    assert.match(await evaluate('document.querySelector("[data-recovery-remaining]").textContent'), /剩余 9 条未使用/);

    // 14. 退出当前设备：错误验证码被拒绝，票据消费后界面回到密码步骤；重复使用的恢复码被拒绝并标记已使用。
    const currentIdAgain = await evaluate('[...document.querySelectorAll("[data-session-client]")].find((node) => node.closest("li").textContent.includes("当前设备"))?.dataset.sessionClient');
    await activate(`#chdsh-access-session-revoke-${currentIdAgain}`);
    await waitFor('document.querySelector("dialog[open] #chdsh-access-session-revoke-confirm") !== null', '退出当前设备确认出现');
    await activate('#chdsh-access-session-revoke-confirm');
    await waitFor('document.getElementById("chdsh-access-password") !== null', '退出当前设备后回到登录页');
    await typeInto('#chdsh-access-password', PASSWORD);
    await cli('press', 'Enter');
    await waitFor('document.getElementById("chdsh-access-factor") !== null', '第二因素步骤出现');
    await typeInto('#chdsh-access-factor', wrongTotpCode(totpSecret));
    await cli('press', 'Enter');
    await waitFor('/验证码不正确/.test(document.getElementById("chdsh-access-error-summary").textContent)', '错误验证码被拒绝');
    await activate('#chdsh-access-use-recovery');
    await typeInto('#chdsh-access-recovery-code', recoveryCodes[3]);
    await activate('#chdsh-access-recovery-submit');
    await waitFor('document.getElementById("chdsh-access-password") !== null', '票据过期后回到密码步骤');
    assert.match(await evaluate('document.getElementById("chdsh-access-error-summary").textContent'), /第二因素票据已经过期/);
    await typeInto('#chdsh-access-password', PASSWORD);
    await cli('press', 'Enter');
    await waitFor('document.getElementById("chdsh-access-use-recovery") !== null', '第二因素步骤再次出现');
    await activate('#chdsh-access-use-recovery');
    await typeInto('#chdsh-access-recovery-code', recoveryCodes[3]);
    await activate('#chdsh-access-recovery-submit');
    await waitFor('/该恢复码已经使用过/.test(document.getElementById("root").textContent)', '重复使用的恢复码被拒绝');
    assert.match(await evaluate('document.querySelector("[data-access-used-recovery]").textContent'), /已使用/);

    // 15. 验证码登录成功，返回目标只接受同源相对路径。
    await typeInto('#chdsh-access-recovery-code', recoveryCodes[4]);
    await activate('#chdsh-access-recovery-submit');
    await waitFor('document.getElementById("chdsh-access-password") !== null', '票据过期后回到密码步骤');
    await typeInto('#chdsh-access-password', PASSWORD);
    await cli('press', 'Enter');
    await waitFor('document.getElementById("chdsh-access-use-totp") !== null', '第二因素步骤再次出现');
    await activate('#chdsh-access-use-totp');
    const loginCode = nextTotpCode(totpSecret);
    await typeInto('#chdsh-access-factor', loginCode.code);
    await cli('press', 'Enter');
    await waitFor('document.getElementById("chdsh-access-sessions-refresh") !== null', '验证码登录成功');
    await cli('open', `${page.origin}/chatdsh/access?next=${encodeURIComponent('https://evil.example/steal')}`);
    await waitFor('document.querySelector("[data-access-signed-in]") !== null', '已登录状态直接显示');
    assert.equal(await evaluate('document.getElementById("chdsh-access-return") === null'), true, '绝对地址不能成为返回目标');
    await cli('open', pageUrl);
    await waitFor('document.querySelector("[data-access-signed-in]") !== null', '安全返回目标显示');
    assert.equal(await evaluate('document.getElementById("chdsh-access-return").getAttribute("href")'), '/workspace/chat?session=abc');

    // 16. 持久存储、页面错误与遥测内容边界。
    assert.equal(await evaluate('Object.keys(localStorage).length'), 0, '整个流程不得写入 localStorage');
    assert.equal(await evaluate('Object.keys(sessionStorage).length'), 0, '整个流程不得写入 sessionStorage');
    assert.deepEqual(await evaluate('window.__wp26Errors'), []);
    const serializedTelemetry = JSON.stringify(service.telemetryBatches);
    for (const secret of [PASSWORD, totpSecret, ...recoveryCodes, ...service.issuedCookies]) {
      assert.equal(serializedTelemetry.includes(secret), false, '遥测里不得出现密码、密钥、恢复码或会话令牌');
    }
    assert.equal(serializedTelemetry.includes('otpauth://'), false, '遥测里不得出现绑定地址');
    const actions = [];
    const attributeKeys = new Set();
    for (const batch of service.telemetryBatches) {
      for (const resource of batch.resourceLogs ?? []) {
        for (const scope of resource.scopeLogs ?? []) {
          for (const record of scope.logRecords ?? []) {
            const attributes = Object.fromEntries((record.attributes ?? []).map((entry) => [entry.key, entry.value?.stringValue]));
            for (const key of Object.keys(attributes)) attributeKeys.add(key);
            if (record.body?.stringValue !== 'chatdsh.client.ui.action') continue;
            actions.push(`${attributes.action}:${attributes.outcome}`);
          }
        }
      }
    }
    for (const expected of [
      'access-status:ok',
      'access-signin:ok',
      'access-signin:failed',
      'access-second-factor:ok',
      'access-second-factor:failed',
      'access-totp-enroll:ok',
      'access-totp-confirm:ok',
      'access-recovery-generate:ok',
      'access-recovery-saved:ok',
      'access-sessions:ok',
      'access-session-revoke:ok',
      'access-sessions-revoke-all:ok',
      'access-reauth:ok',
    ]) {
      assert.ok(actions.includes(expected), `缺少动作遥测 ${expected}，实际 ${actions.join('、')}`);
    }
    for (const key of attributeKeys) {
      assert.ok(['action', 'outcome', 'error.type', 'error.code', 'rpc.method'].includes(key), `遥测出现未登记属性：${key}`);
    }
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    await page.close();
    await service.close();
  }
});
