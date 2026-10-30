// 旧库迁移的验收。
//
// 造一份旧形态的 SQLite 库：有 `accounts` 表、各表带 `account_id` 列与引用它的索引、额度
// 账本按账号分行、MCP 两张表的主键里含账号列。然后用这份库真实启动一次控制平面，读写
// 迁移后的数据，最后直接打开库文件核对：账号表与账号列都不存在，额度并成一行。
//
// 用法：node scripts/verify-account-migration.mjs [--port 3192]
// 退出码 0 表示旧库迁移后仍可正常读写，且账号表与账号列全部消失。

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const PORT = portFlag < 0 ? 3192 : Number.parseInt(argv[portFlag + 1], 10);
const home = tempHome('account-migration');
const databasePath = join(home, 'gateway.sqlite');

const failures = [];

/** 记一条断言结果。 */
function check(ok, label, detail) {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail === undefined ? '' : ` → ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 造一份旧形态的库。 */
function seedLegacyDatabase() {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    create table accounts (
      id text primary key,
      login text not null,
      created_at integer not null
    );
    insert into accounts (id, login, created_at) values
      ('acct-alice', 'alice@example.invalid', 1),
      ('acct-bob', 'bob@example.invalid', 2);

    create table sessions (
      account_id text not null,
      session_id text primary key,
      workspace_id text,
      device_id text not null,
      cwd text not null,
      kind text not null,
      created_at integer not null,
      deleted_at integer
    );
    create index sessions_by_account on sessions(account_id, created_at);
    insert into sessions (account_id, session_id, workspace_id, device_id, cwd, kind, created_at)
      values ('acct-alice', 'legacy-session', 'ws-legacy', 'node-legacy', '/work/legacy', 'work', 11);

    create table devices (
      account_id text not null,
      id text primary key,
      origin text not null,
      platform text not null,
      last_seen_at integer not null
    );
    insert into devices (account_id, id, origin, platform, last_seen_at)
      values ('acct-alice', 'browser-legacy', 'http://127.0.0.1:3080', 'web', 12);

    create table replica_events (
      account_id text not null,
      session_id text not null,
      seq integer not null,
      kind text not null,
      time integer not null,
      bytes integer not null,
      primary key (session_id, seq)
    );
    create index replica_events_by_account on replica_events(account_id, session_id);
    insert into replica_events (account_id, session_id, seq, kind, time, bytes) values
      ('acct-alice', 'legacy-session', 0, 'session/created', 100, 4),
      ('acct-alice', 'legacy-session', 1, 'session/user-message', 101, 4);

    create table replica_watermarks (
      account_id text not null,
      session_id text primary key,
      watermark integer not null,
      updated_at integer not null
    );
    insert into replica_watermarks (account_id, session_id, watermark, updated_at)
      values ('acct-alice', 'legacy-session', 1, 101);

    create table shares (
      account_id text not null,
      token text primary key,
      session_id text not null,
      up_to_seq integer not null,
      created_at integer not null,
      expires_at integer,
      revoked_at integer,
      visits integer not null default 0
    );
    insert into shares (account_id, token, session_id, up_to_seq, created_at)
      values ('acct-alice', 'legacy-share-token', 'legacy-session', 1, 102);

    create table push_queue (
      account_id text not null,
      id text primary key,
      device_id text,
      payload text not null,
      created_at integer not null,
      delivered_at integer
    );
    insert into push_queue (account_id, id, device_id, payload, created_at)
      values ('acct-alice', 'push-legacy', 'device-old', '{"kind":"replica"}', 103);

    create table read_receipts (
      account_id text not null,
      session_id text not null,
      device_id text not null,
      read_up_to_seq integer not null,
      updated_at integer not null,
      primary key (session_id, device_id)
    );
    insert into read_receipts (account_id, session_id, device_id, read_up_to_seq, updated_at)
      values ('acct-alice', 'legacy-session', 'device-old', 1, 104);

    create table mobile_devices (
      account_id text not null,
      id text primary key,
      name text not null,
      platform text not null,
      token_hash text not null unique,
      created_at integer not null,
      last_seen_at integer not null,
      revoked_at integer
    );
    insert into mobile_devices (account_id, id, name, platform, token_hash, created_at, last_seen_at)
      values ('acct-alice', 'mobile-legacy', '旧手机', 'android', 'hash-mobile-legacy', 105, 105);

    create table node_devices (
      account_id text not null,
      id text primary key,
      name text not null,
      platform text not null,
      role text not null,
      capabilities text not null,
      token_hash text not null unique,
      created_at integer not null,
      last_seen_at integer not null
    );
    create index node_devices_by_account on node_devices(account_id, last_seen_at);
    insert into node_devices (account_id, id, name, platform, role, capabilities, token_hash, created_at, last_seen_at)
      values ('acct-alice', 'node-legacy', '旧工作站', 'linux', 'both', '["exec"]', 'hash-node-legacy', 106, 106);

    create table automations (
      account_id text not null,
      id text primary key,
      name text not null,
      trigger text not null,
      action text not null,
      enabled integer not null,
      created_at integer not null
    );
    insert into automations (account_id, id, name, trigger, action, enabled, created_at)
      values ('acct-alice', 'auto-legacy', '旧自动化', '{"kind":"webhook","secretEnv":"HOOK_SECRET"}', '{"kind":"start-session","prompt":"总结"}', 0, 107);

    create table llm_quota (
      account_id text not null,
      used integer not null,
      primary key (account_id)
    );
    insert into llm_quota (account_id, used) values ('acct-alice', 300), ('acct-bob', 120);

    create table mcp_servers (
      account_id text not null,
      name text not null,
      created_by text not null,
      created_at integer not null,
      primary key (account_id, name)
    );
    insert into mcp_servers (account_id, name, created_by, created_at)
      values ('acct-alice', 'legacy-mcp', 'node-legacy', 108);

    create table mcp_endpoints (
      account_id text not null,
      server text not null,
      device_id text not null,
      transport text not null,
      row text not null,
      credential_env text,
      updated_at integer not null,
      primary key (account_id, server, device_id)
    );
    create index mcp_endpoints_by_device on mcp_endpoints(account_id, device_id);
    insert into mcp_endpoints (account_id, server, device_id, transport, row, credential_env, updated_at)
      values ('acct-alice', 'legacy-mcp', 'node-legacy', 'http', '{"url":"https://legacy.example/mcp"}', 'LEGACY_KEY', 108);
  `);
  database.close();
}

const base = `http://127.0.0.1:${PORT}`;
let child;
try {
  seedLegacyDatabase();
  console.log(`旧库已生成：${databasePath}`);

  child = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
    env: {
      ...process.env,
      DSH_HOME: home,
      CHATDSH_TELEMETRY: 'off',
      CHATDSH_GATEWAY_PORT: String(PORT),
      CHATDSH_GATEWAY_DB: databasePath,
      CHATDSH_RUNTIME_URL: 'http://127.0.0.1:9',
      // 额度上限低于旧库里两个账号的用量之和：迁移若丢掉任一账号的用量，这里就会放行。
      CHATDSH_LLM_QUOTA_LIMIT: '400',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`控制平面启动失败（${child.exitCode}）：\n${output.slice(-1200)}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) { ready = true; break; }
    } catch {
      // 还在启动。
    }
    await new Promise((settle) => setTimeout(settle, 200));
  }
  if (!ready) throw new Error(`控制平面未就绪：\n${output.slice(-1200)}`);
  console.log(`控制平面已用旧库启动：${base}`);

  // 读：会话归属、设备、手机、自动化、MCP 都应当从旧库读出来。
  const ownership = await (await fetch(`${base}/chatdsh/gateway/ownership`)).json();
  const session = (ownership.sessions ?? []).find((row) => row.sessionId === 'legacy-session');
  check(session !== undefined, '旧会话归属读到了');
  check(session?.deviceId === 'node-legacy', '旧会话归属保留了设备标识', session?.deviceId);
  check(session?.cwd === '/work/legacy', '旧会话归属保留了工作目录', session?.cwd);

  const devices = await (await fetch(`${base}/chatdsh/gateway/devices`)).json();
  check(devices.devices.some((row) => row.id === 'node-legacy' && row.online === false), '旧执行节点读到了且显示离线');

  const mobile = await (await fetch(`${base}/chatdsh/gateway/mobile/devices`)).json();
  check(mobile.devices.some((row) => row.id === 'mobile-legacy'), '旧手机设备读到了');

  const automations = await (await fetch(`${base}/chatdsh/gateway/automations`)).json();
  check(automations.automations.some((row) => row.id === 'auto-legacy' && row.enabled === false), '旧自动化读到了');

  const mcp = await (await fetch(`${base}/chatdsh/gateway/mcp`)).json();
  check(mcp.servers.some((row) => row.name === 'legacy-mcp'), '旧 MCP 全局注册读到了');
  check(mcp.endpoints[0]?.deviceId === 'node-legacy' && mcp.endpoints[0]?.credentialEnv === 'LEGACY_KEY', '旧 MCP 端点与凭据变量名读到了');

  const receipt = await (await fetch(`${base}/chatdsh/gateway/receipt?sessionId=legacy-session`)).json();
  check(receipt.receipts.some((row) => row.deviceId === 'device-old' && row.readUpToSeq === 1), '旧已读回执读到了');

  const sharePage = await fetch(`${base}/s/legacy-share-token`);
  check(sharePage.status === 200, '旧分享链接仍可打开', `${sharePage.status}`);

  // 写：往旧会话追加副本、写一条新回执、新建一条分享，全部落在迁移后的表结构上。
  const appended = await fetch(`${base}/chatdsh/gateway/replica`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-node-id': 'node-legacy' },
    body: JSON.stringify({ sessionId: 'legacy-session', events: [{ seq: 2, kind: 'session/end-seed', time: 109, bytes: 4 }] }),
  });
  const appendBody = await appended.json();
  check(appended.status === 200 && appendBody.watermark === 2, '向旧会话追加副本成功', JSON.stringify(appendBody));

  const replica = await (await fetch(`${base}/chatdsh/gateway/replica?sessionId=legacy-session`)).json();
  check((replica.events ?? []).map((row) => row.seq).join(',') === '0,1,2', '旧副本事件与新事件按序号连续', JSON.stringify((replica.events ?? []).map((row) => row.seq)));

  const newReceipt = await fetch(`${base}/chatdsh/gateway/receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-node-id': 'device-new' },
    body: JSON.stringify({ sessionId: 'legacy-session', readUpToSeq: 2 }),
  });
  check(newReceipt.status === 200, '新已读回执写入成功', `${newReceipt.status}`);

  const created = await fetch(`${base}/chatdsh/gateway/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'legacy-session' }),
  });
  check(created.status === 200, '新分享写入成功', `${created.status}`);

  // 额度：旧的 300 + 120 必须并成一份读数，超过 400 的上限后请求被拒绝。
  const llm = await fetch(`${base}/chatdsh/gateway/llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gateway', model: 'test', messages: [] }),
  });
  const llmBody = await llm.json();
  check(llm.status === 402 && llmBody.error?.code === 'quota-exceeded', '迁移后的额度读数是两个账号之和', `${llm.status} ${JSON.stringify(llmBody)}`);
} catch (error) {
  check(false, '验收中断', error instanceof Error ? error.message : String(error));
} finally {
  child?.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 600));
}

// 直接打开库文件核对迁移结果。
try {
  const database = new DatabaseSync(databasePath);
  try {
    const tables = (database.prepare("select name from sqlite_master where type = 'table'").all()).map((row) => row.name);
    check(!tables.includes('accounts'), 'accounts 表已删除', tables.join(','));

    const withAccountColumn = tables.filter((table) => {
      const columns = database.prepare(`select name from pragma_table_info('${table}')`).all();
      return columns.some((column) => column.name === 'account_id');
    });
    check(withAccountColumn.length === 0, '所有表都不再有 account_id 列', withAccountColumn.join(','));

    const indexes = database
      .prepare("select name, sql from sqlite_master where type = 'index' and sql is not null")
      .all();
    const accountIndexes = indexes.filter((row) => String(row.sql).includes('account_id')).map((row) => row.name);
    check(accountIndexes.length === 0, '没有索引引用 account_id', accountIndexes.join(','));

    const quota = database.prepare('select key, used from llm_quota').all();
    check(quota.length === 1 && quota[0].key === 'quota' && quota[0].used === 420, 'llm_quota 并成一行且用量求和', JSON.stringify(quota));

    const mcpServers = database.prepare('select name from mcp_servers').all();
    check(mcpServers.length === 1 && mcpServers[0].name === 'legacy-mcp', 'mcp_servers 重建后保留记录', JSON.stringify(mcpServers));

    const pushRows = database.prepare("select id, stage from push_queue where id = 'push-legacy'").all();
    check(pushRows.length === 1, 'push_queue 的旧记录保留并补齐了新列', JSON.stringify(pushRows));

    // 再启动一次，确认迁移是幂等的。
    const again = spawn(process.execPath, [resolve(ROOT, 'gateway/lib/main.js')], {
      env: {
        ...process.env,
        DSH_HOME: home,
        CHATDSH_TELEMETRY: 'off',
        CHATDSH_GATEWAY_PORT: String(PORT + 1),
        CHATDSH_GATEWAY_DB: databasePath,
        CHATDSH_RUNTIME_URL: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let secondOutput = '';
    again.stdout.setEncoding('utf8');
    again.stderr.setEncoding('utf8');
    again.stdout.on('data', (chunk) => { secondOutput += chunk; });
    again.stderr.on('data', (chunk) => { secondOutput += chunk; });
    let secondReady = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (again.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${PORT + 1}/healthz`);
        if (response.ok) { secondReady = true; break; }
      } catch {
        // 还在启动。
      }
      await new Promise((settle) => setTimeout(settle, 200));
    }
    again.kill('SIGTERM');
    check(secondReady, '迁移后的库可以再次启动（迁移幂等）', secondReady ? '' : secondOutput.slice(-800));
    await new Promise((settle) => setTimeout(settle, 400));
  } finally {
    database.close();
  }
} catch (error) {
  check(false, '核对库文件失败', error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('旧库迁移验收通过');
process.exit(0);
