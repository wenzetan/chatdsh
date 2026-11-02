// WP11 助手界面的验收测试：真实宿主服务、真实页面服务与真实 Chrome。
//
// 宿主侧挂载真实的存储中枢、JSON 后端、存储域、系统提示、模型运行时、技能注册表、会话注册表、
// 加载器、agent preset 注册表与插件清单；三档预设按档位契约登记，装配清单来自真实注册表。
// 页面把面板组件接到 `/api` 入口，入口直接调用这些真实服务。浏览器是 agent-browser 独立会话
// 里的真实 Chrome，使用独立 HOME、TMPDIR 与 profile，不截图；断言来自 DOM、可访问属性、焦点
// 位置、宿主服务实况与落盘文件。
//
// 覆盖：空状态与内置档位、字段校验与错误摘要、名称唯一、说明与指令长度、排序值、附加工具与
// 技能多选（停用项不可选）、编辑与版本冲突、装配失败保留原定义、删除二次确认与进行中会话数、
// 对话框焦点约束与 Escape 恢复焦点、加载失败与重新加载、遥测信号。
//
// 运行：node --test e2e/unit/client-complete-wp11-assistants.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { browserOf, bundlePage, openHostStack, RUNTIME, startPanelPage } from './client-complete-wp11-support.mjs';

const contracts = await import(join(RUNTIME, 'packages/core/contracts/lib/index.js'));

/** 助手服务的包目录。 */
const PACKAGE = join(RUNTIME, 'packages/client/assistants/src/client');

/** 页面脚本：真实面板组件、真实数据入口与真实遥测面。 */
const PAGE_ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantsPanel } from ${JSON.stringify(join(PACKAGE, 'panel.tsx'))};
import { createAssistantsGateway } from ${JSON.stringify(join(PACKAGE, 'gateway.ts'))};
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

const gateway = createAssistantsGateway({ transport, telemetry: createPanelTelemetry() });
createRoot(document.getElementById('root')).render(createElement(AssistantsPanel, { gateway }));
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

test('真实 Chrome 完成助手目录、向导、冲突、装配失败、删除与键盘操作', { timeout: 420000 }, async (t) => {
  const home = allocateIndependentHome('wp11-assistants');
  mkdirSync(join(home, 'workspace'), { recursive: true });
  const previousHome = process.env.HOME;
  const previousDshHome = process.env.DSH_HOME;
  process.env.HOME = home;
  process.env.DSH_HOME = home;

  const session = `wp11-assistants-${randomUUID().slice(0, 8)}`;
  const cli = browserOf({ session, home });
  const control = { failList: false };
  let host;
  let page;
  let opened = false;

  const evaluate = async (expression) => {
    const result = await cli('eval', expression);
    return result.data.result;
  };
  const textHas = async (needle) => evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);
  const activeId = async () => evaluate('document.activeElement && document.activeElement.id');

  try {
    host = await openHostStack({
      home,
      skills: [
        { name: 'code-review', description: '审查代码改动', source: 'bundled' },
        { name: 'release-notes', description: '整理发布说明', source: 'project-wp11' },
        { name: 'note-taking', description: '整理会议纪要', source: 'wp11-user' },
      ],
    });
    assert.equal(host.skills.list().length, 3, '技能目录来自真实注册表');
    await host.skills.toggle('note-taking', false);

    const handlers = {
      'chatdshAssistants/list': async () => {
        if (control.failList) throw new Error('助手存储暂时不可用');
        return host.assistants.list();
      },
      'chatdshAssistants/create': async ([input]) => host.assistants.create(input),
      'chatdshAssistants/update': async ([id, patch]) => host.assistants.update(id, patch),
      'chatdshAssistants/delete': async ([id]) => host.assistants.remove(id),
      'agentPresets/list': async () => ({ presets: await host.ctx.agentPresets.list() }),
      'pluginInventory/list': async () => host.ctx.pluginInventory.list(),
      'chatdshSkills/list': async () => host.skills.list(),
      'chatdshSkills/catalog': async () => host.skills.catalogState(),
    };
    const script = await bundlePage(PAGE_ENTRY, 'wp11-assistants-page.tsx');
    page = await startPanelPage({ handlers, script });

    await cli('open', page.origin);
    opened = true;
    await cli('wait', '#wp11-assistant-create');
    await cli('wait', '--fn', 'window.__wp11 && window.__wp11.ready === true');

    await t.test('目录：空状态、内置档位只读与三档装配行', async () => {
      assert.equal(await evaluate('document.querySelectorAll(".chdsh-panel").length'), 1, '面板使用共享组件外壳');
      assert.equal(await textHas('还没有自定义助手'), true, '没有记录时显示空状态');
      assert.equal(await textHas('内置档位（3）'), true, '内置档位一节列出三档');
      assert.equal(await textHas('内置档位由组合补丁层声明，界面只读'), true, '内置档位说明不可编辑的原因');
      for (const tier of contracts.CHATDSH_TOOL_TIERS) {
        const expected = 3 + tier.upstreamRows.length + tier.chatdshRows.length + (tier.presentation === 'ptc' ? 1 : 0);
        assert.equal(await textHas(`预设 ${contracts.presetIdOf(tier.id)} · 装配行 ${expected} 行`), true, `${tier.id} 档的装配行数与契约一致`);
      }
      const group = host.ctx.agentPresets.inspectCompositions();
      assert.equal(group.length, 0, '此刻还没有助手预设');
    });

    await t.test('向导：空提交、摘要焦点、名称唯一、说明与指令长度、排序值', async () => {
      await cli('click', '#wp11-assistant-create');
      await cli('wait', 'dialog[open]');
      assert.equal(await textHas('档位：工作档、全量档'), true, '工具清单标注每一行属于哪些档位');
      assert.equal(await textHas('条件 process.platform'), true, '按平台二选一的命令行带平台条件原文');
      await cli('click', '#wp11-assistant-submit');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-name").getAttribute("aria-invalid")'), 'true');
      assert.equal(await evaluate('document.activeElement.classList.contains("chdsh-error-summary")'), true, '校验失败后焦点落在错误摘要');
      await cli('click', '.chdsh-error-summary a');
      assert.equal(await activeId(), 'wp11-assistant-name', '摘要链接把焦点交给名称字段');

      await cli('fill', '#wp11-assistant-name', '代码审查');
      await cli('fill', '#wp11-assistant-description', 'x'.repeat(513));
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--text', '助手说明最多 512 个字符');
      await cli('fill', '#wp11-assistant-description', '审查改动与测试');
      await cli('fill', '#wp11-assistant-instructions', 'y'.repeat(32001));
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--text', '助手指令最多 32000 个字符');
      await cli('fill', '#wp11-assistant-instructions', '你是代码审查助手');
      await cli('fill', '#wp11-assistant-order', '1.5');
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--text', '排序值必须是');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-order").getAttribute("aria-invalid")'), 'true');
      assert.equal(host.assistants.list().length, 0, '表单校验失败没有写入记录');

      await assert.rejects(
        () => host.assistants.create({ name: '直接调用', instructions: 'z'.repeat(32001) }),
        (error) => error.code === contracts.CHATDSH_ERROR_CODES.requestInvalid,
        '宿主的指令长度校验同样拒绝',
      );

      await cli('fill', '#wp11-assistant-order', '50');
      await cli('select', '#wp11-assistant-tier', 'chat');
      await cli('click', '#wp11-assistant-tools-tool-fs');
      await cli('click', '#wp11-assistant-skills-code-review');
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '代码审查');

      const created = host.assistants.list()[0];
      assert.equal(created.tier, 'chat');
      assert.equal(created.order, 50);
      assert.deepEqual(created.tools, ['tool-fs'], '附加工具写进了记录');
      assert.deepEqual(created.skills, ['code-review'], '技能引用写进了记录');
      const document = await host.ctx.agentPresets.readDocument(created.id);
      assert.match(document.content, /dsh-tool-fs/, '附加工具行进了真实装配结果');
      assert.match(document.content, /dsh-tool-web/, '档位自带的工具行仍在');
      assert.equal(await textHas('聊天档'), true, '列表显示档位');
      assert.equal(await textHas('排序 50'), true, '列表显示排序值');
      assert.equal(await textHas('附加工具 1 行 · 技能 1 个'), true, '列表显示工具与技能引用');
      assert.equal(await textHas('装配诊断：'), true, '装配诊断按宿主给出的原文显示');

      await cli('click', '#wp11-assistant-create');
      await cli('wait', 'dialog[open]');
      await cli('fill', '#wp11-assistant-name', '  代码审查 ');
      await cli('fill', '#wp11-assistant-instructions', '另一份');
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--text', '已被占用');
      assert.equal(host.assistants.list().length, 1, '重名没有写入第二条记录');
      await assert.rejects(
        () => host.assistants.create({ name: '代码审查', instructions: '另一份' }),
        (error) => error.code === contracts.CHATDSH_ERROR_CODES.requestInvalid,
        '宿主的名称唯一校验同样拒绝',
      );
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    });

    await t.test('引用面板：技能状态来自宿主，停用项不可选，已有引用可以取消', async () => {
      await cli('click', '#wp11-assistant-create');
      await cli('wait', 'dialog[open]');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-skills-note-taking").disabled'), true, '停用技能不能新选');
      assert.equal(await textHas('已停用，不能新增引用'), true, '停用项给出原因');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-skills-code-review").disabled'), false, '启用技能可以选');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');

      const holder = await host.assistants.create({ name: '纪要助手', instructions: '整理纪要', tier: 'chat', skills: ['note-taking'] });
      await cli('click', '#wp11-assistant-refresh');
      await cli('wait', '--text', '纪要助手');
      await cli('find', 'role', 'button', 'click', '--name', '编辑 纪要助手');
      await cli('wait', 'dialog[open]');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-skills-note-taking").checked'), true, '已有引用保持勾选');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-skills-note-taking").disabled'), false, '已有引用可以取消');
      assert.equal(await textHas('去掉这条引用之后不能再选回来'), true, '取消之后不能再选回来');
      await cli('click', '#wp11-assistant-skills-note-taking');
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.deepEqual(host.assistants.list().find((record) => record.id === holder.id).skills, [], '取消引用写进了记录');
      await host.assistants.remove(holder.id);
      await cli('click', '#wp11-assistant-refresh');
      await cli('wait', '--fn', 'document.querySelectorAll(".chdsh-skeleton").length === 0 && document.body.innerText.includes("代码审查") && !document.body.innerText.includes("纪要助手")');
    });

    await t.test('详情：定义字段、指令全文、真实装配行与技能引用状态', async () => {
      const record = host.assistants.list()[0];
      await cli('find', 'role', 'button', 'click', '--name', `详情 ${record.name}`);
      await cli('wait', 'dialog[open]');
      await cli('wait', '#wp11-assistant-detail-close');
      assert.equal(
        await evaluate('document.getElementById("wp11-assistant-detail-id").textContent.includes("版本 1")'),
        true,
        '详情显示标识与版本',
      );
      assert.equal(
        await evaluate('document.getElementById("wp11-assistant-detail-instructions").textContent'),
        '你是代码审查助手',
        '指令全文显示在详情里',
      );
      const rows = await evaluate('document.querySelectorAll("#wp11-assistant-detail-rows li").length');
      assert.ok(rows > 0, '详情列出真实装配行');
      assert.equal(
        await evaluate('document.getElementById("wp11-assistant-detail-rows").textContent.includes("tool-web")'),
        true,
        '聊天档自带的工具行出现在装配结果里',
      );
      assert.equal(
        await evaluate('document.getElementById("wp11-assistant-detail-rows").textContent.includes("tool-fs")'),
        true,
        '附加工具行出现在装配结果里',
      );
      assert.equal(
        await evaluate('document.getElementById("wp11-assistant-detail-rows").textContent.includes("persona")'),
        true,
        '所有档位共用的人格行出现在装配结果里',
      );
      assert.equal(await textHas('装配后落盘'), true, '说明写入失败保留原定义');
      assert.equal(await textHas('code-review'), true, '详情列出引用的技能');
      assert.equal(await textHas('已启用'), true, '引用技能带启用状态');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), `详情 ${record.name}`, 'Escape 之后焦点回到详情按钮');
    });

    await t.test('编辑：版本冲突保留编辑稿，重新读取后按最新版本提交', async () => {
      const record = host.assistants.list()[0];
      await cli('find', 'role', 'button', 'click', '--name', `编辑 ${record.name}`);
      await cli('wait', 'dialog[open]');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-name").value'), '代码审查', '表单带回原名称');
      await cli('fill', '#wp11-assistant-description', '审查改动与测试覆盖');

      const elsewhere = await host.assistants.update(record.id, { instructions: '另一处的改动', revision: record.revision });
      assert.equal(elsewhere.revision, record.revision + 1, '另一处写入成功');

      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--text', '助手版本已过期');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-conflict-reload") !== null'), true, '冲突状态给出重新读取入口');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-description").value'), '审查改动与测试覆盖', '编辑稿保留');
      const unchanged = host.assistants.list().find((entry) => entry.id === record.id);
      assert.equal(unchanged.description, '审查改动与测试', '冲突时没有覆盖服务器值');
      assert.equal(unchanged.revision, elsewhere.revision);

      await cli('click', '#wp11-assistant-conflict-reload');
      await cli('wait', '--text', '已按服务器当前值重新读取');
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      const saved = host.assistants.list().find((entry) => entry.id === record.id);
      assert.equal(saved.description, '审查改动与测试覆盖', '重新读取之后按最新版本写入');
      assert.equal(saved.revision, elsewhere.revision + 1);
    });

    await t.test('装配失败：宿主拒绝写入，原定义与表单输入都保留', async () => {
      const record = host.assistants.list()[0];
      const before = await host.ctx.agentPresets.readDocument(record.id);
      await cli('find', 'role', 'button', 'click', '--name', `编辑 ${record.name}`);
      await cli('wait', 'dialog[open]');
      await cli('select', '#wp11-assistant-tier', 'work');
      await cli('fill', '#wp11-assistant-description', '试图换成工作档');
      await cli('click', '#wp11-assistant-submit');
      await cli('wait', '--text', '助手装配失败，已保留原定义');
      assert.equal(await evaluate('document.querySelector("dialog[open]") !== null'), true, '失败后对话框仍在');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-description").value'), '试图换成工作档', '失败后表单输入保留');
      const after = await host.ctx.agentPresets.readDocument(record.id);
      assert.equal(after.content, before.content, '装配失败后装回去的还是原定义');
      const listed = host.assistants.list().find((entry) => entry.id === record.id);
      assert.equal(listed.tier, 'chat', '记录保持原档位');
      assert.equal(listed.description, '审查改动与测试覆盖', '记录保持原说明');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
    });

    await t.test('键盘：对话框约束焦点，Escape 回到触发控件，多选用方向键与空格', async () => {
      await cli('click', '#wp11-assistant-create');
      await cli('wait', 'dialog[open]');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, '打开后焦点在对话框里');
      for (let step = 0; step < 24; step += 1) {
        await cli('press', 'Tab');
        assert.equal(
          await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'),
          true,
          'Tab 不会离开对话框',
        );
      }
      await cli('press', 'Shift+Tab');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, 'Shift+Tab 也不会离开');

      await cli('click', '#wp11-assistant-skills-code-review');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-skills-code-review").checked'), true, '点击勾选');
      await evaluate('document.getElementById("wp11-assistant-skills-code-review").focus()');
      await cli('press', 'ArrowDown');
      const focused = await activeId();
      assert.notEqual(focused, 'wp11-assistant-skills-code-review', '方向键在可选项之间移动焦点');
      assert.equal(focused.startsWith('wp11-assistant-skills-'), true, '焦点落在同一组的下一个选项');
      await cli('press', 'Space');
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(focused)}).checked`), true, '空格勾选当前项');

      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await activeId(), 'wp11-assistant-create', 'Escape 之后焦点回到新建按钮');
    });

    await t.test('删除：二次确认说明影响范围，结果显示进行中会话数', async () => {
      const record = host.assistants.list()[0];
      host.ctx.sessions.create('session-wp11-assistant', { meta: { cwd: join(home, 'workspace'), agentPreset: record.id } });
      assert.equal(host.ctx.sessions.list().filter((item) => item.header.agentPreset === record.id).length, 1);

      await cli('find', 'role', 'button', 'click', '--name', `删除 ${record.name}`);
      await cli('wait', 'dialog[open]');
      assert.equal(await textHas('进行中的会话按创建时的定义继续运行'), true, '确认框说明进行中会话的影响');
      assert.equal(await textHas('删除之后无法恢复'), true, '确认框说明不可恢复');
      assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, '确认框打开后焦点在其中');
      await cli('press', 'Escape');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), `删除 ${record.name}`, 'Escape 之后焦点回到删除按钮');

      await cli('find', 'role', 'button', 'click', '--name', `删除 ${record.name}`);
      await cli('wait', 'dialog[open]');
      await cli('click', '#wp11-assistant-delete-confirm');
      await cli('wait', '--fn', '!document.querySelector("dialog[open]")');
      await cli('wait', '--text', '1 个进行中的会话继续使用创建时的定义');
      assert.equal(host.assistants.list().length, 0);
      assert.equal(host.ctx.sessions.get('session-wp11-assistant').header.agentPreset, record.id, '进行中的会话仍持有原定义标识');
      await cli('wait', '--text', '还没有自定义助手');
    });

    await t.test('加载失败显示原因与重新加载入口，恢复后回到列表', async () => {
      control.failList = true;
      await cli('click', '#wp11-assistant-refresh');
      await cli('wait', '--text', '助手列表读取失败：助手存储暂时不可用');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-reload") !== null'), true, '失败状态给出重新加载入口');
      control.failList = false;
      await cli('click', '#wp11-assistant-reload');
      await cli('wait', '--text', '内置档位（3）');
      assert.equal(await evaluate('document.getElementById("wp11-assistant-reload") === null'), true, '恢复后失败入口消失');
    });

    await t.test('依赖缺失：装配清单与技能目录不可用时分别说明，列表仍然可读', async () => {
      const reduced = {
        'chatdshAssistants/list': async () => host.assistants.list(),
        'agentPresets/list': async () => ({ presets: await host.ctx.agentPresets.list() }),
      };
      const second = await startPanelPage({ handlers: reduced, script });
      try {
        await cli('open', second.origin);
        await cli('wait', '#wp11-assistant-create');
        await cli('wait', '--text', '工具装配清单读取失败');
        assert.equal(await textHas('技能目录读取失败'), true, '技能目录不可用单独说明');
        assert.equal(await textHas('还没有自定义助手'), true, '工具与技能来源缺失不影响目录本身');
      } finally {
        await second.close();
      }
      await cli('open', page.origin);
      await cli('wait', '#wp11-assistant-create');
      await cli('wait', '--text', '内置档位（3）');
    });

    await t.test('遥测：界面动作、调用 span、失败事件与错误计数都送到同源中继', async () => {
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
      assert.ok(actions.some((record) => record.attributes.action === 'assistant.create' && record.attributes.outcome === 'ok'), '新建成功有界面动作');
      assert.ok(actions.some((record) => record.attributes.action === 'assistant.create' && record.attributes.outcome === 'rejected'), '表单校验失败记为 rejected');
      assert.ok(actions.some((record) => record.attributes.action === 'assistant.update' && record.attributes.outcome === 'ok'), '编辑保存有界面动作');
      assert.ok(actions.some((record) => record.attributes.action === 'assistant.update' && record.attributes.outcome === 'failed'), '冲突与装配失败记为 failed');
      assert.ok(actions.some((record) => record.attributes.action === 'assistant.delete' && record.attributes.outcome === 'ok'), '删除成功');
      assert.ok(actions.some((record) => record.attributes.action === 'assistant.detail' && record.attributes.outcome === 'ok'), '打开详情记为界面动作');
      assert.ok(actions.some((record) => record.attributes.action === 'assistant.reload' && record.attributes.outcome === 'ok'), '冲突后重新读取记为界面动作');
      assert.ok(actions.every((record) => typeof record.attributes.action === 'string' && typeof record.attributes.outcome === 'string'));

      const failures = records.filter((record) => record.name === 'chatdsh.client.error');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'revision-conflict'), '版本冲突按错误码上报');
      assert.ok(failures.some((record) => record.attributes['error.code'] === 'request-invalid'), '装配失败按错误码上报');
      assert.ok(failures.every((record) => typeof record.attributes['error.type'] === 'string' && record.attributes['error.type'] !== ''));

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
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshAssistants/create' && span.attributes.outcome === 'ok'));
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'chatdshAssistants/update' && span.attributes.outcome === 'failed'), '冲突的写入有失败 span');
      assert.ok(spans.some((span) => span.attributes['rpc.method'] === 'pluginInventory/list' && span.attributes.outcome === 'ok'));
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
    if (host !== undefined) await host.ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    releaseIndependentHome(home);
  }
});
