// WP08 的真实浏览器验收：两个真实浏览器客户端在同一套真实宿主上审批、提问与计划接管。
//
// 页面由测试自己的 HTTP 服务提供，取数走同源端点，端点直接调用真实的宿主服务；宿主的后面是
// 真实的会话、代理、工具运行时、审批服务与用户提问服务，因此「决定到达工具等待者」由工具本体
// 是否执行来证明，「答案回填」由提问调用收到的批次来证明。浏览器由 agent-browser 驱动，
// 使用独立的 session、HOME、TMPDIR 与 profile 目录，不使用截图。
//
// 覆盖：默认焦点不落在危险按钮、Tab 焦点顺序、Escape 不误批、批准之后工具执行、两个客户端
// 竞争同一卡片、离线不发送决定、提问的选择题与自由输入、跳过、计划接管只有一处编辑区、
// 草稿恢复、提交回填、失效卡片说明与统计。
//
// 运行：node --test e2e/unit/client-complete-wp08-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureDeps(resolve(RUNTIME, '..', 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent');
const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
const { default: UserQuestions } = await import('@deepseek-ai/dsh-user-questions');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime, defineTool } = await import('@deepseek-ai/dsh-tools');
const { default: ApprovalService } = await import('@deepseek-ai/dsh-user-approval');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const approvalHost = await import('../../packages/host/approval/lib/index.js');

const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const CHROME = '/usr/bin/google-chrome';

/** 页面入口：挂载审批界面，把控制器暴露给测试。 */
const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { createApprovalRuntime } from './packages/client/approval/lib/client/index.js';

const params = new URLSearchParams(location.search);
const clientId = params.get('client') ?? 'tab-a';
const scopeSession = params.get('session');
const errors = [];
window.__errors = errors;
window.addEventListener('error', (event) => errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

const transport = {
  pending: (query) => post('pending', query),
  stats: (sessionId) => post('stats', { sessionId: sessionId ?? '' }),
  policies: () => post('policies', {}),
  questions: () => post('questions', {}),
  decide: (request) => post('decide', request),
  answerQuestion: (request) => post('answerQuestion', request),
  skipQuestion: (request) => post('skipQuestion', request),
  takeover: (request) => post('takeover', request),
  savePlanDraft: (request) => post('savePlanDraft', request),
  submitPlan: (request) => post('submitPlan', request),
};

async function post(method, body) {
  const response = await fetch('/approval/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error('端点 ' + method + ' 返回 ' + response.status);
  return response.json();
}

const runtime = createApprovalRuntime(document.querySelector('#root'), {
  transport,
  clientId,
  clientLabel: clientId === 'tab-a' ? '本机浏览器' : '手机浏览器',
  deviceId: 'device-alpha',
  windowId: clientId + '-window',
  storage: window.localStorage,
  ...(scopeSession === null ? {} : { sessionId: scopeSession }),
  navigate: (sessionId) => { window.__navigated = sessionId; location.hash = '#/session/' + encodeURIComponent(sessionId); },
});

const root = createRoot(document.querySelector('#root'));
root.render(runtime.element());
window.__runtime = runtime;
window.__controller = runtime.controller();
void runtime.refresh().then(() => { window.__ready = true; });
window.__refresh = () => runtime.refresh();
`;

/** 页面外壳。 */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WP08 审批验收</title></head>
<body><main id="root"></main><script type="module" src="/app.js"></script></body></html>`;

/**
 * 起一个真实的宿主环境。
 * @param {string} home - 独立数据根。
 * @returns {Promise<object>} 服务、代理、执行记录与清理函数。
 */
async function openHost(home) {
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(SessionProjectionRegistry);
  new SystemPrompt(ctx, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop);
  await ctx.plugin(UserQuestions);
  new ApprovalService(ctx, { policy: 'ask' });

  const executed = [];
  ctx.tools.register(defineTool({
    name: 'wp08-write',
    description: '写入一个文件',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: '已写入' }],
    },
    execute: async (args) => {
      executed.push(args.path);
      return { ok: true };
    },
  }));
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'wp08-write') return next();
    return { kind: 'ask', reason: '工作区之外写入' };
  });

  const service = new approvalHost.ChatdshApprovalService(ctx, {
    takeOver: true,
    answerTimeoutMs: 120_000,
    questionTimeoutMs: 120_000,
    deviceId: 'device-alpha',
  });
  await service[TypertRemoteService.init]();
  const handle = await ctx.agents.create({ sessionId: `wp08-browser-${randomUUID().slice(0, 6)}` });
  const agent = handle.agent;
  return {
    ctx,
    service,
    agent,
    executed,
    async dispose() {
      await ctx.fiber.dispose();
    },
  };
}

/**
 * 起 HTTP 服务：页面、打包产物、审批端点与测试用的触发器。
 * @param {string} bundle - 打包后的页面脚本。
 * @param {object} host - 宿主环境。
 * @returns {Promise<object>} 服务信息与执行记录。
 */
async function startServer(bundle, host) {
  const toolCalls = new Map();
  const questionCalls = new Map();
  const counters = { decide: 0, answerQuestion: 0, skipQuestion: 0 };
  const state = { executed: host.executed, navigated: [], toolCalls: {}, questions: {} };

  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : JSON.parse(text);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local.invalid');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    if (url.pathname === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    if (url.pathname === '/state') {
      json(response, { ...state, counters, executed: host.executed });
      return;
    }
    if (url.pathname === '/trigger/approval' && request.method === 'POST') {
      const body = await readBody(request);
      host.agent.session.append('turn/start', { turn: host.agent.session.seq });
      const pending = host.ctx.tools.execute({
        callId: body.callId,
        name: 'wp08-write',
        arguments: { path: `/workspace/${body.callId}.txt` },
        agent: host.agent,
        signal: new AbortController().signal,
      });
      toolCalls.set(body.callId, pending);
      pending.then((result) => {
        state.toolCalls[body.callId] = { isError: result.isError === true };
      });
      json(response, { started: true });
      return;
    }
    if (url.pathname === '/trigger/question' && request.method === 'POST') {
      const body = await readBody(request);
      const pending = host.ctx.userQuestions.ask({
        questions: [
          { id: 'q-color', header: '样式', question: '用哪种颜色？', options: [{ label: '蓝色' }, { label: '绿色' }] },
          { id: 'q-note', question: '还有什么要求？', options: [{ label: '没有' }] },
        ],
        agent: host.agent,
        wait: { callId: body.callId },
      });
      questionCalls.set(body.callId, pending);
      pending.then((answer) => {
        state.questions[body.callId] = answer.answers;
      }, (error) => {
        state.questions[body.callId] = { error: String(error) };
      });
      json(response, { started: true });
      return;
    }
    if (url.pathname === '/trigger/plan' && request.method === 'POST') {
      const body = await readBody(request);
      const pending = host.ctx.userQuestions.ask({
        questions: [{
          id: 'plan-review',
          header: '计划审阅',
          question: '批准这份计划并退出计划模式吗？',
          detail: '# 计划\n\n1. 收集事实\n2. 写入改动',
          options: [{ label: '批准执行' }, { label: '继续规划' }],
          intent: { kind: 'plan-review', approve: '批准执行', callId: body.callId },
        }],
        agent: host.agent,
      });
      questionCalls.set(body.callId, pending);
      pending.then((answer) => {
        state.questions[body.callId] = answer.answers;
      }, (error) => {
        state.questions[body.callId] = { error: String(error) };
      });
      json(response, { started: true });
      return;
    }
    if (url.pathname.startsWith('/approval/') && request.method === 'POST') {
      const method = url.pathname.slice('/approval/'.length);
      const body = await readBody(request);
      try {
        switch (method) {
          case 'pending': json(response, host.service.pending(body)); return;
          case 'stats': json(response, host.service.stats(body.sessionId ?? '')); return;
          case 'policies': json(response, host.service.policies()); return;
          case 'questions': json(response, host.service.questionCards()); return;
          case 'decide': counters.decide += 1; json(response, host.service.decide(body)); return;
          case 'answerQuestion': counters.answerQuestion += 1; json(response, host.service.answerQuestion(body)); return;
          case 'skipQuestion': counters.skipQuestion += 1; json(response, host.service.skipQuestion(body)); return;
          case 'takeover': json(response, host.service.takeover(body)); return;
          case 'savePlanDraft': json(response, host.service.savePlanDraft(body)); return;
          case 'submitPlan': json(response, host.service.submitPlan(body)); return;
          default: json(response, { error: `未知端点 ${method}` }, 404); return;
        }
      } catch (error) {
        json(response, { error: String(error) }, 500);
        return;
      }
    }
    json(response, { error: 'not found' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    counters,
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

test('真实 Chrome：审批、竞争、离线、提问与计划接管', { timeout: 420_000 }, async () => {
  const home = allocateIndependentHome('wp08-browser');
  const session = `wp08-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    TMPDIR: home,
    HOME: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: CHROME,
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], {
      env,
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };

  const host = await openHost(home);
  const bundle = await build({
    stdin: { contents: PAGE_ENTRY, resolveDir: RUNTIME, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  });
  const server = await startServer(bundle.outputFiles[0].text, host);
  const evalJs = async (expression) => (await cli('eval', expression)).data.result;
  const waitFor = (expression) => cli('wait', '--fn', expression);
  // 页签标识形如 t1、t2，跨命令稳定；第二个客户端用它切回去。
  const firstTab = 't1';
  let secondTab;
  const openTab = async (label) => {
    await cli('tab', 'new', `${server.origin}/?client=${label}`);
    const listed = await cli('tab', 'list', '--json');
    secondTab = (listed.data.tabs ?? []).find((tab) => tab.active === true)?.tabId;
    assert.ok(secondTab !== undefined, '第二个客户端应当有一个页签标识');
    await waitFor(`window.__ready === true && window.__controller !== undefined`);
    return label;
  };
  const readState = async () => JSON.parse(await (await fetch(`${server.origin}/state`)).text());
  /**
   * 触发一次宿主侧的等待，然后反复刷新，直到界面出现预期内容。
   * @param path - 触发器路径。
   * @param body - 请求体。
   * @param readyExpression - 界面就绪的判断表达式。
   */
  const trigger = async (path, body, readyExpression) => {
    const response = await fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `触发器 ${path} 失败`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await evalJs('window.__refresh()');
      if (await evalJs(readyExpression)) return;
      await delay(100);
    }
    throw new Error(`等待界面出现超时：${path}`);
  };

  let opened = false;
  try {
    // 一：会话内的卡片。默认焦点在标题，焦点顺序里拒绝在最后，Escape 关闭不发出决定；
    // 扩大范围要经过一次确认，作用范围说明写在确认区里。
    const sessionId = String(host.agent.id);
    await cli('open', `${server.origin}/?client=tab-a&session=${encodeURIComponent(sessionId)}`);
    opened = true;
    await waitFor('window.__ready === true');
    await trigger('/trigger/approval', { callId: 'call-browser-1' }, 'document.querySelector("[data-call-id=\\"call-browser-1\\"]") !== null');
    assert.equal(
      await evalJs('document.querySelector("[data-approval-card]").getAttribute("data-call-id")'),
      'call-browser-1',
    );
    assert.equal(await evalJs('document.body.innerText.includes("工作区之外写入")'), true);
    await cli('click', '[data-action="open-card"]');
    await waitFor('document.querySelector("[data-action=\\"decide-once\\"]") !== null');
    assert.equal(
      await evalJs('document.activeElement.getAttribute("data-focus-id")'),
      'card-call-browser-1-title',
      '打开卡片之后焦点停在标题上',
    );
    const tabOrder = [];
    for (let index = 0; index < 4; index += 1) {
      await cli('press', 'Tab');
      tabOrder.push(await evalJs('document.activeElement.getAttribute("data-action")'));
    }
    assert.deepEqual(tabOrder, ['decide-once', 'decide-session', 'decide-always', 'decide-deny'], '拒绝排在焦点顺序最后');
    await cli('press', 'Escape');
    await delay(200);
    assert.equal((await readState()).counters.decide, 0, 'Escape 不发出决定');
    assert.equal(await evalJs('document.querySelector("[data-approval-card]").getAttribute("data-state")'), 'pending');
    await cli('click', '[data-action="jump-session"]');
    assert.equal(await evalJs('window.__navigated'), sessionId, '打开会话跳到对应会话');

    // 二：本会话允许先进入确认，取消之后没有决定；确认之后决定生效，真实工具执行。
    await cli('click', '[data-action="open-card"]');
    await cli('click', '[data-action="decide-session"]');
    await waitFor('document.querySelector("[data-escalation]") !== null');
    assert.equal(
      await evalJs('document.querySelector("[data-escalation]").textContent.includes("只对本次会话里同一个工具的同类审批生效")'),
      true,
      '确认区写出作用范围',
    );
    await cli('click', '[data-action="cancel-escalation"]');
    await delay(200);
    assert.equal((await readState()).counters.decide, 0, '取消之后没有发出决定');
    await cli('click', '[data-action="decide-once"]');
    await waitFor('document.body.innerText.includes("决定已经交给运行中的工具")');
    await waitFor('document.querySelector("[data-announcer]").textContent.includes("已提交")');
    await delay(300);
    assert.equal(await evalJs('document.querySelector("[data-approval-card]") === null'), true, '处理之后卡片消失');
    assert.deepEqual((await readState()).executed, ['/workspace/call-browser-1.txt'], '真实工具执行了一次');

    // 三：两个真实客户端竞争同一卡片，只成功一次，另一侧看到明确冲突。
    await trigger('/trigger/approval', { callId: 'call-browser-race' }, 'document.querySelector("[data-call-id=\\"call-browser-race\\"]") !== null');
    await openTab('tab-b');
    await waitFor('document.querySelector("[data-call-id=\\"call-browser-race\\"]") !== null');
    await cli('click', '[data-call-id="call-browser-race"] [data-action="open-card"]');
    await cli('click', '[data-call-id="call-browser-race"] [data-action="decide-once"]');
    await waitFor('document.body.innerText.includes("决定已经交给运行中的工具")');
    // 回到第一页：它的卡片还是刷新之前的样子，此时点击会得到冲突结果。
    await cli('tab', firstTab);
    await waitFor('document.querySelector("[data-call-id=\\"call-browser-race\\"]") !== null');
    await cli('click', '[data-call-id="call-browser-race"] [data-action="open-card"]');
    await cli('click', '[data-call-id="call-browser-race"] [data-action="decide-deny"]');
    await waitFor('document.querySelector("[data-conflict]") !== null');
    assert.equal(
      await evalJs('document.querySelector("[data-conflict]").textContent.includes("另一客户端已经处理了这张卡片")'),
      true,
    );
    await delay(300);
    const raced = await readState();
    assert.equal(raced.executed.filter((path) => path === '/workspace/call-browser-race.txt').length, 1, '只执行一次');
    assert.equal(raced.counters.decide >= 2, true);

    // 四：离线时卡片按失效显示并说明原因，决定发不出去。
    await trigger('/trigger/approval', { callId: 'call-browser-offline' }, 'document.querySelector("[data-call-id=\\"call-browser-offline\\"]") !== null');
    const beforeOffline = (await readState()).counters.decide;
    await evalJs('window.__controller.setOnline(false)');
    await waitFor('document.querySelector("[data-offline]") !== null');
    assert.equal(
      await evalJs('document.querySelector("[data-call-id=\\"call-browser-offline\\"]").getAttribute("data-actionable")'),
      'false',
      '离线时卡片不可操作',
    );
    assert.equal(
      await evalJs('document.body.innerText.includes("设备不在线，决定没有发出")'),
      true,
      '离线卡片写出原因',
    );
    assert.equal(
      await evalJs('document.querySelector("[data-call-id=\\"call-browser-offline\\"] [data-action=\\"decide-once\\"]") === null'),
      true,
      '离线卡片不提供决定按钮',
    );
    await evalJs('void window.__controller.decide("call-browser-offline", "once", false)');
    await waitFor('document.body.innerText.includes("设备离线，决定没有发出")');
    assert.equal((await readState()).counters.decide, beforeOffline, '离线时没有发出任何决定');
    assert.equal(await evalJs('document.querySelector("[data-announcer-urgent]").textContent.length > 0'), true, '离线说明走紧急播报');
    await evalJs('window.__controller.setOnline(true)');
    await waitFor('document.querySelector("[data-call-id=\\"call-browser-offline\\"]").getAttribute("data-actionable") === "true"');

    // 五：提问的选择题与自由输入回填真实等待者。
    await trigger('/trigger/question', { callId: 'call-browser-question' }, 'document.querySelector("[data-question-card]") !== null');
    await cli('click', '[data-question-option="绿色"]');
    await cli('fill', '[data-question-free="q-note"]', '不要渐变');
    await cli('click', '[data-action="answer-question"]');
    await waitFor('document.body.innerText.includes("答案已经交给等待中的工具")');
    await delay(300);
    assert.deepEqual((await readState()).questions['call-browser-question'], [
      { id: 'q-color', selected: ['绿色'] },
      { id: 'q-note', selected: [], custom: '不要渐变' },
    ]);

    // 六：跳过是显式结果。
    await trigger('/trigger/question', { callId: 'call-browser-skip' }, 'document.querySelector("[data-question-card][data-call-id=\\"call-browser-skip\\"]") !== null');
    await cli('click', '[data-call-id="call-browser-skip"] [data-action="skip-question"]');
    await waitFor('document.body.innerText.includes("已经跳过这次提问")');
    await delay(300);
    const skipped = (await readState()).questions['call-browser-skip'];
    assert.equal(Array.isArray(skipped), true);
    assert.deepEqual(skipped.map((item) => item.selected), [[], []]);

    // 七：计划接管只有一处编辑区，草稿恢复并提交。
    await trigger('/trigger/plan', { callId: 'call-browser-plan' }, 'document.querySelector("[data-kind=\\"plan-review\\"]") !== null');
    await waitFor('document.querySelector("[data-plan-markdown]").textContent.includes("收集事实")');
    await cli('click', '[data-kind="plan-review"] [data-action="begin-plan"]');
    await waitFor('document.querySelector("[data-plan-editor][data-editable=\\"true\\"]") !== null');

    await cli('tab', secondTab);
    await evalJs('window.__refresh()');
    await waitFor('document.querySelector("[data-kind=\\"plan-review\\"]") !== null');
    await cli('click', '[data-kind="plan-review"] [data-action="begin-plan"]');
    await waitFor('document.querySelector("[data-plan-editor][data-editable=\\"false\\"]") !== null');
    assert.equal(await evalJs('document.querySelector("[data-plan-text]").disabled'), true, '另一侧的编辑区禁用');
    assert.equal(
      await evalJs('document.querySelector("[data-plan-editor]").textContent.includes("正在编辑")'),
      true,
      '禁用说明写出持有者',
    );

    await cli('tab', firstTab);
    await evalJs('window.__refresh()');
    await waitFor('document.querySelector("[data-kind=\\"plan-review\\"]") !== null');
    await cli('click', '[data-kind="plan-review"] [data-action="begin-plan"]');
    await waitFor('document.querySelector("[data-plan-editor][data-editable=\\"true\\"]") !== null');
    await cli('fill', '[data-plan-text]', '# 计划（改）');
    await cli('click', '[data-action="save-plan-draft"]');
    await delay(300);
    await evalJs('window.__refresh()');
    await cli('reload');
    await waitFor('window.__ready === true');
    await waitFor('document.querySelector("[data-kind=\\"plan-review\\"]") !== null');
    await cli('click', '[data-kind="plan-review"] [data-action="begin-plan"]');
    await waitFor('document.querySelector("[data-plan-editor][data-editable=\\"true\\"]")  !== null');
    await waitFor('document.querySelector("[data-plan-text]").value === "# 计划（改）"');
    assert.equal(await evalJs('document.querySelector("[data-plan-text]").value'), '# 计划（改）', '刷新之后草稿恢复');

    await cli('scrollintoview', '[data-action="approve-plan"]');
    await cli('click', '[data-action="approve-plan"]');
    await waitFor('document.body.innerText.includes("计划已批准")');
    await waitFor('document.querySelector("[data-announcer]").textContent.includes("计划已批准")');
    await delay(300);
    assert.deepEqual((await readState()).questions['call-browser-plan'], [
      { id: 'plan-review', selected: ['批准执行'] },
    ]);

    // 七之二：本会话允许之后同类审批不再询问，策略说明出现在统计面板里。
    await trigger('/trigger/approval', { callId: 'call-browser-policy' }, 'document.querySelector("[data-call-id=\\"call-browser-policy\\"]") !== null');
    await cli('click', '[data-call-id="call-browser-policy"] [data-action="open-card"]');
    await cli('click', '[data-call-id="call-browser-policy"] [data-action="decide-session"]');
    await waitFor('document.querySelector("[data-escalation]") !== null');
    await cli('click', '[data-action="confirm-escalation"]');
    await waitFor('document.body.innerText.includes("决定已经交给运行中的工具")');
    await delay(300);
    await evalJs('window.__refresh()');
    await waitFor('document.querySelector("[data-policies]") !== null');
    assert.equal(
      await evalJs('document.querySelector("[data-policies]").textContent.includes("只对本次会话里")'),
      true,
      '策略作用范围写进面板',
    );
    await trigger('/trigger/approval', { callId: 'call-browser-policy-2' }, 'true');
    await delay(300);
    assert.equal(
      await evalJs('document.querySelector("[data-call-id=\\"call-browser-policy-2\\"]") === null'),
      true,
      '命中策略之后不再生成卡片',
    );
    assert.equal((await readState()).executed.includes('/workspace/call-browser-policy-2.txt'), true, '按策略自动批准并执行');

    // 八：失效卡片说明原因，统计给出计数与最近决定。
    await cli('click', '[data-filter="handled"]');
    await waitFor('document.querySelector("[data-invalid-reason]") !== null');
    assert.equal(
      await evalJs('document.body.innerText.includes("另一客户端已经处理了这张卡片")'),
      true,
      '失效卡片写出原因',
    );
    await cli('click', '[data-filter="all"]');
    await waitFor('document.querySelector("[data-stats]") !== null');
    const approved = Number(await evalJs('document.querySelector("[data-stats-approved]").getAttribute("data-stats-approved")'));
    const denied = Number(await evalJs('document.querySelector("[data-stats-denied]").getAttribute("data-stats-denied")'));
    assert.equal(approved >= 1, true, '统计里有批准');
    assert.equal(Number.isInteger(denied), true);
    assert.equal(await evalJs('document.querySelector("[data-recent-decisions]") !== null'), true, '最近决定可见');
    assert.equal(await evalJs('document.querySelector("[data-announcer]").getAttribute("aria-live")'), 'polite');
    assert.equal(await evalJs('document.querySelector("[data-announcer-urgent]").getAttribute("role")'), 'alert');
    assert.deepEqual(JSON.parse(await evalJs('JSON.stringify(window.__errors)')), []);
  } finally {
    if (opened) await cli('close', '--all');
    await server.close();
    await host.dispose();
    releaseIndependentHome(home);
  }
});
