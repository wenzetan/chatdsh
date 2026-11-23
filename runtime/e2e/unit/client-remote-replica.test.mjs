import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReplicaView,
  completeTurnOf,
  forkRecordsOf,
} from '../../packages/client/remote/lib/client/model.js';

function event(seq, kind, time, data) {
  return { seq, kind, time, payload: { type: kind, seq, time, data } };
}

function bareEvent(seq, kind, time, data) {
  return { seq, kind, time, payload: data };
}

const events = [
  event(0, 'turn/start', 1, { turn: 1 }),
  event(1, 'user/message', 2, { role: 'user', content: [{ type: 'text', text: 'hello' }] }),
  event(2, 'assistant/message', 3, { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
  event(3, 'tool/call', 4, { name: 'bash', arguments: '{"cmd":"ls"}', callId: 'c1' }),
  event(4, 'tool/result', 5, { message: { role: 'tool', content: [{ type: 'text', text: 'file' }], isError: true } }),
  event(5, 'approval/asked', 6, { toolName: 'bash', callId: 'c1', reason: 'needs approval' }),
  event(6, 'approval/decided', 7, { outcome: 'rejected' }),
  event(7, 'turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
  event(8, 'unknown/event', 9, {}),
];

test('副本事件按类型转成只读视图', () => {
  const view = buildReplicaView(events);
  assert.deepEqual(view.map((item) => item.kind), [
    'turn',
    'user',
    'assistant',
    'tool-call',
    'tool-result',
    'approval-asked',
    'approval-decided',
  ]);
  assert.equal(view[0].title, '1');
  assert.equal(view[1].text, 'hello');
  assert.equal(view[2].text, 'hi');
  assert.equal(view[3].title, 'bash');
  assert.equal(view[3].text, '{"cmd":"ls"}');
  assert.equal(view[3].detail, 'c1');
  assert.equal(view[4].failed, true);
  assert.equal(view[5].title, 'bash');
  assert.equal(view[5].text, 'needs approval');
  assert.equal(view[6].title, 'rejected');
  assert.equal(view[6].failed, true);
});

test('裸数据形状的副本事件按类型转成只读视图', () => {
  const view = buildReplicaView([
    bareEvent(0, 'turn/start', 1, { turn: 1 }),
    bareEvent(1, 'user/message', 2, { role: 'user', content: [{ type: 'text', text: 'hello' }] }),
    bareEvent(2, 'assistant/message', 3, { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    bareEvent(3, 'tool/call', 4, { name: 'bash', arguments: '{"cmd":"ls"}', callId: 'c1' }),
    bareEvent(4, 'tool/result', 5, { message: { role: 'tool', content: [{ type: 'text', text: 'file' }], isError: true } }),
    bareEvent(5, 'approval/asked', 6, { toolName: 'bash', callId: 'c1', reason: 'needs approval' }),
    bareEvent(6, 'approval/decided', 7, { outcome: 'rejected' }),
  ]);
  assert.deepEqual(view.map((item) => item.kind), [
    'turn',
    'user',
    'assistant',
    'tool-call',
    'tool-result',
    'approval-asked',
    'approval-decided',
  ]);
  assert.equal(view[0].title, '1');
  assert.equal(view[1].text, 'hello');
  assert.equal(view[2].text, 'hi');
  assert.equal(view[3].title, 'bash');
  assert.equal(view[3].text, '{"cmd":"ls"}');
  assert.equal(view[3].detail, 'c1');
  assert.equal(view[4].failed, true);
  assert.equal(view[5].title, 'bash');
  assert.equal(view[5].text, 'needs approval');
  assert.equal(view[6].title, 'rejected');
  assert.equal(view[6].failed, true);
});

test('副本事件按序号排序', () => {
  const view = buildReplicaView([events[2], events[1], events[0]]);
  assert.deepEqual(view.map((item) => item.seq), [0, 1, 2]);
});

test('找出最后一个完整回合', () => {
  assert.equal(completeTurnOf(events), 1);
  assert.equal(completeTurnOf(events.slice(0, 7)), 0);
  assert.equal(completeTurnOf([
    event(0, 'turn/end', 1, { turn: 3 }),
    event(1, 'turn/end', 2, { turn: 2 }),
  ]), 3);
});

test('裸数据形状也能找出最后一个完整回合', () => {
  assert.equal(completeTurnOf([
    bareEvent(0, 'turn/end', 1, { turn: 3 }),
    bareEvent(1, 'turn/end', 2, { turn: 2 }),
  ]), 3);
});

test('分叉记录保留完整事件信封', () => {
  const records = forkRecordsOf(events);
  assert.equal(records.length, events.length);
  assert.deepEqual(records[0], { seq: 0, kind: 'turn/start', time: 1, payload: events[0].payload });
  assert.equal(records[8].payload.type, 'unknown/event');
});
