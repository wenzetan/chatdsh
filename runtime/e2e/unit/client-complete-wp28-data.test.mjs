// WP28 用量、保留期、副本清理与只读副本的真实浏览器验收。
//
// 控制平面是真实 `GatewayStore`（SQLite 文件）与 WP27 交付的真实维护服务；设备字节来自真实文件
// 系统上的会话日志、附件与数据库文件。页面由 esbuild 打包本包的真实界面源码，浏览器是
// agent-browser 独立会话里的真实 Chrome（独立 HOME、TMPDIR 与 profile，不截图）。断言来自
// DOM、可访问属性、真实接口响应、磁盘数据库记录与同源遥测中继。
//
// 运行：node --test e2e/unit/client-complete-wp28-data.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const execute = promisify(execFile);
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const RUNTIME = resolve(import.meta.dirname, '../..');
const REPO = resolve(RUNTIME, '..');
const ROOT = new URL('../../', import.meta.url);
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { GatewayStore, ReplicaStore, ShareStore } = await import('../../gateway/lib/store.js');
const { DataMaintenance, attachmentAvailability, attachmentIdsOf, contentScopeOf, replicaEventsOf } = await import(
  '../../gateway/lib/maintenance/index.js'
);
const { measureStorageUsage } = await import('../../packages/host/usage/lib/index.js');

const DAY = 86_400_000;

/** 页面入口：挂载真实的数据管理区段。 */
const EXERCISE = `
import { createRoot } from 'react-dom/client';
import { DataManagementSection } from '../../packages/client/data-management/src/client/index.tsx';
import { createHttpDataManagementFace } from '../../packages/client/data-management/src/client/face.ts';
window.__wp28Errors = [];
window.addEventListener('error', (event) => window.__wp28Errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__wp28Errors.push('rejection:' + String(event.reason)));
const face = createHttpDataManagementFace();
createRoot(document.getElementById('root')).render(<DataManagementSection face={face} />);
`;

/** 写一个真实文件并返回字节数。 */
function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return Buffer.byteLength(content);
}

/** 一段完整回合的副本事件。 */
function turn(base, text, start) {
  const out = [];
  const push = (kind, data) => {
    const seq = base + out.length;
    const time = start + seq * 100;
    out.push({ seq, kind, time, bytes: Buffer.byteLength(JSON.stringify(data)), payload: { type: kind, seq, time, data } });
  };
  push('turn/start', { turn: 1 });
  push('user/message', { text });
  push('assistant/message', { text: `${text} 的回答` });
  push('turn/end', { turn: 1 });
  return out;
}

test('用量、保留期、副本清理与只读副本按真实读数工作', { timeout: 300_000 }, async () => {
  const home = allocateIndependentHome('wp28-data');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'root');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  const session = `wp28-data-${randomUUID().slice(0, 8)}`;
  const browserEnv = {
    ...process.env,
    TMPDIR: home,
    HOME: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env: browserEnv,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  const waitFor = async (expression, label, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() > deadline) {
        const visible = await evaluate('document.querySelector("[data-section=data-management]")?.textContent.slice(0, 3000) ?? document.body.innerText.slice(0, 3000)');
        throw new Error(`等待超时：${label}\n页面内容：${String(visible)}`);
      }
      await new Promise((done) => setTimeout(done, 120));
    }
  };
  const clickTab = async (label) => {
    const clicked = await evaluate(
      `(() => { const tab = [...document.querySelectorAll('[role=tab]')].find((item) => item.textContent === ${JSON.stringify(label)}); if (tab === undefined) return false; tab.click(); return true; })()`,
    );
    assert.equal(clicked, true, `找不到页签：${label}`);
  };
  const setInput = async (selector, value) => {
    const applied = await evaluate(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (element === null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); return element.value === ${JSON.stringify(value)}; })()`,
    );
    assert.equal(applied, true, `输入未写入：${selector}`);
  };

  const relay = [];
  let front;
  let opened = false;
  let store;
  try {
    const now = Date.now();
    const attachments = [{ attachmentId: 'att-alpha', sessionId: 'session-alpha' }];
    const attachmentBytes = write(join(root, 'attachments', 'att-alpha', '需求.md'), '# 需求\n真实附件正文\n');
    for (const id of ['session-alpha', 'session-alpha-child', 'session-beta', 'session-gamma']) {
      write(join(root, 'sessions', id, 'events.jsonl'), `{"session":"${id}"}\n`.repeat(6));
    }

    store = new GatewayStore(join(root, 'gateway', 'gateway.sqlite'));
    const sessions = [
      { sessionId: 'session-alpha', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 300 * DAY },
      { sessionId: 'session-alpha-child', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 2 * DAY, parentSession: 'session-alpha' },
      { sessionId: 'session-beta', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 20 * DAY },
      { sessionId: 'session-gamma', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: now - 10 * DAY },
    ];
    for (const item of sessions) store.upsertSession(item);
    const replicas = new ReplicaStore(store.handle());
    const alphaEvents = [];
    for (let index = 0; index < 30; index += 1) {
      const marker = index === 0 ? ' [附件 att-alpha 需求.md text/markdown 20 字节]' : '';
      alphaEvents.push(...turn(alphaEvents.length, `第 ${String(index + 1)} 回合的问题 ${'内容'.repeat(300)}${marker}`, now - 300 * DAY + index * 1_000));
    }
    replicas.append('session-alpha', alphaEvents);
    replicas.append('session-alpha-child', turn(0, '子会话的问题', now - 2 * DAY));
    replicas.append('session-beta', turn(0, '普通的第二回合问题', now - 20 * DAY));
    replicas.append('session-gamma', turn(0, '另一台设备的问题 [附件 att-missing 缺失.md text/markdown 5 字节]', now - 10 * DAY));
    const share = new ShareStore(store.handle()).create({ sessionId: 'session-alpha' }, 3);

    const maintenance = new DataMaintenance({
      database: store.handle(),
      measure: measureStorageUsage,
      dataRoot: root,
    });

    /** 一条会话的只读副本视图，按真实副本行与真实附件目录计算。 */
    const replicaViewOf = (sessionId) => {
      const retentionDays = 90;
      const events = replicaEventsOf(store.handle(), sessionId);
      const ids = attachmentIdsOf(events);
      const availability = attachmentAvailability(ids, root);
      if (events.length === 0) {
        return {
          sessionId,
          replica: { state: 'missing' },
          source: 'replica',
          readOnlyReason: 'device-offline',
          retentionDays,
          missingAttachments: ids.length,
        };
      }
      const scope = contentScopeOf(events, { compressed: false, attachmentsComplete: availability.missing.length === 0 });
      return {
        sessionId,
        replica: {
          state: availability.missing.length === 0 ? 'complete' : 'partial',
          scope,
          readAt: Math.max(...events.map((event) => event.time)),
        },
        source: 'replica',
        readOnlyReason: 'replica-only',
        retentionDays,
        missingAttachments: availability.missing.length,
      };
    };

    const respond = (response, status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const fail = (response, error) => {
      respond(response, 500, { error: error.code ?? 'internal-error', message: error.message });
    };
    const readBody = async (request) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };

    const bundle = await build({
      stdin: {
        contents: EXERCISE,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        sourcefile: 'wp28-data-exercise.tsx',
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      target: 'es2022',
      logLevel: 'warning',
    });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数据管理验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; } table { border-collapse: collapse; } th, td { padding: 4px 8px; text-align: start; }</style></head><body><main id="root"></main><script>${bundle.outputFiles[0].text}</script></body></html>`;

    front = createServer(async (request, response) => {
      try {
        if (request.url === '/chatdsh/telemetry/browser') {
          const body = await readBody(request);
          relay.push({ signal: request.headers['x-chatdsh-signal'], body });
          response.writeHead(204).end();
          return;
        }
        if (request.url === '/chatdsh/client/data/usage') {
          respond(response, 200, await maintenance.usage.report({ root, deviceId: 'device-1', attachments }));
          return;
        }
        if (request.url === '/chatdsh/client/data/retention') {
          if (request.method === 'POST') {
            const body = await readBody(request);
            respond(response, 200, await maintenance.retention.write(Number(body.days)));
            return;
          }
          respond(response, 200, await maintenance.retention.read());
          return;
        }
        if (request.url === '/chatdsh/client/data/cleanup/estimate') {
          const body = await readBody(request);
          respond(response, 200, await maintenance.cleanup.estimate({
            ...(body.retentionDays === undefined ? {} : { retentionDays: Number(body.retentionDays) }),
          }));
          return;
        }
        if (request.url === '/chatdsh/client/data/cleanup/execute') {
          const body = await readBody(request);
          respond(response, 200, await maintenance.cleanup.execute({
            estimateId: String(body.estimateId),
            confirmDependencies: body.confirmDependencies === true,
          }));
          return;
        }
        if (request.url.startsWith('/chatdsh/client/data/replica/')) {
          respond(response, 200, replicaViewOf(decodeURIComponent(request.url.slice('/chatdsh/client/data/replica/'.length))));
          return;
        }
        if (request.url.startsWith('/chatdsh/client/data/')) {
          respond(response, 404, { error: 'object-not-found' });
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
      } catch (error) {
        fail(response, error);
      }
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    const origin = `http://127.0.0.1:${front.address().port}`;

    await cli('open', `${origin}/`);
    opened = true;
    await waitFor('document.querySelector("[data-usage-ready]") !== null', '用量面板载入');

    // 1. 用量读数：总量、五个分类、维度明细都来自真实清点。
    const total = Number(await evaluate('document.querySelector("[data-usage-total]").dataset.bytes'));
    assert.ok(total > 0, '总占用是真实字节');
    const bucketSums = await evaluate(
      '[...document.querySelectorAll("[data-bucket]")].map((row) => ({ bucket: row.dataset.bucket, bytes: Number(row.querySelector("[data-bucket-bytes]").dataset.bytes) }))',
    );
    assert.deepEqual(bucketSums.map((item) => item.bucket), ['session', 'replica', 'attachment', 'memory', 'other']);
    assert.equal(bucketSums.reduce((sum, item) => sum + item.bytes, 0), total, '五个分类之和等于总量');
    const bucketOf = (name) => bucketSums.find((item) => item.bucket === name).bytes;
    assert.ok(bucketOf('session') > 0, '会话日志计入会话分类');
    assert.ok(bucketOf('replica') > 0, '控制平面数据库计入副本分类');
    assert.equal(bucketOf('attachment'), attachmentBytes, '附件分类按真实文件字节计');
    assert.equal(bucketOf('memory'), 0, '没有记忆文件时记忆分类为零字节');
    const du = Number((await execute('du', ['-sb', root], { encoding: 'utf8' })).stdout.split('\t')[0]);
    assert.ok(du >= total, `清点总量不超过磁盘占用：${String(total)} / ${String(du)}`);
    assert.match(await evaluate('document.querySelector("[data-usage-root]").textContent'), new RegExp(root.replaceAll('/', '\\/'), 'u'));
    assert.match(await evaluate('document.querySelector("[data-usage-replica-source]").textContent'), /副本已计入/u);
    assert.match(await evaluate('document.querySelector("[data-usage-retention]").textContent'), /90 天/u);

    await cli('select', '[data-dimension-select]', 'session');
    await waitFor('document.querySelector("[data-usage-row=\\"session-alpha\\"]") !== null', '会话维度行');
    assert.equal(
      Number(await evaluate('document.querySelector("[data-usage-row=\\"session-alpha\\"]").querySelector("[data-attachment-bytes]").dataset.bytes')),
      attachmentBytes,
      '会话行带上归属到它的附件字节',
    );
    await cli('select', '[data-dimension-select]', 'workspace');
    await waitFor('document.querySelector("[data-usage-row=\\"ws-w1\\"]") !== null', '工作区维度行');
    assert.equal(
      await evaluate('document.querySelector("[data-usage-row=\\"ws-w1\\"]").querySelector("td").textContent'),
      '3 个会话',
    );

    // 2. 读取失败显示错误码，不显示任何数字。
    write(join(root, 'attachments', 'att-broken'), '这是一个普通文件，占住了应有的目录位置\n');
    attachments.push({ attachmentId: 'att-broken', sessionId: 'session-alpha' });
    await cli('click', '[data-usage-ready] button');
    await waitFor('document.querySelector("[data-usage-failed]") !== null', '用量失败状态');
    assert.match(await evaluate('document.querySelector("[data-usage-failed]").textContent'), /internal-error/u);
    assert.equal(await evaluate('document.querySelector("[data-usage-total]") === null'), true, '失败时不显示零值');
    assert.equal(await evaluate('document.querySelector("[data-usage-buckets]") === null'), true, '失败时不显示分类明细');
    attachments.pop();
    rmSync(join(root, 'attachments', 'att-broken'));
    await cli('click', '[data-usage-failed] button');
    await waitFor('document.querySelector("[data-usage-ready]") !== null', '重新清点成功');

    // 3. 保留期写入真实设置表，界面与用量一起刷新。
    await clickTab('副本清理');
    await waitFor('document.querySelector("[data-retention-input]") !== null', '保留期编辑');
    await setInput('[data-retention-input]', '30');
    await cli('click', '[data-retention-save]');
    await waitFor('document.querySelector("[data-retention-editor]")?.textContent.includes("当前保留期 30 天") === true', '保留期已保存');
    const storedDays = store.handle().prepare("select value from settings where namespace = 'replica-retention' and key = 'days'").get();
    assert.equal(storedDays.value, '30', '保留期写入真实设置表');
    await waitFor('document.querySelector("[data-usage-ready]") !== null && document.querySelector("[data-usage-retention]")?.textContent.includes("30 天") === true', '用量面板刷到新的保留期');

    // 4. 清理预估列出对象与依赖，依赖未逐项确认时不能执行。
    await cli('click', '[data-cleanup-estimate]');
    await waitFor('document.querySelector("[data-cleanup-estimate-view]") !== null', '清理预估');
    assert.equal(await evaluate('document.querySelector("[data-cleanup-objects]").textContent'), '1 个会话副本');
    const reclaimable = Number(await evaluate('document.querySelector("[data-cleanup-reclaimable]").dataset.bytes'));
    assert.ok(reclaimable > 0, '可释放空间是真实字节');
    assert.equal(await evaluate('document.querySelector("[data-cleanup-shares]").textContent'), '1 个');
    assert.equal(await evaluate('document.querySelector("[data-cleanup-imports]").textContent'), '1 个');
    assert.equal(await evaluate('document.querySelector("[data-cleanup-candidate=\\"session-alpha\\"]") !== null'), true);
    assert.match(
      await evaluate('document.querySelector("[data-cleanup-candidate=\\"session-alpha\\"]").textContent'),
      /1 个有效分享，1 个活动导入/u,
    );
    assert.equal(await evaluate('document.querySelector("[data-cleanup-execute]").disabled'), true, '依赖未确认时执行按钮不可用');
    assert.match(await evaluate('document.body.textContent'), /依赖没有逐项确认前不能执行清理/u);
    assert.equal(await evaluate('document.querySelector("[data-cleanup-dependency=\\"session-alpha\\"]") !== null'), true);
    await cli('check', '[data-cleanup-dependency="session-alpha"]');
    assert.equal(await evaluate('document.querySelector("[data-cleanup-execute]").disabled'), false, '逐项确认后可以执行');
    const deviceLog = join(root, 'sessions', 'session-alpha', 'events.jsonl');
    const deviceLogBytes = statSync(deviceLog).size;

    await cli('click', '[data-cleanup-execute]');
    await waitFor('document.querySelector("[data-cleanup-outcome]") !== null', '清理结果');
    const reclaimed = Number(await evaluate('document.querySelector("[data-cleanup-reclaimed]").dataset.bytes'));
    assert.ok(reclaimed > 0, '实际释放量是真实磁盘减少量');
    assert.equal(await evaluate('document.querySelector("[data-cleanup-removed-sessions]").textContent'), '1 个');
    assert.match(await evaluate('document.querySelector("[data-cleanup-outcome]").textContent'), /设备权威日志与工作区文件保留/u);
    assert.match(await evaluate('document.querySelector("[data-cleanup-outcome]").textContent'), /真实字节差/u);
    assert.equal(
      store.handle().prepare("select count(*) as total from replica_events where session_id = 'session-alpha'").get().total,
      0,
      '副本事件已删除',
    );
    assert.equal(existsSync(deviceLog), true, '设备权威日志保留');
    assert.equal(statSync(deviceLog).size, deviceLogBytes, '设备权威日志内容不变');
    assert.ok(new ShareStore(store.handle()).get(share.token) !== undefined, '清理保留分享记录');

    // 执行后用量自动刷新：有副本的会话数减少，被清理会话的副本字节归零。
    await waitFor('document.querySelector("[data-usage-replica]")?.textContent.includes("3 个会话") === true', '用量自动刷新');
    await cli('select', '[data-dimension-select]', 'session');
    await waitFor(
      'Number(document.querySelector("[data-usage-row=\\"session-alpha\\"] [data-replica-bytes]")?.dataset.bytes ?? -1) === 0',
      '被清理会话的副本字节归零',
    );

    // 5. 只读副本：完整、部分与不可读取三种状态，失效说明按事实给出。
    await clickTab('只读副本');
    await waitFor('document.querySelector("[data-replica-input]") !== null', '只读副本输入');
    await setInput('[data-replica-input]', 'session-beta');
    await cli('click', '[data-replica-read]');
    await waitFor('document.querySelector("[data-replica-state=\\"complete\\"]") !== null', '完整可读');
    const scopeText = await evaluate('document.querySelector("[data-replica-scope-turns]").textContent');
    assert.match(scopeText, /第 1 到 1 回合/u);
    assert.match(scopeText, /4 个事件/u);
    assert.match(await evaluate('document.querySelector("[data-replica-source]").textContent'), /控制平面副本/u);
    assert.match(await evaluate('document.querySelector("[data-replica-read-at]").textContent'), /^\d{4}-\d{2}-\d{2}/u);

    await setInput('[data-replica-input]', 'session-gamma');
    await cli('click', '[data-replica-read]');
    await waitFor('document.querySelector("[data-replica-state=\\"partial\\"]") !== null', '部分可读');
    assert.equal(await evaluate('document.querySelector("[data-replica-missing-attachments]").textContent'), '1 个');
    assert.match(await evaluate('document.querySelector("[data-replica-invalidation]").textContent'), /附件原文/u);
    assert.match(await evaluate('document.querySelector("[data-replica-scope-attachments]").textContent'), /有附件缺失/u);

    await setInput('[data-replica-input]', 'session-alpha');
    await cli('click', '[data-replica-read]');
    await waitFor('document.querySelector("[data-replica-state=\\"missing\\"]") !== null', '不可读取');
    assert.match(await evaluate('document.querySelector("[data-replica-invalidation]").textContent'), /保留期/u);
    assert.match(await evaluate('document.querySelector("[data-replica-invalidation]").textContent'), /源设备/u);
    assert.equal(
      await evaluate('document.querySelector("[data-replica-read-at]").textContent'),
      '没有读取到内容',
      '副本缺失时不显示读取时刻',
    );
    assert.equal(await evaluate('document.querySelector("[data-replica-scope]") === null'), true, '副本缺失时不显示可读范围');

    // 6. 页面没有脚本错误，DOM 与遥测都不含内部位置。
    assert.deepEqual(await evaluate('window.__wp28Errors'), []);
    const sectionHtml = await evaluate(`(() => {
      const section = document.querySelector('[data-section=data-management]').cloneNode(true);
      for (const node of section.querySelectorAll('script, style')) node.remove();
      return section.outerHTML;
    })()`);
    assert.ok(String(sectionHtml).length > 1000, '取到渲染出来的区段内容');
    for (const blocked of ['watermark', 'up_to_seq', 'readUpToSeq', 'sourceWatermark', 'replicaSeq', 'event_seq', '水位', '副本序号']) {
      const index = String(sectionHtml).indexOf(blocked);
      const context = index < 0 ? null : String(sectionHtml).slice(Math.max(0, index - 120), index + 120);
      assert.equal(context, null, `界面不得出现 ${blocked}：${String(context)}`);
    }
    const relayText = relay.map((item) => JSON.stringify(item.body)).join('\n');
    assert.ok(relayText.includes('chatdsh.client.ui.action'), '界面动作写了事件');
    assert.ok(relayText.includes('data-cleanup-execute'), '清理执行写了动作');
    assert.ok(relayText.includes('chatdsh.client.remote.call'), '数据调用写了 span');
    assert.ok(relayText.includes('chatdsh.client.error'), '失败分支写了错误事件');
    assert.ok(relayText.includes('internal-error'), '错误事件带错误码');
    assert.equal(relayText.includes(root), false, '遥测里没有数据根路径');
    assert.equal(relayText.includes('需求.md'), false, '遥测里没有附件名称');
  } finally {
    if (opened) await cli('close').catch(() => undefined);
    if (front !== undefined) {
      front.closeAllConnections();
      await new Promise((done) => front.close(done));
    }
    if (store !== undefined) store.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
});
