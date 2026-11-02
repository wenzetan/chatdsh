// WP09-A1 助手宿主的验收测试。
//
// 每个用例在 runtime/.run 下分配独立数据根，用真实的存储中枢、JSON 后端、存储域、技能注册表、
// 会话注册表、加载器与 agent preset 注册表构造助手服务：装配走注册表的真实挂载流程，重启恢复
// 走真实存储，删除时的会话引用来自真实会话注册表。覆盖增删改查、工具与技能引用校验、重名与
// 超限拒绝、过期 revision、装配失败保留原定义、排序与档位、以及删除不打断进行中的会话。
//
// 运行：node --test e2e/unit/client-complete-wp09-assistants.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { default: Storage } = await import('@deepseek-ai/dsh-storage');
const json = await import('@deepseek-ai/dsh-storage-json');
const domainPlugin = await import('@deepseek-ai/dsh-storage-domain');
const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: AgentPresetRegistry } = await import('@deepseek-ai/dsh-agent-preset-registry');
const {
  ASSISTANT_INSTRUCTIONS_LIMIT,
  ASSISTANT_NAME_LIMIT,
  ChatdshAssistantsService,
} = await import('../../packages/host/assistants/lib/index.js');
const { CHATDSH_ERROR_CODES } = await import('../../packages/core/contracts/lib/index.js');

/** 等待插件树激活。 */
function settle(ms = 1500) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 按真实宿主注册方式装配一套助手服务的运行环境。
 * @param {string} root 数据根。
 * @returns {Promise<import('@deepseek-ai/cordis').Context>} 上下文。
 */
async function openStack(root) {
  const ctx = new Context();
  ctx.plugin(Storage);
  ctx.plugin(json, { root: join(root, 'storages') });
  ctx.plugin(domainPlugin, { backend: 'json' });
  ctx.plugin(SkillRegistry);
  ctx.plugin(SessionPlugin);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(Loader, { baseUrl: `${RUNTIME}/` });
  ctx.plugin(AgentPresetRegistry, { default: 'chatdsh-work' });
  ctx.plugin(ChatdshAssistantsService);
  await settle();
  return ctx;
}

/** 准备一个数据根与一个工作目录。 */
function makeRoot(prefix) {
  const root = tempHome(prefix);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { root, workspace };
}

/** 注册一条真实的运行时技能。 */
function registerSkill(ctx, name) {
  return ctx.skills.register({ name, description: `${name} 的说明`, content: `# ${name}` });
}

/** 记录里是否包含挂载代。 */
function mounted(ctx, id) {
  return ctx.agentPresets.inspectCompositions().some((entry) => entry.id === id);
}

test('新建助手：写进存储并真实装配成预设', async () => {
  const { root } = makeRoot('wp09-assistants-create');
  const ctx = await openStack(root);
  try {
    const created = await ctx.chatdshAssistants.create({
      name: '代码审查',
      description: '审查改动',
      instructions: '你是代码审查助手',
      tier: 'chat',
      tools: ['tool-web', 'tool-web'],
    });
    assert.equal(created.revision, 1);
    assert.equal(created.tools.length, 1, '重复的工具行只保留一次');
    assert.deepEqual(created.skills, []);
    assert.deepEqual(created.tier, 'chat');

    const listed = ctx.chatdshAssistants.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(mounted(ctx, created.id), true, '预设应当真的挂载在注册表里');

    const document = await ctx.agentPresets.readDocument(created.id);
    assert.match(document.content, /persona/, '装配结果里有客户人格行');
    assert.match(document.content, /dsh-tool-web/, '额外工具行进了装配结果');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('重名与超限拒绝，被拒绝的请求不留记录', async () => {
  const { root } = makeRoot('wp09-assistants-limits');
  const ctx = await openStack(root);
  try {
    await ctx.chatdshAssistants.create({ name: '写作', instructions: '指令', tier: 'chat' });

    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: '  写作  ', instructions: '另一份' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '名称去空白后相同即视为重名',
    );

    const second = await ctx.chatdshAssistants.create({ name: 'Writing', instructions: '指令', tier: 'chat' });
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: 'writing', instructions: '指令' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '名称比较忽略大小写',
    );
    await assert.rejects(
      () => ctx.chatdshAssistants.update(second.id, { name: '写作' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '更新也不能撞上别人的名称',
    );

    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: 'x'.repeat(ASSISTANT_NAME_LIMIT + 1), instructions: '指令' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '名称超长被拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: '长指令', instructions: 'y'.repeat(ASSISTANT_INSTRUCTIONS_LIMIT + 1) }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '指令超长被拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: '档位出错', instructions: '指令', tier: 'huge' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '未声明的档位被拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: '标识出错', instructions: '指令', id: '带 空格' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '标识写法不合法被拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: '排序出错', instructions: '指令', order: 1.5 }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '排序值必须是整数',
    );
    assert.equal(ctx.chatdshAssistants.list().length, 2, '被拒绝的创建不留下记录');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('工具与技能引用校验', async () => {
  const { root } = makeRoot('wp09-assistants-references');
  const ctx = await openStack(root);
  try {
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: '未知工具', instructions: '指令', tools: ['tool-not-exists'] }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '目录之外的工具行被拒绝',
    );
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ name: '未知技能', instructions: '指令', skills: ['skill-not-exists'] }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '技能目录之外的技能被拒绝',
    );

    registerSkill(ctx, 'code-review');
    registerSkill(ctx, 'release-notes');
    const created = await ctx.chatdshAssistants.create({
      name: '引用齐全',
      instructions: '指令',
      tier: 'chat',
      tools: ['tool-fs', 'tool-todo'],
      skills: ['code-review', 'release-notes', 'code-review'],
    });
    assert.deepEqual(created.tools, ['tool-fs', 'tool-todo']);
    assert.deepEqual(created.skills, ['code-review', 'release-notes'], '技能引用去重且保留书写顺序');

    await assert.rejects(
      () => ctx.chatdshAssistants.update(created.id, { skills: ['release-notes', 'skill-gone'] }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '更新时的技能引用同样要校验',
    );
    assert.deepEqual(ctx.chatdshAssistants.list()[0].skills, ['code-review', 'release-notes'], '被拒绝的更新不改记录');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('装配失败保留原定义：标识冲突与装不起来的行都不落地', async () => {
  const { root } = makeRoot('wp09-assistants-atomic');
  const ctx = await openStack(root);
  try {
    await ctx.agentPresets.register({ id: 'external-preset', name: '既有预设', description: '', order: 4, plugins: [] });
    await assert.rejects(
      () => ctx.chatdshAssistants.create({ id: 'external-preset', name: '撞标识', instructions: '指令', tier: 'chat' }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '与既有预设撞标识时装配失败',
    );
    assert.equal(ctx.chatdshAssistants.list().length, 0, '装配失败不写记录');
    assert.equal(mounted(ctx, 'external-preset'), true, '既有预设仍在');

    const created = await ctx.chatdshAssistants.create({ name: '原助手', instructions: '原始指令', tier: 'chat' });
    const before = await ctx.agentPresets.readDocument(created.id);
    await assert.rejects(
      () => ctx.chatdshAssistants.update(created.id, { instructions: '新指令', tools: ['chatdsh-tool-browser'] }),
      (error) => error.code === CHATDSH_ERROR_CODES.requestInvalid,
      '额外工具行的包在运行时安装树里不存在，装配被拒绝',
    );
    const after = await ctx.agentPresets.readDocument(created.id);
    assert.equal(after.content, before.content, '装配失败后装回去的还是原定义');
    const listed = ctx.chatdshAssistants.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].instructions, '原始指令', '记录保持原值');
    assert.equal(listed[0].revision, created.revision, '被拒绝的更新不改版本');
    assert.equal(mounted(ctx, created.id), true);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('过期 revision 抛 revision-conflict，并发更新只成功一次', async () => {
  const { root } = makeRoot('wp09-assistants-revision');
  const ctx = await openStack(root);
  try {
    const created = await ctx.chatdshAssistants.create({ name: '并发', instructions: '初始指令', tier: 'chat' });
    const updated = await ctx.chatdshAssistants.update(created.id, { instructions: '第二次指令', revision: created.revision });
    assert.equal(updated.revision, 2);
    await assert.rejects(
      () => ctx.chatdshAssistants.update(created.id, { instructions: '落后指令', revision: created.revision }),
      (error) => error.code === CHATDSH_ERROR_CODES.revisionConflict,
      '落后版本被拒绝',
    );
    assert.equal(ctx.chatdshAssistants.list()[0].instructions, '第二次指令');

    const results = await Promise.allSettled([
      ctx.chatdshAssistants.update(created.id, { instructions: '并发甲', revision: updated.revision }),
      ctx.chatdshAssistants.update(created.id, { instructions: '并发乙', revision: updated.revision }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, CHATDSH_ERROR_CODES.revisionConflict);
    assert.equal(ctx.chatdshAssistants.list()[0].revision, 3);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('删除助手：进行中的会话仍在，引用数记在结果里', async () => {
  const { root, workspace } = makeRoot('wp09-assistants-delete');
  const ctx = await openStack(root);
  try {
    const created = await ctx.chatdshAssistants.create({ name: '待删助手', instructions: '指令', tier: 'chat' });
    const session = ctx.sessions.create('session-wp09-assistant', { meta: { cwd: workspace, agentPreset: created.id } });
    assert.equal(session.header.agentPreset, created.id);

    const removal = await ctx.chatdshAssistants.remove(created.id);
    assert.equal(removal.removed, true);
    assert.equal(removal.liveSessions, 1, '删除时记录仍引用它的活动会话数');
    assert.equal(ctx.chatdshAssistants.list().length, 0);
    assert.equal(mounted(ctx, created.id), false, '预设注册被移除');
    assert.equal(ctx.sessions.get('session-wp09-assistant').header.agentPreset, created.id, '进行中的会话仍持有原定义标识');

    await assert.rejects(
      () => ctx.chatdshAssistants.remove(created.id),
      (error) => error.code === CHATDSH_ERROR_CODES.objectNotFound,
      '重复删除报对象不存在',
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('排序与档位：列表按排序值排列，装配结果按档位生成', async () => {
  const { root } = makeRoot('wp09-assistants-order');
  const ctx = await openStack(root);
  try {
    const late = await ctx.chatdshAssistants.create({ name: '后排', instructions: '指令', tier: 'chat', order: 40 });
    const early = await ctx.chatdshAssistants.create({ name: '前排', instructions: '指令', tier: 'chat', order: 10 });
    const order = ctx.chatdshAssistants.list().map((record) => record.id);
    assert.deepEqual(order, [early.id, late.id], '列表按排序值从前往后');

    const promoted = await ctx.chatdshAssistants.update(late.id, { order: 5, tier: 'chat' });
    assert.equal(promoted.order, 5);
    assert.equal(ctx.chatdshAssistants.list()[0].id, late.id, '更新排序后列表跟着变');

    const document = await ctx.agentPresets.readDocument(early.id);
    assert.match(document.content, /dsh-tool-web/, '聊天档挂网页抓取工具');
    assert.doesNotMatch(document.content, /dsh-tool-fs/, '聊天档不挂文件工具');
    assert.doesNotMatch(document.content, /tool-presentation/, '聊天档不带呈现选择行');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('实例重建后助手、版本与装配都恢复', async () => {
  const { root } = makeRoot('wp09-assistants-restart');
  const first = await openStack(root);
  let created;
  try {
    registerSkill(first, 'code-review');
    created = await first.chatdshAssistants.create({
      name: '重启前',
      instructions: '第一版指令',
      tier: 'chat',
      skills: ['code-review'],
    });
    await first.chatdshAssistants.update(created.id, { instructions: '第二版指令', revision: created.revision });
  } finally {
    await first.fiber.dispose();
    await settle(400);
  }

  const second = await openStack(root);
  try {
    const listed = second.chatdshAssistants.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].instructions, '第二版指令');
    assert.equal(listed[0].revision, 2);
    assert.deepEqual(listed[0].skills, ['code-review']);
    assert.equal(mounted(second, created.id), true, '重启时按记录重新装配预设');
    assert.equal((await second.agentPresets.readDocument(created.id)) !== undefined, true);
  } finally {
    await second.fiber.dispose();
  }
});
