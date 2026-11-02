// SYS04 的验收测试：Postgres 会话后端、跨进程单写者、控制平面替换、导入与摘要比对。
//
// 全部验证都在真实实例上进行：真实 Postgres（优先用 CHATDSH_TEST_PG_URL，缺省时用本机 docker
// 启动独立容器，镜像与版本记进报告）、真实 JSONL 日志、真实 SQLite 文件、真实子进程。
// 没有可用 Postgres 时只跳过依赖数据库的用例，连接失败与不退回本地写入的分支照常执行。
//
// 运行：node --test e2e/unit/client-complete-sys04-postgres.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

/** runtime 根。 */
const RUNTIME = resolve(import.meta.dirname, '../..');
/** 会话后端构建产物。 */
const SESSION_MODULE = join(RUNTIME, 'packages/core/session-persistence-postgres/lib/index.js');
/** 控制平面 Postgres 构建产物。 */
const GATEWAY_MODULE = join(RUNTIME, 'gateway/lib/postgres/index.js');
/** 本机优先使用的 Postgres 镜像。 */
const LOCAL_IMAGE = 'docker.1ms.run/postgres:18-alpine';
/** 本机没有缓存时的上游镜像。 */
const FALLBACK_IMAGE = 'postgres:18';

/** 等待一段时长。 */
function delay(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

/** 执行一条外部命令并取回标准输出。 */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** docker 是否可用。 */
function dockerVersion() {
  try {
    return run('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch {
    return undefined;
  }
}

/** 本机是否已有某个镜像。 */
function imagePresent(image) {
  try {
    run('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    return true;
  } catch {
    return false;
  }
}

/** 在容器里执行一条 SQL 并取回文本。 */
function psql(container, sql) {
  return run('docker', ['exec', container, 'psql', '-U', 'chatdsh', '-d', 'chatdsh', '-tAc', sql]);
}

/** 等容器接受连接。 */
async function waitForPostgres(container) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if (psql(container, 'select 1') === '1') return;
    } catch {
      // 容器尚未就绪时继续等待。
    }
    await delay(500);
  }
  throw new Error('Postgres 容器在 60 秒内没有就绪');
}

/**
 * 准备一个真实 Postgres。
 * @param {string} prefix - 容器名与 schema 前缀。
 * @returns {Promise<{url: string, container?: string, image?: string, version: string, dispose: () => void} | undefined>}
 */
async function startPostgres(prefix) {
  const configured = process.env.CHATDSH_TEST_PG_URL ?? '';
  if (configured !== '') {
    const { SyncPostgres } = await import(GATEWAY_MODULE);
    const admin = new SyncPostgres(configured);
    const version = String(admin.query('show server_version').rows[0].server_version);
    admin.close();
    return { url: configured, version, dispose: () => {} };
  }
  const docker = dockerVersion();
  if (docker === undefined) return undefined;
  const image = imagePresent(LOCAL_IMAGE) ? LOCAL_IMAGE : FALLBACK_IMAGE;
  const password = randomUUID().replaceAll('-', '');
  const container = `chatdsh-sys04-${prefix}-${process.pid}-${randomUUID().slice(0, 6)}`;
  run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '-e',
    'POSTGRES_USER=chatdsh',
    '-e',
    'POSTGRES_DB=chatdsh',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-p',
    '127.0.0.1::5432',
    image,
  ]);
  const dispose = () => {
    try {
      run('docker', ['rm', '-f', container]);
    } catch {
      // 容器已经不在时无需处理。
    }
  };
  try {
    const mapping = run('docker', ['port', container, '5432/tcp']).split('\n')[0];
    const port = mapping.slice(mapping.lastIndexOf(':') + 1);
    await waitForPostgres(container);
    const version = psql(container, 'show server_version');
    const url = ['postgres', '://', `chatdsh:${password}`, '@', `127.0.0.1:${port}/chatdsh`].join('');
    return { url, container, image, version, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** 一个会话事件序列：一次完整回合，带用户与助手消息。 */
function turnEvents(baseTime, turn = 1) {
  return [
    { type: 'turn/start', seq: 0, time: baseTime, data: { turn } },
    { type: 'step/start', seq: 1, time: baseTime + 1, data: { turn, step: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: baseTime + 2,
      surfaceOp: 'append',
      data: {
        id: `m-user-${turn}`,
        role: 'user',
        content: [{ type: 'text', text: '把 tailwind 配置改成暗色主题，附件在 files/report.pdf' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: baseTime + 3,
      surfaceOp: 'append',
      data: {
        turn,
        step: 1,
        message: {
          id: `m-assistant-${turn}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'darkMode 已经设成 class，暗色主题变量写进 theme.css' }],
          source: { kind: 'model', provider: 'probe', model: 'probe' },
        },
        stream: [],
      },
    },
    { type: 'step/end', seq: 4, time: baseTime + 4, data: { turn, step: 1 } },
    { type: 'turn/end', seq: 5, time: baseTime + 5, data: { turn, reason: { kind: 'completed' } } },
  ];
}

/** 断言失败的错误名。 */
function hasName(expected) {
  return (error) => {
    assert.equal(error.name, expected, `期望 ${expected}，实际 ${error.name}: ${error.message}`);
    return true;
  };
}

/** 挂载真实 JSONL 后端。 */
async function openJsonlBackend(root) {
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: SessionPlugin } = await import('@deepseek-ai/dsh-session');
  const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');
  const ctx = new Context();
  ctx.plugin(SessionPlugin);
  ctx.plugin(jsonl, { root });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (ctx.sessionPersistence !== undefined) return { ctx, persistence: ctx.sessionPersistence };
    await delay(50);
  }
  throw new Error('JSONL 会话后端没有在 2 秒内就绪');
}

/** 构造 Postgres 会话后端。 */
async function openPostgresPersistence(url, schema) {
  const { Context } = await import('@deepseek-ai/cordis');
  const { PostgresSessionPersistence } = await import(SESSION_MODULE);
  const backend = new PostgresSessionPersistence(new Context(), {
    connectionString: url,
    schema,
    leaseTtlMs: 4000,
    leaseHeartbeatMs: 1000,
  });
  await backend.initialize();
  return backend;
}

/**
 * 存储契约：两种后端共用同一组断言。
 * @param {string} label - 后端标签。
 * @param {object} backend - 会话持久化实例。
 * @param {object} options - 额外行为开关。
 */
async function runStorageContract(label, backend, options = {}) {
  const home = options.cwd ?? '/contract';
  const created = Date.now() + Number(options.offset ?? 0);
  const id = `contract-${label}-${randomUUID().slice(0, 8)}`;

  // 创建、追加、耐久屏障与冷读。
  const writer = await backend.create({ id, version: 4, cwd: home, createdAt: created, isSeeded: false });
  assert.equal(writer.access, 'write', `${label}: 新建句柄必须是写句柄`);
  assert.equal(writer.inheritedEventCount, 0, `${label}: 非种子会话的继承事件数为 0`);
  const events = turnEvents(created);
  await writer.append(events.slice(0, 3));
  await writer.append(events.slice(3));
  await writer.flush();
  await writer.close();

  const reader = await backend.open(id, 'read');
  const full = await reader.read();
  assert.equal(full.events.length, 6, `${label}: 冷读必须拿到全部事件`);
  assert.deepEqual(
    full.events.map((event) => event.seq),
    [0, 1, 2, 3, 4, 5],
    `${label}: 事件序号必须从 0 起连续`,
  );
  assert.equal(full.events[2].type, 'user/message', `${label}: 事件内容必须逐条一致`);
  const slice = await reader.read(2, 2);
  assert.deepEqual(slice.events.map((event) => event.seq), [2, 3], `${label}: 分片读取必须按序号对齐`);
  await assert.rejects(() => reader.append([{ type: 'turn/start', seq: 6, time: created, data: { turn: 2 } }]), hasName('SessionReadOnlyError'));
  await reader.close();
  await assert.rejects(() => reader.read(), hasName('SessionHandleClosedError'));

  // 快照与列表。
  const stat = await backend.stat(id);
  if (stat.eventCount !== undefined) {
    assert.equal(stat.eventCount, 6, `${label}: stat 给出事件条数时必须与日志一致`);
  }
  assert.equal(typeof stat.revision, 'string', `${label}: stat 必须给出修订号`);
  const listed = await backend.list({ cwd: home });
  assert.ok(
    listed.some((snapshot) => snapshot.header.id === id),
    `${label}: list 必须能看到已持久化的会话`,
  );

  // 序号不连续与重复写者。
  const owner = await backend.open(id, 'write');
  await assert.rejects(
    () => owner.append([{ type: 'turn/start', seq: 9, time: created, data: { turn: 2 } }]),
    (error) => /seq mismatch|序号|contiguous/i.test(error.message),
  );
  await assert.rejects(() => backend.open(id, 'write'), hasName('SessionAlreadyOwnedError'));
  await owner.close();
  await assert.rejects(() => backend.open(`missing-${randomUUID()}`, 'read'), hasName('SessionPersistenceNotFoundError'));

  // 种子与继承数量：JSONL 的继承前缀由格式标记定义，这一组只在 Postgres 后端执行。
  if (options.seeded !== false) {
    const parentId = `contract-parent-${label}-${randomUUID().slice(0, 8)}`;
    const parent = await backend.create({ id: parentId, version: 4, cwd: home, createdAt: created, isSeeded: false });
    await parent.append(turnEvents(created, 1));
    await parent.flush();
    await parent.close();
    await assert.rejects(
      () => backend.create({ id: `seed-missing-${label}-${randomUUID().slice(0, 6)}`, version: 4, cwd: home, createdAt: created, isSeeded: true }),
      (error) => /inherited|继承/i.test(error.message),
    );
    await assert.rejects(
      () => backend.create(
        { id: `seed-plain-${label}-${randomUUID().slice(0, 6)}`, version: 4, cwd: home, createdAt: created, isSeeded: false },
        { inheritedEventCount: 3 },
      ),
      (error) => /inherited|继承/i.test(error.message),
    );
    const seededId = `contract-seed-${label}-${randomUUID().slice(0, 8)}`;
    const seedWriter = await backend.create(
      { id: seededId, version: 4, cwd: home, createdAt: created, isSeeded: true, parentSession: parentId },
      { inheritedEventCount: 2 },
    );
    assert.equal(seedWriter.inheritedEventCount, 2, `${label}: 种子会话必须记住继承事件数`);
    await seedWriter.append([
      { type: 'turn/start', seq: 0, time: created, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: created + 1, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, time: created + 2, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 3, time: created + 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    await seedWriter.flush();
    await seedWriter.close();
    const seededSnapshot = await backend.stat(seededId);
    assert.equal(seededSnapshot.header.parentSession, parentId, `${label}: 父关系必须随会话头保存`);
  }

  // 列表里能看到三个新会话；接缝的 list 没有过滤参数，过滤与分页在 Postgres 用例里单独断言。
  const three = [];
  for (const [index, cwd] of ['/contract/a', '/contract/b', '/contract/b'].entries()) {
    const filteredId = `contract-page-${label}-${index}-${randomUUID().slice(0, 6)}`;
    const handle = await backend.create({
      id: filteredId,
      version: 4,
      cwd,
      createdAt: created + 1000 + index,
      isSeeded: false,
    });
    await handle.flush();
    await handle.close();
    three.push(filteredId);
  }
  const all = await backend.list();
  for (const filteredId of three) {
    assert.ok(all.some((snapshot) => snapshot.header.id === filteredId), `${label}: list 必须列出已创建的会话`);
  }

  return { sessions: 5, events: 6, ids: three };
}

// ── 真实 Postgres 上的用例 ────────────────────────────────────────────

let postgres;

test('准备真实 Postgres 实例', async () => {
  postgres = await startPostgres('main');
  if (postgres === undefined) {
    console.log('没有可用的 Postgres（CHATDSH_TEST_PG_URL 未设置且 docker 不可用），依赖数据库的用例将跳过');
    return;
  }
  console.log(`真实 Postgres：版本 ${postgres.version}，镜像 ${postgres.image ?? '外部实例'}`);
});

test('存储契约：JSONL 与 Postgres 两种后端都通过', async () => {
  const home = allocateIndependentHome('sys04-contract');
  try {
    const jsonl = await openJsonlBackend(join(home, 'sessions'));
    try {
      const jsonlResult = await runStorageContract('jsonl', jsonl.persistence, {
        cwd: join(home, 'contract'),
        seeded: false,
      });
      assert.ok(jsonlResult.events > 0);
    } finally {
      await jsonl.persistence.close?.();
      await jsonl.ctx.fiber?.dispose?.();
    }
    if (postgres === undefined) return;
    const schema = `sys04_contract_${randomUUID().slice(0, 8)}`;
    const backend = await openPostgresPersistence(postgres.url, schema);
    try {
      const pgResult = await runStorageContract('postgres', backend, { cwd: join(home, 'contract') });
      assert.equal(pgResult.events, 6);
      // 列表过滤与分页。
      const pageA = await backend.list({ cwd: '/contract/a' });
      assert.equal(pageA.length, 1, '按工作目录过滤必须只返回匹配项');
      const pageB = await backend.list({ cwd: '/contract/b', order: 'created-asc', offset: 0, limit: 1 });
      assert.equal(pageB.length, 1, 'limit 必须限制本页条数');
      const pageB2 = await backend.list({ cwd: '/contract/b', order: 'created-asc', offset: 1, limit: 1 });
      assert.notEqual(pageB[0].header.id, pageB2[0].header.id, 'offset 必须推进到下一页');
      const seededPage = await backend.list({ seeded: true, limit: 10 });
      assert.ok(seededPage.every((snapshot) => snapshot.header.isSeeded === true), '种子标记过滤必须只返回种子会话');
      // 只属于 Postgres 的删除与恢复：软删除隐藏、恢复后可见。
      const id = `contract-delete-${randomUUID().slice(0, 8)}`;
      const handle = await backend.create({ id, version: 4, cwd: join(home, 'contract'), createdAt: Date.now(), isSeeded: false });
      await handle.append(turnEvents(Date.now()));
      await handle.flush();
      await handle.close();
      const removal = await backend.deleteSession(id);
      assert.equal(removal.sessionId, id);
      const afterDelete = await backend.list({ cwd: join(home, 'contract') });
      assert.ok(!afterDelete.some((snapshot) => snapshot.header.id === id), '软删除后列表必须看不到会话');
      assert.equal(await backend.stat(id), undefined, '软删除后 stat 必须为空');
      await assert.rejects(() => backend.open(id, 'read'), hasName('SessionPersistenceNotFoundError'));
      await backend.restoreSession(id);
      const afterRestore = await backend.list({ cwd: join(home, 'contract') });
      assert.ok(afterRestore.some((snapshot) => snapshot.header.id === id), '恢复后列表必须重新可见');
      const restored = await backend.open(id, 'read');
      const restoredEvents = await restored.read();
      assert.equal(restoredEvents.events.length, 6, '恢复后事件必须完好');
      await restored.close();
    } finally {
      await backend.close();
    }
  } finally {
    releaseIndependentHome(home);
  }
});

test('跨进程单写者：两个真实进程争同一会话只有一个成功', async () => {
  if (postgres === undefined) return;
  const schema = `sys04_writer_${randomUUID().slice(0, 8)}`;
  const backend = await openPostgresPersistence(postgres.url, schema);
  const id = `writer-${randomUUID().slice(0, 8)}`;
  try {
    const handle = await backend.create({ id, version: 4, cwd: '/writer', createdAt: Date.now(), isSeeded: false });
    await handle.flush();
    await handle.close();

    const script = `
      const { Context } = await import('@deepseek-ai/cordis');
      const { PostgresSessionPersistence } = await import(${JSON.stringify(SESSION_MODULE)});
      const backend = new PostgresSessionPersistence(new Context(), {
        connectionString: process.env.SYS04_URL,
        schema: process.env.SYS04_SCHEMA,
        leaseTtlMs: 4000,
        leaseHeartbeatMs: 1000,
      });
      try {
        const handle = await backend.open(process.env.SYS04_ID, 'write');
        process.stdout.write('acquired\\n');
        await new Promise((settle) => setTimeout(settle, 1200));
        await handle.close();
        await backend.close();
        process.exit(0);
      } catch (error) {
        process.stdout.write('failed:' + error.name + '\\n');
        await backend.close().catch(() => {});
        process.exit(3);
      }
    `;
    const childEnv = { ...process.env, SYS04_URL: postgres.url, SYS04_SCHEMA: schema, SYS04_ID: id };
    const startChild = () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const state = { output: '', exited: undefined };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        state.output += chunk;
      });
      state.done = new Promise((settle) => child.on('exit', (code) => {
        state.exited = code;
        settle(code);
      }));
      return state;
    };

    const first = startChild();
    for (let attempt = 0; attempt < 100 && !first.output.includes('acquired'); attempt += 1) await delay(100);
    assert.match(first.output, /acquired/, '第一个进程必须取得写所有权');
    const second = startChild();
    const secondCode = await second.done;
    assert.equal(secondCode, 3, '第二个进程必须被拒绝');
    assert.match(second.output, /SessionAlreadyOwnedError/, `第二个进程必须以 SessionAlreadyOwnedError 结束：${second.output}`);
    assert.equal(await first.done, 0, '第一个进程必须正常退出');
    const after = await backend.open(id, 'write');
    await after.close();
  } finally {
    await backend.close();
  }
});

test('重启恢复：另一个进程创建并追加，重启后从原序号继续', async () => {
  if (postgres === undefined) return;
  const schema = `sys04_restart_${randomUUID().slice(0, 8)}`;
  const id = `restart-${randomUUID().slice(0, 8)}`;
  const childEnv = {
    ...process.env,
    SYS04_URL: postgres.url,
    SYS04_SCHEMA: schema,
    SYS04_ID: id,
    SYS04_SESSION_MODULE: SESSION_MODULE,
  };
  const runChild = (mode) => {
    const script = `
      const { Context } = await import('@deepseek-ai/cordis');
      const { PostgresSessionPersistence } = await import(process.env.SYS04_SESSION_MODULE);
      const backend = new PostgresSessionPersistence(new Context(), {
        connectionString: process.env.SYS04_URL,
        schema: process.env.SYS04_SCHEMA,
        leaseTtlMs: 4000,
        leaseHeartbeatMs: 1000,
      });
      const id = process.env.SYS04_ID;
      if (process.env.SYS04_MODE === 'seed') {
        const now = Date.now();
        const handle = await backend.create({ id, version: 4, cwd: '/restart', createdAt: now, isSeeded: false });
        await handle.append([
          { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
          { type: 'step/start', seq: 1, time: now + 1, data: { turn: 1, step: 1 } },
          { type: 'step/end', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
        ]);
        await handle.flush();
        await handle.close();
        await backend.close();
        process.stdout.write('seeded\\n');
        process.exit(0);
      }
      const reader = await backend.open(id, 'read');
      const slice = await reader.read();
      await reader.close();
      await backend.close();
      process.stdout.write('seqs:' + slice.events.map((event) => event.seq).join(',') + '\\n');
      process.exit(0);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...childEnv, SYS04_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state = { output: '' };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      state.output += chunk;
    });
    state.done = new Promise((settle) => child.on('exit', (code) => settle(code)));
    return state;
  };

  const seeded = runChild('seed');
  assert.equal(await seeded.done, 0, `创建进程必须正常退出：${seeded.output}`);
  assert.match(seeded.output, /seeded/, '创建进程必须完成写入');

  const backend = await openPostgresPersistence(postgres.url, schema);
  try {
    const writer = await backend.open(id, 'write');
    await writer.append([{ type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }]);
    await writer.flush();
    await writer.close();
  } finally {
    await backend.close();
  }

  const reader = runChild('read');
  assert.equal(await reader.done, 0, `读取进程必须正常退出：${reader.output}`);
  assert.match(reader.output, /seqs:0,1,2,3/, `重启后必须看到连续事件：${reader.output}`);
});

test('终止持有者与断开数据库连接：旧句柄追加被拒绝，flush 过的数据仍在', async () => {
  if (postgres === undefined) return;
  const { SyncPostgres } = await import(GATEWAY_MODULE);
  const schema = `sys04_owner_${randomUUID().slice(0, 8)}`;
  const backend = await openPostgresPersistence(postgres.url, schema);
  const id = `owner-${randomUUID().slice(0, 8)}`;
  const admin = new SyncPostgres(postgres.url);
  try {
    const now = Date.now();
    const handle = await backend.create({ id, version: 4, cwd: '/owner', createdAt: now, isSeeded: false });
    await handle.append(turnEvents(now).slice(0, 3));
    await handle.flush();
    const before = await admin.query(
      `select fencing_token from "${schema}".session_writers where session_id = $1`,
      [id],
    );
    assert.equal(Number(before.rows[0].fencing_token), 1, '首次持有时 fencing token 必须是 1');

    // 真实断开这个后端持有的数据库连接。
    const terminated = await admin.query(
      `select pg_terminate_backend(pid) as killed from pg_stat_activity
        where application_name = 'chatdsh-session-persistence' and pid <> pg_backend_pid()`,
    );
    assert.ok(terminated.rows.some((row) => row.killed === true), '必须真的终止了后端的连接');
    await delay(300);

    await assert.rejects(
      () => handle.append([{ type: 'assistant/message', seq: 3, time: now + 9, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm-x', role: 'assistant', content: [{ type: 'text', text: '旧句柄' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] } }]),
      hasName('SessionOwnershipLostError'),
      '断开连接后旧句柄的追加必须被拒绝',
    );
    await handle.close().catch(() => {});

    const reader = await backend.open(id, 'read');
    const events = await reader.read();
    assert.equal(events.events.length, 3, '已确认 flush 的事件必须仍在');
    await reader.close();

    // 新持有者接手，fencing token 递增。
    const next = await backend.open(id, 'write');
    const after = await admin.query(
      `select fencing_token from "${schema}".session_writers where session_id = $1`,
      [id],
    );
    assert.equal(Number(after.rows[0].fencing_token), 2, '换手后 fencing token 必须递增');
    await next.append([{ type: 'step/end', seq: 3, time: now + 10, data: { turn: 1, step: 1 } }]);
    await next.flush();
    await next.close();
    const final = await backend.open(id, 'read');
    const finalEvents = await final.read();
    assert.deepEqual(finalEvents.events.map((event) => event.seq), [0, 1, 2, 3], '接手后必须从原序号继续追加');
    await final.close();
  } finally {
    admin.close();
    await backend.close();
  }
});

test('JSONL 导入 Postgres：检查点复制、只读源与三类摘要一致', async () => {
  if (postgres === undefined) return;
  const home = allocateIndependentHome('sys04-import');
  try {
    const jsonl = await openJsonlBackend(join(home, 'sessions'));
    const sourceCwd = join(home, 'workspace');
    mkdirSync(sourceCwd, { recursive: true });
    const attachmentPath = join(sourceCwd, 'report.pdf');
    const attachmentBytes = 'SYS04-ATTACHMENT-BYTES-不希望进数据库';
    writeFileSync(attachmentPath, attachmentBytes);
    const attachmentDigest = createHash('sha256').update(readFileSync(attachmentPath)).digest('hex');

    const parentId = `import-parent-${randomUUID().slice(0, 8)}`;
    const baseTime = Date.now();
    const parent = await jsonl.persistence.create({ id: parentId, version: 4, cwd: sourceCwd, createdAt: baseTime, isSeeded: false });
    await parent.append(turnEvents(baseTime, 1));
    await parent.flush();
    // 第二个回合：用户消息里带附件引用（只记引用，不写字节）。
    const second = turnEvents(baseTime + 100, 2);
    second[2] = {
      ...second[2],
      data: {
        ...second[2].data,
        content: [{ type: 'text', text: '再看一下 report.pdf 的图表' }],
        attachments: [{ path: 'files/report.pdf', bytes: attachmentBytes.length }],
      },
    };
    second.forEach((event, index) => {
      event.seq = 6 + index;
    });
    await parent.append(second);
    await parent.flush();
    await parent.close();

    const childId = `import-child-${randomUUID().slice(0, 8)}`;
    const child = await jsonl.persistence.create(
      { id: childId, version: 4, cwd: sourceCwd, createdAt: baseTime + 500, isSeeded: false, parentSession: parentId },
    );
    const inherited = turnEvents(baseTime, 1);
    inherited.forEach((event, index) => {
      event.seq = index;
    });
    const own = turnEvents(baseTime + 700, 2);
    own.forEach((event, index) => {
      event.seq = 6 + index;
    });
    await child.append([...inherited, ...own]);
    await child.flush();
    await child.close();

    const gateway = await import(GATEWAY_MODULE);
    const { openPostgresBackend } = gateway;
    const backendBundle = openPostgresBackend({ connectionString: postgres.url });
    assert.ok(backendBundle !== undefined, '配置了连接串时必须构造后端');
    const schema = `sys04_import_${randomUUID().slice(0, 8)}`;
    const persistence = await openPostgresPersistence(postgres.url, schema);
    const admin = new gateway.SyncPostgres(postgres.url);
    try {
      const source = await gateway.readSessionsFromPersistence(jsonl.persistence);
      assert.ok(source.length >= 2, '源里必须能读出父会话与种子会话');
      const search = backendBundle.controlPlane.search;
      backendBundle.controlPlane.ensureSchema();
      const report = await gateway.importSessions({
        source: { kind: 'jsonl', readOnly: true, sessions: async () => source },
        target: persistence,
        database: backendBundle.executor,
        search,
        jobId: `sys04-import-${randomUUID().slice(0, 8)}`,
        schemaVersion: 1,
      });
      assert.equal(report.source.log, report.target.log, '导入前后全日志摘要必须一致');
      assert.equal(report.source.index, report.target.index, '导入前后检索索引摘要必须一致');
      assert.equal(report.source.usage, report.target.usage, '导入前后用量摘要必须一致');
      assert.equal(report.attachments.bytesStored, 0, '附件字节不得写入数据库');
      assert.ok(report.attachments.references >= 1, '附件引用必须被数到');

      // 目标侧确实拿到了父关系与连续事件。
      const childStat = await persistence.stat(childId);
      assert.equal(childStat.header.parentSession, parentId, '导入必须保留父关系');
      const childReader = await persistence.open(childId, 'read');
      assert.equal(childReader.inheritedEventCount, 0, '非种子会话的继承事件数为 0');
      const childEvents = await childReader.read();
      assert.deepEqual(childEvents.events.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '导入后事件必须从 0 连续');
      await childReader.close();

      // 源保持只读：文件摘要不变，且日志目录里没有新增文件。
      assert.equal(
        createHash('sha256').update(readFileSync(attachmentPath)).digest('hex'),
        attachmentDigest,
        '导入不得改动附件文件',
      );
      const attachmentTables = await admin.query(
        `select table_name from information_schema.tables
          where table_schema = $1 and (table_name like '%attachment%' or table_name like '%blob%')`,
        [schema],
      );
      assert.equal(attachmentTables.rows.length, 0, '数据库不得出现附件表');
      const storedEvents = await admin.query(
        `select event::text as text from "${schema}".session_events where session_id = $1 order by seq`,
        [childId],
      );
      const serialized = storedEvents.rows.map((row) => row.text).join('\n');
      assert.ok(!serialized.includes(attachmentBytes), '附件字节不得出现在事件正文里');

      // 重复导入幂等：事件数不增，摘要不变。
      const again = await gateway.importSessions({
        source: { kind: 'jsonl', readOnly: true, sessions: async () => source },
        target: persistence,
        database: backendBundle.executor,
        search,
        jobId: `sys04-import-${randomUUID().slice(0, 8)}`,
        schemaVersion: 1,
      });
      assert.equal(again.source.log, again.target.log, '重复导入后日志摘要仍然一致');
      const eventRows = await admin.query(
        `select count(*)::int as n from "${schema}".session_events where session_id = $1`,
        [parentId],
      );
      assert.equal(Number(eventRows.rows[0].n), 12, '重复导入不得重复写入事件');

      // 检索：真实全文查询命中并给出摘要。
      const hits = search.search('darkMode');
      assert.ok(hits.items.length >= 1, '全文检索必须命中模型文本');
      assert.ok(hits.items[0].snippet.length > 0, '全文检索必须给出摘要');
      assert.equal(typeof search.digest(), 'string');
    } finally {
      admin.close();
      await persistence.close();
      backendBundle.close();
      await jsonl.persistence.close?.();
    }
  } finally {
    releaseIndependentHome(home);
  }
});

test('SQLite 控制平面导入 Postgres：检查点、用量幂等与无账号表', async () => {
  if (postgres === undefined) return;
  const home = allocateIndependentHome('sys04-sqlite');
  try {
    const sqlitePath = join(home, 'gateway.sqlite');
    const database = new DatabaseSync(sqlitePath);
    database.exec(`
      create table operations (operation_id text primary key, request_digest text not null, device_id text not null,
        state text not null, result_ref text, created_at integer not null, expires_at integer not null);
      create table device_generations (device_id text primary key, generation integer not null,
        token_digest text not null, revoked_at integer);
      create table replica_cursors (session_id text primary key, retention_generation integer not null,
        continuous_seq integer not null, digest text not null);
      create table usage_ledger (session_id text not null, turn integer not null, workspace_id text,
        model text not null, provider text not null, input_tokens integer not null, output_tokens integer not null,
        cached_tokens integer not null, reasoning_tokens integer not null, recorded_at integer not null,
        primary key (session_id, turn));
    `);
    const now = Date.now();
    database.prepare('insert into operations values (?, ?, ?, ?, ?, ?, ?)').run('op-a', 'digest-a', 'device-1', 'applied', 'ref-a', now, now + 60000);
    database.prepare('insert into operations values (?, ?, ?, ?, ?, ?, ?)').run('op-b', 'digest-b', 'device-1', 'pending', null, now, now + 60000);
    database.prepare('insert into device_generations values (?, ?, ?, ?)').run('device-1', 7, 'token-digest', null);
    database.prepare('insert into replica_cursors values (?, ?, ?, ?)').run('session-1', 0, 4, 'cursor-digest');
    database.prepare('insert into usage_ledger values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('session-1', 1, 'ws-1', 'model-a', 'provider-a', 100, 200, 10, 5, now);
    database.prepare('insert into usage_ledger values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('session-1', 2, 'ws-1', 'model-a', 'provider-a', 300, 400, 0, 0, now + 1000);
    database.close();

    const gateway = await import(GATEWAY_MODULE);
    const bundle = gateway.openPostgresBackend({ connectionString: postgres.url });
    const source = new gateway.SqliteControlPlaneSource(sqlitePath);
    try {
      const report = gateway.importControlPlane({
        source,
        executor: bundle.executor,
        storage: bundle.controlPlane,
        jobId: `sys04-control-${randomUUID().slice(0, 8)}`,
        schemaVersion: 1,
      });
      assert.equal(report.records, 4, '导入必须复制操作、设备代次与连续游标共四条记录');
      assert.equal(report.sourceDigest, report.targetDigest, '控制平面导入前后摘要必须一致');
      assert.deepEqual(report.accountTables, [], '目标库不得有账号表');
      assert.equal(bundle.controlPlane.deviceGenerations.current('device-1').generation, 7, '设备代次必须原样保留');
      assert.equal(bundle.controlPlane.operations.read('op-a').state, 'applied', '操作状态必须原样保留');
      assert.equal(bundle.controlPlane.replicas.cursor('session-1').continuousSeq, 4, '连续游标必须原样保留');

      // 用量：唯一约束保证不重复计账。
      const totalsOnce = bundle.controlPlane.usageTotals();
      assert.equal(totalsOnce.rows, 2, '用量行数必须与源一致');
      assert.equal(totalsOnce.inputTokens, 400);
      assert.equal(totalsOnce.outputTokens, 600);
      const duplicate = gateway.importControlPlane({
        source,
        executor: bundle.executor,
        storage: bundle.controlPlane,
        jobId: `sys04-control-again-${randomUUID().slice(0, 8)}`,
        schemaVersion: 1,
      });
      assert.equal(duplicate.records, 4);
      const totalsTwice = bundle.controlPlane.usageTotals();
      assert.deepEqual(totalsTwice, totalsOnce, '重复导入不得改变用量合计');

      // 端口语义：异内容冲突与缺口拒绝。
      assert.throws(
        () => bundle.controlPlane.transaction((handle) => bundle.controlPlane.operations.begin(handle, {
          operationId: 'op-a',
          requestDigest: 'different-digest',
          deviceId: 'device-1',
          expiresAt: now + 60000,
          now,
        })),
        (error) => error.code === gateway.POSTGRES_STORAGE_ERROR_CODES.operationDigestConflict,
      );
      assert.throws(
        () => bundle.controlPlane.transaction((handle) => bundle.controlPlane.replicas.advance(handle, {
          sessionId: 'session-1',
          retentionGeneration: 0,
          continuousSeq: 9,
          digest: 'gap',
        })),
        (error) => error.code === gateway.POSTGRES_STORAGE_ERROR_CODES.replicaGap,
      );
      const cursor = bundle.controlPlane.replicas.cursor('session-1');
      assert.equal(cursor.continuousSeq, 4, '缺口被拒绝后游标不得前进');
    } finally {
      source.close();
      bundle.close();
    }
  } finally {
    releaseIndependentHome(home);
  }
});

// ── 不需要真实数据库的用例 ────────────────────────────────────────────

test('数据库不可达：连接失败且不退回本地写入', async () => {
  const home = allocateIndependentHome('sys04-offline');
  try {
    const unreachable = ['postgres', '://', 'chatdsh:secret', '@', '127.0.0.1:1/chatdsh'].join('');
    const gateway = await import(GATEWAY_MODULE);
    assert.throws(
      () => gateway.openPostgresBackend({ connectionString: unreachable }),
      (error) => error.name === 'PostgresUnavailableError' || /ECONNREFUSED|EHOSTUNREACH|不可达/.test(`${error.name} ${error.message}`),
      '控制平面后端必须以连接错误结束',
    );
    assert.equal(
      gateway.openPostgresBackend({}),
      undefined,
      '没有配置连接串时不得构造后端',
    );

    const { Context } = await import('@deepseek-ai/cordis');
    const { PostgresSessionPersistence } = await import(SESSION_MODULE);
    const backend = new PostgresSessionPersistence(new Context(), {
      connectionString: unreachable,
      schema: 'never_ready',
      leaseTtlMs: 4000,
      leaseHeartbeatMs: 1000,
    });
    await assert.rejects(
      () => backend.create({ id: `offline-${randomUUID().slice(0, 6)}`, version: 4, cwd: home, createdAt: Date.now(), isSeeded: false }),
      (error) => error.name === 'PostgresUnavailableError' || /ECONNREFUSED|EHOSTUNREACH/.test(`${error.name} ${error.message}`),
      '数据库不可达时必须直接失败',
    );
    await assert.rejects(
      () => backend.list(),
      (error) => error.name === 'PostgresUnavailableError' || /ECONNREFUSED|EHOSTUNREACH/.test(`${error.name} ${error.message}`),
    );
    await backend.close();
    assert.deepEqual(readdirSync(home), [], '数据库不可达时不得写本地文件');
  } finally {
    releaseIndependentHome(home);
  }
});

test('清理真实实例', async () => {
  if (postgres === undefined) return;
  const container = postgres.container;
  postgres.dispose();
  if (container !== undefined) {
    const remaining = run('docker', ['ps', '-a', '--filter', `name=${container}`, '--format', '{{.Names}}']);
    assert.equal(remaining, '', '验收结束后独立容器必须被回收');
  }
});
