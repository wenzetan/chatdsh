// 记忆接入的测试。
//
// 前半段验证纯规则（bank 划分、去重合并），后半段直接调用本机运行中的 Hindsight，
// 覆盖探活、写入、召回三条真实路径。写入用带标记的内容并在召回时按该标记过滤，避免
// 与已有记忆混在一起。
//
// 运行：node --test e2e/unit/memory.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { banksFor, composeTurnMemory, dedupeHits, planTurnWrite, TurnWriteDeduper } from '../../packages/host/memory/lib/rules.js';
import { createMemoryClient } from '../../packages/host/memory/lib/client.js';

const HINDSIGHT = process.env.HINDSIGHT_URL ?? 'http://127.0.0.1:8889';

test('聊天会话只读写账号 bank', () => {
  assert.deepEqual(banksFor({ accountId: 'a1', tenantId: 'default' }), {
    recall: ['acct:a1'],
    write: 'acct:a1',
  });
});

test('私有工作区召回组 bank 与账号 bank，写入账号 bank', () => {
  assert.deepEqual(banksFor({ accountId: 'a1', tenantId: 'default', memoryGroupId: 'w9' }), {
    recall: ['t:default:ws:w9', 'acct:a1'],
    write: 'acct:a1',
  });
});

test('共享工作区把记忆写进组 bank', () => {
  assert.deepEqual(banksFor({ accountId: 'a1', tenantId: 'default', memoryGroupId: 'w9', shared: true }), {
    recall: ['t:default:ws:w9', 'acct:a1'],
    write: 't:default:ws:w9',
  });
});

test('多路召回按文本去重并保序', () => {
  const merged = dedupeHits([
    { id: '1', text: '同一段话', type: 'world' },
    { id: '2', text: '另一段话', type: 'world' },
    { id: '3', text: '同一段话', type: 'world' },
  ]);
  assert.deepEqual(merged.map((hit) => hit.id), ['1', '2']);
});

test('对真实 Hindsight 完成探活、写入与召回', async () => {
  const client = createMemoryClient({
    hindsightUrl: HINDSIGHT,
    maxTokens: 256,
    requestTimeoutMs: 10_000,
  });
  assert.equal(await client.probe(), true, 'Hindsight 应当可用');

  const marker = `chatdsh-e2e-${Date.now()}`;
  const bank = 'acct:chatdsh-e2e';
  const written = await client.write(bank, {
    content: `端到端验证写入的标记 ${marker}`,
    context: 'chatdsh 记忆接入测试',
    tags: [marker],
  });
  assert.ok(written.items >= 1, '写入应当至少落一条');
  assert.ok(written.operationId !== undefined, '异步写入应当返回整合任务标识');

  // 新写入的内容要等后台整合完成才可被召回，因此这里只验证召回通道可用，
  // 命中与否取决于整合进度，不作为断言条件。
  const hits = await client.recall([bank], { query: marker, tags: [marker], maxTokens: 128 });
  assert.ok(Array.isArray(hits), '召回应当返回列表');
});

test('回合记忆保留用户与助手文本并按上限截断', () => {
  const text = composeTurnMemory([
    { role: 'user', text: '蓝鲸的体长是多少' },
    { role: 'assistant', text: '蓝鲸体长约三十米。' },
  ]);
  assert.equal(text, '用户：蓝鲸的体长是多少\n助手：蓝鲸体长约三十米。');
  const long = composeTurnMemory([{ role: 'user', text: 'x'.repeat(100) }], 10);
  assert.equal(long.length, 11);
  assert.ok(long.endsWith('…'));
  assert.equal(composeTurnMemory([]), '');
});

test('回合写入按工作区是否共享选择 bank', () => {
  const messages = [{ role: 'user', text: '问题' }, { role: 'assistant', text: '结论' }];
  const privatePlan = planTurnWrite({ cwd: '/work/private', shared: false, messages });
  assert.equal(privatePlan.bank, 'acct:local');
  assert.equal(privatePlan.content, '用户：问题\n助手：结论');

  const sharedPlan = planTurnWrite({ cwd: '/work/shared', shared: true, messages });
  assert.equal(sharedPlan.bank, 't:default:ws:/work/shared');

  const chatPlan = planTurnWrite({ cwd: '', shared: false, messages });
  assert.equal(chatPlan.bank, 'acct:local');
});

test('空回合不产生写入计划', () => {
  assert.equal(planTurnWrite({ cwd: '/work', shared: false, messages: [] }), undefined);
});

test('同一会话的同一回合只允许写一次', () => {
  const deduper = new TurnWriteDeduper(4);
  assert.equal(deduper.accept('s1:1'), true);
  assert.equal(deduper.accept('s1:1'), false);
  assert.equal(deduper.accept('s1:2'), true);
  assert.equal(deduper.size, 2);
});
