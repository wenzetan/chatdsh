// Hermes 聊天代写的事件形状测试。
//
// 用上游真实的落盘校验器验证翻译结果：事件必须是连续序号、无损 JSON、通过类型与
// surface 校验。校验器来自 DSH 安装的 dsh-session-persistence，不是替身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materializeAppendBatch, validateStoredEvents } from '../../.dsh-deps/@deepseek-ai/dsh-session-persistence/lib/index.js';
import { approvalPluginEvent, translateRun } from '../../packages/host/chat-hermes/lib/translate.js';

/** 一个最小的会话头，只为让校验器运行。 */
const HEADER = {
  id: 'session-hermes-test',
  version: 1,
  cwd: '/tmp/chatdsh-hermes-test',
  createdAt: 1,
  isSeeded: false,
};

/** 一次典型运行的 Hermes 事件。 */
const EVENTS = [
  { type: 'text', text: '第一段' },
  { type: 'text', text: '，第二段' },
  { type: 'approval-request', runId: 'run-1', requestId: 'req-1', title: '执行命令', choices: ['once', 'deny'] },
  { type: 'finish', reason: 'stop' },
];

test('翻译结果通过上游的落盘校验', () => {
  const translated = translateRun({
    runId: 'run-1',
    firstSeq: 0,
    now: 1_700_000_000_000,
    turn: 1,
    step: 1,
    userText: '你好',
    events: EVENTS,
  });

  assert.equal(translated.assistantText, '第一段，第二段');
  assert.deepEqual(translated.approvals, [{ requestId: 'req-1', title: '执行命令', choices: ['once', 'deny'] }]);
  assert.deepEqual(translated.events.map((event) => event.type), [
    'turn/start',
    'step/start',
    'user/message',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);
  assert.deepEqual(translated.events.map((event) => event.seq), [0, 1, 2, 3, 4, 5]);

  const batch = materializeAppendBatch(translated.events);
  const validated = validateStoredEvents(HEADER, [...batch]);
  assert.equal(validated.length, 6);
});

test('助手消息带 append 的 surfaceOp 且不带 sourceEventSeqs', () => {
  const translated = translateRun({
    runId: 'run-2',
    firstSeq: 10,
    turn: 3,
    step: 1,
    userText: '继续',
    events: [{ type: 'text', text: '好的' }],
  });
  const assistant = translated.events.find((event) => event.type === 'assistant/message');
  assert.equal(assistant.surfaceOp, 'append');
  assert.equal('sourceEventSeqs' in assistant, false);
  assert.equal(assistant.data.message.source.provider, 'hermes');
  assert.equal(assistant.data.message.id, 'hermes:run-2:assistant');
});

test('失败运行以 error 结束', () => {
  const translated = translateRun({
    runId: 'run-3',
    firstSeq: 0,
    turn: 1,
    step: 1,
    userText: '你好',
    events: [{ type: 'error', code: 'unsupported' }],
  });
  assert.equal(translated.failed, true);
  const end = translated.events.at(-1);
  assert.equal(end.type, 'turn/end');
  assert.deepEqual(end.data.reason, { kind: 'error', error: { code: 'UNKNOWN', message: 'Hermes 运行失败' } });
});

test('审批记录是可跳过的插件事件', () => {
  const event = approvalPluginEvent({
    runId: 'run-1', requestId: 'req-1', title: '执行命令', choices: ['once'], seq: 7, now: 1,
  });
  assert.equal(event.type, 'plugin:hermes-approval');
  assert.equal(event.seq, 7);
  assert.equal(event.surfaceOp, undefined);
  // 插件事件不在内核事件类型里，必须能被读取方安全跳过；这里只核对信封形状。
  assert.deepEqual(Object.keys(event).sort(), ['data', 'seq', 'time', 'type']);
});
