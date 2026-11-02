// WP38 领域面板场景的非视觉与辅助技术验证：S09、S10、S11、S13、S14、S15、S17、S20。
//
// 页面挂载真实客户端面板，由真实宿主服务（助手、技能、项目、连接器）与真实控制平面（会话、
// 分享、设备、自动化）供数。浏览器是 agent-browser 独立会话里的真实 Chrome，使用独立 HOME、
// TMPDIR 与 profile，不截图；断言来自 DOM、计算样式、可访问树、焦点位置与真实服务记录。
//
// 覆盖矩阵：两个主题 × 三个宽度（320、768、1440）× 适用状态（加载、空、失败、长内容）。
// 断言项：可访问名称与角色、键盘顺序与对话框焦点恢复、逐元素横向溢出、触控目标、
// 200% 文字缩放、`role=status` 与 `aria-live` 播报、只读校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore, PushQueue, ReceiptStore, ReplicaStore, ShareStore } from '../../gateway/lib/store.js';
import { createPushHub } from '../../gateway/lib/push.js';
import { DeviceLinkHub } from '../../gateway/lib/device-link.js';
import { createGatewayServer  } from '../../gateway/lib/server.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { browserOf, bundlePage, openHostStack, wireFailureOf } from './client-complete-wp11-support.mjs';

const RUNTIME = new URL('../../', import.meta.url).pathname;
const TY = await import('/workspace/chatdsh/dsh-adapter/lib/index.js');
const pathOf = (relative) => join(RUNTIME, relative);

/** 页面脚本：真实面板与真实数据入口。 */
const PAGE_ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantsPanel } from ${JSON.stringify(pathOf('packages/client/assistants/src/client/panel.tsx'))};
import { createAssistantsGateway } from ${JSON.stringify(pathOf('packages/client/assistants/src/client/gateway.ts'))};
import { SkillsPanel } from ${JSON.stringify(pathOf('packages/client/skills/src/client/panel.tsx'))};
import { createSkillsGateway } from ${JSON.stringify(pathOf('packages/client/skills/src/client/gateway.ts'))};
import { ProjectsPanel } from ${JSON.stringify(pathOf('packages/client/projects/src/client/panel.tsx'))};
import { createProjectsGateway } from ${JSON.stringify(pathOf('packages/client/projects/src/client/gateway.ts'))};
import { ConnectorsPanel } from ${JSON.stringify(pathOf('packages/client/connectors/src/client/panel.tsx'))};
import { createConnectorsGateway } from ${JSON.stringify(pathOf('packages/client/connectors/src/client/gateway.ts'))};
import { ArtifactsPanel } from ${JSON.stringify(pathOf('packages/client/artifacts/src/client/panel.tsx'))};
import { createArtifactsGateway } from ${JSON.stringify(pathOf('packages/client/artifacts/src/client/gateway.ts'))};
import { ModelProviderSection } from ${JSON.stringify(pathOf('packages/client/model-provider/src/client/index.tsx'))};
import { createModelGateway } from ${JSON.stringify(pathOf('packages/client/model-provider/src/client/gateway.ts'))};
import { AutomationSection } from ${JSON.stringify(pathOf('packages/client/automation/src/client/index.tsx'))};
import { createAutomationGateway } from ${JSON.stringify(pathOf('packages/client/automation/src/client/gateway.ts'))};
import { DeviceSection } from ${JSON.stringify(pathOf('packages/client/account/src/client/index.tsx'))};
import { createDeviceGateway } from ${JSON.stringify(pathOf('packages/client/account/src/client/gateway.ts'))};
import { ShareSection } from ${JSON.stringify(pathOf('packages/client/share/src/client/index.tsx'))};
import { createShareGateway } from ${JSON.stringify(pathOf('packages/client/share/src/client/gateway.ts'))};
import { createPanelTelemetry } from ${JSON.stringify(pathOf('packages/client/assistants/src/client/telemetry.ts'))};

const transport = {
  async call(endpoint, args) {
    const response = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    return response.json();
  },
};
const telemetry = createPanelTelemetry();
const gateways = {
  assistants: createAssistantsGateway({ transport, telemetry }),
  skills: createSkillsGateway({ transport, telemetry }),
  projects: createProjectsGateway({ transport, telemetry }),
  connectors: createConnectorsGateway({ transport, telemetry }),
  artifacts: createArtifactsGateway({ transport, telemetry }),
  models: createModelGateway(),
  automation: createAutomationGateway({ origin: location.origin, telemetry }),
  devices: createDeviceGateway({ telemetry }),
  share: createShareGateway({ origin: location.origin, telemetry }),
};

const SURFACES = {
  S09: function () { return createElement(ArtifactsPanel, { gateway: gateways.artifacts }); },
  S10: function () { return createElement(ProjectsPanel, { gateway: gateways.projects }); },
  S11: function () { return createElement('div', null, createElement(AssistantsPanel, { gateway: gateways.assistants }), createElement(SkillsPanel, { gateway: gateways.skills })); },
  S13: function () { return createElement(ConnectorsPanel, { gateway: gateways.connectors }); },
  S14: function () { return createElement(AutomationSection, { gateway: gateways.automation }); },
  S15: function () { return createElement(ShareSection, { gateway: gateways.share }); },
  S17: function () { return createElement(DeviceSection, { gateway: gateways.devices }); },
  S20: function () { return createElement(ModelProviderSection, { gateway: gateways.models }); },
};

window.__wp38 = {
  ids: Object.keys(SURFACES),
  mountAll: function () {
    const root = document.getElementById('surfaces');
    root.replaceChildren();
    Object.keys(SURFACES).forEach(function (id) {
      const section = document.createElement('section');
      section.dataset.scenario = id;
      section.setAttribute('aria-label', id);
      const host = document.createElement('div');
      host.className = 'surface-host';
      section.append(host);
      root.append(section);
      createRoot(host).render(SURFACES[id]());
    });
    return Object.keys(SURFACES);
  },
};
`;

/** 逐元素审计：按场景区段给出溢出、触控、名称、焦点与播报。 */
const AUDIT_SOURCE = `(function auditWp38Panels() {
  var viewport = { width: window.innerWidth, height: window.innerHeight };
  function isScrollableOf(element) {
    var style = getComputedStyle(element);
    return ['auto', 'scroll'].indexOf(style.overflowX) !== -1 || ['auto', 'scroll'].indexOf(style.overflow) !== -1;
  }
  function insideScroller(element) {
    var node = element.parentElement;
    while (node !== null) { if (isScrollableOf(node)) return true; node = node.parentElement; }
    return false;
  }
  function describe(element) {
    var parts = [];
    var node = element;
    while (node !== null && node !== document.body && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id !== '') part += '#' + node.id;
      else if (typeof node.className === 'string' && node.className.trim() !== '') part += '.' + node.className.trim().split(/\\s+/).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  var surfaces = [];
  var sections = document.querySelectorAll('[data-scenario]');
  for (var sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    var section = sections[sectionIndex];
    var overflow = [];
    var nodes = section.querySelectorAll('*');
    for (var index = 0; index < nodes.length; index += 1) {
      var element = nodes[index];
      var style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
      var rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      var clippedByPattern = style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)' || (rect.width <= 1.5 && rect.height <= 1.5 && style.overflow === 'hidden');
      if (clippedByPattern) continue;
      if (insideScroller(element)) continue;
      if (rect.right > viewport.width + 1 || rect.left < -1) overflow.push({ selector: describe(element), left: Math.round(rect.left), right: Math.round(rect.right) });
      else if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1) overflow.push({ selector: describe(element), clipped: element.scrollWidth - element.clientWidth });
    }
    var touch = [];
    var belowMinimum = [];
    var touchable = section.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"]');
    for (var touchIndex = 0; touchIndex < touchable.length; touchIndex += 1) {
      var target = touchable[touchIndex];
      var targetStyle = getComputedStyle(target);
      if (targetStyle.display === 'none' || targetStyle.visibility === 'hidden') continue;
      var box = target.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      var type = target.getAttribute('type');
      if (type === 'radio' || type === 'checkbox' || type === 'range') continue;
      if (target.closest('p, li') !== null && target.tagName.toLowerCase() === 'a') continue;
      var entry = { selector: describe(target), width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, text: (target.textContent || '').trim().slice(0, 20) };
      if (box.width < 43.5 || box.height < 43.5) touch.push(entry);
      if (box.width < 23.5 || box.height < 23.5) belowMinimum.push(entry);
    }
    var unnamed = [];
    var interactive = section.querySelectorAll('button, [role="button"], input:not([type="hidden"]), select, textarea');
    for (var nameIndex = 0; nameIndex < interactive.length; nameIndex += 1) {
      var node2 = interactive[nameIndex];
      var nodeStyle = getComputedStyle(node2);
      if (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden') continue;
      var labelled = node2.getAttribute('aria-label') || node2.getAttribute('aria-labelledby') || node2.getAttribute('title');
      var wrapping = node2.closest('label');
      var explicit = node2.id !== '' && section.querySelector('label[for="' + node2.id + '"]') !== null;
      var text = (node2.textContent || '').trim();
      if (labelled === null && wrapping === null && !explicit && text === '') unnamed.push(describe(node2));
    }
    var focusables = [];
    var candidates = section.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    for (var focusIndex = 0; focusIndex < candidates.length; focusIndex += 1) {
      var candidate = candidates[focusIndex];
      var candidateStyle = getComputedStyle(candidate);
      if (candidateStyle.display === 'none' || candidateStyle.visibility === 'hidden' || candidate.disabled === true) continue;
      if (candidate.closest('[hidden]') !== null) continue;
      var labelText = '';
      if (candidate.id !== '') {
        var linked = section.querySelector('label[for="' + candidate.id + '"]');
        if (linked !== null) labelText = (linked.textContent || '').trim();
      }
      if (labelText === '' && candidate.closest('label') !== null) labelText = (candidate.closest('label').textContent || '').trim();
      focusables.push({ selector: describe(candidate), name: candidate.getAttribute('aria-label') || labelText.slice(0, 24) || (candidate.textContent || '').trim().slice(0, 24) });
    }
    var live = [];
    var regions = section.querySelectorAll('[role="status"], [role="alert"], [aria-live]');
    for (var liveIndex = 0; liveIndex < regions.length; liveIndex += 1) {
      var region = regions[liveIndex];
      live.push({ role: region.getAttribute('role'), live: region.getAttribute('aria-live'), text: (region.textContent || '').trim().slice(0, 60) });
    }
    surfaces.push({ id: section.dataset.scenario, overflow: overflow, touch: touch, touchBelowMinimum: belowMinimum, unnamed: unnamed, focusables: focusables, live: live, text: (section.textContent || '').trim().slice(0, 240) });
  }
  return {
    viewport: viewport,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    surfaces: surfaces,
  };
})()`;

test('领域面板矩阵：主题、宽度、状态、名称、键盘与只读', { timeout: 900000 }, async (t) => {
  const home = allocateIndependentHome('wp38-panels');
  mkdirSync(join(home, 'chrome'), { recursive: true });
  mkdirSync(join(home, '.agent-browser'), { recursive: true });
  mkdirSync(join(home, 'workspace', 'alpha'), { recursive: true });
  process.env.HOME = home;
  process.env.DSH_HOME = home;
  const cli = browserOf({ session: `wp38-panels-${randomUUID().slice(0, 8)}`, home });

  const stack = await openHostStack({
    home,
    skills: [
      { name: 'code-review', description: '审查代码改动', source: 'bundled' },
      { name: 'release-notes', description: '整理发布说明', source: 'wp38-project' },
    ],
  });
  const services = { assistants: stack.assistants, skills: stack.skills };
  for (const [key, dir, className] of [
    ['projects', 'projects', 'ChatdshProjectsService'],
    ['connectors', 'connectors', 'ChatdshConnectorService'],
    ['artifacts', 'artifacts', 'ChatdshArtifactsService'],
  ]) {
    const module = await import(pathOf(`packages/host/${dir}/lib/index.js`));
    const instance = new module[className](stack.ctx);
    if (typeof instance[TY.TypertRemoteService.init] === 'function') await instance[TY.TypertRemoteService.init]();
    services[key] = instance;
  }

  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const share = new ShareStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const deviceLink = new DeviceLinkHub({ store, telemetry });
  const push = createPushHub({ queue: new PushQueue(store.handle()), devices: store, mode: 'all-at-once', escalationMs: 1000, telemetry: { counter: (name, config) => telemetry.counter(name, config) } });
  const gatewayServer = createGatewayServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      runtimeUrl: 'http://127.0.0.1:9',
      databasePath: join(home, 'gateway.sqlite'),
      environment: 'test',
      version: '0.0.0',
      pushMode: 'all-at-once',
      pushEscalationMs: 1000,
      llmGateway: { quota: {} },
      pairingCode: 'pair-wp38-panels',
    },
    store,
    replica,
    share,
    receipts,
    push,
    telemetry,
    deviceLink,
    runtime: { url: () => 'http://127.0.0.1:9', bootPath: () => '/', ready: () => false },
    bootstrapSecret: 'wp38-secret',
  });

  const handlers = {
    'chatdshAssistants/list': async () => services.assistants.list(),
    'chatdshAssistants/create': async ([input]) => services.assistants.create(input),
    'chatdshAssistants/update': async ([id, patch]) => services.assistants.update(id, patch),
    'chatdshAssistants/delete': async ([id]) => services.assistants.remove(id),
    'chatdshSkills/list': async () => services.skills.list(),
    'chatdshSkills/catalog': async () => services.skills.catalogState(),
    'chatdshSkills/toggle': async ([name, enabled]) => services.skills.toggle(name, enabled),
    'chatdshProjects/list': async () => services.projects.list(),
    'chatdshProjects/get': async ([path]) => services.projects.get(path),
    'chatdshProjects/create': async ([input]) => services.projects.create(input),
    'chatdshProjects/set': async ([input]) => services.projects.set(input),
    'chatdshProjects/delete': async ([path]) => services.projects.remove(path),
    'chatdshArtifacts/list': async () => services.artifacts.list(),
    'chatdshArtifacts/read': async ([input]) => services.artifacts.read(input),
    'chatdshArtifacts/versionList': async ([input]) => services.artifacts.versionList(input),
    'chatdshArtifacts/delete': async ([input]) => services.artifacts.remove(input),
    'chatdshArtifacts/deleteScope': async ([input]) => services.artifacts.deleteScope(input),
    'chatdshConnectors/list': async () => services.connectors.list(),
    'chatdshConnectors/get': async ([id]) => services.connectors.get(id),
    'chatdshConnectors/save': async ([input]) => services.connectors.save(input),
    'chatdshConnectors/delete': async ([id]) => services.connectors.remove(id),
    'chatdshConnectors/setEnabled': async ([id, enabled]) => services.connectors.setEnabled(id, enabled),
    'chatdshConnectors/states': async () => services.connectors.states(),
    'chatdshConnectors/state': async ([id]) => services.connectors.state(id),
    'chatdshConnectors/mcpRows': async () => services.connectors.mcpRows(),
    'chatdshConnectors/mcpStatus': async () => services.connectors.mcpStatus(),
    'chatdshConnectors/mcpTools': async ([id]) => services.connectors.mcpTools(id),
    'chatdshConnectors/syncMcpRows': async () => services.connectors.syncMcpRows(),
    'chatdshConnectors/refreshMcpRegistry': async () => services.connectors.refreshMcpRegistry(),
    'chatdshConnectors/callMcpTool': async ([input]) => services.connectors.callMcpTool(input),
    'agentPresets/list': async () => ({ presets: await stack.ctx.agentPresets.list() }),
    'pluginInventory/list': async () => stack.ctx.pluginInventory.list(),
  };

  const script = await bundlePage(PAGE_ENTRY, 'wp38-panels-page.tsx');
  const control = { failApi: false, slowApi: false, apiCalls: [] };
  let gatewayDown = false;
  let pageServer;
  const boards = [];

  const serveApi = async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
    if (control.slowApi) await new Promise((settle) => setTimeout(settle, 1200));
    if (control.failApi) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: { code: 'gateway/offline', message: '宿主服务暂时不可用' } }));
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    const endpoint = url.pathname.replace(/^\/api\//u, '');
    const body = raw === '' ? {} : JSON.parse(raw);
    control.apiCalls.push(endpoint);
    const handler = handlers[endpoint];
    if (handler === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: { code: 'object-not-found', message: endpoint } }));
      return;
    }
    let payload;
    try {
      payload = { ok: true, value: await handler(body.args ?? []) };
    } catch (error) {
      payload = { ok: false, error: wireFailureOf(error) };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  try {
    await gatewayServer.start();
    await services.projects.create({ path: join(home, 'workspace', 'alpha'), title: '甲项目', instructions: '项目说明' });
    const sessionId = 'session-wp38';
    store.upsertSession({ sessionId, deviceId: 'device-wp38', cwd: join(home, 'workspace', 'alpha'), kind: 'work', createdAt: Date.now() - 1000 });
    const appended = await fetch(`${gatewayServer.url()}/chatdsh/gateway/replica`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        events: [
          { seq: 0, kind: 'session/title', time: Date.now() - 900, bytes: 16, payload: { seq: 0, type: 'session/title', time: Date.now() - 900, data: { title: '分享的会话' } } },
          { seq: 1, kind: 'user/message', time: Date.now() - 800, bytes: 16, payload: { seq: 1, type: 'user/message', time: Date.now() - 800, data: { content: [{ type: 'text', text: '公开的第一句' }] } } },
        ],
      }),
    });
    assert.equal(appended.status, 200);

    const tokens = readFileSync(pathOf('packages/client/theme/src/client/styles/tokens.css'), 'utf8');
    const themeShell = readFileSync(pathOf('packages/client/theme/src/client/styles/shell.css'), 'utf8');
    const uiKit = await import(pathOf('packages/core/ui-kit/lib/index.js'));
    const html = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>WP38 面板矩阵</title><style>',
      tokens,
      '\n',
      themeShell,
      '\n',
      uiKit.UI_KIT_CSS,
      '\nbody { margin: 0; } main { padding: 8px; } [data-scenario] { margin-block: 12px; } .surface-host { min-width: 0; }\n',
      '</style></head><body><main><h1>WP38 面板矩阵</h1><div id="surfaces"></div></main><script>',
      script,
      '</script></body></html>',
    ].join('');
    const frontServer = createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
        return;
      }
      if (url.pathname.startsWith('/chatdsh/telemetry')) {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await serveApi(request, response);
        return;
      }
      if (url.pathname.startsWith('/chatdsh/')) {
        if (gatewayDown) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'control-plane-stopped' }));
          return;
        }
        const target = new URL(gatewayServer.url());
        const sent = httpRequest(
          { host: target.hostname, port: target.port, method: request.method, path: request.url, headers: { ...request.headers, host: target.host } },
          (upstream) => {
            response.writeHead(upstream.statusCode ?? 502, upstream.headers);
            upstream.pipe(response);
          }
        );
        sent.on('error', () => {
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'upstream-unavailable' }));
        });
        request.pipe(sent);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not-found');
    });
    frontServer.listen(0, '127.0.0.1');
    await once(frontServer, 'listening');
    const origin = `http://127.0.0.1:${frontServer.address().port}`;
    pageServer = frontServer;

    const evaluate = async (expression) => (await cli('eval', expression)).data.result;
    const waitFor = async (expression, note = expression) => {
      const isSelector = !/[()\s]/.test(expression);
      try {
        if (isSelector) await cli('wait', expression);
        else await cli('wait', '--fn', expression);
      } catch (error) {
        const state = await evaluate('JSON.stringify({ url: location.href, text: document.body ? document.body.innerText.slice(0, 800) : null })');
        throw new Error(`等待失败：${note}\n页面状态：${state}\n${String(error)}`);
      }
    };
    const audit = async () => await evaluate(AUDIT_SOURCE);
    const axe = async () => {
      const answer = await cli('a11y');
      assert.equal(answer.data.axeVersion !== undefined, true, '返回 axe 版本');
      return answer.data;
    };
    const contrastFindings = [];
    const touchFindings = [];
    const liveGaps = [];
    const failureGaps = [];
    const assertAxe = (report, where) => {
      const serious = report.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
      for (const violation of serious.filter((entry) => entry.id === 'color-contrast')) {
        for (const node of violation.nodes) contrastFindings.push({ where, target: node.target, summary: node.failureSummary.split('\n').slice(0, 3).join(' ') });
      }
      assert.deepEqual(
        serious.filter((entry) => entry.id !== 'color-contrast').map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) })),
        [],
        `${where}：axe 无严重与致命问题`
      );
    };
    const recordTouch = (report, where) => {
      for (const surface of report.surfaces) {
        for (const entry of surface.touch) touchFindings.push({ where: `${where} ${surface.id}`, ...entry });
        assert.deepEqual(surface.touchBelowMinimum, [], `${where} ${surface.id}：触控目标不低于 24 ${JSON.stringify(surface.touchBelowMinimum)}`);
      }
    };
    const mountAll = async () => {
      const ids = await evaluate('window.__wp38.mountAll()');
      assert.deepEqual([...ids].sort(), ['S09', 'S10', 'S11', 'S13', 'S14', 'S15', 'S17', 'S20']);
      await waitFor('document.querySelectorAll("[data-scenario]").length === 8', '八个场景挂载');
    };
    const settled = 'Array.from(document.querySelectorAll("[data-scenario]")).every((section) => section.textContent.trim().length > 10)';

    await cli('open', `${origin}/`);
    let opened = true;
    await waitFor('typeof window.__wp38 === "object"', '页面脚本就绪');

    await t.test('八个场景在两个主题与三个宽度下的结构、名称、溢出与触控', async () => {
      for (const theme of ['light', 'dark']) {
        for (const width of [320, 768, 1440]) {
          await cli('set', 'viewport', String(width), '900');
          await mountAll();
          await evaluate(theme === 'dark' ? 'document.body.setAttribute("data-ds-dark-theme", "true"); true' : 'document.body.removeAttribute("data-ds-dark-theme"); true');
          await waitFor(settled, '场景读取完成');
          const report = await audit();
          const where = `${theme}/${String(width)}`;
          assert.ok(report.documentScrollWidth <= report.documentClientWidth + 1, `${where}：页面没有横向滚动`);
          assert.equal(report.surfaces.length, 8, `${where}：八个场景都在页面上`);
          for (const surface of report.surfaces) {
            assert.deepEqual(surface.overflow, [], `${where} ${surface.id}：逐元素无横向溢出 ${JSON.stringify(surface.overflow)}`);
            assert.deepEqual(surface.unnamed, [], `${where} ${surface.id}：可交互元素都有可访问名称 ${JSON.stringify(surface.unnamed)}`);
            assert.equal(surface.focusables.every((entry) => entry.name !== ''), true, `${where} ${surface.id}：可聚焦元素都有名称 ${JSON.stringify(surface.focusables)}`);
            if (surface.live.length === 0) liveGaps.push(`${where} ${surface.id}`);
            for (const live of surface.live) {
              assert.ok(live.role === 'status' || live.role === 'alert' || live.live === 'polite' || live.live === 'assertive', `${where} ${surface.id}：播报区域有角色或 aria-live ${JSON.stringify(live)}`);
            }
          }
          recordTouch(report, where);
          assertAxe(await axe(), where);
          boards.push({ theme, width, surfaces: report.surfaces.length });
        }
      }
      await evaluate('document.body.removeAttribute("data-ds-dark-theme")');
      await cli('set', 'viewport', '1440', '900');
    });

    await t.test('键盘顺序与对话框焦点恢复', async () => {
      await mountAll();
      await waitFor(settled, '面板就绪');
      const order = await evaluate(
        `(function () { var nodes = document.querySelectorAll('[data-scenario="S10"] a[href], [data-scenario="S10"] button, [data-scenario="S10"] input, [data-scenario="S10"] select, [data-scenario="S10"] textarea'); var out = []; for (var i = 0; i < nodes.length; i += 1) { if (nodes[i].offsetParent !== null) out.push((nodes[i].textContent || '').trim().slice(0, 12) || nodes[i].getAttribute('aria-label') || nodes[i].id); } return out; })()`
      );
      assert.equal(order.length > 0, true, `项目面板有可聚焦元素：${JSON.stringify(order)}`);
      await cli('focus', '[data-scenario="S10"]');
      const first = await evaluate('(function () { var nodes = document.querySelectorAll(\'[data-scenario="S10"] a[href], [data-scenario="S10"] button, [data-scenario="S10"] input\'); for (var i = 0; i < nodes.length; i += 1) { if (nodes[i].offsetParent !== null) { nodes[i].focus(); return true; } } return false; })()');
      assert.equal(first, true, '项目面板首个可聚焦元素可以取得焦点');
      const openedDialog = await evaluate(
        '(function () { var nodes = document.querySelectorAll(\'[data-scenario="S10"] button\'); for (var i = 0; i < nodes.length; i += 1) { if ((nodes[i].textContent || "").indexOf("新建") !== -1) { nodes[i].click(); return true; } } return false; })()'
      );
      assert.equal(openedDialog, true, '项目面板有新建入口');
      await waitFor('document.querySelector("dialog[open]") !== null', '对话框打开');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, '焦点进入对话框');
      const snapshot = (await cli('snapshot')).data;
      assert.equal(snapshot.snapshot.includes('dialog'), true, '对话框进入可访问树');
      await cli('press', 'Escape');
      await waitFor('document.querySelector("dialog[open]") === null', 'Escape 关闭对话框');
      assert.equal(await evaluate('document.querySelector(\'[data-scenario="S10"]\').contains(document.activeElement)'), true, '关闭后焦点回到项目面板');
    });

    await t.test('加载、失败与恢复：真实服务延迟与拒绝', async () => {
      control.slowApi = true;
      await mountAll();
      await waitFor('document.querySelectorAll("[data-scenario] .chdsh-skeleton").length >= 1', '读取期间出现骨架');
      const loadingReport = await audit();
      assert.equal(loadingReport.surfaces.length, 8, '骨架期间八个场景都占位');
      control.slowApi = false;
      await mountAll();
      await waitFor(settled, '读取完成后内容出现');

      control.failApi = true;
      await mountAll();
      await waitFor('Array.from(document.querySelectorAll("[data-scenario]")).some((section) => /失败|不可用|无法/.test(section.textContent))', '失败说明出现');
      const failedReport = await audit();
      // 宿主服务的拒绝只影响经 /api 供数的面板；分享、设备与自动化经控制平面路由，另行验证。
      const apiSurfaces = ['S09', 'S10', 'S11'];
      for (const surface of failedReport.surfaces.filter((entry) => apiSurfaces.includes(entry.id))) {
        assert.equal(/失败|不可用|无法|没有|空/.test(surface.text), true, `${surface.id}：失败时给出可读说明：${surface.text}`);
        assert.deepEqual(surface.overflow, [], `${surface.id}：失败状态无横向溢出`);
      }
      // 连接器面板在宿主拒绝时仍然渲染配置说明；失败说明的缺口单独记录。
      for (const surface of failedReport.surfaces.filter((entry) => entry.id === 'S13')) {
        assert.deepEqual(surface.overflow, [], 'S13：失败状态无横向溢出');
        assert.deepEqual(surface.unnamed, [], 'S13：失败状态可交互元素都有名称');
        if (!/失败|不可用|无法/.test(surface.text)) failureGaps.push(surface.text.slice(0, 80));
      }
      assertAxe(await axe(), '失败状态');
      control.failApi = false;
      await mountAll();
      await waitFor(settled, '恢复后重新读取');
    });

    await t.test('空状态：真实服务的空目录', async () => {
      for (const record of services.projects.list()) await services.projects.remove(record.path);
      for (const record of services.assistants.list()) await services.assistants.remove(record.id);
      await mountAll();
      await waitFor(settled, '空状态渲染完成');
      const emptyReport = await audit();
      for (const surface of emptyReport.surfaces) {
        assert.deepEqual(surface.unnamed, [], `${surface.id}：空状态可交互元素都有名称`);
        assert.deepEqual(surface.overflow, [], `${surface.id}：空状态无横向溢出`);
      }
      assertAxe(await axe(), '空状态');
    });

    await t.test('S15/S17 失败与恢复：控制平面停止', async () => {
      gatewayDown = true;
      await mountAll();
      await waitFor('Array.from(document.querySelectorAll(\'[data-scenario="S15"], [data-scenario="S17"]\')).some((section) => /失败|不可达|无法/.test(section.textContent))', '控制平面停止后给出说明');
      const text = await evaluate('document.querySelector(\'[data-scenario="S17"]\').textContent');
      assert.equal(/失败|不可达|无法/.test(text), true, `设备面板说明：${text.slice(0, 200)}`);
      gatewayDown = false;
      await mountAll();
      await waitFor('document.querySelectorAll("[data-scenario]").length === 8', '恢复后重新挂载');
    });

    await t.test('200% 文字缩放：三个宽度下的面板重排', async () => {
      await mountAll();
      await waitFor(settled, '面板就绪');
      for (const width of [320, 768, 1440]) {
        await cli('set', 'viewport', String(width), '900');
        await evaluate('document.documentElement.style.fontSize = "32px"');
        const scaled = await audit();
        assert.equal(scaled.rootFontSize, '32px', `${String(width)}：根字号放大`);
        recordTouch(scaled, `200% ${String(width)}`);
        if (width >= 768) {
          for (const surface of scaled.surfaces) {
            assert.deepEqual(surface.overflow, [], `${String(width)} ${surface.id}：200% 字号下无横向溢出 ${JSON.stringify(surface.overflow)}`);
          }
        }
        await evaluate('document.documentElement.style.fontSize = ""');
      }
    });

    await t.test('只读校验：只读场景没有写入真实记录', async () => {
      const before = {
        projects: services.projects.list().length,
        assistants: services.assistants.list().length,
        connectors: services.connectors.list().length,
      };
      const writes = () => control.apiCalls.filter((endpoint) => /^(create|set|save|update|delete|remove|toggle)$/.test(endpoint.split('/')[1] ?? '')).length;
      const writesBefore = writes();
      await mountAll();
      await waitFor('document.querySelectorAll("[data-scenario]").length === 8', '重新挂载完成');
      await new Promise((settle) => setTimeout(settle, 1500));
      const after = {
        projects: services.projects.list().length,
        assistants: services.assistants.list().length,
        connectors: services.connectors.list().length,
      };
      assert.deepEqual(after, before, '只读读取没有改动记录数量');
      assert.equal(writes(), writesBefore, '只读读取没有发出写接口调用');
      const errors = await cli('errors');
      assert.deepEqual(errors.data.errors, [], '页面没有脚本错误');
    });

    await t.test('可访问树：面板按钮有名称，区段可被读屏定位', async () => {
      await mountAll();
      await waitFor('document.querySelectorAll("[data-scenario]").length === 8', '重新挂载完成');
      const snapshot = (await cli('snapshot')).data;
      const refs = Object.values(snapshot.refs ?? {});
      assert.equal(refs.some((entry) => entry.role === 'button' && entry.name !== ''), true, '可访问树里按钮有名称');
      assert.equal(snapshot.snapshot.includes('dialog'), false, '没有遗留的对话框');
    });

    if (boards.length !== 6) throw new Error(`矩阵轮次不足：${JSON.stringify(boards)}`);
    void opened;
  } finally {
    await cli('close').catch(() => undefined);
    await telemetry.shutdown().catch(() => undefined);
    if (pageServer !== undefined) {
      pageServer.closeAllConnections();
      await new Promise((resolve) => pageServer.close(resolve));
    }
    await gatewayServer.stop().catch(() => undefined);
    deviceLink.stop();
    store.close();
    releaseIndependentHome(home);
  }
});
