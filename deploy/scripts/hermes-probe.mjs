// Hermes 补齐与指纹的实测探针。
//
// 回答两个问题，各对应一次真实请求：
// 1. 不带 X-Hermes-Session-Id 的请求，请求体里的合成历史会不会被写进 state.db；
// 2. 会话标识由 system prompt 与第一条 user 消息推导，改动这两者会不会落到另一个会话。
//
// 用法：
//   HERMES_URL=http://127.0.0.1:50011 HERMES_API_KEY=... node deploy/scripts/hermes-probe.mjs
//
// 退出码 0 表示两次实测都拿到了明确结论并打印出来。脚本不预设哪一侧成立，只观测行为。

const baseUrl = process.env.HERMES_URL ?? 'http://127.0.0.1:50011';
const apiKey = process.env.HERMES_API_KEY;
if (apiKey === undefined || apiKey === '') {
  console.error('缺少 HERMES_API_KEY：先从 deploy/.env 读到环境变量再运行');
  process.exit(1);
}

const MARK = 'ALPHA-7';

async function complete(messages, sessionId) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (sessionId !== undefined) headers['X-Hermes-Session-Id'] = sessionId;
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'default', messages, stream: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`补全失败 ${String(response.status)}：${await response.text()}`);
  const body = await response.json();
  const derived = response.headers.get('x-hermes-session-id') ?? '';
  const text = body.choices?.[0]?.message?.content ?? '';
  return { sessionId: derived, text };
}

async function storedMessages(sessionId) {
  const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=500`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`读取会话失败 ${String(response.status)}：${await response.text()}`);
  const body = await response.json();
  return body.data ?? [];
}

const system = '你是探针助手。回答只用中文，不超过十个字。';
const firstUser = '探针开始，回复两个字：开始。';
const secondUser = '探针继续，回复两个字：继续。';

const first = await complete([
  { role: 'system', content: system },
  { role: 'user', content: firstUser },
]);
console.log(`首次请求的会话标识：${first.sessionId}`);

const repeat = await complete([
  { role: 'system', content: system },
  { role: 'user', content: firstUser },
]);
console.log(`同一 system 与同一 first user 再次请求的会话标识：${repeat.sessionId}`);
console.log(`指纹判据一（两者相同）：${String(first.sessionId === repeat.sessionId)}`);

const changedSystem = await complete([
  { role: 'system', content: `${system}第二个版本。` },
  { role: 'user', content: firstUser },
]);
console.log(`改动 system 之后的会话标识：${changedSystem.sessionId}`);
console.log(`指纹判据二（与首次不同）：${String(changedSystem.sessionId !== first.sessionId)}`);

const changedFirstUser = await complete([
  { role: 'system', content: system },
  { role: 'user', content: `${firstUser}换一句。` },
]);
console.log(`改动 first user 之后的会话标识：${changedFirstUser.sessionId}`);
console.log(`指纹判据三（与首次不同）：${String(changedFirstUser.sessionId !== first.sessionId)}`);

const gapUser = '断电期间 DSH 承载了一轮，回复两个字：承接。';
const fill = await complete([
  { role: 'system', content: system },
  { role: 'user', content: firstUser },
  { role: 'assistant', content: `${MARK} 这是合成历史里的一句话。` },
  { role: 'user', content: gapUser },
]);
console.log(`补齐请求（不带会话头）落到的会话标识：${fill.sessionId}`);
console.log(`补齐请求与首次是同一会话：${String(fill.sessionId === first.sessionId)}`);
console.log(`补齐请求的回复：${JSON.stringify(fill.text.slice(0, 60))}`);

const stored = await storedMessages(fill.sessionId);
console.log(`会话 ${fill.sessionId} 的 state.db 里共 ${String(stored.length)} 条消息`);
const markRows = stored.filter((row) => String(row.content ?? '').includes(MARK));
console.log(`含合成标记 ${MARK} 的消息条数：${String(markRows.length)}`);
console.log(`合成历史写入 state.db：${String(markRows.length > 0)}`);
const gapRows = stored.filter((row) => String(row.content ?? '').includes(gapUser));
console.log(`含补齐轮用户消息的条数：${String(gapRows.length)}`);

console.log('消息序列（角色 + 前 24 字）：');
for (const row of stored) {
  console.log(`  ${String(row.role)}: ${String(row.content ?? '').slice(0, 24).replaceAll('\n', ' ')}`);
}
