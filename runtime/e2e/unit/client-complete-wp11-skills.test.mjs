// WP11 技能界面的验收测试：真实宿主服务、真实页面服务与真实 Chrome。
//
// 宿主侧挂载真实技能注册表、存储域、系统提示、模型运行时、加载器、agent preset 注册表、插件
// 清单、技能目录服务与助手服务；技能按三类来源登记，启用决定落在真实存储里。页面把技能面板
// 接到 `/api` 入口，入口直接调用这些真实服务。浏览器是 agent-browser 独立会话里的真实 Chrome，
// 使用独立 HOME、TMPDIR 与 profile，不截图；断言来自 DOM、可访问属性、宿主实况与落盘文件。
//
// 覆盖：来源分组与统计、关键字与来源检索、无匹配、检索关键字超限的真实拒绝、启停二次确认与
// 状态同步、停用未知技能的真实拒绝、重启后的状态一致、助手引用标注、遥测信号。
//
// 运行：node --test e2e/unit/client-complete-wp11-skills.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { browserOf, bundlePage, openHostStack, RUNTIME, startPanelPage } from './client-complete-wp11-support.mjs';

const PACKAGE = join(RUNTIME, 'packages/client/skills/src/client');

/** 页面脚本：真实面板组件、真实数据入口与真实遥测面。 */
const PAGE_ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SkillsPanel } from ${JSON.stringify(join(PACKAGE, 'panel.tsx'))};
import { createSkillsGateway } from ${JSON.stringify(join(PACKAGE, 'gateway.ts'))};
import { createPanelTelemetry } from ${JSON.stringify(join(PACKAGE, 'telemetry.ts'))};

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

const gateway = createSkillsGateway({ transport, telemetry: createPanelTelemetry() });
createRoot(document.getElementById('root')).render(createElement(SkillsPanel, { gateway }));
window.__wp11 = { ready: true };
`;

/** 等待条件成立。 */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((stop) => setTimeout(stop, 100));
  }
  throw new Error(`等待超时：${label}`);
}

test('真实 Chrome 完成技能分组、检索、启停、重启一致性与引用标注', { timeout: 420000 }, async (t) => {
  const home = allocateIndependentHome('wp11-skills');
  const previousHome = process.env.HOME;
  const previousDshHome = process.env.DSH_HOME;
  process.env.HOME = home;
  process.env.DSH_HOME = home;

  const session = `wp11-skills-${randomUUID().slice(0, 8)}`;
  const cli = browserOf({ session, home });
  const current = { host: undefined };
  let page;
  let opened = false;

  const evaluate = async (expression) => {
    const result = await cli('eval', expression);
    return result.data.result;
  };
  const textHas = async (needle) => evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);
  const hasButton = async (label) =>
    evaluate(`[...document.querySelectorAll('[aria-label]')].some((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)})`);
  /** 轮询页面正文，超时的时候把当时的正文带进错误里。 */
  const waitForBodyText = async (needle, label) => {
    const deadline = Date.now() + 5000;
    let body = '';
    while (Date.now() < deadline) {
      body = await evaluate('document.body.innerText');
      if (body.includes(needle)) return body;
      await new Promise((stop) => setTimeout(stop, 100));
    }
    throw new Error(`${label} 没有出现「${needle}」；页面正文：${body}`);
  };

  const skills = [
    { name: 'code-review', description: '审查代码改动', source: 'bundled' },
    { name: 'document-export', description: '导出文档', source: 'bundled' },
    { name: 'project-guide', description: '项目开发约束', source: 'project-wp11' },
    { name: 'note-taking', description: '整理会议纪要', source: 'wp11-user' },
    { name: 'release-notes', description: '整理发布说明', source: 'wp11-custom' },
  ];

  try {
    current.host = await openHostStack({ home, skills });
    await current.host.skills.toggle('release-notes', false);
    await current.host.assistants.create({ name: '代码审查助手', instructions: '审查改动', tier: 'chat', skills: ['code-review'] });

    const handlers = {
      'chatdshSkills/list': async () => current.host.skills.list(),
      'chatdshSkills/catalog': async () => current.host.skills.catalogState(),
      'chatdshSkills/search': async ([request]) => current.host.skills.search(request),
      'chatdshSkills/toggle': async ([id, enabled]) => current.host.skills.toggle(id, enabled),
      'chatdshAssistants/list': async () => current.host.assistants.list(),
    };
    const script = await bundlePage(PAGE_ENTRY, 'wp11-skills-page.tsx');
    page = await startPanelPage({ handlers, script });

    await cli('open', page.origin);
    opened = true;
    await cli('wait', '#wp11-skill-search');
    await cli('wait', '--fn', 'window.__wp11 && window.__wp11.ready === true');
    await cli('wait', '--fn', 'document.querySelectorAll(".chdsh-skeleton").length === 0');

    await t.test('分组：内置、工作区与用户目录各自成组，统计与引用标注来自宿主', async () => {
      assert.equal(await textHas('5 个技能，已启用 4 个'), true, '统计来自宿主的数量统计');
      assert.equal(await textHas('内置（2，已启用 2）'), true, '内置组统计正确');
      assert.equal(await textHas('工作区（1，已启用 1）'), true, '工作区组统计正确');
      assert.equal(await textHas('用户目录（2，已启用 1）'), true, '用户目录组统计正确');
      assert.equal(await textHas('随运行时安装的技能目录'), true, '内置来源说明可见');
      assert.equal(await textHas('来自项目目录的技能'), true, '工作区来源说明可见');
      assert.equal(await textHas('来自用户与自定义目录的技能'), true, '用户目录来源说明可见');
      assert.equal(await textHas('技能目录在宿主启动时扫描一次'), true, '说明扫描范围与重启条件');
      assert.equal(await hasButton('停用 code-review'), true, '启用中的技能给出停用入口');
      assert.equal(await hasButton('启用 release-notes'), true, '停用中的技能给出启用入口');
      assert.equal(await textHas('被助手 代码审查助手 引用'), true, '引用标注来自真实助手记录');
      assert.equal(await textHas('没有助手引用'), true, '没有被引用的技能如实说明');
      assert.equal(await evaluate('document.querySelectorAll(".chdsh-skeleton").length'), 0, '加载完成后没有骨架');
    });

    await t.test('检索：关键字与来源过滤都交给宿主，无匹配与超限各有真实结果', async () => {
      await cli('fill', '#wp11-skill-search', 'review');
      await cli('click', '#wp11-skill-search-submit');
      await cli('wait', '--text', '内置（1，已启用 1）');
      assert.equal(await textHas('document-export'), false, '不含关键字的技能被过滤掉');
      assert.equal(await textHas('code-review'), true, '命中的技能仍在');

      await cli('click', '#wp11-skill-search-clear');
      await waitForBodyText('内置（2，已启用 2）', '清除过滤');
      await cli('select', '#wp11-skill-source', 'workspace');
      await waitForBodyText('工作区（1，已启用 1）', '来源过滤');
      assert.equal(await textHas('project-guide'), true, '来源过滤只看工作区');
      assert.equal(await textHas('code-review'), false, '别的来源被排除');

      await cli('select', '#wp11-skill-source', 'all');
      await cli('wait', '--text', '内置（2，已启用 2）');
      await cli('fill', '#wp11-skill-search', 'zzz');
      await cli('click', '#wp11-skill-search-submit');
      await cli('wait', '--text', '没有匹配的技能');
      assert.equal(await evaluate('document.getElementById("wp11-skill-clear-empty") !== null'), true, '无匹配时给出清除过滤入口');
      await cli('click', '#wp11-skill-clear-empty');
      await cli('wait', '--text', '内置（2，已启用 2）');

      await cli('fill', '#wp11-skill-search', 'x'.repeat(121));
      await cli('click', '#wp11-skill-search-submit');
      await cli('wait', '--text', '检索关键字最多 120 个字符');
      assert.equal(await textHas('检索没有被受理'), true, '超限由宿主拒绝并就地提示');
      assert.equal(await textHas('code-review'), true, '被拒绝的检索保留上一批结果');
      await cli('click', '#wp11-skill-search-clear');
      await cli('wait', '--text', '内置（2，已启用 2）');
    });

    await t.test('启停：二次确认说明影响，状态以宿主返回为准', async () => {
      await cli('find', 'role', 'button', 'click', '--name', '停用 code-review');
      await cli('wait', 'dialog[open]');
      assert.equal(await textHas('停用只改本项目的技能目录视图'), true, '确认框说明停用的影响范围');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, '确认框打开后焦点在其中');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await hasButton('停用 code-review'), true, '取消之后状态不变');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '停用 code-review', 'Escape 之后焦点回到触发按钮');

      await cli('find', 'role', 'button', 'click', '--name', '停用 code-review');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp11-skill-toggle-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '技能 code-review 已停用');
      assert.equal(current.host.skills.list().find((entry) => entry.id === 'code-review').enabled, false, '宿主状态已停用');
      assert.equal(current.host.skills.catalogState().enabled, 3, '目录计数跟着变');
      assert.equal(await hasButton('启用 code-review'), true, '界面按宿主结果换成启用入口');

      await cli('find', 'role', 'button', 'click', '--name', '启用 code-review');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp11-skill-toggle-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '技能 code-review 已启用');
      assert.equal(current.host.skills.catalogState().enabled, 4, '启用之后计数回到四个');
    });

    await t.test('重启：启用决定与助手记录恢复，界面按新宿主重新读取', async () => {
      const overrides = JSON.parse(readFileSync(join(home, 'runtime', 'storages', 'skills_store.json'), 'utf8'));
      assert.equal(overrides.tables.overrides['release-notes'].enabled, false, '停用决定落在真实存储里');
      assert.equal(overrides.tables.overrides['code-review'].enabled, true, '启用决定同样落盘');

      await current.host.ctx.fiber.dispose();
      current.host = await openHostStack({ home, skills: skills.filter((skill) => skill.name !== 'note-taking') });
      assert.equal(current.host.skills.list().find((entry) => entry.id === 'release-notes').enabled, false, '重启后停用决定仍在');
      assert.equal(current.host.skills.list().find((entry) => entry.id === 'code-review').enabled, true, '重启后启用决定仍在');
      assert.equal(current.host.assistants.list().length, 1, '助手记录在重启后仍在');

      await cli('click', '#wp11-skill-refresh');
      await cli('wait', '--fn', 'document.querySelectorAll(".chdsh-skeleton").length === 0');
      await cli('wait', '--text', '用户目录（1，已启用 0）');
      assert.equal(await hasButton('启用 release-notes'), true, '重启后界面仍是停用状态');
      assert.equal(await hasButton('停用 code-review'), true, '重启后界面仍是启用状态');
      assert.equal(await textHas('note-taking'), false, '重启后目录里没有的技能不再出现');
      assert.equal(await textHas('被助手 代码审查助手 引用'), true, '重启后引用标注仍然来自真实助手记录');
    });

    await t.test('启停失败：宿主拒绝时给出原因并按宿主重新读取', async () => {
      await current.host.ctx.fiber.dispose();
      current.host = await openHostStack({ home, skills: skills.filter((skill) => skill.name !== 'note-taking' && skill.name !== 'project-guide') });
      await cli('find', 'role', 'button', 'click', '--name', '停用 project-guide');
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp11-skill-toggle-confirm');
      await cli('wait', '--text', '启停没有被受理');
      assert.equal(await textHas('未知技能：project-guide'), true, '失败提示来自宿主的原话');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('click', '#wp11-skill-refresh');
      await cli('wait', '--fn', 'document.querySelectorAll(".chdsh-skeleton").length === 0');
      await cli('wait', '--fn', '!document.body.innerText.includes("project-guide")');
      assert.equal(current.host.skills.list().some((entry) => entry.id === 'project-guide'), false, '刷新之后目录与宿主一致');
    });

    await t.test('遥测：检索与启停的界面动作、调用 span、失败事件与错误计数', async () => {
      const logs = () => page.batches
        .filter((batch) => batch.signal === 'logs')
        .flatMap((batch) => (batch.body.resourceLogs ?? []).flatMap((resource) => resource.scopeLogs ?? []))
        .flatMap((scope) => scope.logRecords ?? [])
        .map((record) => ({
          name: record.body?.stringValue ?? '',
          attributes: Object.fromEntries((record.attributes ?? []).map((entry) => [entry.key, entry.value.stringValue ?? entry.value.intValue])),
        }));
      await waitFor(() => logs().some((record) => record.name === 'chatdsh.client.error'), '失败事件到达中继');
      const records = logs();
      const actions = records.filter((record) => record.name === 'chatdsh.client.ui.action');
      assert.ok(actions.some((record) => record.attributes.action === 'skill.search' && record.attributes.outcome === 'ok'), '检索成功有界面动作');
      assert.ok(actions.some((record) => record.attributes.action === 'skill.search' && record.attributes.outcome === 'failed'), '关键字超限的检索记为 failed');
      assert.ok(actions.some((record) => record.attributes.action === 'skill.disable' && record.attributes.outcome === 'ok'), '停用成功');
      assert.ok(actions.some((record) => record.attributes.action === 'skill.enable' && record.attributes.outcome === 'ok'), '启用成功');
      assert.ok(actions.some((record) => record.attributes.action === 'skill.disable' && record.attributes.outcome === 'failed'), '停用未知技能记为 failed');
      assert.ok(actions.every((record) => typeof record.attributes.action === 'string' && typeof record.attributes.outcome === 'string'));

      const failures = records.filter((record) => record.name === 'chatdsh.client.error');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'request-invalid'), '检索关键字超限按错误码上报');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'object-not-found'), '未知技能按错误码上报');

      const spans = page.batches
        .filter((batch) => batch.signal === 'traces')
        .flatMap((batch) => (batch.body.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans ?? []))
        .flatMap((scope) => scope.spans ?? [])
        .map((span) => ({
          name: span.name,
          attributes: Object.fromEntries((span.attributes ?? []).map((entry) => [entry.key, entry.value.stringValue])),
        }));
      assert.ok(spans.length > 0, '每次 Remote 调用都有 span');
      assert.ok(spans.every((span) => span.name === 'chatdsh.client.remote.call'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshSkills/search' && span.attributes.outcome === 'failed'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshSkills/toggle' && span.attributes.outcome === 'failed'));
      const metrics = page.batches
        .filter((batch) => batch.signal === 'metrics')
        .flatMap((batch) => (batch.body.resourceMetrics ?? []).flatMap((resource) => resource.scopeMetrics ?? []))
        .flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.name));
      assert.ok(metrics.includes('chatdsh_client_errors_total'), '失败计数上报');
    });

    const errors = await cli('errors');
    assert.deepEqual(errors.data.errors, [], '页面没有未捕获的错误');
  } finally {
    if (opened) await cli('close');
    if (page !== undefined) await page.close();
    if (current.host !== undefined) await current.host.ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    releaseIndependentHome(home);
  }
});
