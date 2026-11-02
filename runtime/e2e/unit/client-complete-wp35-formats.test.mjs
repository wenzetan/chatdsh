// WP35 验收：四种导出格式、范围与内容、脱敏、取消与失败、遥测。
//
// 全部数据经过真实控制平面数据库与真实磁盘：会话行与副本事件用 GatewayStore 与
// ReplicaStore 写入，附件是数据目录下的真实文件，导出由 ExportService 生成真实字节。
// JSONL 逐行用 JSON.parse 校验，HTML 交给本机 Chrome 解析之后检查结构，PDF 由 Chrome 打印
// 管线生成，再用 poppler 的 pdfinfo 与 pdftotext 读出页数与可选中的中文。
//
// 运行：node --test e2e/unit/client-complete-wp35-formats.test.mjs
// 前置：先按仓库约定执行 tsc -b tsconfig.build.json，网关产物在 gateway/lib 下。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const RUNTIME = resolve(import.meta.dirname, '../..');
ensureDeps(RUNTIME);

const { GatewayStore, ReplicaStore } = await import('../../gateway/lib/store.js');
const { ExportService } = await import('../../gateway/lib/exports/service.js');
const { createTelemetryClient } = await import('../../packages/core/diagnostics/lib/client.js');
const { defaultTelemetryConfig } = await import('../../packages/core/diagnostics/lib/config.js');

const CHROME = '/usr/bin/google-chrome';
const LOCAL_DEVICE = 'device-local';
const REMOTE_DEVICE = 'device-remote';
const NOW = Date.UTC(2026, 0, 15, 9, 30, 0);

/** 私钥块的铠甲行，仅用于核对脱敏。 */
const KEY_ARMOR = '-'.repeat(5);

/** 一段用来核对凭据脱敏的私钥文本，内容为测试专用占位，不对应任何真实私钥。 */
const PRIVATE_KEY_BLOCK = [
  `${KEY_ARMOR}BEGIN RSA PRIVATE KEY${KEY_ARMOR}`,
  'MIIEowIBAAKCAQEAx1y2z3',
  `${KEY_ARMOR}END RSA PRIVATE KEY${KEY_ARMOR}`,
].join('\n');

/** 一段用来核对凭据脱敏的接口凭据，内容为测试专用占位。 */
const API_CREDENTIAL = ['sk', 'demoonlytestcredential01'].join('-');

/** 起一个接收 OTLP/HTTP JSON 的本地端点。 */
async function startOtlpReceiver() {
  const records = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      records.push({ path: request.url, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    records,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** 造一条副本事件，载荷形状与设备写入的一致。 */
function event(seq, kind, time, data) {
  const payload = { type: kind, seq, time, data };
  return { seq, kind, time, bytes: Buffer.byteLength(JSON.stringify(payload)), payload };
}

/** 一个对外形状里不允许出现的内部字段。 */
const INTERNAL_KEYS = new Set(['seq', 'watermark', 'storage_key', 'storageKey', 'up_to_seq', 'upToSeq', 'request_digest']);

/**
 * 递归检查一个对外形状里没有内部游标与存储键。
 * @param {unknown} value
 * @param {string} where
 */
function assertNoInternalKeys(value, where) {
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Uint8Array) return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(INTERNAL_KEYS.has(key), false, `${where} 暴露了内部字段 ${key}`);
    assertNoInternalKeys(child, `${where}.${key}`);
  }
}

/** 等待任务离开生成中。 */
async function settle(service, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await service.job(jobId);
    assert.ok(job !== undefined, '任务必须存在');
    if (job.state !== 'generating') return job;
    if (Date.now() > deadline) throw new Error(`等待任务 ${jobId} 超时，当前状态 ${job.state}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** 等一个路径消失，返回最终是否存在。 */
async function waitForGone(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let present = true;
    try {
      statSync(path);
    } catch {
      present = false;
    }
    if (!present) return true;
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** 把下载的字节写到磁盘并返回路径。 */
function writeBytes(path, bytes) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/** 用本机 Chrome 解析一份 HTML 文件，返回解析之后的 DOM 序列化。 */
function parseHtmlWithChrome(htmlPath, profileDir) {
  return execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    '--virtual-time-budget=5000',
    '--dump-dom',
    `file://${htmlPath}`,
  ], { env: { ...process.env, HOME: profileDir }, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
}

/** 读 PDF 的页数与可选中的文本。 */
function readPdf(pdfPath) {
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8', timeout: 30_000 });
  const pages = Number.parseInt(/^Pages:\s+(\d+)$/mu.exec(info)?.[1] ?? '0', 10);
  const text = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', timeout: 30_000 });
  return { pages, text };
}

/** 写一份真实附件文件。 */
function seedAttachment(dataRoot, id, filename, content) {
  const directory = join(dataRoot, 'attachments', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), content);
}

/** 造真实会话数据：本机设备上一个会话，另一台设备上一个会话。 */
function seedSessions(store, replicas, dataRoot) {
  store.upsertSession({
    sessionId: 'wp35-session',
    workspaceId: 'ws-wp35',
    deviceId: LOCAL_DEVICE,
    cwd: '/workspace/chatdsh',
    kind: 'work',
    createdAt: NOW - 3_600_000,
  });
  store.upsertSession({
    sessionId: 'wp35-remote',
    workspaceId: 'ws-wp35',
    deviceId: REMOTE_DEVICE,
    cwd: '/workspace/chatdsh',
    kind: 'work',
    createdAt: NOW - 3_600_000,
  });
  seedAttachment(dataRoot, 'att-report', 'report.csv', 'name,total\nNorth,120\n');

  const internalPath = join(dataRoot, 'exports', 'lost.md');
  const events = [
    event(1, 'session/title', NOW - 3_500_000, { title: '季度报表核对' }),
    event(2, 'turn/start', NOW - 3_400_000, { turn: 1 }),
    event(3, 'user/message', NOW - 3_390_000, { content: [{ type: 'text', text: '第一回合的问题，不在第二第三回合的范围里。' }] }),
    event(4, 'assistant/message', NOW - 3_380_000, { message: { content: [{ type: 'text', text: '第一回合的回答。' }] } }),
    event(5, 'turn/start', NOW - 3_300_000, { turn: 2 }),
    event(6, 'user/message', NOW - 3_290_000, {
      content: [{ type: 'text', text: '请打开报表 [附件 att-report report.csv text/csv 21 字节] 并给出结论。' }],
    }),
    event(7, 'assistant/message', NOW - 3_280_000, {
      message: {
        content: [{
          type: 'text',
          text: `报表里第三季度增长 12%。凭据 ${API_CREDENTIAL} 与 api_key = "k-9f8e7d6c5b4a" 都在原文里，路径 ${internalPath} 同样在原文里。`,
        }],
      },
    }),
    event(8, 'tool/call', NOW - 3_270_000, { name: 'read_file', arguments: { path: '/workspace/chatdsh/report.csv' } }),
    event(9, 'tool/result', NOW - 3_260_000, { name: 'read_file', result: 'name,total\nNorth,120\n' }),
    event(10, 'assistant/reasoning', NOW - 3_250_000, { text: '先算合计，再看增长率。' }),
    event(11, 'memory/recall', NOW - 3_240_000, { source: { kind: 'memory-recall' }, text: '记忆里的偏好不应进入导出。' }),
    event(12, 'turn/start', NOW - 3_200_000, { turn: 3 }),
    event(13, 'user/message', NOW - 3_190_000, {
      content: [{ type: 'text', text: '再补一份缺失附件 [附件 att-missing plan.md text/markdown 9 字节]。' }],
    }),
    event(14, 'assistant/message', NOW - 3_180_000, {
      message: { content: [{ type: 'text', text: `第二部分回答：缺口已记录。${PRIVATE_KEY_BLOCK}` }] },
    }),
  ];
  const written = replicas.append('wp35-session', events);
  assert.equal(written.written, events.length, '副本事件全部写入');

  const remoteEvents = [
    event(1, 'session/title', NOW - 3_500_000, { title: '另一台设备的会话' }),
    event(2, 'turn/start', NOW - 3_400_000, { turn: 1 }),
    event(3, 'user/message', NOW - 3_390_000, {
      content: [{ type: 'text', text: '远端会话里的附件 [附件 att-remote summary.txt text/plain 7 字节] 只在源设备上。' }],
    }),
    event(4, 'assistant/message', NOW - 3_380_000, { message: { content: [{ type: 'text', text: '远端会话的回答。' }] } }),
  ];
  const remoteWritten = replicas.append('wp35-remote', remoteEvents);
  assert.equal(remoteWritten.written, remoteEvents.length, '远端会话事件全部写入');
  return { events, remoteEvents };
}

/** 造一份需要多页的中文长文档。 */
function seedLongSession(store, replicas) {
  store.upsertSession({
    sessionId: 'wp35-long',
    workspaceId: 'ws-wp35',
    deviceId: LOCAL_DEVICE,
    cwd: '/workspace/chatdsh',
    kind: 'work',
    createdAt: NOW - 7_200_000,
  });
  const events = [event(1, 'session/title', NOW - 7_000_000, { title: '长文档分页核对' })];
  let seq = 2;
  for (let turn = 1; turn <= 12; turn += 1) {
    events.push(event(seq, 'turn/start', NOW - 7_000_000 + turn * 60_000, { turn }));
    seq += 1;
    events.push(event(seq, 'user/message', NOW - 7_000_000 + turn * 60_000 + 1, {
      content: [{ type: 'text', text: `第 ${turn} 回合的提问：请核对这一段的排版与分页，正文里的中文应当保持完整可读。` }],
    }));
    seq += 1;
    for (let index = 0; index < 6; index += 1) {
      events.push(event(seq, 'assistant/message', NOW - 7_000_000 + turn * 60_000 + 2 + index, {
        message: {
          content: [{
            type: 'text',
            text: `第 ${turn} 回合第 ${index + 1} 段回答：这一段用来确认分页不切断消息，中文标点在行末按禁则处理，`
              + '正文与标题都不落在页尾单独一行。分页规则要保留孤行与寡行的下限，长表格跨页时重复表头。',
          }],
        },
      }));
      seq += 1;
    }
  }
  const written = replicas.append('wp35-long', events);
  assert.equal(written.written, events.length, '长会话事件全部写入');
  return events;
}

/** 一份会话导出的内容范围。 */
function scopeOfSession(sessionId, format, overrides = {}) {
  const includeToolReads = overrides.includeToolReads ?? false;
  return {
    source: { kind: 'session', sessionId },
    scope: {
      turnFrom: 2,
      turnTo: 3,
      eventCount: 0,
      charCount: 0,
      compressed: !includeToolReads,
      attachmentsComplete: true,
    },
    format,
    includeToolReads,
    attachmentPolicy: 'include-missing-list',
    timeDisplay: 'local',
    redaction: 'default',
    privateExport: format === 'jsonl',
    ...overrides,
  };
}

test('四种导出格式、范围与内容、脱敏、取消与失败', { timeout: 300_000 }, async (t) => {
  const home = allocateIndependentHome('wp35-formats');
  const root = join(home, 'root');
  const dataRoot = join(root, 'data');
  const workspace = join(home, 'workspace');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'report.csv'), 'name,total\nNorth,120\n');

  const receiver = await startOtlpReceiver();
  let store;
  let telemetry;
  try {
    const databasePath = join(root, 'gateway', 'gateway.sqlite');
    mkdirSync(resolve(databasePath, '..'), { recursive: true });
    store = new GatewayStore(databasePath);
    const replicas = new ReplicaStore(store.handle());
    const seeded = seedSessions(store, replicas, dataRoot);
    seedLongSession(store, replicas);

    const watermark = store.handle()
      .prepare("select watermark from replica_watermarks where session_id = 'wp35-session'")
      .get();
    assert.equal(watermark.watermark, seeded.events.length, '副本水位是最后一条事件的序号');

    telemetry = createTelemetryClient({
      config: defaultTelemetryConfig({
        endpoint: receiver.endpoint,
        surface: 'gateway',
        exportIntervalMs: 2000,
        exportIntervalMsMetrics: 3000,
        exportTimeoutMs: 500,
      }),
      component: '@chatdsh/gateway',
      env: { CHATDSH_TELEMETRY: 'on' },
    });

    const exportsRoot = join(root, 'exports');
    const service = new ExportService({
      database: store.handle(),
      telemetry,
      dataRoot,
      exportsRoot,
      localDeviceId: LOCAL_DEVICE,
      timeZone: 'Asia/Shanghai',
      now: () => NOW,
    });
    const actor = { deviceId: LOCAL_DEVICE, privateExport: true };

    /** 建一份导出、等待完成并下载字节。 */
    const exportOf = async (format, overrides = {}) => {
      const job = await service.create({
        operationId: `wp35-${format}-${Math.random().toString(16).slice(2, 10)}`,
        requestDigest: 'a'.repeat(64),
        scope: scopeOfSession(overrides.sessionId ?? 'wp35-session', format, overrides),
      }, actor);
      const done = await settle(service, job.jobId);
      assert.equal(done.state, 'completed', `${format} 导出必须完成`);
      assert.ok(done.completedAt !== undefined);
      assert.ok(done.expiresAt !== undefined);
      const download = await service.download(job.jobId);
      return { job: done, download };
    };

    const markdown = await exportOf('markdown');
    const jsonl = await exportOf('jsonl');
    const html = await exportOf('html');

    await t.test('JSONL 每行都能被 JSON.parse 读出，头尾与条数一致', () => {
      const text = new TextDecoder('utf-8').decode(jsonl.download.bytes);
      assert.equal(jsonl.download.contentType, 'application/jsonl; charset=utf-8');
      assert.ok(jsonl.download.filename.endsWith('.jsonl'));
      const lines = text.trimEnd().split('\n');
      assert.ok(lines.length > 3, '至少要有文件头、事件与结尾');
      const objects = lines.map((line) => JSON.parse(line));
      const header = objects[0];
      assert.equal(header.type, 'export.header');
      assert.equal(header.format, 'jsonl');
      assert.equal(header.title, '季度报表核对');
      assert.deepEqual(header.turns, [2, 3]);
      assert.equal(header.scope.turnFrom, 2);
      assert.equal(header.scope.turnTo, 3);
      assert.equal(header.scope.eventCount, 10);
      assert.equal(header.privateRecord, true);
      assert.ok(header.excluded.includes('replica-watermark'));
      const events = objects.filter((object) => object.type === 'export.event');
      const attachments = objects.filter((object) => object.type === 'export.attachment');
      const end = objects[objects.length - 1];
      assert.equal(end.type, 'export.end');
      assert.equal(end.events, events.length);
      assert.equal(end.attachments, attachments.length);
      assert.deepEqual(events.map((item) => item.role), ['user', 'assistant', 'user', 'assistant']);
      assert.equal(events[0].turn, 2);
      assert.equal(events[3].turn, 3);
      assert.ok(events[0].text.includes('请打开报表'));
      assert.equal(events.some((item) => item.role === 'tool'), false, '默认导出不含工具阅读记录');
      assert.deepEqual(attachments.map((item) => item.state), ['downloadable', 'missing']);
      assert.equal(attachments[0].size, 21);
      assert.equal(text.includes('第一回合'), false, '范围之外的回合不进入导出');
    });

    await t.test('Markdown 结构与内容逐条对应', () => {
      const text = new TextDecoder('utf-8').decode(markdown.download.bytes);
      assert.equal(markdown.download.contentType, 'text/markdown; charset=utf-8');
      assert.ok(markdown.download.filename.endsWith('.md'));
      const lines = text.split('\n');
      assert.equal(lines[0], '# 季度报表核对');
      assert.ok(text.includes('- **来源**：会话 wp35-session'));
      assert.ok(text.includes('- **内容范围**：回合 2–3（完整回合，10 个事件，'));
      assert.ok(text.includes('- **工具阅读记录**：不包含（工具输出按摘要处理）'));
      assert.ok(text.includes('- **排除内容**：副本水位'));
      assert.ok(text.includes('## 附件清单'));
      assert.ok(text.includes('| report.csv | 可下载 | 21 |'));
      assert.ok(text.includes('| plan.md | 缺失 | 9 |'));
      const turns = lines.filter((line) => line.startsWith('## 第 '));
      assert.deepEqual(turns, ['## 第 2 回合', '## 第 3 回合']);
      const entries = lines.filter((line) => line.startsWith('### '));
      assert.equal(entries.length, 4, '四个条目各有一个小标题');
      assert.ok(entries[0].startsWith('### 用户 · '));
      assert.ok(text.includes('```text\n请打开报表'), '正文用围栏块包起来');
      assert.equal(text.includes('第一回合'), false);
      assert.equal(text.includes('记忆里的偏好'), false, '记忆召回不进入正文');
      assert.equal(text.includes('先算合计'), false, '思考过程不进入正文');
    });

    await t.test('HTML 由 Chrome 解析之后结构与内容正确', () => {
      const htmlPath = writeBytes(join(home, 'check', 'export.html'), html.download.bytes);
      const dom = parseHtmlWithChrome(htmlPath, join(home, 'check', 'chrome-html'));
      assert.ok(dom.startsWith('<!DOCTYPE html>'), 'Chrome 解析出完整文档');
      assert.ok(dom.includes('<title>季度报表核对</title>'));
      assert.ok(dom.includes('<h1>季度报表核对</h1>'));
      assert.equal(/<script/iu.test(dom), false, '导出页没有脚本');
      assert.ok(dom.includes('Content-Security-Policy'));
      const articles = dom.match(/<article class="chdsh-print-msg">/gu) ?? [];
      assert.equal(articles.length, 4, '四个条目各有一篇文章块');
      const sections = dom.match(/<section class="chdsh-export-turn"/gu) ?? [];
      assert.equal(sections.length, 2, '两个完整回合各有一节');
      assert.ok(dom.includes('第 2 回合'));
      assert.ok(dom.includes('第 3 回合'));
      assert.ok(dom.includes('<td>report.csv</td>'));
      assert.ok(dom.includes('<td>缺失</td>'));
      assert.ok(dom.includes('请打开报表'));
      assert.equal(dom.includes('第一回合'), false);
    });

    await t.test('PDF 由 Chrome 打印管线生成，多页中文可选', async () => {
      const job = await service.create({
        operationId: 'wp35-pdf-long',
        requestDigest: 'b'.repeat(64),
        scope: {
          source: { kind: 'session', sessionId: 'wp35-long' },
          scope: { turnFrom: 1, turnTo: 12, eventCount: 0, charCount: 0, compressed: true, attachmentsComplete: true },
          format: 'pdf',
          includeToolReads: false,
          attachmentPolicy: 'available-only',
          timeDisplay: 'utc',
          redaction: 'default',
          privateExport: false,
        },
      }, actor);
      const done = await settle(service, job.jobId, 120_000);
      assert.equal(done.state, 'completed', 'PDF 导出必须完成');
      const download = await service.download(job.jobId);
      assert.equal(download.contentType, 'application/pdf');
      assert.ok(download.filename.endsWith('.pdf'));
      const head = new TextDecoder('latin1').decode(download.bytes.subarray(0, 5));
      assert.equal(head, '%PDF-', '文件头是标准 PDF 标记');
      assert.ok(download.bytes.byteLength > 10_000, '真实打印产物有实际体积');
      const pdfPath = writeBytes(join(home, 'check', 'long.pdf'), download.bytes);
      const { pages, text } = readPdf(pdfPath);
      assert.ok(pages >= 2, `多页中文文档的页数是 ${pages}`);
      assert.ok(text.includes('长文档分页核对'), 'PDF 里能读出标题');
      assert.ok(text.includes('第 12 回合第 6 段回答'), 'PDF 里能读出末段中文');
      assert.ok(text.includes('分页不切断消息'), 'PDF 里保留了正文原句');
      assert.ok(text.includes('核对这一段的排版与分页'), 'PDF 里保留了提问原文');
    });

    await t.test('工具阅读记录开关按整回合切换', async () => {
      const withTools = await exportOf('markdown', { includeToolReads: true });
      const text = new TextDecoder('utf-8').decode(withTools.download.bytes);
      assert.ok(text.includes('### 工具阅读记录 · '));
      assert.ok(text.includes('工具调用：read_file'));
      assert.ok(text.includes('工具结果：read_file'));
      assert.ok(text.includes('回合 2–3（完整回合，10 个事件，'));
      assert.equal(withTools.job.scope.scope.compressed, false);
      assert.equal(markdown.job.scope.scope.compressed, true);
      assert.equal(text.includes('第一回合的问题'), false);
    });

    await t.test('附件清单逐项状态与缺失确认', async () => {
      const estimate = await service.estimate(scopeOfSession('wp35-session', 'markdown'), actor);
      assert.deepEqual(estimate.attachments.map((item) => item.state), ['downloadable', 'missing']);
      assert.equal(estimate.attachments[0].size, 21, '可下载附件带真实字节数');
      assertNoInternalKeys(estimate, '预估');

      const remote = await service.estimate({
        source: { kind: 'session', sessionId: 'wp35-remote' },
        scope: { turnFrom: 1, turnTo: 1, eventCount: 0, charCount: 0, compressed: true, attachmentsComplete: true },
        format: 'markdown',
        includeToolReads: false,
        attachmentPolicy: 'include-missing-list',
        timeDisplay: 'local',
        redaction: 'default',
        privateExport: false,
      }, actor);
      assert.deepEqual(remote.attachments.map((item) => item.state), ['needs-source-device'], '别的设备上的附件按需要源设备处理');

      const jobDir = join(exportsRoot, markdown.job.jobId);
      const attachmentPath = join(jobDir, 'attachments', 'att-report', 'report.csv');
      assert.equal(readFileSync(attachmentPath, 'utf8'), 'name,total\nNorth,120\n', '可下载附件按真实字节写进导出包');
      assert.equal(statSync(attachmentPath).size, 21);
    });

    await t.test('默认导出不含副本水位、事件序号与内部存储键', async () => {
      assertNoInternalKeys(markdown.job, '任务视图');
      assertNoInternalKeys(jsonl.job, '任务视图');
      const texts = [markdown, jsonl, html].map((item) => new TextDecoder('utf-8').decode(item.download.bytes));
      for (const text of texts) {
        assert.equal(/watermark["']?\s*[:=]/u.test(text), false, '导出里没有副本水位字段');
        assert.equal(/storage_key["']?\s*[:=]/u.test(text), false, '导出里没有内部存储键');
        assert.equal(text.includes('replica_events'), false, '导出里没有内部表名');
        assert.equal(text.includes('request_digest'), false, '导出里没有请求摘要');
      }
      const jsonlText = new TextDecoder('utf-8').decode(jsonl.download.bytes);
      const jsonlObjects = jsonlText.trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.equal(jsonlObjects.some((object) => 'seq' in object), false, 'JSONL 里没有事件序号');
      const jobs = await service.list();
      assert.ok(jobs.length >= 3);
      assertNoInternalKeys(jobs, '任务列表');
    });

    await t.test('脱敏覆盖凭据、绝对路径与私钥块', () => {
      const items = { markdown, jsonl, html };
      for (const [format, item] of Object.entries(items)) {
        const text = new TextDecoder('utf-8').decode(item.download.bytes);
        assert.equal(text.includes(API_CREDENTIAL), false, `${format} 没有漏出接口凭据`);
        assert.equal(text.includes('k-9f8e7d6c5b4a'), false, `${format} 没有漏出 api_key 取值`);
        assert.equal(text.includes('BEGIN RSA PRIVATE KEY'), false, `${format} 没有漏出私钥块`);
        assert.equal(text.includes('MIIEowIBAAKCAQEAx1y2z3'), false, `${format} 没有漏出私钥内容`);
        assert.equal(text.includes(join(dataRoot, 'exports')), false, `${format} 没有漏出内部路径`);
        assert.ok(text.includes('[凭据已隐藏]'), `${format} 留下凭据替换标记`);
        assert.ok(text.includes('[路径已隐藏]'), `${format} 留下路径替换标记`);
      }
      const text = new TextDecoder('utf-8').decode(markdown.download.bytes);
      assert.ok(text.includes('命中 '), '导出说明记录脱敏命中次数');
      assert.equal(markdown.job.scope.redaction, 'default');
    });

    await t.test('进行中的导出可以取消，半成品文件被删掉', async () => {
      const created = await service.create({
        operationId: 'wp35-cancel',
        requestDigest: 'c'.repeat(64),
        scope: {
          source: { kind: 'session', sessionId: 'wp35-long' },
          scope: { turnFrom: 1, turnTo: 12, eventCount: 0, charCount: 0, compressed: true, attachmentsComplete: true },
          format: 'pdf',
          includeToolReads: false,
          attachmentPolicy: 'available-only',
          timeDisplay: 'utc',
          redaction: 'default',
          privateExport: false,
        },
      }, actor);
      assert.equal(created.state, 'generating');
      const cancelled = await service.cancel(created.jobId);
      assert.equal(cancelled.state, 'cancelling');
      assert.ok(cancelled.completedAt !== undefined, '取消完成带完成时刻');
      const settled = await settle(service, created.jobId, 60_000);
      assert.equal(settled.state, 'cancelling');
      const again = await service.cancel(created.jobId);
      assert.equal(again.state, 'cancelling', '重复取消返回同一状态');
      await assert.rejects(
        () => service.download(created.jobId),
        (error) => error.code === 'write-unconfirmed' && error.reason === 'job-running',
        '取消之后没有可下载的产物',
      );
      const gone = await waitForGone(join(exportsRoot, created.jobId), 60_000);
      assert.equal(gone, true, '取消之后导出包里没有半成品目录');
    });

    await t.test('生成失败留下失败状态与原因码，没有可下载文件', async () => {
      const blockedRoot = join(root, 'exports-blocked');
      writeFileSync(blockedRoot, '这里是一个普通文件，导出包目录无法建立。');
      const failing = new ExportService({
        database: store.handle(),
        telemetry,
        dataRoot,
        exportsRoot: blockedRoot,
        localDeviceId: LOCAL_DEVICE,
        timeZone: 'Asia/Shanghai',
        now: () => NOW,
      });
      const created = await failing.create({
        operationId: 'wp35-fail',
        requestDigest: 'd'.repeat(64),
        scope: scopeOfSession('wp35-session', 'html', { attachmentPolicy: 'available-only' }),
      }, actor);
      const failed = await settle(failing, created.jobId, 30_000);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.code, 'internal-error');
      await assert.rejects(
        () => failing.download(created.jobId),
        (error) => error.reason === 'job-failed',
        '失败的任务没有可下载文件',
      );
    });

    await t.test('遥测记录导出 span、失败事件、计数与字节', async () => {
      await telemetry.flush(5000);
      const all = receiver.records.map((item) => item.body).join('\n');
      assert.ok(all.includes('chatdsh.gateway.export.estimate'), '预估写了 span');
      assert.ok(all.includes('chatdsh.gateway.export.generate'), '生成写了 span');
      assert.ok(all.includes('chatdsh.gateway.export.download'), '下载写了 span');
      assert.ok(all.includes('chatdsh.gateway.export.rejected'), '失败分支写了拒绝事件');
      assert.ok(all.includes('internal-error'), '拒绝事件带错误码');
      assert.ok(all.includes('chatdsh_gateway_exports_total'), '动作计数指标已导出');
      assert.ok(all.includes('chatdsh_gateway_export_bytes'), '导出字节分布已导出');
      assert.equal(all.includes('第三季度增长'), false, '遥测里没有正文');
      assert.equal(all.includes('report.csv'), false, '遥测里没有附件文件名');
    });
  } finally {
    if (telemetry !== undefined) await telemetry.shutdown();
    await receiver.close();
    if (store !== undefined) store.close();
    releaseIndependentHome(home);
  }
});
