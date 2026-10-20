// 记忆后端的召回与写入验收。
//
// 直接使用记忆插件里的客户端，对本机运行的 Hindsight 做一次写入与召回。这条链路此前只有
// 单元测试与历史的一次手工验证。
//
// 用法：node scripts/verify-memory.mjs [--url http://127.0.0.1:8889]
// 退出码 0 表示探活通过、写入返回成功、召回返回至少一条命中。

import { resolve } from 'node:path';
import { createMemoryClient } from '../packages/host/memory/lib/client.js';

const argv = process.argv.slice(2);
const index = argv.indexOf('--url');
const URL_BASE = index < 0 ? 'http://127.0.0.1:8889' : argv[index + 1];
const BANK = 't:chatdsh-verify';
const PROBE = `验收探针，写于 ${new Date().toISOString()}：蓝鲸的体长记录是三十米。`;

const failures = [];
try {
  console.log(`Hindsight 地址：${URL_BASE}`);
  const client = createMemoryClient({
    hindsightUrl: URL_BASE,
    maxTokens: 2048,
    requestTimeoutMs: 90_000,
  });

  const alive = await client.probe();
  console.log(`探活：${alive ? '可用' : '不可用'}`);
  if (!alive) failures.push('Hindsight 不可用');

  if (alive) {
    // 同步写入：异步整合要等一会儿才能召回，验收里用同步换取确定性。
    const started = Date.now();
    const written = await client.write(BANK, { content: PROBE, context: '验收脚本', async: false });
    console.log(`写入：${JSON.stringify(written)}（${Date.now() - started} 毫秒）`);
    if (written.items < 1) failures.push('写入没有返回条目数');

    const hits = await client.recall([BANK], { query: '蓝鲸的体长是多少', maxTokens: 2048 });
    console.log(`召回：${hits.length} 条`);
    for (const hit of hits.slice(0, 3)) {
      console.log(`  - ${String(hit.text ?? hit.content ?? JSON.stringify(hit)).slice(0, 80)}`);
    }
    if (hits.length === 0) failures.push('召回没有返回命中');
  }
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('记忆后端验收通过');
process.exit(0);
