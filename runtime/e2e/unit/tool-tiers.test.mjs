// 工具档位契约的回归测试。
//
// 三档分别断言挂载面与呈现形态，并核对补丁层与契约声明一致：档位声明在两处
// （`core-contracts` 与 preset 补丁层），不一致时这里失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const contracts = await import('../../packages/core/contracts/lib/index.js');
// 适配层在仓库根的同级目录，测试按相对路径取它的登记表。
const upstream = await import('../../../dsh-adapter/lib/upstream.js');

test('档位按排序值排列，默认档位是工作档', () => {
  assert.deepEqual(
    contracts.CHATDSH_TOOL_TIERS.map((tier) => tier.id),
    ['chat', 'work', 'full'],
  );
  assert.equal(contracts.DEFAULT_TOOL_TIER, 'work');
  assert.equal(contracts.presetIdOf('work'), 'chatdsh-work');
});

test('聊天档不带文件与命令工具', () => {
  const chat = contracts.toolTierOf('chat');
  for (const row of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search']) {
    assert.ok(!chat.upstreamRows.includes(row), `聊天档不应挂 ${row}`);
  }
  assert.equal(chat.presentation, 'native');
  assert.deepEqual(chat.chatdshRows, []);
});

test('工作档是默认档位，自带自建产出类工具', () => {
  const work = contracts.toolTierOf('work');
  assert.equal(work.presentation, 'native');
  for (const row of ['tool-fs', 'tool-fs-search', 'tool-todo', 'tool-web']) {
    assert.ok(work.upstreamRows.includes(row), `工作档应挂 ${row}`);
  }
  assert.ok(work.chatdshRows.includes('chatdsh-tool-artifact'));
});

test('全量档走 ptc 形态并且条目多于工作档', () => {
  const work = contracts.toolTierOf('work');
  const full = contracts.toolTierOf('full');
  assert.equal(full.presentation, 'ptc');
  assert.ok(
    full.upstreamRows.length > work.upstreamRows.length,
    '全量档的上游行应当多于工作档',
  );
  for (const row of ['tool-subagent', 'tool-worktree', 'tool-ask-user', 'tool-schedule']) {
    assert.ok(full.upstreamRows.includes(row), `全量档应挂 ${row}`);
  }
});

test('档位标识之外的值直接抛出', () => {
  assert.throws(() => contracts.toolTierOf('bogus'), /未知的工具档位/);
});

test('补丁层的三档与契约声明一致', () => {
  const text = readFileSync(resolve(REPO, 'runtime/packages/preset/chat/cordis.patch.yml'), 'utf8');
  const ids = [...text.matchAll(/^\s+- id: preset-([a-z0-9-]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(ids, ['chatdsh-chat', 'chatdsh-work', 'chatdsh-full']);

  for (const tier of contracts.CHATDSH_TOOL_TIERS) {
    // 每一档在补丁层里都要声明自己的全部上游行与自建行。
    // 上游行的包名从适配层登记表取，不靠前缀推导：worktree 这一行叫
    // dsh-experimental-tool-worktree，按前缀拼会得到不存在的包名。
    for (const row of [...tier.upstreamRows, ...tier.chatdshRows]) {
      const name = row.startsWith('chatdsh-')
        ? `@chatdsh/${row.slice('chatdsh-'.length)}`
        : upstream.UPSTREAM_TOOL_ROWS[row];
      assert.ok(name !== undefined, `上游工具行未登记：${row}`);
      assert.ok(text.includes(`name: '${name}'`), `补丁层缺少 ${name}`);
    }
  }
});

test('只有全量档声明 ptc 呈现', () => {
  const text = readFileSync(resolve(REPO, 'runtime/packages/preset/chat/cordis.patch.yml'), 'utf8');
  const blocks = text.split(/^\s*- id: preset-/m).slice(1);
  const ptcBlocks = blocks.filter((block) => block.includes('mode: ptc'));
  assert.equal(ptcBlocks.length, 1, '只应有一档声明 ptc');
  assert.ok(ptcBlocks[0].startsWith('chatdsh-full'), 'ptc 应当属于全量档');
});

test('每个 profile 的默认预设都落在已声明的档位里', () => {
  const presetText = readFileSync(resolve(REPO, 'runtime/packages/preset/chat/cordis.patch.yml'), 'utf8');
  const declared = new Set(
    [...presetText.matchAll(/^\s+- id: preset-([a-z0-9-]+)$/gm)].map((match) => match[1]),
  );
  const files = ['runtime/profiles', 'runtime/e2e/profiles'].flatMap((base) =>
    readdirSync(resolve(REPO, base), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(REPO, base, entry.name, 'cordis.patch.yml')),
  ).filter((file) => existsSync(file));

  let checked = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const registry = text.match(/- id: agent-preset-registry[\s\S]*?(?=\n- |\n#|$)/);
    if (registry === null) continue;
    const wanted = registry[0].match(/^\s*default:\s*(\S+)$/m)?.[1];
    assert.ok(wanted !== undefined, `${file} 的 agent-preset-registry 没有 default`);
    checked += 1;
    // 档位拆分之后旧的 `chatdsh` 标识不存在了：默认值必须指向补丁层声明过的档位。
    assert.ok(declared.has(wanted), `${file} 的默认预设 ${wanted} 不在补丁层声明里`);
    assert.equal(wanted, contracts.presetIdOf(contracts.DEFAULT_TOOL_TIER), `${file} 的默认预设应为工作档`);
  }
  assert.ok(checked > 0, '没有找到任何设置默认预设的 profile');
});
