// WP33 验收：权限向导、持续指示、一键中断、多窗口一致与审计。
//
// 面板由 esbuild 从真实源码打包，装进真实 Chrome。页面里的数据入口走真实 HTTP，服务端是
// 权限与租约模块 `desktop/control/` 的真实实现：一个实例按本机平台声明（不提供能力），另一个
// 按 Windows 声明并接入符合接口约定的控制提供方。两个标签页连同一个实例，中断在一个窗口
// 按下、另一个窗口必须看到同一个结果。断言来自 DOM、计算样式、页面错误与浏览器发出的界面
// 动作遥测。
//
// 运行：node --test e2e/unit/client-complete-wp33-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { createControlHttpHandler, CONTROL_PREFIX } from '../../desktop/control/http.mjs';
import { createDesktopControl } from '../../desktop/control/index.mjs';

const execute = promisify(execFile);
const RUNTIME = resolve(import.meta.dirname, '../..');
const PACKAGE = join(RUNTIME, 'packages/client/desktop-control');
const NODE_BIN = '/usr/local/nvm/versions/node/v24.19.0/bin';
const AGENT_BROWSER = `${NODE_BIN}/agent-browser`;
const ROOT = new URL('../../', import.meta.url);

/** 页面入口：挂真实面板，另外暴露一次动作探测，用来验证中断之后不再放行动作。 */
const ENTRY = `
import { createRoot } from 'react-dom/client';
import { DesktopControlSurface, browserTelemetry, createControlGateway, ensureControlStyles, runControlAction } from '../../packages/client/desktop-control/src/client/index.tsx';
ensureControlStyles(document);
const config = window.__wp33Config;
const gateway = createControlGateway({ prefix: config.prefix });
window.__wp33 = { gateway };
window.__wp33Probe = async (action) => {
  try {
    const permit = await runControlAction(gateway, { action, run: async (granted) => granted }, browserTelemetry);
    return { permitted: true, permitId: permit.permitId };
  } catch (error) {
    return { permitted: false, code: error.code };
  }
};
createRoot(document.getElementById('root')).render(
  <DesktopControlSurface gateway={gateway} telemetry={browserTelemetry} pollIntervalMs={config.pollIntervalMs} auditLimit={12} />,
);
`;

/** 按接口约定实现的提供方，系统授权结果由 `granted` 决定。 */
function controlProvider({ granted = true } = {}) {
  const state = {
    accessibility: granted,
    'screen-recording': granted,
    'screen-capture': granted,
    'input-injection': granted,
  };
  return {
    name: '@deepseek-ai/dsh-computer-use',
    version: '0.1.6-alpha.1',
    capabilities() {
      return ['screen-capture', 'input-injection', 'window-enumeration'];
    },
    async checkPermissions() {
      return { ...state };
    },
    async requestPermissions() {
      return { ...state };
    },
  };
}

/** 建立本包的依赖链接，内容与安装之后一致。 */
function ensureWorkspaceLinks() {
  const modules = join(PACKAGE, 'node_modules', '@chatdsh');
  mkdirSync(modules, { recursive: true });
  const link = join(modules, 'core-ui-kit');
  if (existsSync(link)) return;
  symlinkSync('../../../../core/ui-kit', link, 'dir');
}

test('真实 Chrome 验证向导、指示条、一键中断、多窗口一致与审计', { timeout: 600_000 }, async (t) => {
  const home = allocateIndependentHome('wp33-browser');
  const session = `wp33-browser-${randomUUID().slice(0, 8)}`;
  const env = {
    ...process.env,
    PATH: `${NODE_BIN}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: home,
    DSH_HOME: home,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
    AGENT_BROWSER_PROFILE: join(home, 'chrome'),
    AGENT_BROWSER_ARGS: '--no-sandbox',
  };
  const cli = async (...args) => {
    const result = await execute(AGENT_BROWSER, ['--session', session, '--json', ...args], { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  const evaluate = async (expression) => (await cli('eval', expression)).data.result;
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(125);
    }
    assert.fail(`等待超时：${message}`);
  };
  const click = async (selector) => {
    const clicked = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.click(); return true; })()`);
    assert.equal(clicked, true, `找不到可以点击的元素：${selector}`);
  };
  /** 走真实数据入口发起一次受控动作，返回是否放行以及失败代码。 */
  const probe = async (action) => JSON.parse(await evaluate(
    `(async () => JSON.stringify(await window.__wp33Probe(${action === undefined ? '' : JSON.stringify(action)})))()`,
  ));

  const unsupported = createDesktopControl({
    platform: 'linux',
    provider: controlProvider(),
    auditFile: join(home, 'unsupported', 'audit.jsonl'),
  });
  const supported = createDesktopControl({
    platform: 'win32',
    osVersion: '10.0.22631',
    provider: controlProvider(),
    auditFile: join(home, 'supported', 'audit.jsonl'),
  });
  const handleUnsupported = createControlHttpHandler({ control: unsupported, prefix: `/unsupported${CONTROL_PREFIX}` });
  const handleSupported = createControlHttpHandler({ control: supported, prefix: `/supported${CONTROL_PREFIX}` });
  const relayed = [];
  let server;
  let opened = false;

  try {
    const bundle = await build({
      stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wp33-entry.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      target: 'es2022',
      logLevel: 'warning',
      alias: { '@chatdsh/core-ui-kit': join(RUNTIME, 'packages/core/ui-kit/src/index.ts') },
    });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const script = bundle.outputFiles[0].text;
    const pageOf = (prefix) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>桌面控制验收</title><style>${tokens}\n${UI_KIT_CSS}\nbody{margin:0;padding:16px;background:var(--chatdsh-bg);color:var(--chatdsh-ink)}</style></head><body><main id="root"></main><script>window.__wp33Config=${JSON.stringify({ prefix, pollIntervalMs: 300 })};</script><script>${script}</script></body></html>`;

    const pageFor = (pathname) => {
      if (pathname === '/unsupported/window') return pageOf(`/unsupported${CONTROL_PREFIX}`);
      if (pathname === '/supported/primary' || pathname === '/supported/secondary') return pageOf(`/supported${CONTROL_PREFIX}`);
      return undefined;
    };

    server = createServer(async (request, response) => {
      if (request.url === '/chatdsh/telemetry/browser') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        relayed.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET') {
        const page = pageFor(new URL(request.url, 'http://127.0.0.1').pathname);
        if (page !== undefined) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(page);
          return;
        }
      }
      if (await handleUnsupported(request, response)) return;
      if (await handleSupported(request, response)) return;
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'object-not-found' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;

    await t.test('不支持的平台只说明缺口，没有申请与执行入口', async () => {
      await cli('open', `${origin}/unsupported/window`);
      opened = true;
      await waitFor('document.querySelector("#chdsh-control-wizard") !== null', '向导渲染');
      await waitFor('document.querySelector("#chdsh-control-capability") !== null', '能力块渲染');
      const capability = JSON.parse(await evaluate(`JSON.stringify({
        supported: document.querySelector('#chdsh-control-capability').dataset.supported,
        gaps: [...document.querySelectorAll('.chdsh-control-wizard__gaps li')].map((node) => node.textContent),
        begin: document.querySelector('#chdsh-control-begin') !== null,
        indicator: document.querySelector('#chdsh-control-indicator') !== null,
        notice: document.body.textContent,
      })`));
      assert.equal(capability.supported, 'no');
      assert.equal(capability.gaps.length, 1);
      assert.ok(capability.gaps[0].includes('Linux') || capability.gaps[0].includes('linux'), capability.gaps[0]);
      assert.ok(capability.gaps[0].includes('没有声明能力'), capability.gaps[0]);
      assert.equal(capability.begin, false, '不支持的平台没有申请入口');
      assert.equal(capability.indicator, false, '没有租约时不显示指示条');
      assert.ok(capability.notice.includes('不提供桌面控制'), capability.notice.slice(0, 300));
      assert.deepEqual(await probe('click'), { permitted: false, code: 'lease-missing' });
      assert.deepEqual((await cli('errors')).data.errors, []);
    });

    await t.test('逐项确认之后授权，指示条给出目标、时长与期限', async () => {
      await cli('open', `${origin}/supported/primary`);
      await waitFor('document.querySelector("#chdsh-control-begin") !== null', '申请入口出现');
      const requirements = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#chdsh-control-capability li')].map((node) => node.textContent))`));
      assert.equal(requirements.length, 2);
      assert.ok(requirements[0].includes('屏幕采集'));
      assert.ok(requirements[1].includes('输入注入'));
      assert.ok(requirements[0].includes('未授权'));

      await cli('fill', '#chdsh-control-purpose', '由模型整理表格数据。');
      assert.equal(await evaluate('document.querySelector("#chdsh-control-purpose").value'), '由模型整理表格数据。');
      await cli('focus', '#chdsh-control-scope-region');
      await cli('press', 'Space');
      assert.equal(await evaluate('document.querySelector("#chdsh-control-scope-region").checked'), true);
      assert.equal(await evaluate('document.querySelector("#chdsh-control-display") !== null'), true, '区域范围给出坐标字段');
      await cli('focus', '#chdsh-control-scope-window');
      await cli('press', 'Space');
      assert.equal(await evaluate('document.querySelector("#chdsh-control-app") !== null'), true, '窗口范围给出应用字段');
      await cli('focus', '#chdsh-control-begin');
      await cli('press', 'Enter');
      await waitFor('document.querySelector("#chdsh-control-pending") !== null', '逐项确认清单出现');

      const items = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#chdsh-control-pending li .chdsh-control-wizard__item-title')].map((node) => node.textContent))`));
      assert.deepEqual(items, ['用途', '作用范围', '授权期限', '屏幕采集', '输入注入']);
      const confirmDisabled = await evaluate('document.querySelector("#chdsh-control-confirm-purpose").disabled');
      assert.equal(confirmDisabled, true, '未勾选时确认按钮不可用');

      const ids = ['purpose', 'scope', 'duration', 'permission-screen-capture', 'permission-input-injection'];
      for (const id of ids) {
        await click(`[id="chdsh-control-check-${id}"]`);
        await click(`[id="chdsh-control-confirm-${id}"]`);
        if (id !== ids.at(-1)) {
          await waitFor(`document.querySelector('[data-item-id="${id}"]').dataset.confirmed === 'yes'`, `条目 ${id} 记为已确认`);
        }
      }
      await waitFor('document.querySelector("#chdsh-control-granted") !== null', '授权完成');
      await waitFor('document.querySelector("#chdsh-control-indicator") !== null', '指示条出现');
      const bar = JSON.parse(await evaluate(`JSON.stringify({
        status: document.querySelector('#chdsh-control-indicator').dataset.leaseStatus,
        leaseId: document.querySelector('#chdsh-control-indicator').dataset.leaseId,
        summary: document.querySelector('#chdsh-control-summary').textContent,
        target: document.querySelector('#chdsh-control-target').textContent,
        scope: document.querySelector('#chdsh-control-scope').textContent,
        elapsed: document.querySelector('#chdsh-control-elapsed').textContent,
        remaining: document.querySelector('#chdsh-control-remaining').textContent,
        position: getComputedStyle(document.querySelector('#chdsh-control-indicator')).position,
        top: document.querySelector('#chdsh-control-indicator').getBoundingClientRect().top,
        live: document.querySelector('#chdsh-control-indicator').getAttribute('aria-live'),
        role: document.querySelector('#chdsh-control-indicator').getAttribute('role'),
      })`));
      assert.equal(bar.status, 'active');
      assert.ok(bar.summary.includes('桌面控制进行中'));
      assert.ok(bar.target.includes('notepad.exe'), bar.target);
      assert.ok(bar.scope.includes('目标窗口'), bar.scope);
      assert.ok(/已运行 \d+ 秒/.test(bar.elapsed), bar.elapsed);
      assert.ok(/剩余 \d+ 分 \d+ 秒/.test(bar.remaining), bar.remaining);
      assert.equal(bar.position, 'sticky');
      assert.ok(bar.top >= 0 && bar.top < 40, `指示条应在视口顶部，实际 ${bar.top}`);
      assert.equal(bar.live, 'polite');
      assert.equal(bar.role, 'status');
      assert.ok(bar.leaseId.startsWith('lease-'));

      const first = bar.elapsed;
      await delay(1_300);
      const later = await evaluate('document.querySelector("#chdsh-control-elapsed").textContent');
      assert.notEqual(later, first, '运行时长随真实时间增长');
      assert.deepEqual((await cli('errors')).data.errors, []);
    });

    await t.test('暂停期间不放行动作，恢复之后照原期限继续', async () => {
      await click('#chdsh-control-pause');
      await waitFor('document.querySelector("#chdsh-control-indicator").dataset.leaseStatus === "paused"', '状态切到暂停');
      const paused = await evaluate('document.querySelector("#chdsh-control-pause").textContent');
      assert.equal(paused, '继续');
      assert.deepEqual(await probe(), { permitted: false, code: 'lease-paused' });
      const remainingWhilePaused = Number(await evaluate('document.querySelector("#chdsh-control-indicator").dataset.remainingMs'));
      assert.ok(remainingWhilePaused > 0, '暂停不改变期限');
      await click('#chdsh-control-pause');
      await waitFor('document.querySelector("#chdsh-control-indicator").dataset.leaseStatus === "active"', '状态切回有效');
      const permitted = await probe('click');
      assert.equal(permitted.permitted, true);
    });

    await t.test('第二窗口看到同一份状态，中断之后两个窗口一致且不再放行动作', async () => {
      const primaryLease = await evaluate('document.querySelector("#chdsh-control-indicator").dataset.leaseId');
      const primaryRemaining = Number(await evaluate('document.querySelector("#chdsh-control-indicator").dataset.remainingMs'));
      await cli('tab', 'new', `${origin}/supported/secondary`);
      await waitFor('document.querySelector("#chdsh-control-indicator") !== null', '第二窗口的指示条出现');
      const secondary = JSON.parse(await evaluate(`JSON.stringify({
        leaseId: document.querySelector('#chdsh-control-indicator').dataset.leaseId,
        status: document.querySelector('#chdsh-control-indicator').dataset.leaseStatus,
        target: document.querySelector('#chdsh-control-target').textContent,
        remaining: Number(document.querySelector('#chdsh-control-indicator').dataset.remainingMs),
      })`));
      assert.equal(secondary.leaseId, primaryLease, '两个窗口显示同一份租约');
      assert.equal(secondary.status, 'active');
      assert.ok(secondary.target.includes('notepad.exe'));
      assert.ok(secondary.remaining > 0 && secondary.remaining <= primaryRemaining, '两个窗口的剩余期限一致');

      await click('#chdsh-control-interrupt');
      await waitFor('document.querySelector("#chdsh-control-indicator").dataset.leaseStatus === "interrupted"', '第二窗口显示已中断');
      const stopped = await probe('click');
      assert.deepEqual(stopped, { permitted: false, code: 'lease-interrupted' }, '中断之后不再产生新动作');
      const endedText = await evaluate('document.querySelector("#chdsh-control-summary").textContent');
      assert.ok(endedText.includes('已中断'), endedText);
      assert.equal(await evaluate('document.querySelector("#chdsh-control-interrupt") === null'), true, '结束之后没有中断按钮');

      const tabs = (await cli('tab', 'list', '--json')).data.tabs;
      const first = tabs[0];
      await cli('tab', first.tabId ?? first.id);
      await waitFor('document.querySelector("#chdsh-control-indicator") !== null', '第一窗口仍然是同一个页面');
      await waitFor('document.querySelector("#chdsh-control-indicator").dataset.leaseStatus === "interrupted"', '第一窗口同步到已中断');
      assert.equal(await evaluate('document.querySelector("#chdsh-control-indicator").dataset.leaseId'), primaryLease);
      assert.deepEqual(await probe('click'), { permitted: false, code: 'lease-interrupted' });
      assert.deepEqual((await cli('errors')).data.errors, []);
    });

    await t.test('审计列出时间、范围、期限与结果', async () => {
      await click('#chdsh-control-audit-refresh');
      await waitFor('document.querySelectorAll("#chdsh-control-audit li").length > 0', '审计记录出现');
      const rows = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#chdsh-control-audit li')].map((node) => node.textContent))`));
      const text = rows.join('\n');
      for (const kind of ['授权', '动作', '中断', '暂停', '恢复']) {
        assert.ok(text.includes(kind), `审计里没有 ${kind}：${text.slice(0, 400)}`);
      }
      assert.ok(/范围 目标窗口 notepad\.exe/.test(text), text.slice(0, 400));
      assert.ok(/期限 \d{4}/.test(text), '记录里有期限时刻');
      assert.ok(/已授权|已放行|已中断|已拒绝/.test(text));
      const settings = await evaluate('document.querySelector("#chdsh-control-settings")');
      assert.equal(settings, null, '授权完成之后没有拒绝块');
    });

    await t.test('界面动作写进浏览器遥测，且不带用途与目标原文', async () => {
      const awaiting = async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const bodies = relayed.join('\n');
          if (bodies.includes('control-interrupt') && bodies.includes('control-grant')) return bodies;
          await delay(50);
        }
        return relayed.join('\n');
      };
      const bodies = await awaiting();
      assert.ok(bodies.includes('chatdsh.client.ui.action'), '中继没有收到界面动作');
      for (const action of ['control-request', 'control-grant', 'control-pause', 'control-resume', 'control-interrupt', 'control-audit-open']) {
        assert.ok(bodies.includes(action), `遥测里缺少动作 ${action}`);
      }
      assert.ok(bodies.includes('"failed"'), '暂停期间的拒绝也记录在界面动作里');
      assert.equal(bodies.includes('由模型整理表格数据'), false, '遥测里没有用途原文');
      assert.equal(bodies.includes('notepad.exe'), false, '遥测里没有目标应用标识');
      assert.equal(bodies.includes('audio'), false);
    });

    await t.test('样式只引用令牌，没有颜色字面值', async () => {
      const report = JSON.parse(await evaluate(`(() => {
        const style = document.getElementById('chdsh-desktop-control-styles');
        const text = style.textContent;
        const used = [...text.matchAll(/var\\((--[a-zA-Z0-9-]+)\\)/g)].map((match) => match[1]);
        const defined = new Set([...document.styleSheets].flatMap((sheet) => {
          try { return [...sheet.cssRules].flatMap((rule) => [...(rule.cssText.matchAll(/(--[a-zA-Z0-9-]+)\\s*:/g))].map((match) => match[1])); }
          catch { return []; }
        }));
        const inline = [...document.querySelectorAll('style')].flatMap((node) => [...(node.textContent.matchAll(/(--[a-zA-Z0-9-]+)\\s*:/g))].map((match) => match[1]));
        const all = new Set([...defined, ...inline]);
        return JSON.stringify({
          missing: [...new Set(used)].filter((name) => !all.has(name)),
          literals: text.match(/#[0-9a-fA-F]{3,8}\\b|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)/g) ?? [],
        });
      })()`));
      assert.deepEqual(report.missing, [], '样式引用了未定义的令牌');
      assert.deepEqual(report.literals, [], '样式出现颜色字面值');
    });

    await t.test('客户端包清单与宿主侧入口', async () => {
      ensureWorkspaceLinks();
      execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', join(PACKAGE, 'tsconfig.json')], { cwd: RUNTIME, stdio: 'inherit' });
      const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
      assert.equal(manifest.name, '@chatdsh/client-desktop-control');
      assert.equal(manifest.main, 'lib/index.js');
      assert.equal(manifest.exports['.'].default, './lib/index.js');
      assert.equal(manifest.exports['./client'].default, './lib/client.js');
      assert.equal(manifest.dsh.client.platform, 'web');
      assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings']);
      assert.deepEqual(manifest.chatdsh.telemetry, { events: ['chatdsh.client.ui.action'], spans: [], metrics: [] });
      assert.equal(manifest.dependencies['@chatdsh/core-ui-kit'], 'workspace:*');
      assert.equal(existsSync(join(PACKAGE, 'lib/client.js')), true, '缺少浏览器侧产物');

      const host = await import(join(PACKAGE, 'lib/index.js'));
      assert.equal(host.CLIENT_ENTRY, './client');
      assert.equal(host.PANEL_ID, 'chatdsh-desktop-control');
      assert.equal(typeof host.apply, 'function');
      assert.equal(typeof host.runControlAction, 'function');
      assert.equal(host.formatDuration(65_000), '1 分 05 秒');
      assert.equal(host.formatDuration(9_000), '9 秒');
      assert.equal(host.formatDuration(0), '0 秒');
      const state = {
        capability: { platform: 'win32', platformLabel: 'Windows', supported: true, available: true, capabilities: [], gaps: [], notice: 'Windows 支持桌面控制' },
        requirements: [],
        permissions: {},
        lease: {
          leaseId: 'lease-1',
          scope: { kind: 'window', applicationId: 'notepad.exe', windowId: 'main' },
          grantedAt: 1_000,
          expiresAt: 61_000,
          status: 'active',
          paused: false,
          actionCount: 2,
        },
        remainingMs: 30_000,
        activeActions: 0,
        now: 31_000,
      };
      assert.equal(host.isLeaseActive(state.lease), true);
      assert.equal(host.remainingOf(state), 30_000);
      assert.equal(host.elapsedOf(state), 30_000);
      assert.equal(host.canAct(state), true);
      assert.equal(host.canPause(state), true);
      assert.equal(host.canInterrupt(state), true);
      assert.equal(host.targetLabel(state.lease.scope), 'notepad.exe');
      assert.ok(host.scopeLabel(state.lease.scope).includes('目标窗口'));
      assert.equal(host.indicatorSummary(state).includes('桌面控制进行中'), true);
      assert.equal(host.leaseStatusLabel({ ...state.lease, status: 'paused', paused: true }), '已暂停');
      assert.equal(host.canAct({ ...state, lease: { ...state.lease, status: 'paused', paused: true } }), false);
      assert.equal(host.canAct({ ...state, lease: { ...state.lease, status: 'interrupted' } }), false);
      assert.equal(host.canRequest({ ...state, capability: { ...state.capability, supported: false } }), false);
      const audit = host.describeAuditEntry({
        at: Date.UTC(2026, 10, 2, 4, 0, 0),
        time: '2026-11-02T04:00:00.000Z',
        kind: 'grant',
        outcome: 'granted',
        scope: { kind: 'region', displayId: '1', x: 0, y: 0, width: 800, height: 600 },
        expiresAtTime: '2026-11-02T04:05:00.000Z',
      });
      assert.equal(audit.kind, '授权');
      assert.equal(audit.outcome, '已授权');
      assert.ok(audit.scope.includes('800×600'));
      assert.ok(audit.expires.includes('2026'));
      assert.equal(host.ERROR_LABELS['lease-interrupted'], '授权已中断');
      assert.deepEqual(host.DURATION_CHOICES.map((choice) => choice.minutes), [5, 15, 30, 60]);
    });
  } finally {
    if (opened) await cli('close');
    unsupported.dispose();
    supported.dispose();
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    releaseIndependentHome(home);
  }
});
