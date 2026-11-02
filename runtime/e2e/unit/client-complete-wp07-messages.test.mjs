// WP07 消息呈现、流式装配、准确停止、长会话分页与消息反馈的真实函数测试。
//
// 输入是运行时线上事件的真实形状：`user/message`、`assistant/message`（内容块加紧凑流记录）、
// `tool/call`、`tool/result`、`turn/*` 与 `step/*`；跟随帧是真实 SSE 端点会发出的三种帧。
// 断言全部来自包内导出的真实函数，没有替身，也没有为通过测试而准备的数据。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActiveRun,
  ConversationStream,
  DEFAULT_TRUNCATE_BYTES,
  EXECUTION_SOURCE_TEXT,
  FeedbackBoard,
  MESSAGE_STATUS_TEXT,
  captureAnchor,
  extendNewer,
  extendOlder,
  formatMessageTime,
  latestWindow,
  newMessagesLabel,
  parseFollowFrame,
  projectConversation,
  restoreScroll,
  segmentsText,
  shouldAutoFollow,
  truncateForDisplay,
  utf8Bytes,
} from '../../packages/client/conversation/lib/index.js';

/** 一条用户消息事件。 */
function userEvent(seq, time, text) {
  return {
    type: 'user/message',
    seq,
    time,
    surfaceOp: 'append',
    data: {
      id: `user-${seq}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  };
}

/** 一条助手消息事件。 */
function assistantEvent(seq, time, content) {
  return {
    type: 'assistant/message',
    seq,
    time,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `assistant-${seq}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'v4' },
        content,
      },
      stream: [],
    },
  };
}

/** 一次工具调用事件。 */
function toolCallEvent(seq, time, callId, name, args) {
  return { type: 'tool/call', seq, time, data: { turn: 1, step: 1, callId, name, arguments: args } };
}

/** 一次工具结果事件。 */
function toolResultEvent(seq, time, callId, text, extra = {}) {
  return {
    type: 'tool/result',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `tool-${seq}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        ...extra,
      },
    },
  };
}

test('投影合并连续文本片段，并保留角色、时刻与执行来源', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    userEvent(1, 1_001, '你好'),
    assistantEvent(2, 1_002, [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '，第二段' },
    ]),
    { type: 'turn/end', seq: 3, time: 1_003, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const local = projectConversation(events, { source: 'local' });
  assert.equal(local.messages.length, 2);
  const [user, assistant] = local.messages;
  assert.equal(user.role, 'user');
  assert.equal(user.source, 'local');
  assert.equal(user.at, 1_001);
  assert.equal(user.status, 'completed');
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.segments.length, 1, '两个连续文本块合并成一个片段');
  assert.equal(assistant.segments[0].kind, 'text');
  assert.equal(assistant.segments[0].text, '第一段，第二段');
  assert.equal(segmentsText(assistant.segments), '第一段，第二段');
  assert.equal(EXECUTION_SOURCE_TEXT.local, '本机执行');
  assert.equal(MESSAGE_STATUS_TEXT.completed, '已完成');
  assert.match(formatMessageTime(1_001), /^\d{2}:\d{2}:\d{2}$/);

  const remote = projectConversation(events, { source: 'remote' });
  assert.equal(remote.messages[0].source, 'remote');
  assert.equal(EXECUTION_SOURCE_TEXT.remote, '远程执行');
});

test('工具调用与结果按调用标识配对，给出状态、耗时与参数摘要', () => {
  const events = [
    userEvent(0, 5_000, '跑一下'),
    assistantEvent(1, 5_001, [
      { type: 'text', text: '我来执行' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}' },
    ]),
    toolCallEvent(2, 5_002, 'call-1', 'bash', '{"command":"ls -la"}'),
    toolResultEvent(3, 5_030, 'call-1', 'total 0\ndrwxr-xr-x  2 root root 40'),
    { type: 'turn/end', seq: 4, time: 5_031, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const projection = projectConversation(events, { source: 'local' });
  const assistant = projection.messages.at(-1);
  const tool = assistant.segments.find((segment) => segment.kind === 'tool');
  assert.ok(tool !== undefined);
  assert.equal(tool.callId, 'call-1');
  assert.equal(tool.name, 'bash');
  assert.equal(tool.status, 'succeeded');
  assert.equal(tool.argumentsText, '{"command":"ls -la"}');
  assert.equal(tool.argumentsSummary, '{"command":"ls -la"}');
  assert.equal(tool.durationMs, 28);
  assert.equal(tool.result.truncated, false);
  assert.equal(tool.result.fullReadable, true);
  assert.match(tool.result.text, /total 0/);
  // 轨迹默认折叠，按事件顺序保留。
  assert.deepEqual(projection.trace.map((entry) => entry.kind), ['turn-end']);
  assert.equal(projection.trace[0].collapsed, true);
});

test('工具失败结果带原因码，思考片段默认折叠', () => {
  const events = [
    assistantEvent(0, 6_000, [
      { type: 'reasoning', text: '先看看目录结构' },
      { type: 'text', text: '执行失败' },
    ]),
    toolCallEvent(1, 6_001, 'call-2', 'bash', '{"command":"false"}'),
    {
      type: 'tool/result',
      seq: 2,
      time: 6_010,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-2',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-2' },
          toolCallId: 'call-2',
          content: [{ type: 'text', text: '命令返回非零退出码' }],
          isError: true,
        },
        error: { name: 'BashError', code: 'EXIT_CODE', reason: '退出码 1' },
      },
    },
  ];
  const projection = projectConversation(events, { source: 'local' });
  const assistant = projection.messages[0];
  const reasoning = assistant.segments[0];
  assert.equal(reasoning.kind, 'reasoning');
  assert.equal(reasoning.collapsed, true);
  const tool = assistant.segments.find((segment) => segment.kind === 'tool');
  assert.equal(tool.status, 'failed');
  assert.equal(tool.result.errorCode, 'EXIT_CODE');
});

test('工具结果超过展示上限时截断，完整正文保留在本地', () => {
  const long = 'x'.repeat(9000);
  const events = [
    assistantEvent(0, 7_000, [{ type: 'text', text: '输出很长' }]),
    toolCallEvent(1, 7_001, 'call-3', 'bash', '{}'),
    toolResultEvent(2, 7_500, 'call-3', long),
  ];
  const projection = projectConversation(events, { source: 'local' });
  const tool = projection.messages[0].segments.find((segment) => segment.kind === 'tool');
  assert.equal(tool.result.truncated, true);
  assert.equal(tool.result.bytes, utf8Bytes(long));
  assert.equal(tool.result.fullText.length, long.length);
  assert.equal(tool.result.text.length, DEFAULT_TRUNCATE_BYTES);
  assert.equal(tool.result.fullReadable, true);
  // 截断点不切开多字节字符。
  const chinese = truncateForDisplay('中文'.repeat(100), 8);
  assert.equal(chinese.truncated, true);
  assert.equal(utf8Bytes(chinese.text) <= 8, true);
  assert.equal('中文中文'.startsWith(chinese.text), true);
});

test('跟随帧校验拒绝缺少序号与未知形状的帧', () => {
  const snapshot = parseFollowFrame({
    type: 'snapshot',
    cursor: 3,
    hasMore: false,
    records: [{ type: 'event', event: userEvent(3, 1, 'x') }],
    assistantStream: { revision: 1 },
  });
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.records.length, 1);

  const chunk = parseFollowFrame({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 10, chunk: { type: 'text-delta', index: 0, text: '你' } },
  });
  assert.equal(chunk.type, 'assistant-stream');
  assert.equal(chunk.frame.chunk.text, '你');

  assert.throws(() => parseFollowFrame({ type: 'event', event: { type: 'user/message', time: 1 } }), /跟随帧结构不合法/);
  assert.throws(() => parseFollowFrame({ type: 'unknown' }), /跟随帧结构不合法/);
});

test('流式片段逐段追加，落盘内容与累积一致时记为 consistent', () => {
  const stream = new ConversationStream({ source: 'local', now: () => 1_000 });
  stream.apply({
    type: 'snapshot',
    cursor: 0,
    hasMore: false,
    records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } } }],
  });
  assert.equal(stream.apply({
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'attempt-1', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
  }), 'applied');
  for (const [index, text] of ['逐', '段', '追加'].entries()) {
    const outcome = stream.apply({
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index, time: 1_001 + index, chunk: { type: 'text-delta', index, text } },
    });
    assert.equal(outcome, 'applied');
  }
  const live = stream.snapshot();
  assert.equal(live.status, 'streaming');
  assert.equal(live.live.attemptId, 'attempt-1');
  assert.equal(segmentsText(live.live.segments), '逐段追加');
  assert.equal(live.counters.chunks, 3);

  assert.equal(stream.apply({
    type: 'assistant-stream',
    frame: { type: 'end', attemptId: 'attempt-1', revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
  }), 'applied');
  assert.equal(stream.apply({
    type: 'event',
    event: assistantEvent(1, 1_010, [{ type: 'text', text: '逐段追加' }]),
  }), 'applied');
  assert.equal(stream.reconcile.outcome, 'consistent');
  assert.equal(stream.reconcile.liveChars, 4);
  assert.equal(stream.reconcile.finalChars, 4);
  const final = stream.snapshot();
  assert.equal(final.status, 'completed');
  assert.equal(final.live, undefined);
  assert.equal(final.messages.length, 1);
  assert.equal(segmentsText(final.messages[0].segments), '逐段追加');
});

test('落盘内容以累积开头时记为 appended，内容被改写时记为 reconciled', () => {
  const appended = new ConversationStream({ source: 'local' });
  appended.apply({ type: 'snapshot', cursor: 0, hasMore: false, records: [] });
  appended.apply({
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'attempt-a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
  });
  appended.apply({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-a', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '前' } },
  });
  appended.apply({
    type: 'assistant-stream',
    frame: { type: 'end', attemptId: 'attempt-a', revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
  });
  appended.apply({ type: 'event', event: assistantEvent(1, 2, [{ type: 'text', text: '前后' }]) });
  assert.equal(appended.reconcile.outcome, 'appended');

  const rewritten = new ConversationStream({ source: 'local' });
  rewritten.apply({ type: 'snapshot', cursor: 0, hasMore: false, records: [] });
  rewritten.apply({
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'attempt-b', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
  });
  rewritten.apply({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-b', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '旧' } },
  });
  rewritten.apply({
    type: 'assistant-stream',
    frame: { type: 'end', attemptId: 'attempt-b', revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
  });
  rewritten.apply({ type: 'event', event: assistantEvent(1, 2, [{ type: 'text', text: '新' }]) });
  assert.equal(rewritten.reconcile.outcome, 'reconciled');
  assert.equal(rewritten.snapshot().counters.mismatches, 1);
  assert.equal(segmentsText(rewritten.snapshot().messages[0].segments), '新');
});

test('迟到片段、重复序号与序号缺口分别丢弃并计数', () => {
  const stream = new ConversationStream({ source: 'local' });
  stream.apply({
    type: 'snapshot',
    cursor: 2,
    hasMore: false,
    records: [
      { type: 'event', event: userEvent(1, 1, '一') },
      { type: 'event', event: userEvent(2, 2, '二') },
    ],
  });
  stream.apply({
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'attempt-c', revision: 2, startedAfterSeq: 2, turn: 1, step: 1 },
  });
  stream.apply({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-c', revision: 2, index: 0, time: 3, chunk: { type: 'text-delta', index: 0, text: '甲' } },
  });
  // 更旧的修订号、重复的片段序号、尝试结束之后到达的片段都被丢弃。
  assert.equal(stream.apply({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-c', revision: 1, index: 1, time: 4, chunk: { type: 'text-delta', index: 1, text: '乙' } },
  }), 'late');
  assert.equal(stream.apply({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-c', revision: 2, index: 0, time: 4, chunk: { type: 'text-delta', index: 0, text: '乙' } },
  }), 'late');
  assert.equal(stream.apply({
    type: 'assistant-stream',
    frame: { type: 'end', attemptId: 'attempt-c', revision: 2, index: 0, outcome: { kind: 'abandoned' } },
  }), 'applied');
  assert.equal(stream.apply({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-c', revision: 2, index: 1, time: 5, chunk: { type: 'text-delta', index: 1, text: '丙' } },
  }), 'late');
  assert.equal(stream.snapshot().counters.lateChunks, 3);
  assert.equal(stream.snapshot().status, 'interrupted');

  // 重复序号按重复丢弃；跳过序号时要求重新订阅。
  assert.equal(stream.apply({ type: 'event', event: userEvent(2, 2, '二') }), 'duplicate');
  assert.equal(stream.apply({ type: 'event', event: userEvent(5, 5, '五') }), 'gap');
  assert.equal(stream.snapshot().counters.duplicates, 1);
  assert.equal(stream.snapshot().counters.gaps, 1);
  assert.equal(stream.apply({ type: 'event', event: userEvent(3, 3, '三') }), 'applied');
  assert.equal(stream.snapshot().messages.length, 3);
});

test('断线冻结接收，恢复只恢复读取', () => {
  const stream = new ConversationStream({ source: 'local' });
  stream.apply({ type: 'snapshot', cursor: 0, hasMore: false, records: [] });
  stream.suspend('connection-error');
  assert.equal(stream.isSuspended, true);
  assert.equal(stream.currentStatus, 'interrupted');
  assert.equal(stream.apply({ type: 'event', event: userEvent(1, 1, '离线期间') }), 'suspended');
  assert.equal(stream.snapshot().messages.length, 0);

  // 恢复后的打开窗口重建状态，读取恢复；装配器本身不发送任何内容。
  assert.equal(stream.apply({
    type: 'snapshot',
    cursor: 1,
    hasMore: false,
    records: [{ type: 'event', event: userEvent(1, 1, '离线期间') }],
  }), 'applied');
  assert.equal(stream.isSuspended, false);
  assert.equal(stream.snapshot().messages.length, 1);
  const resumed = stream.resume();
  assert.equal(resumed.cursor, 1);
  assert.equal(resumed.status, 'idle', '恢复只恢复读取，没有输出在进行');
});

test('准确停止只作用于当前运行，确认之后丢弃该尝试的迟到片段', () => {
  const run = new ActiveRun({ now: () => 100 });
  run.begin({ runId: 'run-1', attemptId: 'attempt-1' });
  assert.equal(run.runState, 'running');
  const request = run.requestStop('operation-1');
  assert.equal(request.runId, 'run-1');
  assert.equal(run.runState, 'stopping');
  // 重复点击共享同一个操作标识。
  assert.deepEqual(run.requestStop('operation-1'), request);

  // 上一次运行的迟到应答被丢弃。
  const stale = run.acknowledge({ outcome: 'stopped', runId: 'run-0' });
  assert.equal(stale.applied, false);
  assert.equal(run.runState, 'stopping');

  const unconfirmed = run.acknowledge({ outcome: 'unconfirmed', code: 'timeout' });
  assert.equal(unconfirmed.applied, true);
  assert.equal(run.runState, 'stop-unconfirmed');
  assert.notEqual(run.runState, 'stopped', '未确认时不能显示已停止');

  const stopped = run.acknowledge({ outcome: 'stopped', runId: 'run-1' });
  assert.equal(stopped.applied, true);
  assert.equal(run.runState, 'stopped');
  assert.equal(run.discardedAttempt, 'attempt-1');
  assert.equal(run.isLateFragment('attempt-1'), true);
  assert.equal(run.isLateFragment('attempt-2'), false);

  const stream = new ConversationStream({ source: 'local' });
  stream.discardAttempt('attempt-1');
  assert.equal(stream.apply({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '迟到' } },
  }), 'late');

  // 新运行开始后，停止状态与丢弃标记清空。
  run.begin({ runId: 'run-2', attemptId: 'attempt-2' });
  assert.equal(run.runState, 'running');
  assert.equal(run.isLateFragment('attempt-1'), false);

  const rejected = run.acknowledge({ outcome: 'rejected', runId: 'run-2', code: 'not-cancellable' });
  assert.equal(rejected.applied, true);
  assert.equal(run.runState, 'stop-failed');
  assert.equal(run.code, 'not-cancellable');
  run.end('run-2');
  assert.equal(run.runState, 'idle');
});

test('长会话分段渲染与滚动位置保持', () => {
  const window = latestWindow(120, 40);
  assert.deepEqual(window, { startIndex: 80, endIndex: 119, hasOlder: true, hasNewer: false });
  const older = extendOlder(window, 40);
  assert.deepEqual(older, { startIndex: 40, endIndex: 119, hasOlder: true, hasNewer: false });
  const oldest = extendOlder(older, 40);
  assert.equal(oldest.startIndex, 0);
  assert.equal(oldest.hasOlder, false);
  const newer = extendNewer({ startIndex: 0, endIndex: 39, hasOlder: false, hasNewer: true }, 120, 40);
  assert.deepEqual(newer, { startIndex: 0, endIndex: 79, hasOlder: false, hasNewer: true });
  assert.deepEqual(latestWindow(0, 40), { startIndex: -1, endIndex: -1, hasOlder: false, hasNewer: false });

  // 视口顶部在第三条消息上，翻页之后按同一锚点恢复。
  const boxes = [
    { id: 'm1', offsetTop: 0, offsetHeight: 100 },
    { id: 'm2', offsetTop: 100, offsetHeight: 100 },
    { id: 'm3', offsetTop: 200, offsetHeight: 100 },
  ];
  const anchor = captureAnchor({ scrollTop: 150, scrollHeight: 900, clientHeight: 300 }, boxes);
  assert.deepEqual(anchor, { messageId: 'm2', offsetPx: -50 });
  const afterPrepend = [
    { id: 'm0', offsetTop: 0, offsetHeight: 80 },
    { id: 'm1', offsetTop: 80, offsetHeight: 100 },
    { id: 'm2', offsetTop: 180, offsetHeight: 100 },
    { id: 'm3', offsetTop: 280, offsetHeight: 100 },
  ];
  assert.equal(restoreScroll(anchor, afterPrepend), 230);
  assert.equal(restoreScroll(anchor, [{ id: 'm3', offsetTop: 0, offsetHeight: 100 }]), undefined);

  assert.equal(shouldAutoFollow({ scrollTop: 600, scrollHeight: 900, clientHeight: 300 }), true);
  assert.equal(shouldAutoFollow({ scrollTop: 100, scrollHeight: 900, clientHeight: 300 }), false);
  assert.equal(shouldAutoFollow({ scrollTop: 600, scrollHeight: 900, clientHeight: 300 }, { paused: true }), false);
  assert.equal(newMessagesLabel(0), undefined);
  assert.equal(newMessagesLabel(3), '3 条新消息');
});

test('消息反馈：赞、踩带原因与说明、失败保留输入、复制结果', async () => {
  const submitted = [];
  const board = new FeedbackBoard({
    submit: async (input) => {
      submitted.push(input);
      return { accepted: input.note !== '失败' };
    },
    createOperationId: () => 'operation-feedback',
    now: () => 500,
    clipboard: { writeText: async (text) => { board.copiedText = text; } },
  });
  assert.equal(board.stateOf('message-1').status, 'idle');
  const liked = board.rate('message-1', 'like');
  assert.equal(liked.rating, 'like');
  assert.equal(liked.status, 'idle');
  assert.throws(() => board.rate('message-1', 'like', 'incorrect'), /赞不携带原因/);

  const submittedState = await board.submit('message-1');
  assert.equal(submittedState.status, 'submitted');
  assert.equal(submittedState.operationId, 'operation-feedback');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].rating, 'like');
  // 已提交之后重复提交不再写入。
  await board.submit('message-1');
  assert.equal(submitted.length, 1);

  board.rate('message-2', 'dislike', 'incorrect', '失败');
  const failed = await board.submit('message-2');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'incorrect');
  assert.equal(failed.note, '失败', '失败保留已经填写的说明');

  const copied = await board.copy('message-3', '正文');
  assert.equal(copied.outcome, 'copied');
  assert.equal(board.copiedText, '正文');
  assert.equal(board.copiedAt('message-3'), 500);

  const rejecting = new FeedbackBoard({
    submit: async () => ({ accepted: true }),
    createOperationId: () => 'operation-2',
    clipboard: { writeText: async () => { throw new Error('拒绝写入'); } },
  });
  const rejectedCopy = await rejecting.copy('message-4', '正文');
  assert.equal(rejectedCopy.outcome, 'failed');
  assert.match(rejectedCopy.detail, /手动选择/);
  assert.equal((await rejecting.copy('message-4', '')).outcome, 'failed');
});
