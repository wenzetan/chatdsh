// Hermes 测试容器的联调探针。
//
// 用 deploy/compose.yaml 起的测试 Hermes（端口 50011），验证适配器的五个往返：
// 探活、发起运行、读事件流、审批应答与终止。密钥与地址只从环境变量读。
//
// 用法：
//   HERMES_URL=http://127.0.0.1:50011 HERMES_API_KEY=... node deploy/scripts/hermes-smoke.mjs
//
// 退出码 0 表示收到文本增量与结束事件。

import { createHermesChatBackend } from '../../hermes-adapter/lib/index.js';

const baseUrl = process.env.HERMES_URL ?? 'http://127.0.0.1:50011';
if (process.env.HERMES_API_KEY === undefined || process.env.HERMES_API_KEY === '') {
  console.error('缺少 HERMES_API_KEY：先从 deploy/.env 读到环境变量再运行');
  process.exit(1);
}

const backend = createHermesChatBackend({
  baseUrl,
  apiKeyEnv: 'HERMES_API_KEY',
  requestTimeoutMs: 120_000,
  approvalTimeoutMs: 300_000,
});

const failures = [];
const health = await backend.health({});
console.log(`探活：${health.ok ? '可用' : '不可用'}`);
if (!health.ok) failures.push('探活失败');

if (health.ok) {
  const run = await backend.createRun({ sessionId: `chatdsh-smoke-${Date.now()}`, text: '只回复两个字：收到' }, {});
  console.log(`运行：${run.runId}`);
  let text = '';
  let finished = false;
  for await (const event of backend.streamEvents(run.runId, {})) {
    if (event.type === 'text') text += event.text;
    if (event.type === 'finish') {
      finished = true;
      console.log(`结束：${event.reason}`);
      break;
    }
    if (event.type === 'error') {
      failures.push(`运行报错：${event.code}`);
      break;
    }
  }
  console.log(`文本增量：${JSON.stringify(text.slice(0, 80))}`);
  if (!finished) failures.push('没有收到结束事件');
  if (text === '') failures.push('没有收到文本增量');
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('Hermes 适配器联调通过');
