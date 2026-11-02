// WP19 分享宿主的生命周期与遥测验收：真实 SQLite、真实 HTTP 服务与独立数据根。
//
// 覆盖撤销立即失效、过期与未知令牌的响应、旧渲染入口的过滤、动作 span、失败事件与计数
// 指标，以及遥测声明与源码一致。路由函数由测试装配在自己的 HTTP 服务上。
//
// 运行：node --test e2e/unit/client-complete-wp19-lifecycle.test.mjs

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { ShareRepository } from '../../gateway/lib/sharing/repository.js';
import { ShareService, SHARE_METRICS, SHARE_SPANS } from '../../gateway/lib/sharing/service.js';
import { createShareHttpHandler } from '../../gateway/lib/sharing/http.js';
import { createDirectoryAttachmentSource } from '../../gateway/lib/sharing/attachments.js';
import { renderSharePage, renderShareUnavailablePage } from '../../gateway/lib/render.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PRIVATE = '私密工具输出原文';
const PATH_TEXT = '/workspace/chatdsh/runtime';
const SECRET = ['sk', 'lifecycle', '0123456789abcdef'].join('-');

/** 记录信号的遥测出口。 */
class RecordingTelemetry {
  constructor() {
    this.events = [];
    this.counters = [];
    this.spans = [];
  }

  get enabled() {
    return true;
  }

  get reason() {
    return undefined;
  }

  event(name, attributes = {}) {
    this.events.push({ name, attributes });
  }

  log(level, message, attributes = {}) {
    this.events.push({ name: message, level, attributes });
  }

  counter(name, options) {
    return { add: (delta, attributes = {}) => this.counters.push({ name, delta, attributes, options }) };
  }

  histogram() {
    return { record: () => {} };
  }

  gauge() {
    return { record: () => {} };
  }

  startSpan(name, attributes = {}) {
    const record = { name, attributes: { ...attributes }, ended: false };
    this.spans.push(record);
    return {
      setAttribute: (key, value) => { record.attributes[key] = value; },
      setAttributes: (extra) => { Object.assign(record.attributes, extra); },
      recordException: () => {},
      end: () => { record.ended = true; },
    };
  }

  runSpanSync(name, attributes, fn) {
    const span = this.startSpan(name, attributes);
    try {
      return fn(span);
    } finally {
      span.end();
    }
  }

  async runSpan(name, attributes, fn) {
    const span = this.startSpan(name, attributes);
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  }

  inject(carrier) {
    return carrier;
  }

  extract() {
    return {};
  }

  withContext(_carrier, fn) {
    return fn();
  }

  currentTraceId() {
    return undefined;
  }

  async flush() {}

  async shutdown() {}
}

/** 写入一个真实会话副本：两个完整回合。 */
function seedSession(replica) {
  const events = [];
  let seq = 0;
  const push = (kind, payload) => {
    events.push({ seq, kind, time: 1_700_000_000_000 + seq, bytes: 64, payload });
    seq += 1;
  };
  push('session/title', { data: { title: '生命周期记录' } });
  push('turn/start', { data: { turn: 1 } });
  push('user/message', {
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: `先看 ${PATH_TEXT}，密钥 ${SECRET}` }],
    },
  });
  push('assistant/message', { data: { message: { content: [{ type: 'text', text: '第一回合回复' }] } } });
  push('tool/result', { data: { output: PRIVATE } });
  push('turn/end', { data: { turn: 1 } });
  push('turn/start', { data: { turn: 2 } });
  push('user/message', {
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二回合提问' }] },
  });
  push('assistant/message', { data: { message: { content: [{ type: 'text', text: '第二回合回复' }] } } });
  push('turn/end', { data: { turn: 2 } });
  replica.append('session-alpha', events);
}

/** 起一个装配了真实存储、真实 HTTP 与真实文件系统的分享服务。 */
async function start() {
  const home = allocateIndependentHome('wp19-lifecycle');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const repository = new ShareRepository(store.handle());
  const sharesRoot = join(home, 'shares');
  const attachmentsRoot = join(home, 'attachments');
  const attachmentBytes = Buffer.from('附件内容', 'utf8');
  await mkdir(join(attachmentsRoot, 'attach-one'), { recursive: true });
  await writeFile(join(attachmentsRoot, 'attach-one', '记录.txt'), attachmentBytes);
  seedSession(replica);
  const telemetry = new RecordingTelemetry();
  const service = new ShareService({
    repository,
    replica,
    attachments: createDirectoryAttachmentSource({ root: attachmentsRoot }),
    telemetry,
    sharesRoot,
  });
  const accessToken = randomBytes(20).toString('hex');
  const csrfToken = randomBytes(20).toString('hex');
  let origin = '';
  const handler = createShareHttpHandler({
    service,
    telemetry,
    authorize(request, action) {
      if (request.headers.authorization !== `Bearer ${accessToken}`) return undefined;
      const requestOrigin = request.headers.origin;
      if (typeof requestOrigin === 'string' && requestOrigin !== origin) return undefined;
      if (action === 'write' && request.headers['x-chatdsh-csrf'] !== csrfToken) return undefined;
      return { deviceId: 'owner-device' };
    },
  });
  const server = createServer(async (request, response) => {
    if (await handler(request, response)) return;
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not-found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'x-chatdsh-csrf': csrfToken,
    'content-type': 'application/json',
  };
  return {
    home,
    origin,
    headers,
    replica,
    repository,
    telemetry,
    attachmentBytes,
    async create(body) {
      const response = await fetch(`${origin}/chatdsh/gateway/share`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async preview(body) {
      const response = await fetch(`${origin}/chatdsh/gateway/share/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async page(path) {
      const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } });
      return { status: response.status, headers: response.headers, html: await response.text() };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
      store.close();
      releaseIndependentHome(home);
    },
  };
}

const SCOPE = { includeUserText: true, includeAssistantText: true, attachmentIds: [] };

test('撤销立即失效，未知令牌不泄露源会话，反复撤销幂等', async () => {
  const app = await start();
  try {
    const created = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'session' },
      scope: { ...SCOPE, attachmentIds: ['attach-one'] },
      ttlMs: 3_600_000,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const active = await app.page(created.body.path);
    assert.equal(active.status, 200);
    const attachmentUrl = `${app.origin}${created.body.path}/attachments/attach-one`;
    assert.equal((await fetch(attachmentUrl)).status, 200);

    const revoked = await fetch(`${app.origin}/chatdsh/gateway/share?token=${encodeURIComponent(created.body.shareId)}`, {
      method: 'DELETE',
      headers: app.headers,
    });
    assert.equal(revoked.status, 200);
    const revokedBody = await revoked.json();
    assert.equal(revokedBody.revoked, true);
    assert.equal(revokedBody.status, 'revoked');

    const afterRevoke = await app.page(created.body.path);
    assert.equal(afterRevoke.status, 410);
    assert.match(afterRevoke.headers.get('content-security-policy') ?? '', /script-src 'none'/u);
    assert.ok(!afterRevoke.html.includes('session-alpha'));
    assert.ok(!afterRevoke.html.includes('生命周期记录'));
    assert.ok(afterRevoke.html.includes('链接已失效'));
    assert.equal((await fetch(attachmentUrl)).status, 404);

    const again = await fetch(`${app.origin}/chatdsh/gateway/share?token=${encodeURIComponent(created.body.shareId)}`, {
      method: 'DELETE',
      headers: app.headers,
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).revoked, true);

    const unknown = await fetch(`${app.origin}/chatdsh/gateway/share?token=${encodeURIComponent('z'.repeat(43))}`, {
      method: 'DELETE',
      headers: app.headers,
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { revoked: false, error: 'object-not-found' });

    const list = await (await fetch(`${app.origin}/chatdsh/gateway/shares`, { headers: app.headers })).json();
    const record = list.shares.find((share) => share.shareId === created.body.shareId);
    assert.equal(record.status, 'revoked');
    assert.equal(record.path, undefined);
    assert.equal(record.visits, 1);
  } finally {
    await app.close();
  }
});

test('未知令牌返回 404 且响应不带来源信息，过期返回 410', async () => {
  const app = await start();
  try {
    const unknown = await app.page(`/s/${randomBytes(32).toString('base64url')}`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get('content-security-policy') ?? '', /script-src 'none'/u);
    assert.ok(unknown.html.includes('链接不存在'));
    for (const secret of ['session-alpha', '生命周期记录', 'README', 'upToSeq']) {
      assert.ok(!unknown.html.includes(secret));
    }
    const malformed = await app.page('/s/%E0%A4%A');
    assert.equal(malformed.status, 404);
    const shortToken = await app.page('/s/abc');
    assert.equal(shortToken.status, 404);

    const expiring = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 1 },
      scope: SCOPE,
      ttlMs: 1,
    });
    assert.equal(expiring.status, 200);
    await delay(10);
    const expired = await app.page(expiring.body.path);
    assert.equal(expired.status, 410);
    assert.ok(!expired.html.includes('session-alpha'));
    const list = await (await fetch(`${app.origin}/chatdsh/gateway/shares`, { headers: app.headers })).json();
    assert.equal(list.shares.find((share) => share.shareId === expiring.body.shareId).status, 'expired');
  } finally {
    await app.close();
  }
});

test('旧渲染入口同样执行默认过滤，不显示序号与源会话', async () => {
  const app = await start();
  try {
    const events = app.replica.read('session-alpha', 50);
    const html = renderSharePage(
      {
        token: 'legacy-token-0123456789',
        sessionId: 'session-alpha',
        upToSeq: 50,
        createdAt: 1_700_000_000_000,
        visits: 0,
      },
      events,
    );
    assert.ok(html.includes('生命周期记录'));
    assert.ok(html.includes('第一回合回复'));
    assert.ok(html.includes('[路径已隐藏]'));
    assert.ok(html.includes('[凭据已隐藏]'));
    assert.ok(!html.includes(PRIVATE));
    assert.ok(!html.includes(PATH_TEXT));
    assert.ok(!html.includes(SECRET));
    assert.ok(!html.includes('session-alpha'));
    assert.ok(!html.includes('upToSeq'));
    assert.doesNotMatch(html, /#\d+ ·/u);
    assert.doesNotMatch(html, /<script/iu);
    const notFound = renderShareUnavailablePage(404);
    const gone = renderShareUnavailablePage(410);
    assert.ok(notFound.includes('链接不存在'));
    assert.ok(gone.includes('链接已失效'));
    assert.ok(!notFound.includes('session-alpha'));
    assert.ok(!gone.includes('session-alpha'));
  } finally {
    await app.close();
  }
});

test('动作 span、失败事件与计数指标覆盖建立、预览、列表、撤销、公开页与附件', async () => {
  const app = await start();
  try {
    await app.preview({ sessionId: 'session-alpha', range: { mode: 'session' }, scope: SCOPE });
    const created = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'session' },
      scope: { ...SCOPE, attachmentIds: ['attach-one'] },
      ttlMs: 3_600_000,
    });
    assert.equal(created.status, 200);
    await app.page(created.body.path);
    await fetch(`${app.origin}${created.body.path}/attachments/attach-one`);
    await fetch(`${app.origin}${created.body.path}/attachments/attach-two`);
    await fetch(`${app.origin}/chatdsh/gateway/shares`, { headers: app.headers });
    const badRange = await app.preview({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 3, turnTo: 9 },
      scope: SCOPE,
    });
    assert.equal(badRange.status, 400);
    const revoked = await fetch(`${app.origin}/chatdsh/gateway/share?token=${encodeURIComponent(created.body.shareId)}`, {
      method: 'DELETE',
      headers: app.headers,
    });
    assert.equal(revoked.status, 200);
    await app.page(created.body.path);
    await app.page(`/s/${randomBytes(32).toString('base64url')}`);

    const spanNames = new Set(app.telemetry.spans.map((span) => span.name));
    for (const name of Object.values(SHARE_SPANS)) {
      assert.ok(spanNames.has(name), `缺少 span ${name}`);
    }
    const metricNames = new Set(app.telemetry.counters.map((entry) => entry.name));
    for (const name of Object.values(SHARE_METRICS)) {
      assert.ok(metricNames.has(name), `缺少指标 ${name}`);
    }
    const outcomes = (metric) => app.telemetry.counters
      .filter((entry) => entry.name === metric)
      .map((entry) => entry.attributes.outcome);
    assert.ok(outcomes(SHARE_METRICS.previews).includes('ok'));
    assert.ok(outcomes(SHARE_METRICS.previews).includes('rejected'));
    assert.ok(outcomes(SHARE_METRICS.creations).includes('ok'));
    assert.ok(outcomes(SHARE_METRICS.listings).includes('ok'));
    assert.ok(outcomes(SHARE_METRICS.revocations).includes('ok'));
    assert.ok(outcomes(SHARE_METRICS.views).includes('ok'));
    assert.ok(outcomes(SHARE_METRICS.views).includes('revoked'));
    assert.ok(outcomes(SHARE_METRICS.views).includes('unknown'));
    assert.ok(outcomes(SHARE_METRICS.downloads).includes('ok'));
    assert.ok(outcomes(SHARE_METRICS.downloads).includes('denied'));

    const rejected = app.telemetry.events.filter((entry) => entry.name === 'chatdsh.gateway.share.rejected');
    assert.ok(rejected.length >= 4);
    for (const entry of rejected) {
      assert.equal(typeof entry.attributes['error.type'], 'string');
      assert.equal(typeof entry.attributes['error.code'], 'string');
      assert.equal(typeof entry.attributes.outcome, 'string');
      assert.equal(typeof entry.attributes.kind, 'string');
    }
    assert.ok(rejected.some((entry) => entry.attributes.outcome === 'rejected' && entry.attributes['error.code'] === 'request-invalid'));
    assert.ok(rejected.some((entry) => entry.attributes.outcome === 'revoked' && entry.attributes['error.code'] === 'share-unavailable'));
    assert.ok(rejected.some((entry) => entry.attributes.outcome === 'unknown'));
    assert.ok(rejected.some((entry) => entry.attributes.outcome === 'denied' && entry.attributes['error.code'] === 'permission-denied'));

    const allowed = new Set([
      'session.id',
      'turn',
      'step',
      'tool.name',
      'provider',
      'model',
      'request.id',
      'error.type',
      'error.code',
      'outcome',
      'count',
      'bytes',
      'kind',
      'reason',
      'action',
      'status',
      'mode',
      'role',
    ]);
    const seen = new Set();
    for (const span of app.telemetry.spans) {
      for (const key of Object.keys(span.attributes)) seen.add(key);
    }
    for (const entry of app.telemetry.counters) {
      for (const key of Object.keys(entry.attributes)) seen.add(key);
    }
    for (const entry of app.telemetry.events) {
      for (const key of Object.keys(entry.attributes)) seen.add(key);
    }
    for (const key of seen) assert.ok(allowed.has(key), `遥测里出现未登记属性键 ${key}`);

    const telemetryText = JSON.stringify({
      events: app.telemetry.events,
      counters: app.telemetry.counters,
      spans: app.telemetry.spans,
    });
    assert.ok(!telemetryText.includes(created.body.shareId), '遥测里出现了分享令牌');
    for (const secret of [PRIVATE, PATH_TEXT, SECRET, '生命周期记录', '第一回合回复']) {
      assert.ok(!telemetryText.includes(secret), `遥测里出现了内容原文：${secret}`);
    }
  } finally {
    await app.close();
  }
});

test('分享信号的包声明与源码使用一致', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'gateway', 'package.json'), 'utf8'));
  const declared = new Set([
    ...(manifest.chatdsh?.telemetry?.events ?? []),
    ...(manifest.chatdsh?.telemetry?.spans ?? []),
    ...(manifest.chatdsh?.telemetry?.metrics ?? []),
  ]);
  const sources = [];
  for (const directory of ['sharing']) {
    const path = join(ROOT, 'gateway', 'src', directory);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      sources.push(await readFile(join(path, entry.name), 'utf8'));
    }
  }
  sources.push(await readFile(join(ROOT, 'gateway', 'src', 'render.ts'), 'utf8'));
  const used = new Set();
  for (const text of sources) {
    for (const match of text.matchAll(/\bchatdsh\.[a-z0-9]+(?:\.[a-z0-9]+)+\b/gu)) used.add(match[0]);
    for (const match of text.matchAll(/\bchatdsh_[a-z0-9_]+\b/gu)) used.add(match[0]);
  }
  assert.ok(used.has('chatdsh.gateway.share.create'));
  assert.ok(used.has('chatdsh_gateway_share_views_total'));
  for (const name of used) {
    assert.ok(declared.has(name), `${name} 没有写进 gateway/package.json 的遥测声明`);
  }
  for (const name of Object.values(SHARE_SPANS)) assert.ok(declared.has(name));
  for (const name of Object.values(SHARE_METRICS)) assert.ok(declared.has(name));
});
