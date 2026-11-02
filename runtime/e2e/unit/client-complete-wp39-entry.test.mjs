// WP39 第一批集成验收：四条公共入口经真实控制平面进程与真实 HTTP 逐条打通。
//
// 控制平面用 `node gateway/lib/main.js` 单独启动，数据根、数据库、端口与对外地址都来自本次
// 运行的独立环境；设备是真实的 WebSocket 长连接，会话归属与副本经真实接口写入，分享、自动化
// 与导出的读写全部落在同一个 SQLite 数据库和真实目录里。
//
// 运行：node --test e2e/unit/client-complete-wp39-entry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
const GATEWAY_ENTRY = join(RUNTIME, 'gateway', 'lib', 'main.js');

/** 配对码与 webhook 密钥。 */
const PAIRING_CODE = 'wp39-entry-pair';
const HOOK_ENV = 'CHATDSH_WP39_HOOK';
const HOOK_SECRET = 'wp39-webhook-secret';

/** 会话标识与工作目录。 */
const SESSION_ID = 'wp39-session';
const CWD = '/workspace/chatdsh';

/** 自动化会话建立的提示词。 */
const AUTOMATION_PROMPT = '核对这一轮的公共入口集成结果';

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

/** 本次会话的副本事件：三个完整回合，文本里带可核对的中文。 */
function sessionEvents(base) {
  return [
    event(1, 'session/title', base, { title: 'WP39 公共入口' }),
    event(2, 'turn/start', base + 1_000, { turn: 1 }),
    event(3, 'user/message', base + 1_100, { content: [{ type: 'text', text: '第一回合的问题：四条入口都要通。' }] }),
    event(4, 'assistant/message', base + 1_200, { message: { content: [{ type: 'text', text: '第一回合的回答：客户端读取、分享、自动化与导出。' }] } }),
    event(5, 'turn/end', base + 1_300, { turn: 1, reason: { kind: 'completed' } }),
    event(6, 'turn/start', base + 2_000, { turn: 2 }),
    event(7, 'user/message', base + 2_100, { content: [{ type: 'text', text: '第二回合的问题：公开页要能打开打印视图。' }] }),
    event(8, 'assistant/message', base + 2_200, { message: { content: [{ type: 'text', text: '第二回合的回答：打印样式来自导出宿主的打印视图。' }] } }),
    event(9, 'turn/end', base + 2_300, { turn: 2, reason: { kind: 'completed' } }),
  ];
}

/**
 * 按版本 2 帧协议连上的设备：收到请求头立刻回应答头，请求体收齐之后回正文与结束帧。
 *
 * `open` 帧只带方法、路径与请求头，请求体随 `data` 帧到达，`end` 帧表示请求发送完毕。
 * 控制平面在收到 `accepted` 之后才发送请求体，因此应答头必须在 `open` 时先回。
 */
class LinkDevice {
  constructor(token, url, deviceId, respond) {
    this.requests = [];
    this.respond = respond;
    this.opened = new Map();
    this.chunks = new Map();
    this.socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.ready = new Promise((done, fail) => {
      this.socket.addEventListener('open', () => {
        this.send({ type: 'hello', version: 2, deviceId, generation: 0, platform: 'linux', role: 'both', capabilities: ['shell'] });
        done();
      });
      this.socket.addEventListener('error', () => fail(new Error('设备连接失败')));
      this.socket.addEventListener('message', ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.type === 'ping') this.send({ type: 'pong', generation: frame.generation, nonce: frame.nonce });
        if (frame.type === 'open') {
          this.opened.set(frame.channelId, frame);
          this.chunks.set(frame.channelId, []);
          this.send({ type: 'accepted', channelId: frame.channelId, generation: frame.generation, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
        }
        if (frame.type === 'data') {
          this.chunks.get(frame.channelId)?.push(Buffer.from(frame.payload, 'base64'));
        }
        if (frame.type === 'end') {
          const opening = this.opened.get(frame.channelId);
          const body = Buffer.concat(this.chunks.get(frame.channelId) ?? []).toString('utf8');
          const request = { method: opening.method, path: opening.path, headers: opening.headers, body };
          this.requests.push(request);
          this.reply(opening, this.respond(request));
        }
      });
    });
  }

  send(frame) {
    this.socket.send(JSON.stringify(frame));
  }

  /** 回填应答正文与结束帧。 */
  reply(opening, { body = {} } = {}) {
    const text = JSON.stringify(body);
    this.send({ type: 'data', channelId: opening.channelId, generation: opening.generation, seq: 0, payloadLength: Buffer.byteLength(text), payload: Buffer.from(text, 'utf8').toString('base64') });
    this.send({ type: 'end', channelId: opening.channelId, generation: opening.generation, lastSeq: 0 });
  }

  close() {
    this.socket.close();
  }
}

test('真实控制平面进程：客户端读取、分享与打印、自动化与投递、导出与下载', { timeout: 180_000 }, async (t) => {
  const home = allocateIndependentHome('wp39-entry');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [GATEWAY_ENTRY], {
    env: {
      ...process.env,
      DSH_HOME: home,
      CHATDSH_GATEWAY_HOST: '127.0.0.1',
      CHATDSH_GATEWAY_PORT: String(port),
      CHATDSH_GATEWAY_DB: join(home, 'gateway', 'gateway.sqlite'),
      CHATDSH_PUBLIC_URL: origin,
      CHATDSH_RUNTIME_URL: 'http://127.0.0.1:9',
      CHATDSH_PAIRING_CODE: PAIRING_CODE,
      CHATDSH_TELEMETRY: 'off',
      [HOOK_ENV]: HOOK_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  let device;
  let deviceCookie = '';
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${origin}/healthz`);
        return response.ok;
      } catch {
        return false;
      }
    }, '控制平面启动');

    // 浏览器设备标识由控制平面自己签发；后续请求带上它，公共入口按设备区分读请求。
    const cookieResponse = await fetch(`${origin}/healthz`);
    const issued = cookieResponse.headers.getSetCookie().find((value) => value.startsWith('chatdsh-device='));
    assert.ok(issued, '控制平面应当签发浏览器设备标识');
    deviceCookie = issued.split(';')[0];

    /** 发一次请求；写动作自动带同源与写令牌。 */
    const call = async (path, options = {}) => {
      const method = options.method ?? 'GET';
      const headers = {
        ...(options.cookie === false ? {} : { cookie: deviceCookie }),
        ...(method === 'GET' || method === 'HEAD' ? {} : { origin, 'x-chatdsh-csrf': '1' }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      };
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

    // 配对一台执行节点并连上长连接：会话归属、自动化派发与在线判定都依赖它。
    const paired = await call('/chatdsh/gateway/devices/pair', {
      method: 'POST',
      cookie: false,
      body: { code: PAIRING_CODE, name: '集成工作站', platform: 'linux', role: 'both', capabilities: ['shell'] },
    });
    assert.equal(paired.status, 200, JSON.stringify(paired.json));
    const { deviceId, token } = paired.json;

    device = new LinkDevice(token, `${origin.replace(/^http/, 'ws')}/chatdsh/gateway/device-link`, deviceId, (request) => {
      assert.equal(request.path, '/chatdsh/sessions', '自动化派发送到设备的会话建立端点');
      const payload = JSON.parse(request.body);
      return { status: 200, body: { sessionId: `session-from-${payload.automationId}` } };
    });
    await device.ready;
    await waitFor(async () => {
      const listed = await call('/chatdsh/gateway/devices');
      return listed.json.devices.some((node) => node.id === deviceId && node.online === true);
    }, '设备上线');

    const owned = await call('/chatdsh/gateway/ownership', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { sessionId: SESSION_ID, deviceId, cwd: CWD, kind: 'work' },
    });
    assert.equal(owned.status, 200, JSON.stringify(owned.json));
    assert.equal(owned.json.created, true);

    const base = Date.now() - 600_000;
    const events = sessionEvents(base);
    const appended = await call('/chatdsh/gateway/replica', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { sessionId: SESSION_ID, events },
    });
    assert.equal(appended.status, 200, JSON.stringify(appended.json));
    assert.equal(appended.json.watermark, events.length, '副本水位等于最后一条事件的序号');

    await t.test('客户端读取返回控制平面的真实会话数据', async () => {
      const listed = await call(`/chatdsh/client/sessions?deviceId=${encodeURIComponent(deviceId)}`);
      assert.equal(listed.status, 200, listed.text);
      assert.equal(listed.json.items.length, 1, '列表里只有刚写入的那条会话');
      const item = listed.json.items[0];
      assert.equal(item.sessionId, SESSION_ID);
      assert.equal(item.deviceId, deviceId);
      assert.equal(item.deviceName, '集成工作站');
      assert.equal(item.title, 'WP39 公共入口');
      assert.equal(item.online, true);
      assert.equal(item.cwd, CWD);
      assert.equal(typeof item.unreadMessages, 'number');
      assert.equal(listed.json.page.hasMore, false);
      assert.equal('watermark' in item, false, '客户端形状不带副本水位');
      assert.equal(listed.headers.get('cache-control'), 'no-store', '私有内容不缓存');
    });

    await t.test('分享预览、建立、公开页、打印视图与撤销', async () => {
      const preview = await call('/chatdsh/gateway/share/preview', {
        method: 'POST',
        body: { sessionId: SESSION_ID, range: { mode: 'session' } },
      });
      assert.equal(preview.status, 200, preview.text);
      assert.equal(preview.json.title, 'WP39 公共入口');
      assert.equal(preview.json.messageCount, 4, '两个完整回合的用户与助手文本');
      assert.ok(preview.json.scope.turnFrom >= 1);

      const created = await call('/chatdsh/gateway/share', {
        method: 'POST',
        body: { sessionId: SESSION_ID, range: { mode: 'session' } },
      });
      assert.equal(created.status, 200, created.text);
      assert.equal(created.json.status, 'active');
      assert.match(created.json.shareId, /^[A-Za-z0-9_-]{16,}$/);
      assert.equal(created.json.path, `/s/${created.json.shareId}`);

      const page = await call(created.json.path, { cookie: false });
      assert.equal(page.status, 200, page.text);
      assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
      assert.ok(page.text.includes('第一回合的回答：客户端读取、分享、自动化与导出。'));
      assert.ok(page.text.includes('?print=1'), '公开页给出打印视图入口');
      assert.equal(/<script/iu.test(page.text), false, '公开页没有脚本');

      const printed = await call(`${created.json.path}?print=1`, { cookie: false });
      assert.equal(printed.status, 200, printed.text);
      assert.ok(printed.text.includes('chdsh-print-msg'), '打印视图按导出宿主的文档结构渲染');
      assert.ok(printed.text.includes('@page{size:A4'), '打印视图带打印样式');
      assert.ok(printed.text.includes('打印样式已应用'));
      assert.equal(/<script/iu.test(printed.text), false, '打印视图没有脚本');
      assert.equal(/<nav|<button|<input|<textarea/iu.test(printed.text), false, '打印视图不含应用导航、输入区与交互按钮');

      const listed = await call('/chatdsh/gateway/shares');
      assert.equal(listed.status, 200, listed.text);
      assert.ok(listed.json.shares.some((row) => row.shareId === created.json.shareId && row.status === 'active'));
      assert.equal(JSON.stringify(listed.json).includes('upToSeq'), false, '分享列表不带内部序号');

      const revoked = await call(`/chatdsh/gateway/share/${encodeURIComponent(created.json.shareId)}`, { method: 'DELETE' });
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal(revoked.json.revoked, true);
      const after = await call(created.json.path, { cookie: false });
      assert.equal(after.status, 410, '撤销之后公开页立即失效');
    });

    await t.test('自动化记录读写、webhook 投递与投递记录分页', async () => {
      const created = await call('/chatdsh/gateway/automations', {
        method: 'POST',
        body: {
          name: 'WP39 投递核对',
          trigger: { kind: 'webhook', secretEnv: HOOK_ENV },
          prompt: AUTOMATION_PROMPT,
          enabled: true,
          target: { deviceId, cwd: CWD },
        },
      });
      assert.equal(created.status, 201, created.text);
      const automationId = created.json.id;
      assert.equal(created.json.target.deviceId, deviceId);
      assert.equal(created.json.target.deviceName, '集成工作站');
      assert.equal(created.json.revision, 0);

      const listed = await call('/chatdsh/gateway/automations');
      assert.equal(listed.status, 200, listed.text);
      assert.ok(listed.json.automations.some((row) => row.id === automationId));

      const disabled = await call('/chatdsh/gateway/automations', { method: 'PATCH', body: { id: automationId, enabled: false } });
      assert.equal(disabled.status, 200, disabled.text);
      assert.equal(disabled.json.enabled, false);
      const enabled = await call('/chatdsh/gateway/automations', { method: 'PATCH', body: { id: automationId, enabled: true, revision: disabled.json.revision } });
      assert.equal(enabled.status, 200, enabled.text);
      assert.equal(enabled.json.enabled, true);

      const delivered = await call(`/chatdsh/gateway/webhook/${encodeURIComponent(automationId)}`, {
        method: 'POST',
        cookie: false,
        headers: { 'x-chatdsh-webhook-secret': HOOK_SECRET },
        body: { action: 'opened', issue: 39 },
      });
      assert.equal(delivered.status, 202, delivered.text);
      assert.deepEqual(delivered.json, { accepted: true });

      const page = await waitFor(async () => {
        const answer = await call(`/chatdsh/gateway/automation-deliveries?automationId=${encodeURIComponent(automationId)}&limit=10`);
        if (answer.status !== 200) return false;
        const row = answer.json.deliveries.find((entry) => entry.automationId === automationId);
        return row?.state === 'completed' ? answer : false;
      }, '投递完成');
      const delivery = page.json.deliveries.find((entry) => entry.automationId === automationId);
      assert.equal(delivery.state, 'completed');
      assert.equal(delivery.sessionId, `session-from-${automationId}`, '会话标识来自目标设备的真实应答');
      assert.equal(delivery.source, 'generic');

      const sent = device.requests.find((request) => request.path === '/chatdsh/sessions');
      assert.ok(sent, '目标设备收到了会话建立请求');
      const payload = JSON.parse(sent.body);
      assert.equal(payload.automationId, automationId);
      assert.equal(payload.prompt, AUTOMATION_PROMPT);
      assert.equal(payload.cwd, CWD);

      const removed = await call(`/chatdsh/gateway/automations/${encodeURIComponent(automationId)}`, { method: 'DELETE' });
      assert.equal(removed.status, 204);
      const after = await call(`/chatdsh/gateway/automations?id=${encodeURIComponent(automationId)}`);
      assert.equal(after.status, 404);
    });

    await t.test('导出预估、生成与下载返回真实内容', async () => {
      const scope = {
        source: { kind: 'session', sessionId: SESSION_ID },
        scope: { turnFrom: 1, turnTo: 2, eventCount: 0, charCount: 0, compressed: false, attachmentsComplete: true },
        format: 'markdown',
        includeToolReads: false,
        attachmentPolicy: 'available-only',
        timeDisplay: 'local',
        redaction: 'default',
        privateExport: true,
      };

      const estimate = await call('/chatdsh/gateway/export/estimate', { method: 'POST', body: { scope } });
      assert.equal(estimate.status, 200, estimate.text);
      assert.ok(estimate.json.eventCount > 0, '预估读到真实事件条数');
      assert.ok(estimate.json.charCount > 0);
      assert.ok(estimate.json.bytes > 0);
      assert.deepEqual(estimate.json.attachments, []);

      const created = await call('/chatdsh/gateway/exports', {
        method: 'POST',
        body: { operationId: 'wp39-entry-export', requestDigest: 'a'.repeat(64), scope },
      });
      assert.equal(created.status, 200, created.text);
      const jobId = created.json.jobId;
      assert.match(jobId, /^[A-Za-z0-9_-]+$/);

      const done = await waitFor(async () => {
        const job = await call(`/chatdsh/gateway/exports/${encodeURIComponent(jobId)}`);
        if (job.status !== 200) return false;
        return job.json.state === 'completed' ? job.json : false;
      }, '导出完成');
      assert.equal(done.state, 'completed');
      assert.equal(done.scope.format, 'markdown');

      const listed = await call('/chatdsh/gateway/exports');
      assert.equal(listed.status, 200, listed.text);
      assert.ok(listed.json.jobs.some((row) => row.jobId === jobId));

      const download = await call(`/chatdsh/gateway/exports/${encodeURIComponent(jobId)}/download`);
      assert.equal(download.status, 200, download.text);
      assert.match(download.headers.get('content-type') ?? '', /^text\/markdown/);
      assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
      assert.ok(download.text.includes('# WP39 公共入口'), '下载内容是真实导出的 Markdown');
      assert.ok(download.text.includes('第一回合的回答：客户端读取、分享、自动化与导出。'));
      assert.ok(download.text.includes('第二回合的回答：打印样式来自导出宿主的打印视图。'));
    });
  } finally {
    device?.close();
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((done) => child.once('exit', () => done(true))),
      new Promise((done) => setTimeout(() => done(false), 10_000)),
    ]);
    if (!exited) child.kill('SIGKILL');
    if (child.exitCode !== null && child.exitCode !== 0 && child.exitCode !== 143) {
      console.log(`控制平面退出码 ${String(child.exitCode)}\n${output.slice(-2000)}`);
    }
    releaseIndependentHome(home);
  }
});
