// P04 的纯逻辑验收：副本事件到视图模型、审批角标 reducer、IndexedDB 草稿键与版本迁移、
// 页面内联产物与浏览器遥测载荷。视图与草稿测试直接加载构建产物，页面测试渲染同一份 HTML。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_APPROVAL_BADGES,
  approvalCountOf,
  approvalNotificationIdsOf,
  approvalTotalOf,
  buildReplicaTimeline,
  reduceApprovalBadge,
} from '../../gateway/lib/pwa-view.js';
import {
  DRAFT_DB_VERSION,
  DRAFT_TEXT_MAX,
  MemoryDraftStore,
  draftKeyOf,
  draftRecordOf,
  draftUpgradePlan,
  migrateLegacyDraft,
  normalizeDraftRecord,
} from '../../gateway/lib/pwa-drafts.js';
import { createPwaPageTelemetry } from '../../gateway/lib/pwa-telemetry.js';
import { renderPwaIndexHtml } from '../../gateway/lib/pwa-page.js';
import { sameOrigin } from '../../gateway/lib/browser-telemetry.js';
import { buildServiceWorkerSource } from '../../packages/client/pwa/lib/client/service-worker.js';

const USER_MESSAGE = {
  seq: 0,
  kind: 'user/message',
  time: 1_700_000_000_000,
  payload: {
    id: 'message-1',
    role: 'user',
    content: [{ type: 'text', text: '请检查这个仓库' }],
    source: { kind: 'user' },
  },
};

const ASSISTANT_MESSAGE = {
  seq: 1,
  kind: 'assistant/message',
  time: 1_700_000_001_000,
  payload: {
    turn: 1,
    step: 1,
    message: {
      id: 'message-2',
      role: 'assistant',
      content: [{ type: 'text', text: '我先看目录结构。' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    usage: { inputTokens: 12, outputTokens: 34 },
  },
};

const TOOL_CALL = {
  seq: 2,
  kind: 'tool/call',
  time: 1_700_000_002_000,
  payload: { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}' },
};

const TOOL_RESULT = {
  seq: 3,
  kind: 'tool/result',
  time: 1_700_000_003_000,
  payload: {
    turn: 1,
    step: 1,
    message: {
      id: 'message-3',
      role: 'tool',
      content: [{ type: 'text', text: 'README.md\nruntime' }],
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
      isError: false,
    },
  },
};

const APPROVAL_ASKED = {
  seq: 4,
  kind: 'approval/asked',
  time: 1_700_000_004_000,
  payload: { id: 'request-1', toolName: 'shell', callId: 'call-1', reason: '需要写入文件' },
};

const APPROVAL_DECIDED = {
  seq: 5,
  kind: 'approval/decided',
  time: 1_700_000_005_000,
  payload: { id: 'request-1', outcome: 'allowed-once' },
};

const UNKNOWN_EVENT = {
  seq: 6,
  kind: 'custom/unknown',
  time: 1_700_000_006_000,
  payload: { anything: true },
};

test('副本事件按真实 payload 字段生成结构化时间线', () => {
  const timeline = buildReplicaTimeline([
    USER_MESSAGE,
    ASSISTANT_MESSAGE,
    TOOL_CALL,
    TOOL_RESULT,
    APPROVAL_ASKED,
    APPROVAL_DECIDED,
    UNKNOWN_EVENT,
  ]);

  assert.equal(timeline.empty, false);
  assert.deepEqual(timeline.counts, { total: 7, user: 1, assistant: 1, tool: 2, approval: 2, unknown: 1 });

  const [user, assistant, call, result, asked, decided, unknown] = timeline.items;
  assert.equal(user.role, 'user');
  assert.equal(user.title, '你');
  assert.equal(user.body, '请检查这个仓库');
  assert.equal(user.bodyTruncated, false);

  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.body, '我先看目录结构。');
  assert.match(assistant.meta, /deepseek/);
  assert.match(assistant.meta, /输入 12 \/ 输出 34/);

  assert.equal(call.role, 'tool');
  assert.equal(call.title, '工具调用 · shell');
  assert.equal(call.body, '{"cmd":"ls"}');
  assert.match(call.meta, /调用 call-1/);

  assert.equal(result.role, 'tool');
  assert.equal(result.title, '工具结果');
  assert.equal(result.body, 'README.md\nruntime');
  assert.equal(result.status, undefined);

  assert.equal(asked.role, 'approval');
  assert.equal(asked.status, 'decided');
  assert.equal(asked.body, '需要写入文件');
  assert.match(asked.meta, /结果 已允许一次/);

  assert.equal(decided.role, 'approval');
  assert.equal(decided.status, 'decided');
  assert.equal(decided.body, '工具 shell');
  assert.match(decided.title, /已允许一次/);

  assert.equal(unknown.role, 'unknown');
  assert.equal(unknown.collapsed, true);
  assert.match(unknown.raw, /custom\/unknown/);
});

test('空副本给出空视图', () => {
  const timeline = buildReplicaTimeline([]);
  assert.equal(timeline.empty, true);
  assert.deepEqual(timeline.items, []);
  assert.deepEqual(timeline.counts, { total: 0, user: 0, assistant: 0, tool: 0, approval: 0, unknown: 0 });
});

test('超长工具输出被截断并标记', () => {
  const timeline = buildReplicaTimeline([{
    seq: 0,
    kind: 'tool/call',
    time: 1,
    payload: { turn: 1, step: 1, callId: 'call-long', name: 'shell', arguments: 'x'.repeat(5000) },
  }]);
  const item = timeline.items[0];
  assert.equal(item.body.length, 1200);
  assert.equal(item.bodyTruncated, true);
});

test('失败的工具结果带错误身份与原因', () => {
  const timeline = buildReplicaTimeline([{
    seq: 0,
    kind: 'tool/result',
    time: 1,
    payload: {
      turn: 1,
      step: 1,
      message: {
        id: 'message-error',
        role: 'tool',
        content: [{ type: 'text', text: '写入失败' }],
        source: { kind: 'tool', callId: 'call-9' },
        toolCallId: 'call-9',
        isError: true,
      },
      error: { name: 'ToolError', code: 'write-failed', reason: '磁盘已满' },
    },
  }]);
  const item = timeline.items[0];
  assert.equal(item.title, '工具结果 · 失败');
  assert.equal(item.status, 'error');
  assert.match(item.body, /写入失败/);
  assert.match(item.body, /错误：ToolError（write-failed）磁盘已满/);
});

test('没有决定的审批请求保持待审批', () => {
  const timeline = buildReplicaTimeline([APPROVAL_ASKED]);
  const item = timeline.items[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.title, '审批请求 · shell');
});

test('审批角标按通知与撤回事件增减', () => {
  const added = reduceApprovalBadge(EMPTY_APPROVAL_BADGES, {
    kind: 'notification',
    items: [{
      id: 'notification-1',
      kind: 'approval',
      sessionId: 'session-1',
      objectId: 'call-1',
      deviceId: 'device-1',
      createdAt: 1000,
    }],
  });
  assert.equal(approvalTotalOf(added), 1);
  assert.equal(approvalCountOf(added, 'session-1'), 1);
  assert.deepEqual(approvalNotificationIdsOf(added, 'session-1'), ['notification-1']);
  const entry = Object.values(added.entries)[0];
  assert.equal(entry.deviceId, 'device-1');
  assert.equal(entry.callId, 'call-1');

  const read = reduceApprovalBadge(added, { kind: 'notification-read', ids: ['notification-1'] });
  assert.equal(approvalTotalOf(read), 0);

  const withdrawn = reduceApprovalBadge(added, {
    kind: 'notification-withdraw',
    ids: ['notification-1'],
    tags: ['approval-call-1'],
    sessionId: 'session-1',
    objectId: 'call-1',
    at: 2000,
  });
  assert.equal(approvalTotalOf(withdrawn), 0);
});

test('审批事件与决定事件按会话与调用标识配对', () => {
  const asked = reduceApprovalBadge(EMPTY_APPROVAL_BADGES, {
    kind: 'approval',
    sessionId: 'session-2',
    callId: 'call-2',
    toolName: 'shell',
    deviceId: 'device-2',
    at: 3000,
  });
  assert.equal(approvalTotalOf(asked), 1);
  assert.equal(approvalCountOf(asked, 'session-2'), 1);

  const decided = reduceApprovalBadge(asked, {
    kind: 'approval/decided',
    sessionId: 'session-2',
    callId: 'call-2',
  });
  assert.equal(approvalTotalOf(decided), 0);
});

test('无关通知与未知事件不改变角标', () => {
  const state = reduceApprovalBadge(EMPTY_APPROVAL_BADGES, {
    kind: 'notification',
    items: [{ id: 'notification-2', kind: 'run-result', sessionId: 'session-3', createdAt: 1 }],
  });
  assert.equal(state, EMPTY_APPROVAL_BADGES);
  const replica = { kind: 'replica', sessionId: 'session-3', appended: 2 };
  assert.equal(reduceApprovalBadge(state, replica), state);
});

test('已处理通知清除角标', () => {
  const added = reduceApprovalBadge(EMPTY_APPROVAL_BADGES, {
    kind: 'notification',
    items: [{ id: 'notification-3', kind: 'approval', sessionId: 'session-4', objectId: 'call-4', createdAt: 1 }],
  });
  const handled = reduceApprovalBadge(added, { kind: 'notification-handled', ids: ['notification-3'] });
  assert.equal(approvalTotalOf(handled), 0);
});

test('草稿键按会话隔离并拒绝非法标识', () => {
  assert.equal(draftKeyOf('session-a'), 'session:session-a');
  assert.throws(() => draftKeyOf(''));
  assert.throws(() => draftKeyOf('x'.repeat(201)));
});

test('数据库升级步骤覆盖新库、旧库与当前版本', () => {
  assert.deepEqual(draftUpgradePlan(0), { createStore: true, migrateLegacy: false, dropLegacy: false });
  assert.deepEqual(draftUpgradePlan(1), { createStore: true, migrateLegacy: true, dropLegacy: true });
  assert.deepEqual(draftUpgradePlan(DRAFT_DB_VERSION), { createStore: false, migrateLegacy: false, dropLegacy: false });
  assert.deepEqual(draftUpgradePlan(DRAFT_DB_VERSION + 1), { createStore: false, migrateLegacy: false, dropLegacy: false });
  assert.throws(() => draftUpgradePlan(-1));
});

test('草稿记录校验、迁移与修订号递增', () => {
  const first = draftRecordOf('session-b', '第一版', undefined, 100);
  assert.equal(first.revision, 1);
  assert.equal(first.key, 'session:session-b');
  assert.equal(first.text, '第一版');
  const second = draftRecordOf('session-b', '第二版', first, 200);
  assert.equal(second.revision, 2);
  assert.equal(draftRecordOf('session-b', '   ', second, 300), undefined);

  assert.deepEqual(normalizeDraftRecord(first), first);
  assert.equal(normalizeDraftRecord({ ...first, revision: -1 }), undefined);
  assert.equal(normalizeDraftRecord({ ...first, text: 1 }), undefined);
  assert.equal(normalizeDraftRecord({ ...first, sessionId: '' }), undefined);
  assert.deepEqual(migrateLegacyDraft(first), first);
});

test('草稿文本按上限截断', () => {
  const record = draftRecordOf('session-c', 'x'.repeat(DRAFT_TEXT_MAX + 20), undefined, 1);
  assert.equal(record.text.length, DRAFT_TEXT_MAX);
});

test('内存草稿存储保存、读取、列举与清除', async () => {
  const store = new MemoryDraftStore();
  const saved = await store.save('session-d', '草稿内容', 1000);
  assert.equal(saved.revision, 1);
  const loaded = await store.load('session-d');
  assert.equal(loaded.text, '草稿内容');
  assert.deepEqual(await store.listSessionIds(), ['session-d']);

  const revised = await store.save('session-d', '更新内容', 2000);
  assert.equal(revised.revision, 2);
  assert.equal((await store.load('session-d')).text, '更新内容');

  const cleared = await store.save('session-d', ' ', 3000);
  assert.equal(cleared, undefined);
  assert.equal(await store.load('session-d'), undefined);
  assert.deepEqual(await store.listSessionIds(), []);

  await store.save('session-e', '另一条', 4000);
  await store.clear('session-e');
  assert.equal(await store.load('session-e'), undefined);
});

test('页面内联产物包含结构化时间线、草稿与推送入口', () => {
  const html = renderPwaIndexHtml({ version: '1.2.3', deviceId: 'web-test' });
  for (const marker of [
    'id="replica-timeline"',
    'id="replica-raw"',
    '<summary>原始事件</summary>',
    'const PAGE_DEVICE_ID = "web-test";',
    'function buildReplicaTimeline',
    'function reduceApprovalBadge',
    'function createIndexedDbDraftStore',
    'function createPwaPageTelemetry',
    '设备离线 · 只读副本',
    '草稿已保存，恢复连接后由你手动发送',
    "'/chatdsh/gateway/import'",
    "'/chatdsh/gateway/notifications/vapid'",
    "'/chatdsh/gateway/events'",
    'env(safe-area-inset-bottom)',
  ]) {
    assert.ok(html.includes(marker), `页面包含 ${marker}`);
  }
  assert.ok(!html.includes('id="replica-body"'), '页面不再直接倾倒原始 JSON 到主区域');
  assert.ok(!html.includes('JSON.stringify(data.events'), '页面不再把副本事件直接写进 pre');
});

test('浏览器遥测载荷使用同源中继与登记信号', () => {
  const calls = [];
  const telemetry = createPwaPageTelemetry({
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    },
    now: () => 1000,
    randomHex: (bytes) => 'a'.repeat(bytes * 2),
  });

  telemetry.action('replica-open', 'ok');
  assert.equal(calls[0].url, '/chatdsh/telemetry/browser');
  assert.equal(calls[0].init.headers['x-chatdsh-signal'], 'logs');
  assert.equal(calls[0].init.headers['x-chatdsh-csrf'], '1');
  const log = calls[0].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(log.body.stringValue, 'chatdsh.client.ui.action');
  assert.deepEqual(
    log.attributes.map((item) => [item.key, item.value.stringValue]),
    [['action', 'replica-open'], ['outcome', 'ok']],
  );

  telemetry.boot(6, 'ok');
  assert.equal(calls[1].init.headers['x-chatdsh-signal'], 'traces');
  const span = calls[1].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'chatdsh.client.boot');
  assert.equal(span.status.code, 1);

  telemetry.failure('draft-save', Object.assign(new Error('配额不足'), { code: 'quota' }));
  assert.equal(calls[2].body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'chatdsh.client.error');
  assert.equal(calls[3].body.resourceMetrics[0].scopeMetrics[0].metrics[0].name, 'chatdsh_client_errors_total');
});

test('浏览器遥测只接受同源与回环别名', () => {
  assert.equal(sameOrigin('http://127.0.0.1:3170', 'http://127.0.0.1:3170'), true);
  assert.equal(sameOrigin('http://localhost:3170', 'http://127.0.0.1:3170'), true);
  assert.equal(sameOrigin('http://[::1]:3170', 'http://127.0.0.1:3170'), true);
  assert.equal(sameOrigin('https://localhost:3170', 'http://127.0.0.1:3170'), false);
  assert.equal(sameOrigin('http://localhost:3171', 'http://127.0.0.1:3170'), false);
  assert.equal(sameOrigin('http://evil.example:3170', 'http://127.0.0.1:3170'), false);
  assert.equal(sameOrigin('not-a-url', 'http://127.0.0.1:3170'), false);
});

test('Service Worker 展示推送并处理点击', () => {
  const source = buildServiceWorkerSource({ version: '3' });
  assert.ok(source.includes("addEventListener('push'"));
  assert.ok(source.includes('showNotification'));
  assert.ok(source.includes("addEventListener('notificationclick'"));
  assert.ok(source.includes('openWindow'));
});
