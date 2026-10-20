// 会话导入的验收。
//
// 源会话在自己的数据里有一份副本；导入在控制平面侧建一条带 parentSession 的新会话，把副本
// 事件复制过去。源设备是否在线不参与这一步，读的是控制平面保存的副本。
//
// 用法：node scripts/verify-import.mjs [--port 3189]
// 退出码 0 表示导入成功、事件一致、归属关系正确、跨账号被拒绝。

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const index = argv.indexOf('--port');
const PORT = index < 0 ? 3189 : Number.parseInt(argv[index + 1], 10);
const HOME = tempHome('import-home');

const child = spawn(process.execPath, [resolve(ROOT, 'packages/gateway/lib/main.js')], {
  env: { ...process.env, DSH_HOME: HOME, CHATDSH_GATEWAY_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const base = `http://127.0.0.1:${PORT}`;

async function waitReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // 还没起来。
    }
    await new Promise((settle) => setTimeout(settle, 300));
  }
  throw new Error(`控制平面未就绪：\n${output.slice(-600)}`);
}

function as(login) {
  return (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'tailscale-user-login': login },
  });
}

const failures = [];
try {
  await waitReady();
  console.log(`控制平面已就绪：${base}`);

  const alice = as('alice@example.test');
  const bob = as('bob@example.test');
  const sourceId = 'abcdef01-2345-6789-abcd-ef0123456789';

  const appended = await alice('/chatdsh/gateway/replica', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sourceId,
      events: [0, 1, 2].map((seq) => ({ seq, kind: 'session/end-seed', time: Date.now() + seq, bytes: 4 })),
    }),
  });
  if (appended.status !== 200) failures.push(`源会话上报失败（${appended.status}）`);

  const imported = await alice('/chatdsh/gateway/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceSessionId: sourceId, cwd: '/work/b' }),
  });
  const record = await imported.json();
  console.log(`导入结果：${imported.status} ${JSON.stringify(record)}`);
  if (imported.status !== 200) failures.push(`导入失败（${imported.status}）`);

  if (record.parentSession !== sourceId) failures.push('新会话的 parentSession 不指向源会话');
  if (record.imported !== 3) failures.push(`导入的事件数应为 3，实际 ${record.imported}`);

  // 新会话的副本应当与源会话逐条一致。
  const copy = await (await alice(`/chatdsh/gateway/replica?sessionId=${record.sessionId}`)).json();
  const seqs = (copy.events ?? []).map((event) => event.seq);
  console.log(`新会话副本序号：${JSON.stringify(seqs)}，水位 ${JSON.stringify(copy.watermark)}`);
  if (JSON.stringify(seqs) !== JSON.stringify([0, 1, 2])) failures.push('新会话的副本事件与源不一致');

  // 归属表里应当能看到这条导入关系与新的 cwd。
  const ownership = await (await alice('/chatdsh/gateway/ownership')).json();
  const importedRow = (ownership.sessions ?? []).find((row) => row.sessionId === record.sessionId);
  if (importedRow === undefined) {
    failures.push('归属表里没有导入的会话');
  } else {
    console.log(`归属记录：cwd=${importedRow.cwd} parent=${importedRow.parentSession}`);
    if (importedRow.parentSession !== sourceId) failures.push('归属表里的 parentSession 不对');
    if (importedRow.cwd !== '/work/b') failures.push('导入的会话没有采用请求里的工作目录');
  }

  // 跨账号导入应当被拒绝。
  const cross = await bob('/chatdsh/gateway/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceSessionId: sourceId }),
  });
  console.log(`跨账号导入：${cross.status}`);
  if (cross.status !== 403) failures.push(`跨账号导入没有被拒绝（${cross.status}）`);
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 600));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('会话导入验收通过');
process.exit(0);
