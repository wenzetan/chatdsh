// WP28 血缘、导入与分叉、删除收件箱、键盘焦点与导出的真实浏览器验收。
//
// 控制平面是真实 `GatewayStore`（SQLite 文件）、WP27 交付的真实血缘与删除服务，以及
// `@chatdsh/host-import` 的真实分叉计划；设备附件是真实文件。页面由 esbuild 打包本包的真实
// 界面源码，浏览器是 agent-browser 独立会话里的真实 Chrome（独立 HOME、TMPDIR 与 profile，
// 不截图）。键盘与焦点断言来自真实按键，导出断言来自真实 Blob 内容与渲染出来的 DOM。
//
// 运行：node --test e2e/unit/client-complete-wp28-inbox.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const {
  DataMaintenance,
  activeSharesOf,
  memoryGroupReferencesOf,
  replicaEventsOf,
} = await import('../../gateway/lib/maintenance/index.js');
const { planFork } = await import('../../packages/host/import/lib/index.js');
const { measureStorageUsage } = await import('../../packages/host/usage/lib/index.js');
const { MemoryStore } = await import('../../packages/host/memory/lib/store.js');
const { MemoryGroupRegistry } = await import('../../packages/host/memory/lib/groups.js');

const DAY = 86_400_000;
const BLOCKED = ['watermark', 'up_to_seq', 'readUpToSeq', 'sourceWatermark', 'replicaSeq', 'event_seq', '水位', '副本序号'];

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

/** 写一个真实文件。 */
function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 一条副本事件。 */
function record(seq, kind, data, time) {
  return { seq, kind, time, bytes: Buffer.byteLength(JSON.stringify(data)), payload: { type: kind, seq, time, data } };
}

/** 一段完整回合，从给定序号起连续编号。 */
function turn(base, text, start, options = {}) {
  const out = [];
  const push = (kind, data) => {
    const seq = base + out.length;
    const time = start + seq * 100;
    out.push(record(seq, kind, data, time));
  };
  push('turn/start', { turn: options.turn ?? 1 });
  push('user/message', { text });
  if (options.tool === true) {
    push('tool/call', { callId: `call-${String(base)}`, tool: 'shell' });
    push('tool/result', { callId: `call-${String(base)}`, content: '命令输出' });
  }
  push('assistant/message', { text: `${text} 的回答` });
  push('turn/end', { turn: options.turn ?? 1 });
  return out;
}

test('血缘、分叉、删除收件箱、键盘焦点与导出按真实状态工作', { timeout: 300_000 }, async () => {
  const home = allocateIndependentHome('wp28-inbox');
  const previousHome = process.env.DSH_HOME;
  const root = join(home, 'root');
  mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = root;
  const session = `wp28-inbox-${randomUUID().slice(0, 8)}`;
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
        const text = await evaluate('document.querySelector("[data-section=data-management]")?.textContent.slice(0, 3000) ?? document.body.innerText.slice(0, 3000)');
        throw new Error(`等待超时：${label}\n页面内容：${String(text)}`);
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
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (element === null) return false; const prototype = element instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event(element instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true; })()`,
    );
    assert.equal(applied, true, `输入未写入：${selector}`);
  };

  const relay = [];
  let front;
  let opened = false;
  let store;
  try {
    const now = Date.now();
    for (const [id, rounds] of [
      ['session-root', 3],
      ['session-fork', 3],
      ['session-fork-child', 2],
      ['session-compressed', 2],
      ['session-inbox-a', 2],
      ['session-inbox-b', 1],
      ['session-inbox-c', 1],
    ]) {
      write(join(root, 'sessions', id, 'events.jsonl'), `{"session":"${id}"}\n`.repeat(rounds * 2));
    }
    write(join(root, 'attachments', 'att-root', '需求.md'), '# 需求\n根会话的附件正文\n');

    store = new GatewayStore(join(root, 'gateway', 'gateway.sqlite'));
    const ownership = [
      { sessionId: 'session-root', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 50 * DAY },
      { sessionId: 'session-fork', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: now - 40 * DAY, parentSession: 'session-root' },
      { sessionId: 'session-fork-child', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: now - 30 * DAY, parentSession: 'session-fork' },
      { sessionId: 'session-compressed', workspaceId: 'ws-w2', deviceId: 'device-2', cwd: '/work/beta', kind: 'work', createdAt: now - 10 * DAY, parentSession: 'session-root' },
      { sessionId: 'session-inbox-a', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 60 * DAY },
      { sessionId: 'session-inbox-b', workspaceId: 'ws-w1', deviceId: 'device-1', cwd: '/work/alpha', kind: 'work', createdAt: now - 90 * DAY },
      { sessionId: 'session-inbox-c', workspaceId: 'ws-w2', deviceId: 'device-1', cwd: '/work/memory', kind: 'work', createdAt: now - 40 * DAY },
    ];
    for (const item of ownership) store.upsertSession(item);

    const replicas = new ReplicaStore(store.handle());
    const rootEvents = [
      ...turn(0, '第一回合的问题 [附件 att-missing 缺失.md text/markdown 5 字节]', now - 50 * DAY, { tool: true }),
      ...turn(5, '第二回合的问题 [附件 att-root 需求.md text/markdown 20 字节]', now - 50 * DAY + 10_000, { turn: 2 }),
    ];
    replicas.append('session-root', rootEvents);
    const forkEvents = [...rootEvents, ...turn(rootEvents.length, '分叉后的问题', now - 40 * DAY, { turn: 3 })];
    replicas.append('session-fork', forkEvents);
    replicas.append('session-fork-child', forkEvents.slice(0, 8));
    replicas.append('session-compressed', [
      ...rootEvents.slice(0, 3),
      record(3, 'plugin:import', {
        kind: 'import',
        sourceSessionId: 'session-root',
        sourceDeviceId: 'device-1',
        sourceWatermark: 3,
        mode: 'compressed',
        eventCount: 3,
        charCount: 120,
        lossy: true,
        importedAt: now - 10 * DAY,
      }, now - 10 * DAY),
    ]);
    replicas.append('session-inbox-a', turn(0, '待删除的会话甲', now - 60 * DAY));
    replicas.append('session-inbox-b', turn(0, '待删除的会话乙', now - 90 * DAY));
    replicas.append('session-inbox-c', turn(0, '待删除的会话丙', now - 40 * DAY));
    const shareStore = new ShareStore(store.handle());
    const inboxShare = shareStore.create({ sessionId: 'session-inbox-c' }, 0);
    shareStore.create({ sessionId: 'session-inbox-a' }, 0);
    const database = store.handle();
    database.prepare('update sessions set deleted_at = ? where session_id = ?').run(now - 5 * DAY, 'session-inbox-a');
    database.prepare('update sessions set deleted_at = ? where session_id = ?').run(now - 31 * DAY, 'session-inbox-b');
    database.prepare('update sessions set deleted_at = ? where session_id = ?').run(now - 3 * DAY, 'session-inbox-c');

    const groups = new MemoryGroupRegistry(new MemoryStore());
    await groups.save({ displayName: '记忆项目', workspaces: [{ deviceId: 'device-1', path: '/work/memory' }] });

    const maintenance = new DataMaintenance({ database, measure: measureStorageUsage, dataRoot: root });
    await maintenance.retention.write(30);

    /** 源会话的副本记录，按序号升序。 */
    const recordsOf = (sessionId) => replicaEventsOf(database, sessionId).map((row) => ({
      seq: row.seq,
      kind: row.kind,
      time: row.time,
      payload: row.payload === null ? null : JSON.parse(row.payload),
    }));
    /** 磁盘上可用的附件标识。 */
    const attachmentsOnDisk = () => (existsSync(join(root, 'attachments')) ? readdirSync(join(root, 'attachments')) : []);
    /** 按真实副本构造分叉计划。 */
    const planOf = (body) => planFork({
      records: recordsOf(String(body.sourceSessionId)),
      sourceSessionId: String(body.sourceSessionId),
      sourceDeviceId: String(body.sourceDeviceId),
      turnTo: Number(body.turnTo),
      importMode: String(body.importMode),
      availableAttachmentIds: attachmentsOnDisk(),
      scheduledTasks: 2,
    });

    const respond = (response, status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
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
        sourcefile: 'wp28-inbox-exercise.tsx',
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
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数据管理验收</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; } table { border-collapse: collapse; } th, td { padding: 4px 8px; text-align: start; } dialog dl { display: grid; gap: 4px; }</style></head><body><main id="root"></main><script>${bundle.outputFiles[0].text}</script></body></html>`;

    front = createServer(async (request, response) => {
      try {
        if (request.url === '/chatdsh/telemetry/browser') {
          relay.push({ signal: request.headers['x-chatdsh-signal'], body: await readBody(request) });
          response.writeHead(204).end();
          return;
        }
        if (request.url === '/chatdsh/client/data/usage') {
          respond(response, 200, await maintenance.usage.report({ root, deviceId: 'device-1', attachments: [] }));
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
        if (request.url.startsWith('/chatdsh/client/data/lineage/')) {
          const id = decodeURIComponent(request.url.slice('/chatdsh/client/data/lineage/'.length));
          respond(response, 200, await maintenance.lineage.chain(id));
          return;
        }
        if (request.url === '/chatdsh/client/data/fork/estimate') {
          respond(response, 200, planOf(await readBody(request)).estimate);
          return;
        }
        if (request.url === '/chatdsh/client/data/fork') {
          const body = await readBody(request);
          const plan = planOf(body);
          const sessionId = `session-forked-${randomUUID().slice(0, 8)}`;
          const createdAt = Date.now();
          store.upsertSession({
            sessionId,
            workspaceId: 'ws-w1',
            deviceId: String(body.targetDeviceId),
            cwd: String(body.targetCwd),
            kind: 'work',
            createdAt,
            parentSession: String(body.sourceSessionId),
          });
          const seedEvents = plan.seed.map((event, index) => {
            const time = createdAt + index;
            return { seq: index, kind: event.type, time, bytes: Buffer.byteLength(JSON.stringify(event.data ?? {})), payload: { type: event.type, seq: index, time, data: event.data } };
          });
          const importSeq = seedEvents.length;
          seedEvents.push({
            seq: importSeq,
            kind: 'plugin:import',
            time: createdAt + importSeq,
            bytes: Buffer.byteLength(JSON.stringify(plan.importRecord)),
            payload: { type: 'plugin:import', seq: importSeq, time: createdAt + importSeq, data: plan.importRecord },
          });
          new ReplicaStore(database).append(sessionId, seedEvents);
          respond(response, 200, {
            sessionId,
            parentSession: String(body.sourceSessionId),
            cwd: String(body.targetCwd),
            createdAt,
            estimate: plan.estimate,
            replay: {
              replayedToolCalls: plan.replay.toolCalls,
              replayedScheduledTasks: plan.replay.scheduledTasks,
              retainedScheduledTasks: plan.replay.retainedScheduledTasks,
              droppedToolCalls: plan.replay.droppedToolCalls,
              droppedToolResults: plan.replay.droppedToolResults,
              unresolvedToolCalls: plan.replay.unresolvedToolCalls,
            },
          });
          return;
        }
        if (request.url === '/chatdsh/client/data/deletion/inbox') {
          respond(response, 200, await maintenance.deletion.inbox());
          return;
        }
        if (request.url === '/chatdsh/client/data/deletion/restore') {
          const body = await readBody(request);
          respond(response, 200, await maintenance.deletion.restore({
            sessionId: String(body.sessionId),
            operationId: String(body.operationId),
            requestDigest: String(body.requestDigest),
          }));
          return;
        }
        if (request.url.startsWith('/chatdsh/client/data/deletion/scope/')) {
          const id = decodeURIComponent(request.url.slice('/chatdsh/client/data/deletion/scope/'.length));
          const scope = await maintenance.deletion.permanentScope(id);
          const row = store.getSession(id);
          const shares = activeSharesOf(database, id, Date.now());
          const referenced = row === undefined ? [] : memoryGroupReferencesOf(root, row.deviceId, row.cwd);
          respond(response, 200, {
            ...scope,
            dependencies: [
              ...shares.map((item) => ({
                kind: 'share',
                label: '分享链接',
                createdAt: item.created_at,
                ...(item.expires_at === null ? {} : { expiresAt: item.expires_at }),
                visits: item.visits,
              })),
              ...referenced.map((item) => ({ kind: 'memory-group', label: item.displayName })),
            ],
          });
          return;
        }
        if (request.url === '/chatdsh/client/data/deletion/permanent') {
          const body = await readBody(request);
          respond(response, 200, await maintenance.deletion.permanentDelete({
            sessionId: String(body.sessionId),
            confirm: body.confirm === true,
            confirmDependencies: body.confirmDependencies === true,
          }));
          return;
        }
        if (request.url.startsWith('/chatdsh/client/data/')) {
          respond(response, 404, { error: 'object-not-found' });
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
      } catch (error) {
        respond(response, 500, { error: error.code ?? 'internal-error', message: error.message });
      }
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    const origin = `http://127.0.0.1:${front.address().port}`;

    await cli('open', `${origin}/`);
    opened = true;
    await waitFor('document.querySelector("[data-inbox]") !== null', '删除收件箱载入');

    // 1. 血缘：祖先、自身、直接子会话与整棵子树，继承范围按真实复制内容计算。
    await clickTab('血缘');
    await setInput('[data-lineage-input]', 'session-fork-child');
    await cli('click', '[data-lineage-read]');
    await waitFor('document.querySelector("[data-lineage-view]") !== null', '血缘链');
    assert.equal(await evaluate('document.querySelector("[data-lineage-root]").textContent'), 'session-root');
    assert.equal(await evaluate('document.querySelector("[data-lineage-depth]").textContent'), '2 层');
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll("[data-lineage-ancestor]")].map((item) => item.dataset.lineageAncestor)'),
      ['session-root', 'session-fork'],
    );
    assert.equal(await evaluate('document.querySelector("[data-lineage-self]").dataset.lineageSelf'), 'session-fork-child');
    assert.match(await evaluate('document.querySelector("[data-inherited=\\"session-fork-child\\"]").textContent'), /个完整回合/u);
    assert.match(await evaluate('document.querySelector("[data-inherited=\\"session-fork-child\\"]").textContent'), /个字符/u);
    assert.equal(
      await evaluate('document.querySelector("[data-inherited=\\"session-fork-child\\"] [data-inherited-compressed]").textContent'),
      '原文复制',
    );

    await cli('click', '[data-lineage-ancestor="session-root"]');
    await waitFor('document.querySelector("[data-lineage-self]")?.dataset.lineageSelf === "session-root"', '导航到祖先');
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll("[data-lineage-descendant]")].map((item) => item.dataset.lineageDescendant).sort()'),
      ['session-compressed', 'session-fork', 'session-fork-child'],
      '后代覆盖整棵子树',
    );
    await cli('click', '[data-lineage-descendant="session-compressed"]');
    await waitFor('document.querySelector("[data-lineage-self]")?.dataset.lineageSelf === "session-compressed"', '导航到后代');
    assert.equal(
      await evaluate('document.querySelector("[data-inherited=\\"session-compressed\\"] [data-inherited-compressed]").textContent'),
      '压缩复制',
      '压缩导入的标记进入继承范围',
    );

    // 2. 导入与分叉：导入范围、缺失附件与压缩损失。
    await clickTab('导入与分叉');
    await setInput('[data-fork-source]', 'session-root');
    await setInput('[data-fork-source-device]', 'device-1');
    await setInput('[data-fork-target-device]', 'device-1');
    await setInput('[data-fork-target-cwd]', '/work/alpha');
    await setInput('[data-fork-turn]', '1');
    await cli('click', '[data-fork-estimate]');
    await waitFor('document.querySelector("[data-fork-estimate-view]") !== null', '分叉预估');
    assert.match(await evaluate('document.querySelector("[data-fork-scope-turns]").textContent'), /第 1 到 1 回合/u);
    assert.match(await evaluate('document.querySelector("[data-fork-scope-turns]").textContent'), /6 个事件/u);
    assert.match(await evaluate('document.querySelector("[data-fork-missing-attachments]").textContent'), /att-missing/u);
    assert.match(await evaluate('document.querySelector("[data-fork-loss]").textContent'), /没有内容被替换/u);
    assert.equal(await evaluate('document.querySelector("[data-fork-create]").disabled'), false);

    await setInput('[data-fork-mode]', 'compressed');
    await cli('click', '[data-fork-estimate]');
    await waitFor('document.querySelector("[data-fork-loss]")?.textContent.includes("压缩复制会移出工具调用") === true', '压缩损失');
    assert.equal(await evaluate('document.querySelector("[data-fork-create]").disabled'), true, '压缩损失未确认时不能创建');
    assert.match(await evaluate('document.querySelector("[data-fork-mode-label]").textContent'), /压缩摘要/u);
    await cli('check', '[data-fork-acknowledge-check]');
    assert.equal(await evaluate('document.querySelector("[data-fork-create]").disabled'), false, '确认后可以创建');
    await cli('click', '[data-fork-create]');
    await waitFor('document.querySelector("[data-fork-outcome]") !== null', '分叉结果');
    const forkedId = await evaluate('document.querySelector("[data-fork-new-session]").textContent');
    assert.match(forkedId, /^session-forked-/u);
    assert.equal(await evaluate('document.querySelector("[data-fork-parent]").textContent'), 'session-root');
    const replayText = await evaluate('document.querySelector("[data-fork-replay]").textContent');
    assert.match(replayText, /工具调用重放 0 个/u);
    assert.match(replayText, /定时任务重放 0 个/u);
    assert.match(replayText, /定时任务仍然留在源会话上，共 2 个/u);
    assert.match(replayText, /压缩复制移出工具调用 1 个、工具结果 1 个/u);
    assert.equal(
      database.prepare('select parent_session from sessions where session_id = ?').get(forkedId).parent_session,
      'session-root',
      '新会话带 parentSession',
    );

    await clickTab('血缘');
    await setInput('[data-lineage-input]', forkedId);
    await cli('click', '[data-lineage-read]');
    await waitFor(`document.querySelector("[data-lineage-self]")?.dataset.lineageSelf === ${JSON.stringify(forkedId)}`, '新会话的血缘');
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll("[data-lineage-ancestor]")].map((item) => item.dataset.lineageAncestor)'),
      ['session-root'],
    );
    assert.equal(
      await evaluate(`document.querySelector("[data-inherited=\\"${forkedId}\\"] [data-inherited-compressed]").textContent`),
      '压缩复制',
      '分叉的压缩标记进入继承范围',
    );

    // 3. 删除收件箱：剩余天数、恢复与过期。
    await clickTab('删除收件箱');
    await waitFor('document.querySelector("[data-inbox-item=\\"session-inbox-a\\"]") !== null', '收件箱条目');
    assert.equal(await evaluate('document.querySelectorAll("[data-inbox-item]").length'), 3);
    assert.equal(
      await evaluate('document.querySelector("[data-inbox-item=\\"session-inbox-a\\"] [data-inbox-remaining]").textContent'),
      '25 天',
    );
    assert.equal(await evaluate('document.querySelector("[data-inbox-restore=\\"session-inbox-b\\"]").disabled'), true, '过期条目不能恢复');
    await cli('click', '[data-inbox-restore="session-inbox-a"]');
    await waitFor('document.querySelector("[data-inbox-restored]") !== null', '恢复结果');
    assert.match(await evaluate('document.querySelector("[data-inbox-restored]").textContent'), /已恢复 session-inbox-a/u);
    await waitFor('document.querySelector("[data-inbox-item=\\"session-inbox-a\\"]") === null', '收件箱刷新');
    assert.equal(
      database.prepare('select deleted_at from sessions where session_id = ?').get('session-inbox-a').deleted_at,
      null,
      '恢复清空删除时刻',
    );

    // 4. 永久删除：两级确认、逐项依赖确认、默认焦点与对话框焦点约束。
    await cli('focus', '[data-inbox-permanent="session-inbox-c"]');
    await cli('press', 'Enter');
    await waitFor('document.querySelector("dialog[open]") !== null', '永久删除范围对话框');
    assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
    assert.equal(await evaluate('document.activeElement.hasAttribute("data-confirm-cancel")'), true, '默认焦点落在取消按钮');
    assert.equal(await evaluate('document.activeElement.hasAttribute("data-confirm-accept")'), false, '默认焦点不在确认按钮');
    assert.match(await evaluate('document.querySelector("dialog[open] [data-confirm-facts]").textContent'), /释放空间/u);
    assert.match(await evaluate('document.querySelector("dialog[open] [data-confirm-dependencies]").textContent'), /记忆组引用/u);
    for (let step = 0; step < 6; step += 1) {
      await cli('press', 'Tab');
      assert.equal(
        await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'),
        true,
        '对话框内的 Tab 不离开对话框',
      );
    }
    await cli('press', 'Shift+Tab');
    assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
    await cli('press', 'Escape');
    await waitFor('document.querySelector("dialog[open]") === null', 'Escape 关闭对话框');
    assert.equal(
      await evaluate('document.activeElement.dataset.inboxPermanent'),
      'session-inbox-c',
      'Escape 之后焦点回到触发按钮',
    );

    await cli('press', 'Enter');
    await waitFor('document.querySelector("dialog[open]") !== null', '再次打开范围对话框');
    await cli('focus', 'dialog[open] [data-confirm-accept]');
    await cli('press', 'Enter');
    await waitFor('document.querySelector("dialog[open] [data-acknowledge-check]") !== null', '第二级确认');
    assert.equal(await evaluate('document.querySelector("dialog[open] [data-confirm-accept]").disabled'), true, '两项确认未完成时不能删除');
    assert.equal(await evaluate('document.querySelectorAll("dialog[open] [data-dependency-check]").length'), 2, '分享与记忆组逐项列出');
    await cli('check', 'dialog[open] [data-dependency-check="share-0"]');
    await cli('check', 'dialog[open] [data-dependency-check="memory-group-1"]');
    assert.equal(await evaluate('document.querySelector("dialog[open] [data-confirm-accept]").disabled'), true, '还差不可恢复确认');
    await cli('check', 'dialog[open] [data-acknowledge-check]');
    assert.equal(await evaluate('document.querySelector("dialog[open] [data-confirm-accept]").disabled'), false);
    await cli('click', 'dialog[open] [data-confirm-accept]');
    await waitFor('document.querySelector("[data-inbox-permanent-outcome]") !== null', '永久删除结果');
    assert.match(await evaluate('document.querySelector("[data-inbox-permanent-outcome]").textContent'), /有效分享 1 个，记忆组 1 个/u);
    assert.match(await evaluate('document.querySelector("[data-inbox-permanent-outcome]").textContent'), /设备权威日志与工作区文件保留/u);
    assert.ok(Number(await evaluate('document.querySelector("[data-permanent-released]").dataset.bytes')) >= 0);
    assert.equal(store.getSession('session-inbox-c'), undefined, '永久删除移除归属记录');
    assert.equal(shareStore.get(inboxShare.token), undefined, '永久删除移除分享记录');
    assert.equal(existsSync(join(root, 'sessions', 'session-inbox-c', 'events.jsonl')), true, '设备权威日志保留');
    await waitFor('document.querySelector("[data-inbox-item=\\"session-inbox-c\\"]") === null', '收件箱刷新');

    // 5. 导出当前视图：字段清单式构造，界面上没有内部游标。
    await cli('click', '[data-export-button]');
    await waitFor('document.querySelector("[data-export-preview]") !== null', '导出预览');
    const href = await evaluate('document.querySelector("[data-export-download]").getAttribute("href")');
    assert.match(href, /^blob:/u, '导出使用真实 Blob 地址');
    const exportedText = await evaluate(`fetch(${JSON.stringify(href)}).then((response) => response.text())`);
    const exported = JSON.parse(exportedText);
    assert.equal(exported.kind, 'chatdsh-data-management');
    assert.ok(exported.usage.totalBytes > 0, '导出包含用量读数');
    assert.equal(exported.lineage.self.sessionId, forkedId, '导出包含最近查询的血缘');
    assert.equal(exported.inbox.permanentScope.dependencies.length, 2, '导出包含永久删除范围');
    for (const blocked of BLOCKED) {
      assert.equal(exportedText.includes(blocked), false, `导出文件不得包含 ${blocked}`);
    }
    const sectionHtml = await evaluate(`(() => {
      const section = document.querySelector('[data-section=data-management]').cloneNode(true);
      for (const node of section.querySelectorAll('script, style')) node.remove();
      return section.outerHTML;
    })()`);
    for (const blocked of BLOCKED) {
      assert.equal(String(sectionHtml).includes(blocked), false, `界面不得出现 ${blocked}`);
    }
    assert.deepEqual(await evaluate('window.__wp28Errors'), []);

    const relayText = relay.map((item) => JSON.stringify(item.body)).join('\n');
    for (const action of ['data-lineage-read', 'data-fork-estimate', 'data-fork-create', 'data-restore', 'data-permanent-delete', 'data-usage-export']) {
      assert.ok(relayText.includes(action), `遥测里记录了动作 ${action}`);
    }
    assert.ok(relayText.includes('chatdsh.client.remote.call'), '数据调用写了 span');
    assert.equal(relayText.includes('/work/alpha'), false, '遥测里没有工作目录');
    assert.equal(relayText.includes('待删除的会话丙'), false, '遥测里没有会话标题');
    assert.equal(relayText.includes('session-inbox-c'), false, '遥测里没有会话标识');
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
