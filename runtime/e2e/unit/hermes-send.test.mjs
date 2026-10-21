// Hermes 聊天服务层的端到端测试。
//
// 用真实的 Cordis 上下文、真实的 JSONL 会话持久化与真实 Hermes 测试容器（默认
// 127.0.0.1:50011）调用 `send`，断言事件序列写进会话日志。不替身 Hermes，也不替身
// 持久化。缺少 HERMES_API_KEY 时跳过，并说明原因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const RUNTIME = resolve(import.meta.dirname, '../..');

ensureDeps(RUNTIME);
ensureDeps(resolve(REPO, 'dsh-adapter'));

const HERMES_URL = process.env.HERMES_URL ?? 'http://127.0.0.1:50011';
const hasKey = (process.env.HERMES_API_KEY ?? '') !== '';

test('send 把 Hermes 回复写成连续的会话事件', { skip: hasKey ? false : '缺少 HERMES_API_KEY，跳过真实 Hermes 联调' }, async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');
  const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
  const { ChatdshHermesChatService } = await import('../../packages/host/chat-hermes/lib/index.js');

  const home = tempHome('hermes-send');
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root: join(home, 'sessions') });
  ctx.plugin(ChatdshHermesChatService, {
    baseUrl: HERMES_URL,
    apiKeyEnv: 'HERMES_API_KEY',
    requestTimeoutMs: 120_000,
    approvalTimeoutMs: 300_000,
    modelLabel: 'hermes-0.21.7',
  });
  await new Promise((settle) => setTimeout(settle, 800));

  const id = `hermes-send-${Date.now()}`;
  const cwd = REPO;
  const header = { id, version: 4, cwd, createdAt: Date.now(), isSeeded: false };
  const created = await ctx.sessionPersistence.create(header);
  await created.flush();
  await created.close();
  // 故意不创建活体会话：走存储写句柄分支，覆盖没有活动 Agent 的渠道会话形态。

  try {
    const result = await ctx.chatdshHermesChat.send(id, '只回复两个字：收到');
    assert.equal(result.appended, 6);
    assert.match(result.assistantText, /收到/);

    const read = await ctx.sessionPersistence.open(id, 'read');
    try {
      const slice = await read.read();
      assert.deepEqual(slice.events.map((event) => event.type), [
        'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
      ]);
      const assistant = slice.events.find((event) => event.type === 'assistant/message');
      assert.equal(assistant.data.message.source.provider, 'hermes');
      assert.match(assistant.data.message.content[0].text, /收到/);
    } finally {
      await read.close();
    }

    // 第二次发送必须接着已有日志追加，序号从 6 开始。
    const second = await ctx.chatdshHermesChat.send(id, '再回复两个字：收到');
    assert.equal(second.appended, 6);
    const readAgain = await ctx.sessionPersistence.open(id, 'read');
    try {
      const slice = await readAgain.read();
      assert.equal(slice.events.length, 12);
      assert.equal(slice.events[6].seq, 6);
      assert.equal(slice.events[6].type, 'turn/start');
      assert.equal(slice.events[6].data.turn, 2);
    } finally {
      await readAgain.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
