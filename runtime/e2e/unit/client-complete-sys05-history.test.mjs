// SYS05 的历史规范化与分页读取验收。
//
// 用真实的 Cordis 上下文、真实的 JSONL 会话持久化与真实的上游会话重建构造一段包含
// 压缩替换、工具结果与非文本内容的历史，检查：分页读到日志结束、system 稳定、第一条
// user 取自当前表面、被替换的消息不复活、损失逐项声明、指纹不受分页大小影响。
//
// 运行：node --test e2e/unit/client-complete-sys05-history.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);

const { Context } = await import('@deepseek-ai/cordis');
const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');
const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
const { readSessionHistory } = await import('../../packages/host/chat-hermes/lib/history-source.js');
const { historyDigestOf, normalizeHistory } = await import('../../../hermes-adapter/lib/index.js');

/** 等插件激活。 */
function settle(ms = 400) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 一条事件的公共字段。 */
function row(seq, type, data, extra = {}) {
  return { seq, type, time: 1_700_000_000_000 + seq, data, ...extra };
}

/**
 * 构造一段带压缩替换与工具结果的历史。
 * @returns {object[]} 事件序列。
 */
function historyRows() {
  const system = {
    id: 's1', role: 'system', source: { kind: 'system-prompt' },
    content: [{ type: 'text', text: '稳定系统提示' }],
  };
  return [
    row(0, 'turn/start', { turn: 1 }),
    row(1, 'step/start', { turn: 1, step: 1 }),
    row(2, 'system/message', { turn: 1, step: 1, message: system }, { surfaceOp: 'append' }),
    row(3, 'user/message', {
      id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条用户' }],
    }, { surfaceOp: 'append' }),
    row(4, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'dsh', model: 'dsh-1' },
        content: [{ type: 'text', text: '第一条回答' }],
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    row(5, 'step/end', { turn: 1, step: 1 }),
    row(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    row(7, 'turn/start', { turn: 2 }),
    row(8, 'step/start', { turn: 2, step: 1 }),
    row(9, 'user/message', {
      id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条用户' }],
    }, { surfaceOp: 'append' }),
    row(10, 'assistant/message', {
      turn: 2, step: 1,
      message: {
        id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'dsh', model: 'dsh-1' },
        content: [{ type: 'text', text: '第二条回答' }, { type: 'reasoning', text: '内部推理' }],
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    row(11, 'step/end', { turn: 2, step: 1 }),
    row(12, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    // 压缩：把第一轮的用户与助手消息替换成一条摘要，两条原消息不再位于表面上。
    row(13, 'user/message', {
      id: 'compact', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '压缩摘要' }],
    }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] }),
  ];
}

/** 建一个持久化会话并写入事件。 */
async function seedSession(ctx, id) {
  const created = await ctx.sessionPersistence.create({
    id, version: 4, cwd: RUNTIME, createdAt: Date.now(), isSeeded: false,
  });
  await created.append(historyRows());
  await created.flush();
  await created.close();
}

test('分页读完日志，压缩替换不复活，损失逐项声明', async () => {
  const home = tempHome('sys05-history');
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root: join(home, 'sessions') });
  await settle();
  const id = `sys05-history-${Date.now()}`;
  await seedSession(ctx, id);
  try {
    const small = await readSessionHistory(ctx, id, { pageSize: 2 });
    assert.equal(small.snapshot.eventCount, 14);
    assert.equal(small.snapshot.pages, 8, '每页 2 条时要读到返回短页为止');
    assert.equal(small.inheritedEventCount, 0);

    const large = await readSessionHistory(ctx, id, { pageSize: 200 });
    assert.equal(large.snapshot.pages, 1);
    assert.equal(large.snapshot.historyDigest, small.snapshot.historyDigest, '指纹不受分页大小影响');

    const snapshot = small.snapshot;
    assert.equal(snapshot.system, '稳定系统提示');
    assert.equal(snapshot.firstUser, '压缩摘要', '第一条 user 取自当前表面');
    assert.deepEqual(snapshot.messages.map((message) => message.text), [
      '压缩摘要', '第二条用户', '第二条回答',
    ]);
    assert.equal(
      snapshot.messages.some((message) => message.text === '第一条用户' || message.text === '第一条回答'),
      false,
      '被替换的消息不得复活',
    );

    const loss = Object.fromEntries(snapshot.loss.map((item) => [item.code, item.count]));
    assert.equal(loss['shadowed-messages-omitted'], 2);
    assert.equal(loss['non-text-blocks-omitted'], 1);

    assert.deepEqual(snapshot.model, { provider: 'dsh', model: 'dsh-1', source: 'assistant' });
    assert.equal(snapshot.historyDigest, historyDigestOf(snapshot.system, snapshot.messages));

    const again = await readSessionHistory(ctx, id, { pageSize: 200 });
    assert.equal(again.snapshot.historyDigest, snapshot.historyDigest, '重复读取指纹稳定');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('新增回合后历史继续增长且旧消息保持', async () => {
  const home = tempHome('sys05-history-growth');
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root: join(home, 'sessions') });
  await settle();
  const id = `sys05-history-growth-${Date.now()}`;
  await seedSession(ctx, id);
  try {
    const before = await readSessionHistory(ctx, id, { pageSize: 3 });
    const handle = await ctx.sessionPersistence.open(id, 'write');
    const nextSeq = (await handle.read()).events.length;
    await handle.append([
      row(nextSeq, 'turn/start', { turn: 3 }),
      row(nextSeq + 1, 'step/start', { turn: 3, step: 1 }),
      row(nextSeq + 2, 'user/message', {
        id: 'u4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '后续问题' }],
      }, { surfaceOp: 'append' }),
      row(nextSeq + 3, 'assistant/message', {
        turn: 3, step: 1,
        message: {
          id: 'a4', role: 'assistant', source: { kind: 'model', provider: 'dsh', model: 'dsh-2' },
          content: [{ type: 'text', text: '后续回答' }],
        },
        stream: [],
      }, { surfaceOp: 'append' }),
    ]);
    await handle.flush();
    await handle.close();

    const after = await readSessionHistory(ctx, id, { pageSize: 3 });
    assert.equal(after.snapshot.messages.length, before.snapshot.messages.length + 2);
    assert.deepEqual(after.snapshot.messages.slice(-2).map((message) => message.text), ['后续问题', '后续回答']);
    assert.equal(after.snapshot.firstUser, '压缩摘要');
    assert.notEqual(after.snapshot.historyDigest, before.snapshot.historyDigest);
    assert.deepEqual(after.snapshot.model, { provider: 'dsh', model: 'dsh-2', source: 'assistant' });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('会话不存在时直接失败', async () => {
  const home = tempHome('sys05-history-missing');
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root: join(home, 'sessions') });
  await settle();
  try {
    await assert.rejects(
      () => readSessionHistory(ctx, 'sys05-absent', { pageSize: 10 }),
      /会话不存在/,
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('工具轨迹与非文本内容逐项计入损失声明', () => {
  const snapshot = normalizeHistory({
    events: [
      { seq: 0, type: 'system/message', data: {} },
      { seq: 1, type: 'user/message', data: {} },
      { seq: 2, type: 'assistant/message', data: {} },
      { seq: 3, type: 'tool/result', data: {} },
      { seq: 4, type: 'developer/message', data: {} },
      {
        seq: 5,
        type: 'user/message',
        data: {},
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
        sourceEventSeqs: [1, 2],
      },
    ],
    projection: {
      messages: [
        { role: 'system', text: 'S', contentTypes: ['text'] },
        { role: 'user', text: '摘要', contentTypes: ['text'] },
        { role: 'assistant', text: '回答', contentTypes: ['text', 'reasoning'] },
        { role: 'tool', text: '工具输出', contentTypes: ['text'], messageId: 't1' },
      ],
    },
    pages: 3,
  });
  const loss = Object.fromEntries(snapshot.loss.map((item) => [item.code, item.count]));
  assert.equal(loss['tool-traces-omitted'], 1);
  assert.equal(loss['non-text-blocks-omitted'], 1);
  assert.equal(loss['shadowed-messages-omitted'], 2);
  assert.equal(snapshot.firstUser, '摘要');
  assert.deepEqual(snapshot.messages.map((message) => message.text), ['摘要', '回答']);
  assert.equal(snapshot.historyDigest.startsWith('sha256'), false, '指纹是十六进制');
  assert.match(snapshot.historyDigest, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.pages, 3);
  assert.equal(snapshot.eventCount, 6);
});
