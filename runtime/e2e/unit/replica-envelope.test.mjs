// R03 的副本信封回归：设备上报完整事件信封，中继存储与种子构造保留压缩语义，
// PWA 时间线同时接受信封与裸数据，重复上报保持幂等并拒绝内容冲突。
//
// 真实 SQLite、真实 HTTP 与真实 JSONL 会话持久化；数据根固定在 runtime/.run。
//
// 运行：node --test e2e/unit/replica-envelope.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import SessionPlugin from '@deepseek-ai/dsh-session';
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {
  REPLICA_PATH,
  ReplicaContinuityStore,
  replicaBytesOf,
  replicaDigestOf,
  startReplicaServer,
} from '../../gateway/lib/replica-continuity/index.js';
import { SqliteDatabase } from '../../gateway/lib/replica-continuity/sqlite.js';
import { ReplicaIntentStore } from '../../packages/host/push/lib/intents.js';
import { ReplicaContinuity } from '../../packages/host/push/lib/continuity.js';
import { buildSeed } from '../../packages/host/import/lib/seed.js';
import { planFork } from '../../packages/host/import/lib/fork.js';
import { buildReplicaTimeline } from '../../gateway/lib/pwa-view.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const BASE_TIME = 1_700_000_000_000;
const DEVICE_ID = 'device-agent';
const NODE_TOKEN = 'token-agent';

function delay(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let detail;
  while (Date.now() < deadline) {
    detail = await check();
    if (detail.ok) return detail.value;
    await delay(20);
  }
  throw new Error(`等待超时：${label}；最后状态 ${JSON.stringify(detail)}`);
}

function userMessage(id, text) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function envelopeOf(event) {
  return {
    type: event.type ?? event.kind,
    seq: event.seq,
    time: event.time,
    data: event.data,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
  };
}

function sessionEvents() {
  return [
    { type: 'turn/start', seq: 0, time: BASE_TIME, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: BASE_TIME + 1,
      data: userMessage('message-1', '第一条消息'),
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: 2, time: BASE_TIME + 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 3,
      time: BASE_TIME + 3,
      data: userMessage('message-2', '第二条消息'),
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 4, time: BASE_TIME + 4, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 5,
      time: BASE_TIME + 5,
      data: userMessage('message-3', '第三条消息'),
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      seq: 6,
      time: BASE_TIME + 6,
      data: userMessage('message-4', '压缩后的摘要'),
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 },
      sourceEventSeqs: [1, 2, 3],
    },
    { type: 'turn/end', seq: 7, time: BASE_TIME + 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

async function startReplica(home) {
  const databasePath = join(home, 'replica', 'replica.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new SqliteDatabase(databasePath);
  const store = new ReplicaContinuityStore(database);
  store.registerToken(DEVICE_ID, NODE_TOKEN);
  const server = await startReplicaServer({ store, host: '127.0.0.1', port: 0 });
  return {
    store,
    databasePath,
    url: server.url,
    async close() {
      await server.close();
      database.close();
    },
  };
}

async function startPersistence(home) {
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root: join(home, 'sessions') });
  await waitFor(() => ({ ok: ctx.sessionPersistence !== undefined }), 10_000, '会话持久化');
  return ctx;
}

async function postBatch(base, body) {
  const response = await fetch(`${base}${REPLICA_PATH}`, {
    method: 'POST',
    headers: {
      'x-chatdsh-node-id': DEVICE_ID,
      authorization: `Bearer ${NODE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

function eventRowCount(databasePath, sessionId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('select count(*) as total from replica_events where session_id = ?').get(sessionId);
    return Number(row.total);
  } finally {
    database.close();
  }
}

test('host-push 上报完整信封，副本存储与种子构造保留压缩语义', async () => {
  const home = allocateIndependentHome('replica-envelope-push');
  let replica;
  let ctx;
  let intents;
  try {
    replica = await startReplica(home);
    ctx = await startPersistence(home);
    const sessionId = 'replica-envelope-session';
    const events = sessionEvents();
    const handle = await ctx.sessionPersistence.create({
      id: sessionId,
      version: 4,
      cwd: process.cwd(),
      createdAt: Date.now(),
      isSeeded: false,
    });
    await handle.flush();
    await handle.close();

    intents = new ReplicaIntentStore(join(home, 'push', 'replica-intents.sqlite'));
    const runner = new ReplicaContinuity({
      persistence: ctx.sessionPersistence,
      intents,
      controlUrl: replica.url,
      deviceId: DEVICE_ID,
      nodeToken: NODE_TOKEN,
    });
    const reply = await runner.sendBatch(sessionId, 0, events);
    assert.equal(reply.kind, 'accepted');
    assert.equal(reply.appended, events.length);
    assert.equal(reply.acknowledgedThrough, events.length - 1);

    const smallEvents = [
      { type: 'turn/start', seq: 0, time: BASE_TIME, data: { turn: 1 } },
      { type: 'turn/start', seq: 1, time: BASE_TIME + 1, data: { turn: 1 } },
    ];
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelopeOf(smallEvents[0])));
    assert.ok(2 * Buffer.byteLength(JSON.stringify(smallEvents[0].data)) <= envelopeBytes);
    const limiter = new ReplicaContinuity({
      persistence: ctx.sessionPersistence,
      intents,
      controlUrl: replica.url,
      deviceId: DEVICE_ID,
      nodeToken: NODE_TOKEN,
      batchBytes: envelopeBytes,
    });
    assert.deepEqual(limiter.limitBytes(smallEvents).map((event) => event.seq), [0]);

    const stored = replica.store.readEvents(sessionId);
    assert.equal(stored.length, events.length);
    for (const [index, record] of stored.entries()) {
      assert.equal(record.seq, index);
      const envelope = record.payload;
      assert.equal(typeof envelope, 'object');
      assert.notEqual(envelope, null);
      assert.equal(envelope.type, events[index].type);
      assert.equal(envelope.seq, record.seq);
      assert.equal(envelope.time, record.time);
      assert.deepEqual(envelope.data, events[index].data);
      assert.equal(record.bytes, replicaBytesOf(envelope));
      assert.equal(record.digest, replicaDigestOf(envelope));
    }

    const replacement = stored[6];
    assert.ok(replacement !== undefined);
    const replacementEnvelope = replacement.payload;
    assert.equal(typeof replacementEnvelope, 'object');
    assert.notEqual(replacementEnvelope, null);
    assert.equal(replacementEnvelope.type, 'user/message');
    assert.equal(replacementEnvelope.seq, 6);
    assert.equal(replacementEnvelope.time, BASE_TIME + 6);
    assert.deepEqual(replacementEnvelope.data, userMessage('message-4', '压缩后的摘要'));
    assert.deepEqual(replacementEnvelope.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 5 });
    assert.deepEqual(replacementEnvelope.sourceEventSeqs, [1, 2, 3]);

    const cursor = replica.store.cursorView(sessionId);
    const expectedBytes = stored.reduce((sum, record) => sum + replicaBytesOf(record.payload), 0);
    assert.equal(cursor.continuousSeq, events.length - 1);
    assert.equal(cursor.eventCount, events.length);
    assert.equal(cursor.bytesCommitted, expectedBytes);

    const records = stored.map((record) => ({
      seq: record.seq,
      kind: record.kind,
      time: record.time,
      payload: record.payload,
    }));
    const seed = buildSeed(records);
    const seedReplacement = seed.find((event) => event.seq === 6);
    assert.ok(seedReplacement !== undefined);
    assert.equal(seedReplacement.type, 'user/message');
    assert.equal(seedReplacement.time, BASE_TIME + 6);
    assert.deepEqual(seedReplacement.data, userMessage('message-4', '压缩后的摘要'));
    assert.deepEqual(seedReplacement.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 5 });
    assert.deepEqual(seedReplacement.sourceEventSeqs, [1, 2, 3]);

    const plan = planFork({
      records,
      sourceSessionId: sessionId,
      sourceDeviceId: DEVICE_ID,
      turnTo: 1,
      importMode: 'full-prefix',
      availableAttachmentIds: [],
      scheduledTasks: 0,
      now: BASE_TIME,
    });
    const forkReplacement = plan.seed.find((event) => event.seq === 6);
    assert.ok(forkReplacement !== undefined);
    assert.deepEqual(forkReplacement.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 5 });
    assert.deepEqual(forkReplacement.sourceEventSeqs, [1, 2, 3]);

    const bareData = userMessage('message-bare', '裸数据消息');
    const bareSeed = buildSeed([{ seq: 0, kind: 'user/message', time: 8, payload: bareData }]);
    assert.deepEqual(bareSeed, [{
      type: 'user/message',
      seq: 0,
      time: 8,
      data: bareData,
      surfaceOp: 'append',
    }]);
  } finally {
    intents?.close();
    if (ctx !== undefined) await ctx.fiber.dispose();
    if (replica !== undefined) await replica.close();
    releaseIndependentHome(home);
  }
});

test('PWA 时间线对信封与裸数据输出一致', () => {
  const semantic = [
    { seq: 0, kind: 'user/message', time: BASE_TIME, data: userMessage('message-1', '请检查这个仓库') },
    {
      seq: 1,
      kind: 'assistant/message',
      time: BASE_TIME + 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: '我先看目录结构。' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
        usage: { inputTokens: 12, outputTokens: 34 },
      },
    },
    {
      seq: 2,
      kind: 'tool/call',
      time: BASE_TIME + 2,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}' },
    },
    {
      seq: 3,
      kind: 'approval/asked',
      time: BASE_TIME + 3,
      data: { id: 'request-1', toolName: 'shell', callId: 'call-1', reason: '需要写入文件' },
    },
    {
      seq: 4,
      kind: 'approval/decided',
      time: BASE_TIME + 4,
      data: { id: 'request-1', outcome: 'allowed-once' },
    },
  ];
  const bare = semantic.map((event) => ({
    seq: event.seq,
    kind: event.kind,
    time: event.time,
    payload: event.data,
  }));
  const enveloped = semantic.map((event) => ({
    seq: event.seq,
    kind: event.kind,
    time: event.time,
    payload: envelopeOf(event),
  }));

  const bareTimeline = buildReplicaTimeline(bare);
  const envelopeTimeline = buildReplicaTimeline(enveloped);
  assert.deepEqual(envelopeTimeline.counts, bareTimeline.counts);
  assert.equal(envelopeTimeline.items.length, bareTimeline.items.length);
  for (const [index, envelopeItem] of envelopeTimeline.items.entries()) {
    const bareItem = bareTimeline.items[index];
    assert.deepEqual(
      { ...envelopeItem, raw: undefined },
      { ...bareItem, raw: undefined },
    );
  }
  assert.equal(envelopeTimeline.items[3].status, 'decided');
  assert.match(envelopeTimeline.items[3].meta, /结果 已允许一次/);
  assert.equal(envelopeTimeline.items[4].body, '工具 shell');
});

test('重复上报同一批事件幂等，同序号内容变化返回冲突', async () => {
  const home = allocateIndependentHome('replica-envelope-idempotent');
  let replica;
  try {
    replica = await startReplica(home);
    const sessionId = 'replica-envelope-idempotent';
    const events = [
      {
        seq: 0,
        kind: 'user/message',
        time: BASE_TIME,
        payload: envelopeOf({
          type: 'user/message',
          seq: 0,
          time: BASE_TIME,
          data: userMessage('message-a', '第一条'),
          surfaceOp: 'append',
        }),
      },
      {
        seq: 1,
        kind: 'assistant/message',
        time: BASE_TIME + 1,
        payload: envelopeOf({
          type: 'assistant/message',
          seq: 1,
          time: BASE_TIME + 1,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'assistant-a',
              role: 'assistant',
              content: [{ type: 'text', text: '收到。' }],
              source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            },
          },
          surfaceOp: 'append',
        }),
      },
    ];

    const first = await postBatch(replica.url, { sessionId, retentionGeneration: 0, events });
    assert.equal(first.status, 200);
    assert.equal(first.payload.appended, 2);
    assert.equal(first.payload.duplicates, 0);
    assert.equal(first.payload.acknowledgedThrough, 1);
    const committedBytes = first.payload.bytesCommitted;

    const second = await postBatch(replica.url, { sessionId, retentionGeneration: 0, events });
    assert.equal(second.status, 200);
    assert.equal(second.payload.appended, 0);
    assert.equal(second.payload.duplicates, 2);
    assert.equal(second.payload.acknowledgedThrough, 1);
    assert.equal(second.payload.bytesCommitted, committedBytes);
    assert.equal(eventRowCount(replica.databasePath, sessionId), 2);
    assert.equal(replica.store.cursorView(sessionId).continuousSeq, 1);

    const conflicting = [
      {
        seq: 0,
        kind: 'user/message',
        time: BASE_TIME,
        payload: userMessage('message-a', '第一条'),
      },
      events[1],
    ];
    const conflict = await postBatch(replica.url, { sessionId, retentionGeneration: 0, events: conflicting });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.payload.error, 'replica-content-conflict');
    assert.equal(conflict.payload.seq, 0);
    assert.equal(eventRowCount(replica.databasePath, sessionId), 2);
    assert.equal(replica.store.cursorView(sessionId).continuousSeq, 1);
    assert.equal(replica.store.cursorView(sessionId).bytesCommitted, committedBytes);
  } finally {
    if (replica !== undefined) await replica.close();
    releaseIndependentHome(home);
  }
});
