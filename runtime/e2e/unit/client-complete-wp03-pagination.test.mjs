import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore, ReplicaStore, ReceiptStore } from '../../gateway/lib/store.js';
import { createClientSessionQuery } from '../../gateway/lib/sessions.js';

function database() {
  const home = allocateIndependentHome('wp03-pagination');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  const query = createClientSessionQuery(store.handle(), () => false);
  return { store, replica, receipts, query, close() { store.close(); releaseIndependentHome(home); } };
}

test('一万条真实 SQLite 会话按稳定顺序分页，无重复、遗漏和设备越权', () => {
  const app = database();
  try {
    const db = app.store.handle();
    const insert = db.prepare('insert into sessions(session_id, device_id, cwd, kind, created_at) values (?, ?, ?, ?, ?)');
    const event = db.prepare('insert into replica_events(session_id, seq, kind, time, bytes, payload) values (?, ?, ?, ?, ?, ?)');
    db.exec('begin');
    try {
      for (let index = 0; index < 10000; index += 1) {
        const id = `session-${String(index).padStart(5, '0')}`;
        const time = Math.floor(index / 20);
        insert.run(id, index % 2 ? 'device-b' : 'device-a', '/workspace/project', 'work', time);
        event.run(id, 0, 'session/title', time, 32, JSON.stringify({ data: { title: `会话 ${index}` } }));
        event.run(id, 1, 'assistant/message', time, 8, '{}');
        event.run(id, 2, 'tool/result', time, 8, '{}');
      }
      db.exec('commit');
    } catch (error) { db.exec('rollback'); throw error; }
    const seen = [];
    const durations = [];
    let after;
    do {
      const started = performance.now();
      const page = app.query({ clientId: 'reader', deviceIds: ['device-a'], query: '', limit: 137, after });
      durations.push(performance.now() - started);
      assert.ok(page.items.length <= 137);
      assert.ok(page.items.every((item) => item.deviceId === 'device-a'));
      assert.ok(page.items.every((item) => item.unreadMessages === 1));
      seen.push(...page.items.map((item) => item.sessionId));
      if (!page.hasMore) break;
      const last = page.items.at(-1);
      assert.ok(last);
      after = [last.updatedAt, last.sessionId];
    } while (true);
    assert.equal(seen.length, 5000);
    assert.equal(new Set(seen).size, 5000);
    const expected = db.prepare("select session_id from sessions where device_id = 'device-a' order by created_at desc, session_id collate binary asc").all().map((row) => row.session_id);
    assert.deepEqual(seen, expected);
    assert.equal(app.query({ clientId: 'reader', deviceIds: [], query: '', limit: 50 }).items.length, 0);
    assert.equal(app.query({ clientId: 'reader', deviceIds: ['device-a'], deviceId: 'device-b', query: '', limit: 50 }).items.length, 0);
    assert.equal(app.query({ clientId: 'reader', deviceIds: 'all', query: '', limit: 200 }).items.length, 200);
    const sorted = durations.toSorted((a, b) => a - b);
    console.log(JSON.stringify({ sessions: 10000, selected: seen.length, pages: durations.length, p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.floor(sorted.length * 0.95)], maxMs: sorted.at(-1) }));
  } finally { app.close(); }
});

test('标题、路径末段、删除状态与业务未读在数据库查询中保持准确', () => {
  const app = database();
  try {
    for (const [id, cwd] of [['A', 'C:\\work\\项目\\'], ['a', '/workspace/项目/'], ['z', '']]) {
      app.store.upsertSession({ sessionId: id, deviceId: 'device-a', cwd, kind: 'work', createdAt: 1 });
    }
    app.replica.append('A', [
      { seq: 0, kind: 'session/title', time: 1, bytes: 8, payload: { data: { title: 'Old' } } },
      { seq: 1, kind: 'session/title', time: 2, bytes: 8, payload: { data: { title: 'ÄBC_% 中文' } } },
      { seq: 2, kind: 'session/title', time: 3, bytes: 8, payload: { data: { title: '' } } },
      { seq: 3, kind: 'assistant/message', time: 4, bytes: 8, payload: {} },
      { seq: 4, kind: 'tool/result', time: 5, bytes: 8, payload: {} },
      { seq: 5, kind: 'assistant/message', time: 6, bytes: 8, payload: {} },
    ]);
    app.receipts.mark({ sessionId: 'A', deviceId: 'reader', readUpToSeq: 3 });
    const options = { clientId: 'reader', deviceIds: 'all', query: '', limit: 50 };
    const rows = app.query(options).items;
    assert.equal(rows.find((row) => row.sessionId === 'A').title, 'ÄBC_% 中文');
    assert.equal(rows.find((row) => row.sessionId === 'A').unreadMessages, 1);
    assert.equal(rows.find((row) => row.sessionId === 'a').title, '项目');
    assert.equal(rows.find((row) => row.sessionId === 'z').title, 'z');
    assert.deepEqual(app.query({ ...options, query: 'äbc_%' }).items.map((row) => row.sessionId), ['A']);
    assert.deepEqual(app.query({ ...options, query: '%' }).items.map((row) => row.sessionId), ['A']);
    app.store.handle().prepare('update sessions set deleted_at = ? where session_id = ?').run(Date.now(), 'A');
    assert.deepEqual(app.query(options).items.map((row) => row.sessionId), ['a', 'z']);
    assert.throws(() => app.query({ ...options, limit: 201 }), /每页条数/);
  } finally { app.close(); }
});
