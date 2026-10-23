// 助手按工具档位装配的回归测试。
//
// 装配结果直接决定模型看到哪些工具，因此这里对真实 Cordis 上下文构造助手服务，
// 用假注册表接收 preset 定义，逐档核对挂载行与呈现声明。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const { ChatdshAssistantsService } = await import('../../packages/host/assistants/lib/index.js');

/** 造一个只记录注册的定义收集器。 */
function fakeRegistry() {
  const definitions = [];
  return {
    definitions,
    agentPresets: {
      async register(definition) {
        definitions.push(definition);
        return async () => {};
      },
    },
  };
}

/** 在真实上下文里构造服务并按档位装配一条助手。 */
async function mountWith(tier) {
  const registry = fakeRegistry();
  const ctx = new Context();
  ctx.provide('agentPresets', registry.agentPresets);
  const service = new ChatdshAssistantsService(ctx);
  // 装配路径只依赖记录，不依赖存储：直接对服务实例调装配，核对它产出的行。
  const plugins = service.composePlugins({
    id: 'a1',
    name: '助手',
    description: '',
    order: 1,
    instructions: '指令',
    ...(tier === undefined ? {} : { tier }),
    tools: [],
    createdAt: 0,
    updatedAt: 0,
  });
  return plugins;
}

test('不写档位时按工作档装配', async () => {
  const plugins = await mountWith(undefined);
  const ids = plugins.map((row) => row.id);
  assert.ok(ids.includes('tool-fs'), '工作档应挂文件工具');
  assert.ok(ids.includes('chatdsh-tool-artifact'), '工作档应挂制品工具');
  assert.ok(!ids.includes('tool-presentation'), '工作档不带呈现选择行');
});

test('聊天档不挂文件与命令工具', async () => {
  const plugins = await mountWith('chat');
  const ids = plugins.map((row) => row.id);
  for (const row of ['tool-fs', 'tool-fs-search', 'tool-bash', 'tool-pwsh']) {
    assert.ok(!ids.includes(row), `聊天档不应挂 ${row}`);
  }
  assert.ok(ids.includes('tool-session-query'), '聊天档应挂会话检索');
});

test('全量档带 ptc 呈现行，包名取自适配层登记表', async () => {
  const plugins = await mountWith('full');
  const presentation = plugins.find((row) => row.id === 'tool-presentation');
  assert.ok(presentation !== undefined, '全量档应带呈现选择行');
  assert.equal(presentation.config.mode, 'ptc');
  assert.equal(presentation.name, '@deepseek-ai/dsh-agent-tool-presentation');
});

test('命令执行的两行按平台只挂一个', async () => {
  for (const tier of ['work', 'full']) {
    const ids = (await mountWith(tier)).map((row) => row.id);
    const commands = ids.filter((row) => row === 'tool-bash' || row === 'tool-pwsh');
    assert.equal(commands.length, 1, `${tier} 档应只挂一个命令工具`);
    const expected = process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash';
    assert.deepEqual(commands, [expected]);
  }
});

test('人格、指令与时间上下文三行所有档位都挂', async () => {
  for (const tier of ['chat', 'work', 'full']) {
    const ids = (await mountWith(tier)).map((row) => row.id);
    for (const row of ['persona', 'agent-instructions', 'time-context']) {
      assert.ok(ids.includes(row), `${tier} 档缺少 ${row}`);
    }
  }
});
