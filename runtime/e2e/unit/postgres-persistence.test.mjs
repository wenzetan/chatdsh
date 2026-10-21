// PostgreSQL 会话持久化后端的契约测试。
//
// 用真实 Postgres（deploy/compose.postgres.yaml，宿主 50031）验证建表、创建会话、追加、
// 读取、列目录与写所有权。需要 CHATDSH_TEST_PG_URL 指向可写数据库，缺省跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const URL = process.env.CHATDSH_TEST_PG_URL ?? '';
const hasPostgres = URL !== '';

test('Postgres 会话持久化：创建、追加、读取与列目录', { skip: hasPostgres ? false : '缺少 CHATDSH_TEST_PG_URL' }, async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { PostgresSessionPersistence } = await import('../../packages/core/session-persistence-postgres/lib/index.js');
  const ctx = new Context();
  const backend = new PostgresSessionPersistence(ctx, { connectionString: URL, schema: 'chatdsh_test' });
  await backend.initialize();
  const id = `pg-${Date.now()}`;
  const header = { id, version: 4, cwd: '/workspace/chatdsh', createdAt: Date.now(), isSeeded: false };

  const handle = await backend.create(header);
  const event = {
    type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 },
  };
  await handle.append([event]);
  await handle.flush();
  await handle.close();

  const read = await backend.open(id, 'read');
  try {
    const slice = await read.read();
    assert.equal(slice.events.length, 1);
    assert.equal(slice.events[0].type, 'turn/start');
  } finally {
    await read.close();
  }

  const list = await backend.list();
  assert.ok(list.some((snapshot) => snapshot.header.id === id));
  const stat = await backend.stat(id);
  assert.equal(stat?.header.id, id);

  const writer = await backend.open(id, 'write');
  try {
    await assert.rejects(() => backend.open(id, 'write'), /SessionAlreadyOwnedError|已经|owner/i);
  } finally {
    await writer.close();
  }
  await backend.close();
});
