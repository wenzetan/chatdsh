// SYS02 连续副本、持久补传与已提交事件的验收测试。
//
// 真实 SQLite、真实 HTTP 与独立数据根。设备侧进程加载真实 DSH 会话持久化（JSONL）与上报
// 插件，接收端进程加载真实连续副本服务；用 SIGKILL 终止进程后重启，验证补传意图恢复、
// 冷会话补齐、提交后确认前的中断幂等、乱序与冲突拒绝、保留代次与视图脱敏。
//
// 运行：node --test e2e/unit/client-complete-sys02-continuity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');

/** 被测模块的路径，供子进程加载同一份编译产物。 */
const MODULES = {
  replicaServerPath: join(RUNTIME, 'gateway/lib/replica-continuity/server.js'),
  replicaIndex: pathToFileURL(join(RUNTIME, 'gateway/lib/replica-continuity/index.js')).href,
  sqlite: pathToFileURL(join(RUNTIME, 'gateway/lib/storage/sqlite.js')).href,
  intents: pathToFileURL(join(RUNTIME, 'packages/host/push/lib/intents.js')).href,
  continuity: pathToFileURL(join(RUNTIME, 'packages/host/push/lib/continuity.js')).href,
  queue: pathToFileURL(join(RUNTIME, 'packages/client/conversation/lib/queue/queue.js')).href,
};

/** 上报路由。 */
const REPLICA_PATH = '/chatdsh/gateway/replica';

/** 保留策略路由。 */
const RETENTION_PATH = '/chatdsh/gateway/replica/retention';

/** 一行一行读子进程输出。 */
class LineReader {
  constructor(stream) {
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        this.deliver(line);
        index = this.buffer.indexOf('\n');
      }
    });
  }

  deliver(line) {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.lines.push(line);
  }

  next(timeoutMs, label) {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
    return new Promise((settle, fail) => {
      const timer = setTimeout(() => fail(new Error(`等待输出超时：${label}`)), timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(timer);
        settle(line);
      });
    });
  }
}

/** 等待一个条件成立。 */
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last.value;
    await new Promise((settle) => setTimeout(settle, 60));
  }
  throw new Error(`等待超时：${label}；最后状态 ${JSON.stringify(last?.detail ?? last)}`);
}

/** 等待子进程退出。 */
function waitExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error('等待子进程退出超时')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      settle();
    });
  });
}

/** 终止一个正在运行的子进程。 */
async function killProcess(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitExit(child);
}

/** 启动一个接收端进程。 */
async function startReplica(home, devices, options = {}) {
  const databasePath = join(home, 'replica', 'replica.sqlite');
  const entries = devices.map((device) => `${device.deviceId}:${device.token}`).join(',');
  const entry = options.crashAfterCommit === true ? null : MODULES.replicaServerPath;
  let args;
  let script;
  if (entry !== null) {
    args = [entry];
    script = entry;
  } else {
    script = [
      "import { mkdirSync } from 'node:fs';",
      "import { dirname } from 'node:path';",
      `const { SqliteDatabase } = await import(${JSON.stringify(MODULES.sqlite)});`,
      `const { ReplicaContinuityStore, startReplicaServer } = await import(${JSON.stringify(MODULES.replicaIndex)});`,
      'mkdirSync(dirname(process.env.CHATDSH_REPLICA_DB), { recursive: true });',
      "const database = new SqliteDatabase(process.env.CHATDSH_REPLICA_DB);",
      'const store = new ReplicaContinuityStore(database);',
      `for (const entry of (${JSON.stringify(entries)}).split(',')) {`,
      "  const separator = entry.indexOf(':');",
      '  store.registerToken(entry.slice(0, separator), entry.slice(separator + 1));',
      '}',
      'const server = await startReplicaServer({',
      '  store,',
      "  host: '127.0.0.1',",
      '  port: 0,',
      '  notify: (event) => {',
      "    process.stdout.write(JSON.stringify({ committed: event.seq }) + '\\n');",
      "    process.kill(process.pid, 'SIGKILL');",
      '  },',
      '});',
      'process.stdout.write(`chatdsh-replica ${server.url}\\n`);',
    ].join('\n');
    args = ['--input-type=module', '-e', script];
  }
  const child = spawn(process.execPath, args, {
    cwd: RUNTIME,
    env: {
      ...process.env,
      DSH_HOME: home,
      CHATDSH_TELEMETRY: 'off',
      CHATDSH_REPLICA_DB: databasePath,
      CHATDSH_REPLICA_HOST: '127.0.0.1',
      CHATDSH_REPLICA_PORT: '0',
      CHATDSH_REPLICA_DEVICES: entries,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reader = new LineReader(child.stdout);
  let errorText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errorText += chunk;
  });
  const line = await reader.next(30_000, '接收端监听地址').catch((error) => {
    throw new Error(`${error.message}；stderr=${errorText}；stdout=${JSON.stringify(reader.lines)}`);
  });
  const match = /chatdsh-replica (http:\/\/[^\s]+)/.exec(line);
  assert.ok(match !== null, `接收端启动输出应包含地址：${line}`);
  const base = match[1];
  return {
    base,
    databasePath,
    child,
    reader,
    output: () => errorText,
    async stop() {
      await killProcess(child);
    },
  };
}

/** 等接收端能响应探活。 */
async function waitHealthy(base) {
  await waitFor(async () => {
    try {
      const response = await fetch(`${base}/healthz`);
      return { ok: response.ok };
    } catch (error) {
      return { ok: false, detail: String(error) };
    }
  }, 15_000, '接收端探活');
}

/** 认证请求头。 */
function authHeaders(deviceId, token) {
  return {
    'x-chatdsh-node-id': deviceId,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

/** 发一次上报。 */
async function postBatch(base, deviceId, token, body) {
  const response = await fetch(`${base}${REPLICA_PATH}`, {
    method: 'POST',
    headers: authHeaders(deviceId, token),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

/** 读一个会话的内部状态。 */
async function readCursor(base, deviceId, token, sessionId) {
  const response = await fetch(`${base}${REPLICA_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(deviceId, token),
  });
  return { status: response.status, payload: await response.json() };
}

/** 调用保留策略路由。 */
async function postRetention(base, deviceId, token, sessionId, action) {
  const response = await fetch(`${base}${RETENTION_PATH}`, {
    method: 'POST',
    headers: authHeaders(deviceId, token),
    body: JSON.stringify({ sessionId, action }),
  });
  return { status: response.status, payload: await response.json() };
}

/** 设备侧子进程的脚本。 */
function deviceScript(mode) {
  return [
    "import { join } from 'node:path';",
    "const home = process.env.SYS02_HOME;",
    "const controlUrl = process.env.SYS02_CONTROL_URL;",
    "const deviceId = process.env.SYS02_DEVICE_ID;",
    "const token = process.env.SYS02_TOKEN;",
    "const count = Number(process.env.SYS02_COUNT ?? '0');",
    "const inputSession = process.env.SYS02_SESSION ?? '';",
    "const mode = process.env.SYS02_MODE;",
    "const { Context } = await import('@deepseek-ai/cordis');",
    "const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');",
    "const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');",
    `const { ReplicaIntentStore } = await import(${JSON.stringify(MODULES.intents)});`,
    `const { ReplicaContinuity } = await import(${JSON.stringify(MODULES.continuity)});`,
    `const { PendingQueue } = await import(${JSON.stringify(MODULES.queue)});`,
    'const ctx = new Context();',
    'ctx.plugin(SessionPlugin);',
    "ctx.plugin(jsonl, { root: join(home, 'sessions') });",
    'await new Promise((settle) => setTimeout(settle, 600));',
    'let sessionId = inputSession;',
    "if (mode === 'seed') {",
    '  sessionId = `sys02-${Date.now()}`;',
    '  const created = await ctx.sessionPersistence.create({',
    '    id: sessionId, version: 4, cwd: process.cwd(), createdAt: Date.now(), isSeeded: false,',
    '  });',
    '  const baseTime = Date.now();',
    '  const events = [];',
    '  for (let index = 0; index < count; index += 2) {',
    "    events.push({ type: 'turn/start', seq: index, time: baseTime + index, data: { turn: index / 2 + 1 } });",
    '    if (index + 1 < count) {',
    "      events.push({ type: 'turn/end', seq: index + 1, time: baseTime + index + 1, data: { turn: index / 2 + 1, reason: { kind: 'completed' } } });",
    '    }',
    '  }',
    '  for (let offset = 0; offset < events.length; offset += 100) {',
    '    await created.append(events.slice(offset, offset + 100));',
    '  }',
    '  await created.flush();',
    '  await created.close();',
    '}',
    "const intents = new ReplicaIntentStore(join(home, 'push', 'replica-intents.sqlite'));",
    'const runner = new ReplicaContinuity({',
    '  persistence: ctx.sessionPersistence,',
    '  intents,',
    '  controlUrl,',
    '  deviceId,',
    '  nodeToken: token,',
    '  batchSize: 64,',
    '});',
    "if (mode === 'seed') {",
    '  for (let seq = 0; seq < count; seq += 1) runner.noteEvent(sessionId, seq);',
    '  const results = await runner.scanAll();',
    '  const listed = await ctx.sessionPersistence.list();',
    '  process.stdout.write(`${JSON.stringify({',
    '    seeded: sessionId,',
    '    count,',
    '    listed: listed.length,',
    '    pending: runner.pendingSessions(),',
    '    results: results.map((item) => ({ sessionId: item.sessionId, outcome: item.outcome, remaining: item.remaining })),',
    "  })}\\n`);",
    '  setInterval(() => {}, 1000);',
    "} else if (mode === 'reacquire') {",
    '  const result = await runner.reacquire(inputSession);',
    '  process.stdout.write(`${JSON.stringify({ reacquired: result })}\\n`);',
    '  process.exit(0);',
    "} else if (mode === 'append-stale') {",
    "  const readHandle = await ctx.sessionPersistence.open(inputSession, 'read');",
    '  const existing = await readHandle.read();',
    '  const nextSeq = existing.events.length;',
    '  await readHandle.close();',
    "  const writeHandle = await ctx.sessionPersistence.open(inputSession, 'write');",
    '  const nextTurn = Math.floor(nextSeq / 2) + 1;',
    '  await writeHandle.append([',
    "    { type: 'turn/start', seq: nextSeq, time: Date.now(), data: { turn: nextTurn } },",
    "    { type: 'turn/end', seq: nextSeq + 1, time: Date.now(), data: { turn: nextTurn, reason: { kind: 'completed' } } },",
    '  ]);',
    '  await writeHandle.flush();',
    '  await writeHandle.close();',
    '  runner.noteEvent(inputSession, nextSeq);',
    '  const results = await runner.scanAll();',
    '  process.stdout.write(`${JSON.stringify({',
    '    appendedSeq: nextSeq,',
    '    results: results.map((item) => ({ sessionId: item.sessionId, outcome: item.outcome, remaining: item.remaining })),',
    '    pending: runner.pendingSessions(),',
    "  })}\\n`);",
    '  process.exit(0);',
    '} else {',
    '  const queue = new PendingQueue({',
    '    submit: async () => ({ accepted: true }),',
    "    query: async () => ({ state: 'unknown' }),",
    "    createId: () => 'offline-message-1',",
    '  });',
    "  queue.enqueue({ sessionId: inputSession, text: '离线消息保持草稿' });",
    '  const before = queue.snapshot();',
    '  const results = await runner.runUntilIdle({ deadlineMs: 120_000 });',
    '  const after = queue.snapshot();',
    '  process.stdout.write(`${JSON.stringify({',
    '    synced: inputSession,',
    '    pending: runner.pendingSessions(),',
    '    results: results.map((item) => ({ sessionId: item.sessionId, outcome: item.outcome, acknowledgedThrough: item.acknowledgedThrough, appended: item.appended, duplicates: item.duplicates, remaining: item.remaining })),',
    '    queue: { before, after },',
    "  })}\\n`);",
    '  process.exit(0);',
    '}',
  ].join('\n');
}

/** 启动设备侧进程。 */
function startDevice(home, mode, options) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', deviceScript(mode)], {
    cwd: RUNTIME,
    env: {
      ...process.env,
      DSH_HOME: home,
      CHATDSH_TELEMETRY: 'off',
      SYS02_HOME: home,
      SYS02_MODE: mode,
      SYS02_CONTROL_URL: options.controlUrl,
      SYS02_DEVICE_ID: options.deviceId,
      SYS02_TOKEN: options.token,
      SYS02_COUNT: String(options.count ?? 0),
      SYS02_SESSION: options.sessionId ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reader = new LineReader(child.stdout);
  let errorText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errorText += chunk;
  });
  return { child, reader, output: () => errorText };
}

/** 读设备进程的一行输出；失败时带上子进程的错误输出。 */
async function nextDeviceLine(device, timeoutMs, label) {
  try {
    return await device.reader.next(timeoutMs, label);
  } catch (error) {
    throw new Error(`${error.message}；stderr=${device.output()}；stdout=${JSON.stringify(device.reader.lines)}`);
  }
}

/** 在读意图库的总条数。 */
function intentCount(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('select count(*) as total from replica_intents').get();
    return Number(row.total);
  } finally {
    database.close();
  }
}

/** 在接收端数据库里读一个会话的事件与通知。 */
function replicaCounts(databasePath, sessionId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const events = database.prepare('select count(*) as total, coalesce(sum(payload_bytes), 0) as bytes from replica_events where session_id = ?').get(sessionId);
    const notifications = database.prepare('select count(*) as total from replica_notifications where session_id = ?').get(sessionId);
    return { events: Number(events.total), bytes: Number(events.bytes), notifications: Number(notifications.total) };
  } finally {
    database.close();
  }
}

test('设备离线积压超过内存上限，终止并重启宿主后冷会话补齐连续日志', async () => {
  const home = allocateIndependentHome('sys02-restart');
  const count = 800;
  let replica;
  let device;
  try {
    device = startDevice(home, 'seed', {
      controlUrl: 'http://127.0.0.1:1',
      deviceId: 'device-a',
      token: 'token-a',
      count,
    });
    const seededLine = await device.reader.next(120_000, '设备写下事件与意图');
    const seeded = JSON.parse(seededLine);
    assert.equal(seeded.count, count);
    assert.equal(seeded.pending, 1, '离线时意图保留为待补传会话');
    assert.equal(seeded.listed, 1, '会话已经写入真实 JSONL 日志');
    assert.equal(seeded.results[0].outcome, 'unreachable', '控制平面不可达时本轮同步明确失败');
    assert.equal(seeded.results[0].remaining, count, '全部事件仍待补传');

    const sessionId = seeded.seeded;
    const intentPath = join(home, 'push', 'replica-intents.sqlite');
    assert.equal(intentCount(intentPath), count, '每条事件都留下持久补传意图');

    await killProcess(device.child);
    assert.equal(device.child.signalCode, 'SIGKILL', '设备进程以真实终止结束');
    assert.equal(intentCount(intentPath), count, '进程终止后意图仍在');

    replica = await startReplica(home, [{ deviceId: 'device-a', token: 'token-a' }]);
    await waitHealthy(replica.base);

    device = startDevice(home, 'sync', {
      controlUrl: replica.base,
      deviceId: 'device-a',
      token: 'token-a',
      sessionId,
    });
    const syncedLine = await device.reader.next(120_000, '重启后继续补传');
    const synced = JSON.parse(syncedLine);
    assert.equal(synced.pending, 0, '重启之后意图全部确认');
    assert.equal(synced.results.length, 1);
    assert.equal(synced.results[0].sessionId, sessionId);
    assert.equal(synced.results[0].outcome, 'pushed');
    assert.equal(synced.results[0].acknowledgedThrough, count - 1, '连续前缀覆盖全部事件');
    assert.equal(synced.results[0].appended, count, '重启后补传全部事件');
    assert.equal(synced.results[0].remaining, 0);
    assert.equal(synced.queue.before.items.length, 1, '离线消息队列里有一条待发送内容');
    assert.equal(synced.queue.after.items.length, 1, '副本补传不改动离线消息队列');
    assert.equal(synced.queue.after.items[0].state, 'pending', '离线消息保持待发送');
    assert.equal(synced.queue.after.paused, false);
    assert.deepEqual(synced.queue.after, synced.queue.before, '副本补传与离线消息队列完全分离');

    const cursor = await readCursor(replica.base, 'device-a', 'token-a', sessionId);
    assert.equal(cursor.status, 200);
    assert.equal(cursor.payload.continuousSeq, count - 1);
    assert.equal(cursor.payload.eventCount, count);
    assert.equal(cursor.payload.retentionState, 'active');
    assert.ok(cursor.payload.bytesCommitted > 0);

    const counts = replicaCounts(replica.databasePath, sessionId);
    assert.equal(counts.events, count);
    assert.equal(counts.bytes, cursor.payload.bytesCommitted, '字节账本等于已提交正文的实际字节');
    assert.equal(counts.notifications, count, '通知登记与已提交事件一一对应');
    assert.equal(intentCount(intentPath), 0, '确认之后意图被清除');
  } finally {
    if (device !== undefined) await killProcess(device.child);
    if (replica !== undefined) await replica.stop();
    releaseIndependentHome(home);
  }
});

test('控制平面在写入提交后确认前终止，重传不增加事件与字节计数', async () => {
  const home = allocateIndependentHome('sys02-commit-crash');
  let crashing;
  let replica;
  try {
    crashing = await startReplica(home, [{ deviceId: 'device-a', token: 'token-a' }], { crashAfterCommit: true });
    const body = {
      sessionId: 'crash-session',
      retentionGeneration: 0,
      events: [{ seq: 0, kind: 'turn/start', time: 1_700_000_000_000, payload: { turn: 1 } }],
    };
    let posted;
    try {
      posted = await postBatch(crashing.base, 'device-a', 'token-a', body);
    } catch (error) {
      posted = { status: 0, payload: { error: String(error) } };
    }
    assert.equal(posted.status, 0, '提交之后的响应不会到达上报方');
    const committedLine = await crashing.reader.next(15_000, '提交后终止标记');
    assert.deepEqual(JSON.parse(committedLine), { committed: 0 });
    await waitExit(crashing.child);
    assert.equal(crashing.child.signalCode, 'SIGKILL', '接收端在确认前被真实终止');

    replica = await startReplica(home, [{ deviceId: 'device-a', token: 'token-a' }]);
    await waitHealthy(replica.base);
    const before = replicaCounts(replica.databasePath, 'crash-session');
    assert.equal(before.events, 1, '终止前的一个事务已经提交');
    assert.equal(before.bytes, Buffer.byteLength('{"turn":1}'));

    const replayed = await postBatch(replica.base, 'device-a', 'token-a', body);
    assert.equal(replayed.status, 200, `重传应当幂等确认：${JSON.stringify(replayed.payload)}`);
    assert.equal(replayed.payload.appended, 0, '重传不新增事件');
    assert.equal(replayed.payload.duplicates, 1);
    assert.equal(replayed.payload.acknowledgedThrough, 0);
    assert.equal(replayed.payload.bytesCommitted, before.bytes, '重传不增加字节计数');

    const after = replicaCounts(replica.databasePath, 'crash-session');
    assert.equal(after.events, 1);
    assert.equal(after.bytes, before.bytes);
  } finally {
    if (crashing !== undefined) await killProcess(crashing.child);
    if (replica !== undefined) await replica.stop();
    releaseIndependentHome(home);
  }
});

/** 构造一段连续事件。 */
function eventsOf(from, to) {
  const events = [];
  for (let seq = from; seq <= to; seq += 1) {
    events.push({ seq, kind: 'turn/start', time: 1_700_000_000_000 + seq, payload: { turn: seq + 1 } });
  }
  return events;
}

/** 在接收端数据库上撤销一个设备令牌。 */
async function revokeDeviceToken(databasePath, deviceId) {
  const { SqliteDatabase } = await import(MODULES.sqlite);
  const { ReplicaContinuityStore } = await import(MODULES.replicaIndex);
  const database = new SqliteDatabase(databasePath);
  try {
    const store = new ReplicaContinuityStore(database);
    store.revokeToken(deviceId);
  } finally {
    database.close();
  }
}

test('乱序、重复、冲突与非法归属被拒绝，连续前缀不跨过缺口', async () => {
  const home = allocateIndependentHome('sys02-conflict');
  let replica;
  try {
    replica = await startReplica(home, [
      { deviceId: 'device-a', token: 'token-a' },
      { deviceId: 'device-b', token: 'token-b' },
    ]);
    await waitHealthy(replica.base);

    const gap = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: eventsOf(1, 3),
    });
    assert.equal(gap.status, 409, JSON.stringify(gap.payload));
    assert.equal(gap.payload.error, 'replica-gap');
    assert.equal(gap.payload.expectedSeq, 0, '缺口返回期望序号');
    assert.deepEqual(gap.payload.missing, { from: 0, to: 0 }, '缺口返回缺失区间');
    let cursor = await readCursor(replica.base, 'device-a', 'token-a', 'gap-session');
    assert.equal(cursor.payload.continuousSeq, -1, '缺口不推进连续前缀');
    assert.equal(cursor.payload.eventCount, 0, '被拒绝的整批不留下事件');

    const filled = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: eventsOf(0, 3),
    });
    assert.equal(filled.status, 200, JSON.stringify(filled.payload));
    assert.equal(filled.payload.appended, 4);
    assert.equal(filled.payload.acknowledgedThrough, 3);
    const committedBytes = filled.payload.bytesCommitted;

    const duplicate = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: eventsOf(0, 3),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.payload.appended, 0, '重复相同内容不新增事件');
    assert.equal(duplicate.payload.duplicates, 4);
    assert.equal(duplicate.payload.bytesCommitted, committedBytes, '重复相同内容不增加字节');

    const conflict = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: [{ seq: 2, kind: 'turn/start', time: 1_700_000_000_002, payload: { turn: 99 } }],
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.payload));
    assert.equal(conflict.payload.error, 'replica-content-conflict');
    assert.equal(conflict.payload.seq, 2);
    cursor = await readCursor(replica.base, 'device-a', 'token-a', 'gap-session');
    assert.equal(cursor.payload.continuousSeq, 3);
    assert.equal(cursor.payload.bytesCommitted, committedBytes, '冲突不改变字节账本');

    const tail = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: eventsOf(4, 5),
    });
    assert.equal(tail.status, 200);
    const skipped = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: eventsOf(7, 7),
    });
    assert.equal(skipped.status, 409);
    assert.equal(skipped.payload.error, 'replica-gap');
    assert.equal(skipped.payload.expectedSeq, 6);
    assert.deepEqual(skipped.payload.missing, { from: 6, to: 6 });
    cursor = await readCursor(replica.base, 'device-a', 'token-a', 'gap-session');
    assert.equal(cursor.payload.continuousSeq, 5, '中间缺口不推进连续前缀');
    assert.equal(cursor.payload.eventCount, 6);
    const notified = replicaCounts(replica.databasePath, 'gap-session');
    assert.equal(notified.events, 6);
    assert.equal(notified.notifications, 6, '通知登记只覆盖已提交事件');

    const intruder = await postBatch(replica.base, 'device-b', 'token-b', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: eventsOf(6, 6),
    });
    assert.equal(intruder.status, 409, JSON.stringify(intruder.payload));
    assert.equal(intruder.payload.error, 'replica-owner-mismatch', '非法归属被拒绝');

    await revokeDeviceToken(replica.databasePath, 'device-a');
    const revoked = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'gap-session',
      retentionGeneration: 0,
      events: eventsOf(6, 6),
    });
    assert.equal(revoked.status, 401, '令牌撤销后拒绝上报');
    assert.equal(revoked.payload.error, 'replica-unauthorized');

    const other = await postBatch(replica.base, 'device-b', 'token-b', {
      sessionId: 'other-session',
      retentionGeneration: 0,
      events: eventsOf(0, 1),
    });
    assert.equal(other.status, 200, '另一台设备的会话不受影响');
    assert.equal(other.payload.appended, 2);
  } finally {
    if (replica !== undefined) await replica.stop();
    releaseIndependentHome(home);
  }
});

test('清理后的副本不会被旧补传重建，显式重新获取后按新代次补齐', async () => {
  const home = allocateIndependentHome('sys02-retention');
  let replica;
  try {
    replica = await startReplica(home, [{ deviceId: 'device-a', token: 'token-a' }]);
    await waitHealthy(replica.base);

    const seeded = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'retention-session',
      retentionGeneration: 0,
      events: eventsOf(0, 4),
    });
    assert.equal(seeded.status, 200);
    assert.equal(seeded.payload.appended, 5);

    const cleared = await postRetention(replica.base, 'device-a', 'token-a', 'retention-session', 'clear');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.payload.generation, 1, '清理增加保留代次');
    assert.equal(cleared.payload.state, 'cleared');
    const afterClear = await readCursor(replica.base, 'device-a', 'token-a', 'retention-session');
    assert.equal(afterClear.payload.eventCount, 0);
    assert.equal(afterClear.payload.continuousSeq, -1);
    assert.equal(afterClear.payload.retentionState, 'cleared');

    const stale = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'retention-session',
      retentionGeneration: 0,
      events: eventsOf(0, 4),
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.payload));
    assert.equal(stale.payload.error, 'replica-retention-stale');
    assert.equal(stale.payload.currentGeneration, 1);
    const stillEmpty = await readCursor(replica.base, 'device-a', 'token-a', 'retention-session');
    assert.equal(stillEmpty.payload.eventCount, 0, '旧代次的补传不会重建已清理副本');

    const reacquired = await postRetention(replica.base, 'device-a', 'token-a', 'retention-session', 'reacquire');
    assert.equal(reacquired.status, 200);
    assert.equal(reacquired.payload.generation, 2, '显式重新获取创建新代次');
    assert.equal(reacquired.payload.state, 'active');

    const stalePrevious = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'retention-session',
      retentionGeneration: 1,
      events: eventsOf(0, 4),
    });
    assert.equal(stalePrevious.status, 409);
    assert.equal(stalePrevious.payload.error, 'replica-retention-stale');

    const refilled = await postBatch(replica.base, 'device-a', 'token-a', {
      sessionId: 'retention-session',
      retentionGeneration: 2,
      events: eventsOf(0, 4),
    });
    assert.equal(refilled.status, 200, JSON.stringify(refilled.payload));
    assert.equal(refilled.payload.appended, 5);
    const final = await readCursor(replica.base, 'device-a', 'token-a', 'retention-session');
    assert.equal(final.payload.continuousSeq, 4);
    assert.equal(final.payload.eventCount, 5);
    assert.equal(final.payload.retentionGeneration, 2);
    assert.equal(final.payload.retentionState, 'active');

    const { replicaOverviewOf, replicaExportOf, INTERNAL_REPLICA_FIELDS } = await import(MODULES.replicaIndex);
    const overview = replicaOverviewOf(final.payload);
    const exported = replicaExportOf(overview);
    const text = JSON.stringify({ overview, exported });
    for (const field of INTERNAL_REPLICA_FIELDS) {
      assert.equal(text.includes(field), false, `界面与导出视图不得包含内部字段 ${field}`);
    }
    assert.deepEqual(Object.keys(overview).sort(), ['bytes', 'deviceId', 'eventCount', 'sessionId', 'updatedAt']);
    assert.deepEqual(Object.keys(exported).sort(), ['bytes', 'deviceId', 'eventCount', 'sessionId', 'updatedAt']);
    assert.equal(exported.eventCount, 5);
    assert.equal(exported.bytes, final.payload.bytesCommitted);
    assert.match(exported.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    if (replica !== undefined) await replica.stop();
    releaseIndependentHome(home);
  }
});

test('副本补传与用户离线消息发送不共用队列与包依赖', () => {
  const manifest = JSON.parse(readFileSync(join(RUNTIME, 'packages/host/push/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@chatdsh/adapter', '@chatdsh/core-contracts']);
  const sources = [
    readFileSync(join(RUNTIME, 'packages/host/push/src/continuity.ts'), 'utf8'),
    readFileSync(join(RUNTIME, 'packages/host/push/src/intents.ts'), 'utf8'),
    readFileSync(join(RUNTIME, 'packages/host/push/src/index.ts'), 'utf8'),
  ].join('\n');
  assert.equal(sources.includes('PendingQueue'), false, '补传通路不引用会话消息队列');
  assert.equal(sources.includes('conversation'), false, '补传通路不引用会话模块');
  assert.equal(sources.includes('offline-send'), false);
});

test('设备侧按保留代次停止旧补传，显式重新获取后继续补齐', async () => {
  const home = allocateIndependentHome('sys02-device-retention');
  let replica;
  let device;
  try {
    replica = await startReplica(home, [{ deviceId: 'device-a', token: 'token-a' }]);
    await waitHealthy(replica.base);
    device = startDevice(home, 'seed', {
      controlUrl: replica.base,
      deviceId: 'device-a',
      token: 'token-a',
      count: 12,
    });
    const seeded = JSON.parse(await nextDeviceLine(device, 60_000, '首次在线补传'));
    const sessionId = seeded.seeded;
    assert.equal(seeded.results[0].outcome, 'pushed');
    assert.equal(seeded.results[0].remaining, 0);
    const seededCursor = await readCursor(replica.base, 'device-a', 'token-a', sessionId);
    assert.equal(seededCursor.payload.continuousSeq, 11);
    assert.equal(intentCount(join(home, 'push', 'replica-intents.sqlite')), 0, '确认之后意图清空');
    await killProcess(device.child);

    const cleared = await postRetention(replica.base, 'device-a', 'token-a', sessionId, 'clear');
    assert.equal(cleared.payload.generation, 1);
    assert.equal(cleared.payload.state, 'cleared');

    device = startDevice(home, 'append-stale', {
      controlUrl: replica.base,
      deviceId: 'device-a',
      token: 'token-a',
      sessionId,
    });
    const stale = JSON.parse(await nextDeviceLine(device, 30_000, '旧保留代次被拒绝'));
    assert.equal(stale.appendedSeq, 12, '清理之后会话日志又追加了一条真实事件');
    assert.equal(stale.results[0].outcome, 'stale', '旧代次的上报被拒绝');
    assert.equal(stale.pending, 1, '设备保留待补传意图');
    await waitExit(device.child);
    const stillEmpty = await readCursor(replica.base, 'device-a', 'token-a', sessionId);
    assert.equal(stillEmpty.payload.eventCount, 0, '旧代次补传不重建已清理副本');

    device = startDevice(home, 'reacquire', {
      controlUrl: replica.base,
      deviceId: 'device-a',
      token: 'token-a',
      sessionId,
    });
    const reacquired = JSON.parse(await nextDeviceLine(device, 60_000, '显式重新获取'));
    assert.equal(reacquired.reacquired.outcome, 'pushed');
    assert.equal(reacquired.reacquired.acknowledgedThrough, 13);
    await waitExit(device.child);

    const final = await readCursor(replica.base, 'device-a', 'token-a', sessionId);
    assert.equal(final.payload.eventCount, 14);
    assert.equal(final.payload.continuousSeq, 13);
    assert.equal(final.payload.retentionGeneration, 2);
    assert.equal(final.payload.retentionState, 'active');
    assert.equal(intentCount(join(home, 'push', 'replica-intents.sqlite')), 0);
  } finally {
    if (device !== undefined) await killProcess(device.child);
    if (replica !== undefined) await replica.stop();
    releaseIndependentHome(home);
  }
});

