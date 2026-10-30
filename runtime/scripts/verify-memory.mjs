// 记忆后端与召回注入的验收。
//
// 两段：
//   1. 后端链路：直接使用记忆插件里的客户端，对本机运行的 Hindsight 做一次同步写入与召回。
//   2. 召回注入：把两批带标记的记忆写进该会话场景的组 bank，起一个加载 chatdsh-memory 的
//      ACP 会话，连续两轮提问触发召回，然后读该会话的 JSONL 日志核对注入方式——system
//      消息只有开头一条；第二轮请求的消息前缀与第一轮逐字节一致，新增内容只出现在末尾；
//      两轮都追加了召回消息。
//
// 第二段需要测试模型网关的凭据（环境变量 `CHATDSH_TEST_GATEWAY_API_KEY`），缺凭据时明确
// 失败，不跳过。`--skip-session` 只跑第一段，并把跳过的原因打印出来。
//
// 用法：node scripts/verify-memory.mjs [--url http://127.0.0.1:8889] [--profile chatdsh-acp-live]
//                                      [--cwd <会话工作目录>] [--skip-session]
// 退出码 0 表示两段都通过。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMemoryClient } from '../packages/host/memory/lib/client.js';
import { banksFor } from '../packages/host/memory/lib/rules.js';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

/**
 * 读一个命令行选项。
 * @param name - 选项名，不带前缀。
 * @param fallback - 缺省值。
 * @returns 选项值。
 */
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return argv[index + 1] ?? fallback;
}

const URL_BASE = option('url', 'http://127.0.0.1:8889');
const PROFILE = option('profile', 'chatdsh-acp-live');
/** 验收会话里记忆插件的请求超时：本机 Hindsight 的一次召回约二十秒。 */
const RECALL_TIMEOUT_MS = 90_000;
/** 会话的工作目录；空串表示聊天会话，召回只查账号 bank。 */
const CWD = option('cwd', resolve(ROOT, '..'));
const SKIP_SESSION = argv.includes('--skip-session');
const BANK = 't:chatdsh-verify';
const PROBE = `验收探针，写于 ${new Date().toISOString()}：蓝鲸的体长记录是三十米。`;
const MARKER = `chatdsh-recall-${String(Date.now())}`;

/** 会话日志里的消息事件：类型 → 从 `data` 里取消息字段的方式。 */
const SURFACE_MESSAGE = {
  'system/message': (data) => data.message,
  'developer/message': (data) => data.message,
  'user/message': (data) => data,
  'assistant/message': (data) => data.message,
  'tool/result': (data) => data.message,
};

const failures = [];

/**
 * 把会话日志还原成每次模型请求进入 prompt 的消息列表。
 *
 * 每一步的请求由该步的 `assistant/message` 落盘收尾：那一刻之前积累的消息事件就是这次
 * 请求的 prompt。`request/header` 只在新配置生效时落盘，不能当作每次请求的标记。
 * @param events - 会话日志事件，按 seq 顺序。
 * @returns 全部 prompt 消息与每次请求时的消息快照。
 */
function promptsOf(events) {
  const surface = [];
  const prompts = [];
  for (const event of events) {
    if (event.type === 'assistant/message') {
      prompts.push({ seq: event.seq, turn: event.data?.turn, step: event.data?.step, messages: [...surface] });
      surface.push({ type: event.type, message: event.data?.message });
      continue;
    }
    const pick = SURFACE_MESSAGE[event.type];
    if (pick === undefined) continue;
    surface.push({ type: event.type, message: pick(event.data ?? {}) });
  }
  return { surface, prompts };
}

/**
 * 取一条消息的文本。
 * @param entry - prompt 里的一条消息。
 * @returns 文本；没有文本块时为空串。
 */
function textOf(entry) {
  const content = entry.message?.content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(' ').trim();
}

/**
 * 找到会话日志文件。
 * @param home - 本次运行的数据根。
 * @param sessionId - 会话标识。
 * @returns 日志文件路径。
 */
function findSessionFile(home, sessionId) {
  for (const entry of readdirSync(join(home, 'sessions'), { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name !== sessionId) continue;
    const dir = join(entry.parentPath, entry.name);
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const file = join(dir, name);
      if (existsSync(file)) return file;
    }
  }
  throw new Error(`会话 ${sessionId} 的日志文件不存在`);
}

/**
 * 读取会话日志文本。
 *
 * 存储层按事件追加 zstd 帧，一帧一行；`zstd -dc` 解全部帧。
 * @param file - 日志文件路径。
 * @returns 解码后的文本。
 */
function readSessionText(file) {
  if (file.endsWith('.jsonl')) return readFileSync(file, 'utf8');
  const result = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined) throw new Error(`解压会话日志需要 zstd 命令：${result.error.message}`);
  if (result.status !== 0) throw new Error(`zstd 解压失败：${String(result.stderr).trim()}`);
  return result.stdout;
}

/**
 * 起一个 ACP 会话并连发两轮提问。
 * @param prompts - 两轮的提示文本。
 * @returns 数据根、会话标识与子进程的错误输出。
 */
async function runSession(prompts) {
  const home = tempHome('memory-recall');
  mkdirSync(join(home, 'profiles'), { recursive: true });
  symlinkSync(resolve(ROOT, 'e2e', 'profiles', PROFILE), join(home, 'profiles', PROFILE));
  // Hindsight 在本机的召回耗时接近二十秒，profile 里的五秒超时会让每次 pre-step 召回都走
  // 降级分支，读不到召回消息。验收在临时数据根里加一层覆盖，只放超时这一项。
  const overlay = join(home, 'recall-timeout.patch.yml');
  writeFileSync(overlay, [
    '- id: chatdsh-memory',
    "  name: '@chatdsh/host-memory'",
    '  config:',
    `    hindsightUrl: ${URL_BASE}`,
    '    maxTokens: 1024',
    `    requestTimeoutMs: ${RECALL_TIMEOUT_MS}`,
    '    mirrorToOwnBank: false',
    '    additionalBanks: []',
    '    summaryProvider: test-gateway',
    '    summaryModel: xhs/dots3-note-prev',
    '',
  ].join('\n'));
  const child = spawn(dshCommand(), ['--profile', PROFILE, '--patch', overlay], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { childError += chunk; });

  let nextId = 0;
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter === undefined) continue;
      pending.delete(message.id);
      if (message.error === undefined) waiter.resolve(message.result);
      else waiter.reject(new Error(JSON.stringify(message.error)));
    }
  });

  /** 发一条 JSON-RPC 请求并等结果。 */
  function request(method, params, timeoutMs = 180_000) {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => rejectRequest(new Error(`${method} 超时`)), timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
        reject: (error) => { clearTimeout(timer); rejectRequest(error); },
      });
    });
  }

  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await request('session/new', { cwd: CWD, mcpServers: [] });
    for (const prompt of prompts) {
      await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
    }
    return { home, sessionId: session.sessionId, childError };
  } finally {
    child.kill('SIGTERM');
    await new Promise((settle) => setTimeout(settle, 800));
  }
}

// ── 第一段：后端链路 ──────────────────────────────────────────────

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

    // ── 第二段：召回注入 ──────────────────────────────────────────
    if (SKIP_SESSION) {
      console.log('召回注入段：跳过（命令行给了 --skip-session）');
    } else if ((process.env.CHATDSH_TEST_GATEWAY_API_KEY ?? '') === '') {
      console.log('召回注入段：缺少模型凭据，未执行。设置环境变量 CHATDSH_TEST_GATEWAY_API_KEY 后重跑。');
      failures.push('缺模型凭据');
    } else {
      const scope = { accountId: 'local', tenantId: 'default', memoryGroupId: CWD === '' ? undefined : CWD };
      const banks = banksFor(scope);
      const seedBank = banks.recall[0];
      const facts = [
        `验收标记 ${MARKER}：蓝鲸的体长记录是三十米。`,
        `验收标记 ${MARKER}：部署端口是 3191。`,
      ];
      for (const fact of facts) {
        await client.write(seedBank, { content: fact, context: 'recall-verify', async: false });
      }
      console.log(`召回注入段：会话工作目录 ${JSON.stringify(CWD)}，召回 bank ${banks.recall.join('、')}`);
      console.log(`召回注入段：写入 ${facts.length} 条带标记的记忆到 ${seedBank}（标记 ${MARKER}）`);

      const { home, sessionId, childError } = await runSession([
        `验收标记 ${MARKER}：蓝鲸的体长记录是多少？请只回复：收到`,
        `验收标记 ${MARKER}：部署端口是多少？请只回复：收到`,
      ]);
      const file = findSessionFile(home, sessionId);
      const events = readSessionText(file).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
      const { surface, prompts } = promptsOf(events);
      console.log(`会话日志：${file}`);
      console.log(`会话 ${sessionId} 事件 ${events.length} 个，模型请求 ${prompts.length} 次`);

      const systems = surface.filter((entry) => entry.type === 'system/message');
      console.log(`system 消息：${systems.length} 条，长度为 ${systems.map((entry) => textOf(entry).length).join('、')} 字`);
      if (systems.length !== 1) failures.push(`system 消息应当只有一条，实际 ${systems.length} 条`);
      if (systems.length > 0 && surface[0]?.type !== 'system/message') failures.push('system 消息不在 prompt 的最前面');

      const recalls = (messages) => messages.filter((entry) => entry.message?.source?.kind === 'memory-recall');
      const first = prompts.find((entry) => entry.turn === 1 && entry.step === 1);
      const second = prompts.find((entry) => entry.turn === 2 && entry.step === 1);
      if (first === undefined || second === undefined) {
        failures.push('没有观察到两个回合的模型请求');
      } else {
        const firstRecall = recalls(first.messages);
        const secondRecall = recalls(second.messages);
        console.log(`第一轮请求：消息 ${first.messages.length} 条，召回 ${firstRecall.length} 条`);
        console.log(`第二轮请求：消息 ${second.messages.length} 条，召回 ${secondRecall.length} 条`);
        for (const entry of firstRecall) console.log(`  第一轮召回内容：${textOf(entry).slice(0, 120)}`);
        for (const entry of secondRecall.slice(firstRecall.length)) console.log(`  第二轮新增召回内容：${textOf(entry).slice(0, 120)}`);
        if (firstRecall.length === 0) failures.push('第一轮请求里没有召回消息');
        if (secondRecall.length <= firstRecall.length) failures.push('第二轮请求里没有新增召回消息');
        if ([...firstRecall, ...secondRecall].some((entry) => !textOf(entry).startsWith('# 相关记忆'))) failures.push('召回消息的内容不是相关记忆段');

        const prefix = JSON.stringify(first.messages);
        const secondPrefix = JSON.stringify(second.messages.slice(0, first.messages.length));
        console.log(`前缀比对：第一轮 ${Buffer.byteLength(prefix)} 字节，第二轮开头 ${Buffer.byteLength(secondPrefix)} 字节，${prefix === secondPrefix ? '逐字节一致' : '不一致'}`);
        if (prefix !== secondPrefix) failures.push('第二轮请求的消息前缀与第一轮不一致');
        if (second.messages.length <= first.messages.length) failures.push('第二轮请求没有比第一轮更长');
      }
      if (childError.trim() !== '') console.log(`运行时错误输出：${childError.slice(-2000)}`);
    }
  }
} catch (error) {
  console.log(`验收中断：${error instanceof Error ? error.message : String(error)}`);
  failures.push('runtime');
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('记忆后端与召回注入验收通过');
process.exit(0);
