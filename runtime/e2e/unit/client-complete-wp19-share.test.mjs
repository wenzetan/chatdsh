// WP19 分享宿主的验收测试：真实 SQLite、真实 HTTP 服务与独立数据根。
//
// 覆盖完整回合范围、服务端强制的内容过滤、附件逐项授权、公开页、快照固定性与空间统计。
// 路由函数由测试装配在自己的 HTTP 服务上，控制公共入口的挂载属于发行集成。
//
// 运行：node --test e2e/unit/client-complete-wp19-share.test.mjs

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { ShareRepository } from '../../gateway/lib/sharing/repository.js';
import { ShareService } from '../../gateway/lib/sharing/service.js';
import { createShareHttpHandler } from '../../gateway/lib/sharing/http.js';
import { createDirectoryAttachmentSource } from '../../gateway/lib/sharing/attachments.js';

/** 记录信号的遥测出口；其余路径全部走真实实现。 */
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

const PUBLIC_TEXT = '第 1 回合的回复';
const PRIVATE_MEMORY = '记忆内容不应出现';
const PRIVATE_REASONING = '思考过程不应出现';
const PRIVATE_TOOL_OUTPUT = '工具输出原文不应出现';
const PRIVATE_TOOL_ARGS = '工具参数原文不应出现';
const PRIVATE_PATH = '/workspace/chatdsh/runtime';
const PRIVATE_CREDENTIAL = ['sk', 'example', '0123456789abcdef'].join('-');

/** 写入一个真实会话副本：三个完整回合。 */
function seedSession(replica) {
  const events = [];
  let seq = 0;
  const push = (kind, payload) => {
    events.push({ seq, kind, time: 1_700_000_000_000 + seq, bytes: 128, payload });
    seq += 1;
    return seq - 1;
  };
  push('session/title', { data: { title: '排障记录' } });
  push('turn/start', { data: { turn: 1 } });
  push('step/start', { data: { turn: 1, step: 1 } });
  const userSeq = push('user/message', {
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: `把 ${PRIVATE_PATH} 里的失败日志整理一下，token=${PRIVATE_CREDENTIAL}` }],
    },
  });
  push('assistant/message', {
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: PUBLIC_TEXT }],
        source: { kind: 'model', provider: 'local', model: 'demo' },
      },
      stream: [{ type: 'reasoning', text: PRIVATE_REASONING }],
    },
  });
  push('assistant/reasoning', { data: { text: PRIVATE_REASONING } });
  push('tool/call', { data: { name: 'shell', arguments: { command: PRIVATE_TOOL_ARGS }, callId: 'call-1' } });
  push('tool/result', { data: { callId: 'call-1', output: PRIVATE_TOOL_OUTPUT } });
  push('user/message', {
    data: {
      role: 'user',
      source: { kind: 'memory-recall' },
      content: [{ type: 'text', text: PRIVATE_MEMORY }],
    },
  });
  push('step/end', { data: { turn: 1, step: 1 } });
  push('turn/end', { data: { turn: 1, reason: { kind: 'completed' } } });
  push('turn/start', { data: { turn: 2 } });
  const turnTwoStart = seq;
  push('user/message', {
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第 2 回合的提问' }] },
  });
  push('assistant/message', {
    data: { message: { content: [{ type: 'text', text: '第 2 回合的回复' }] } },
  });
  push('turn/end', { data: { turn: 2, reason: { kind: 'completed' } } });
  push('turn/start', { data: { turn: 3 } });
  push('user/message', {
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第 3 回合的提问' }] },
  });
  push('assistant/message', {
    data: { message: { content: [{ type: 'text', text: '第 3 回合的回复' }] } },
  });
  push('turn/end', { data: { turn: 3, reason: { kind: 'completed' } } });
  replica.append('session-alpha', events);
  return { userSeq, turnTwoStart };
}

/** 起一个装配了真实存储、真实 HTTP 与真实文件系统的分享服务。 */
async function start() {
  const home = allocateIndependentHome('wp19-share');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const repository = new ShareRepository(store.handle());
  const sharesRoot = join(home, 'shares');
  const attachmentsRoot = join(home, 'attachments');
  const attachmentBytes = Buffer.from('公开附件的内容\n第二行\n', 'utf8');
  await mkdir(join(attachmentsRoot, 'attach-public'), { recursive: true });
  await mkdir(join(attachmentsRoot, 'attach-private'), { recursive: true });
  await writeFile(join(attachmentsRoot, 'attach-public', '排障报告.txt'), attachmentBytes);
  await writeFile(join(attachmentsRoot, 'attach-private', '不能公开.txt'), '私有附件的内容');
  const seed = seedSession(replica);
  const telemetry = new RecordingTelemetry();
  const service = new ShareService({
    repository,
    replica,
    attachments: createDirectoryAttachmentSource({ root: attachmentsRoot }),
    telemetry,
    sharesRoot,
  });
  const accessToken = randomBytes(24).toString('hex');
  const csrfToken = randomBytes(24).toString('hex');
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
    seed,
    attachmentBytes,
    attachmentsRoot,
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
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      store.close();
      releaseIndependentHome(home);
    },
  };
}

/** 去掉写动作的 CSRF 请求头，用来验证缺少它时被拒绝。 */
function ownerHeaders(app) {
  const base = { ...app.headers };
  delete base['x-chatdsh-csrf'];
  return base;
}

const SCOPE = { includeUserText: true, includeAssistantText: true, attachmentIds: [] };

test('预览与建立覆盖完整回合、默认过滤与附件逐项授权', async () => {
  const app = await start();
  try {
    const preview = await app.preview({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 2 },
      scope: { ...SCOPE, attachmentIds: ['attach-public', 'attach-private'] },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.scope.turnFrom, 1);
    assert.equal(preview.body.scope.turnTo, 2);
    assert.equal(preview.body.messageCount, 6);
    assert.ok(preview.body.scope.eventCount > 0);
    assert.ok(preview.body.scope.charCount > 0);
    assert.deepEqual(preview.body.turns, [1, 2]);
    assert.deepEqual(preview.body.attachments, [
      { id: 'attach-public', filename: '排障报告.txt', downloadable: true },
      { id: 'attach-private', filename: '不能公开.txt', downloadable: true },
    ]);
    assert.deepEqual(preview.body.excluded, [
      'memory-recall',
      'tool-arguments',
      'internal-paths',
      'sensitive-metadata',
      'replica-watermark',
    ]);
    assert.ok(preview.body.redactions.paths >= 1);
    assert.ok(preview.body.redactions.credentials >= 1);
    assert.equal(preview.body.title, '排障记录');
    const previewText = JSON.stringify(preview.body);
    for (const key of ['"seq"', '"upToSeq"', '"boundSeq"', '"ordinal"', '"watermark":']) {
      assert.ok(!previewText.includes(key), `预览响应里出现了 ${key}`);
    }

    const created = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 2 },
      scope: { ...SCOPE, attachmentIds: ['attach-public'] },
      ttlMs: 3_600_000,
      operationId: 'op-preview-create',
      requestDigest: 'a'.repeat(64),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.status, 'active');
    assert.equal(created.body.title, '排障记录');
    assert.match(created.body.path, /^\/s\/[A-Za-z0-9_-]+$/);
    assert.equal(created.body.attachments.length, 1);
    assert.equal(created.body.attachments[0].id, 'attach-public');
    assert.ok(created.body.bytes > 0);
    assert.ok(created.body.expiresAt > created.body.createdAt);
    const createdText = JSON.stringify(created.body);
    for (const key of ['"seq"', '"upToSeq"', '"boundSeq"', '"ordinal"', '"watermark":']) {
      assert.ok(!createdText.includes(key), `建立响应里出现了 ${key}`);
    }

    const page = await app.page(created.body.path);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/u);
    assert.match(csp, /script-src 'none'/u);
    assert.match(csp, /form-action 'none'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.doesNotMatch(page.html, /<script/iu);
    assert.doesNotMatch(page.html, /<form/iu);
    assert.doesNotMatch(page.html, /src=["']https?:/iu);
    assert.doesNotMatch(page.html, /#\d+ ·/u);
    assert.ok(page.html.includes('排障记录'));
    assert.ok(page.html.includes(PUBLIC_TEXT));
    assert.ok(page.html.includes('第 2 回合的回复'));
    assert.ok(page.html.includes('回合 1–2'));
    assert.ok(page.html.includes('[路径已隐藏]'));
    assert.ok(page.html.includes('[凭据已隐藏]'));
    assert.ok(page.html.includes('工具调用：shell'));
    for (const secret of [
      PRIVATE_MEMORY,
      PRIVATE_REASONING,
      PRIVATE_TOOL_OUTPUT,
      PRIVATE_TOOL_ARGS,
      PRIVATE_PATH,
      PRIVATE_CREDENTIAL,
      'session-alpha',
      'call-1',
    ]) {
      assert.ok(!page.html.includes(secret), `公开页里出现了 ${secret}`);
    }

    const printView = await app.page(`${created.body.path}?print=1`);
    assert.equal(printView.status, 200);
    assert.ok(printView.html.includes('打印样式已应用'));

    const attachmentUrl = `${app.origin}${created.body.path}/attachments/attach-public`;
    assert.ok(page.html.includes(`${created.body.path}/attachments/attach-public`));
    const downloaded = await fetch(attachmentUrl);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(downloaded.headers.get('content-disposition') ?? '', /^attachment;/u);
    assert.ok((downloaded.headers.get('content-disposition') ?? '').includes(`filename*=UTF-8''${encodeURIComponent('排障报告.txt')}`));
    assert.match(downloaded.headers.get('content-security-policy') ?? '', /sandbox/u);
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(Buffer.compare(bytes, app.attachmentBytes), 0);

    const privateAttachment = await fetch(`${app.origin}${created.body.path}/attachments/attach-private`);
    assert.equal(privateAttachment.status, 404);
    assert.ok(!(await privateAttachment.text()).includes('不能公开.txt'));
    const guessed = await fetch(`${app.origin}${created.body.path}/attachments/..%2F..%2Fgateway.sqlite`);
    assert.equal(guessed.status, 404);
  } finally {
    await app.close();
  }
});

test('快照固定、范围边界不切断回合、指定回合集合与旧上界', async () => {
  const app = await start();
  try {
    const created = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 2 },
      scope: SCOPE,
      ttlMs: 3_600_000,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const before = await app.page(created.body.path);
    assert.equal(before.status, 200);

    app.replica.append('session-alpha', [
      { seq: 100, kind: 'turn/start', time: 1_700_000_100_000, bytes: 32, payload: { data: { turn: 4 } } },
      {
        seq: 101,
        kind: 'user/message',
        time: 1_700_000_100_001,
        bytes: 32,
        payload: { data: { role: 'user', content: [{ type: 'text', text: '快照之后的新提问' }] } },
      },
      {
        seq: 102,
        kind: 'assistant/message',
        time: 1_700_000_100_002,
        bytes: 32,
        payload: { data: { message: { content: [{ type: 'text', text: '快照之后的新回复' }] } } },
      },
      { seq: 103, kind: 'turn/end', time: 1_700_000_100_003, bytes: 32, payload: { data: { turn: 4 } } },
    ]);
    const after = await app.page(created.body.path);
    assert.equal(after.status, 200);
    assert.equal(after.html, before.html, '源会话追加内容改变了已发布快照');
    assert.ok(!after.html.includes('快照之后的新回复'));

    const midTurn = await app.create({
      sessionId: 'session-alpha',
      upToSeq: app.seed.turnTwoStart + 1,
      scope: SCOPE,
    });
    assert.equal(midTurn.status, 200, JSON.stringify(midTurn.body));
    const midPage = await app.page(midTurn.body.path);
    assert.equal(midPage.status, 200);
    assert.ok(midPage.html.includes('第 2 回合的回复'), '上界落在回合中间时切断了回合');
    assert.ok(!midPage.html.includes('第 3 回合的回复'));
    assert.ok(midPage.html.includes('回合 1–2'));

    const selected = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'turns', turns: [1, 3] },
      scope: SCOPE,
    });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    const selectedPage = await app.page(selected.body.path);
    assert.ok(selectedPage.html.includes(PUBLIC_TEXT));
    assert.ok(selectedPage.html.includes('第 3 回合的回复'));
    assert.ok(!selectedPage.html.includes('第 2 回合的回复'));
    assert.ok(selectedPage.html.includes('回合 1、3'));

    const whole = await app.create({ sessionId: 'session-alpha', range: { mode: 'session' }, scope: SCOPE });
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    const wholePage = await app.page(whole.body.path);
    assert.ok(wholePage.html.includes('第 3 回合的回复'));
    assert.ok(wholePage.html.includes('快照之后的新回复'));

    const unknownTurn = await app.preview({
      sessionId: 'session-alpha',
      range: { mode: 'turns', turns: [9] },
      scope: SCOPE,
    });
    assert.equal(unknownTurn.status, 400);
    assert.equal(unknownTurn.body.error, 'request-invalid');
    assert.equal(unknownTurn.body.reason, 'turn-unknown');
    const missingSession = await app.preview({ sessionId: 'session-missing', range: { mode: 'session' }, scope: SCOPE });
    assert.equal(missingSession.status, 404);
    assert.equal(missingSession.body.error, 'session-not-found');

    app.replica.append('session-plain', [
      {
        seq: 0,
        kind: 'user/message',
        time: 1_700_000_200_000,
        bytes: 8,
        payload: { data: { role: 'user', content: [{ type: 'text', text: '没有回合边界的历史提问' }] } },
      },
      {
        seq: 1,
        kind: 'assistant/message',
        time: 1_700_000_200_001,
        bytes: 8,
        payload: { data: { message: { content: [{ type: 'text', text: '没有回合边界的历史回复' }] } } },
      },
    ]);
    const plain = await app.preview({ sessionId: 'session-plain', range: { mode: 'session' }, scope: SCOPE });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.messageCount, 2);
    assert.deepEqual(plain.body.turns, [1]);
  } finally {
    await app.close();
  }
});

test('过滤规则由服务端强制，客户端字段无法关闭；附件副本自包含', async () => {
  const app = await start();
  try {
    const created = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 1 },
      scope: {
        includeUserText: true,
        includeAssistantText: true,
        attachmentIds: ['attach-public'],
        excluded: [],
      },
      filter: 'none',
      includeTools: true,
      includeReasoning: true,
      includeMemory: true,
      redact: false,
      ttlMs: 3_600_000,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const page = await app.page(created.body.path);
    for (const secret of [
      PRIVATE_MEMORY,
      PRIVATE_REASONING,
      PRIVATE_TOOL_OUTPUT,
      PRIVATE_TOOL_ARGS,
      PRIVATE_PATH,
      PRIVATE_CREDENTIAL,
    ]) {
      assert.ok(!page.html.includes(secret), `关闭过滤的请求字段生效了：${secret}`);
    }
    assert.ok(page.html.includes('[路径已隐藏]'));
    assert.ok(page.html.includes('[凭据已隐藏]'));

    await rm(join(app.attachmentsRoot, 'attach-public'), { recursive: true, force: true });
    const downloaded = await fetch(`${app.origin}${created.body.path}/attachments/attach-public`);
    assert.equal(downloaded.status, 200, '附件副本没有随分享包保存');
    assert.equal(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), app.attachmentBytes), 0);

    const noAttachment = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 2 },
      scope: SCOPE,
      ttlMs: 3_600_000,
    });
    assert.equal(noAttachment.status, 200);
    const noAttachmentPage = await app.page(noAttachment.body.path);
    assert.ok(!noAttachmentPage.html.includes('可分享附件'));
    const guessed = await fetch(`${app.origin}${noAttachment.body.path}/attachments/attach-public`);
    assert.equal(guessed.status, 404);

    const missingAttachment = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 2 },
      scope: { ...SCOPE, attachmentIds: ['attach-missing'] },
    });
    assert.equal(missingAttachment.status, 409);
    assert.equal(missingAttachment.body.error, 'attachment-missing');
  } finally {
    await app.close();
  }
});

test('有效期、空间统计与列表不出现内部序号', async () => {
  const app = await start();
  try {
    const first = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 2 },
      scope: { ...SCOPE, attachmentIds: ['attach-public'] },
      ttlMs: 3_600_000,
    });
    const second = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 2, turnTo: 3 },
      scope: SCOPE,
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.expiresAt, undefined);

    const listResponse = await fetch(`${app.origin}/chatdsh/gateway/shares`, { headers: app.headers });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.shares.length, 2);
    const sum = list.shares.reduce((total, share) => total + share.bytes, 0);
    assert.equal(list.totalBytes, sum);
    assert.ok(first.body.bytes <= list.totalBytes);
    for (const share of list.shares) {
      assert.ok(share.bytes > 0);
      assert.deepEqual(Object.keys(share).filter((key) => /seq|watermark/i.test(key)), []);
      assert.equal(share.status, 'active');
      assert.match(share.path, /^\/s\//u);
      assert.equal(share.visits, 0);
    }
    const listText = JSON.stringify(list);
    for (const key of ['"upToSeq"', '"boundSeq"', '"watermark":', '"seq"']) {
      assert.ok(!listText.includes(key), `列表响应里出现了 ${key}`);
    }

    await app.page(first.body.path);
    await app.page(first.body.path);
    const refreshed = await (await fetch(`${app.origin}/chatdsh/gateway/shares`, { headers: app.headers })).json();
    const visits = refreshed.shares.find((share) => share.shareId === first.body.shareId)?.visits;
    assert.equal(visits, 2);

    const expired = await app.create({
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 1 },
      scope: SCOPE,
      ttlMs: 1,
    });
    assert.equal(expired.status, 200);
    assert.equal(expired.body.status, 'active');
    await delay(10);
    const page = await app.page(expired.body.path);
    assert.equal(page.status, 410);
    assert.ok(!page.html.includes('session-alpha'));
    assert.ok(!page.html.includes('排障记录'));
    assert.ok(page.html.includes('链接已失效'));
    const expiredList = await (await fetch(`${app.origin}/chatdsh/gateway/shares`, { headers: app.headers })).json();
    const expiredRecord = expiredList.shares.find((share) => share.shareId === expired.body.shareId);
    assert.equal(expiredRecord.status, 'expired');
    assert.equal(expiredRecord.path, undefined);
  } finally {
    await app.close();
  }
});

test('管理接口要求身份校验与写动作的请求头', async () => {
  const app = await start();
  try {
    const anonymous = await fetch(`${app.origin}/chatdsh/gateway/shares`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'auth-required');
    const noCsrf = await fetch(`${app.origin}/chatdsh/gateway/share`, {
      method: 'POST',
      headers: ownerHeaders(app),
      body: JSON.stringify({ sessionId: 'session-alpha', scope: SCOPE }),
    });
    assert.equal(noCsrf.status, 401);
    const crossOrigin = await fetch(`${app.origin}/chatdsh/gateway/share`, {
      method: 'POST',
      headers: { ...app.headers, origin: 'https://attacker.invalid' },
      body: JSON.stringify({ sessionId: 'session-alpha', scope: SCOPE }),
    });
    assert.equal(crossOrigin.status, 401);
    const invalidJson = await fetch(`${app.origin}/chatdsh/gateway/share`, {
      method: 'POST',
      headers: app.headers,
      body: '{',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).reason, 'body-json');
    const bothTextsOff = await app.create({
      sessionId: 'session-alpha',
      scope: { includeUserText: false, includeAssistantText: false, attachmentIds: [] },
    });
    assert.equal(bothTextsOff.status, 400);
    assert.equal(bothTextsOff.body.reason, 'text-selection');
    const unknownPath = await fetch(`${app.origin}/chatdsh/gateway/unknown`);
    assert.equal(unknownPath.status, 404);
  } finally {
    await app.close();
  }
});

test('建立分享按操作标识幂等，摘要不一致时拒绝', async () => {
  const app = await start();
  try {
    const body = {
      sessionId: 'session-alpha',
      range: { mode: 'range', turnFrom: 1, turnTo: 2 },
      scope: SCOPE,
      operationId: 'op-idempotent',
      requestDigest: 'b'.repeat(64),
    };
    const first = await app.create(body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await app.create(body);
    assert.equal(second.status, 200);
    assert.equal(second.body.shareId, first.body.shareId);
    const list = await (await fetch(`${app.origin}/chatdsh/gateway/shares`, { headers: app.headers })).json();
    assert.equal(list.shares.length, 1);
    const conflicting = await app.create({ ...body, requestDigest: 'c'.repeat(64) });
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.body.error, 'operation-digest-mismatch');
    assert.equal(app.repository.list().length, 1);
    const stored = await readFile(join(app.home, 'shares', first.body.shareId, 'attachments', 'attach-public')).catch(() => undefined);
    assert.equal(stored, undefined, '未选择附件时不应写入附件副本');
  } finally {
    await app.close();
  }
});
