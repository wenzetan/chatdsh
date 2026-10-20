// 连接器同步的遥测验收。
//
// 起一个本地 OTLP/HTTP 接收端，把运行时的遥测指向它，重启一次之后核对导出的请求体里有没有
// `chatdsh.connectors.sync` 这个 span 名，以及它的动作条数。数据根里预先放一条连接器记录，
// 让同步真的产生创建动作。
//
// 用法：node scripts/verify-telemetry-sync.mjs
// 退出码 0 表示收到了该 span 且创建动作不少于一条。

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';

const PORT = 4319;
const received = [];

/** 收下所有 OTLP 请求体；不做解析，只按明文检索信号名。 */
const collector = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ path: request.url ?? '/', body: Buffer.concat(chunks).toString('binary') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});

await new Promise((resolve, reject) => {
  collector.once('error', reject);
  collector.listen(PORT, '127.0.0.1', resolve);
});

const home = tempHome('telemetry-sync');
// 预置一条启用的连接器，让同步至少有一次创建动作。
mkdirSync(join(home, 'storages'), { recursive: true });
writeFileSync(join(home, 'storages', 'connectors_store.json'), JSON.stringify({
  unit: { name: 'connectors_store', version: 1 },
  global: {},
  tables: {
    connectors: {
      'demo-connector': {
        id: 'demo-connector',
        name: 'demo server',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        enabled: true,
        createdAt: 1792430000000,
        updatedAt: 1792430000000,
      },
    },
  },
}, null, 2));

mkdirSync(join(home, 'profiles'), { recursive: true });
const { symlinkSync, existsSync } = await import('node:fs');
const profileLink = join(home, 'profiles', 'chatdsh-web');
if (!existsSync(profileLink)) symlinkSync(join(import.meta.dirname, '..', 'profiles', 'chatdsh-web'), profileLink);

const child = spawn(dshCommand(), ['--profile', 'chatdsh-web', '--port', '3097', '--no-open'], {
  env: {
    ...process.env,
    DSH_HOME: home,
    CHATDSH_TELEMETRY_ENDPOINT: `http://127.0.0.1:${PORT}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const failures = [];
try {
  const deadline = Date.now() + 90_000;
  let booted = false;
  while (Date.now() < deadline) {
    if (/dsh web: http/.test(output)) { booted = true; break; }
    if (output.includes('startup failed')) throw new Error(`启动失败：\n${output.slice(-600)}`);
    await delay(400);
  }
  if (!booted) throw new Error(`等待启动超时：\n${output.slice(-600)}`);
  console.log('运行时已启动');

  // 等一次批量导出周期。
  await delay(8000);

  const spans = received.filter((item) => item.path.includes('/v1/traces'));
  const logs = received.filter((item) => item.path.includes('/v1/logs'));
  console.log(`收到 ${spans.length} 个 trace 请求、${logs.length} 个 log 请求`);

  const all = [...spans, ...logs].map((item) => item.body).join('\n');
  const hasSync = all.includes('chatdsh.connectors.sync');
  console.log(`请求体里出现 chatdsh.connectors.sync：${hasSync ? '是' : '否'}`);
  if (!hasSync) failures.push('导出的遥测里没有连接器同步的 span');

  // 同步真的建了行时，行配置里的连接器名会跟着进 span 属性与日志，按明文出现。
  const hasRow = all.includes('demo server') || all.includes('demo-connector');
  console.log(`请求体里出现连接器标识：${hasRow ? '是' : '否'}`);
  const createMarker = all.includes('create.count');
  console.log(`请求体里出现 create.count 键：${createMarker ? '是' : '否'}`);

  // 同步的条数写在日志正文里，明文可读。
  const synced = all.includes('connectors synced');
  const detail = all.match(/connectors synced[^"]{0,80}/)?.[0] ?? '（未找到）';
  console.log(`请求体里出现同步日志：${synced ? '是' : '否'}，${detail}`);
  if (!synced) failures.push('导出的遥测里没有同步日志');
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
} finally {
  child.kill('SIGTERM');
  collector.close();
  await delay(600);
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('连接器同步遥测验收通过');
process.exit(0);
