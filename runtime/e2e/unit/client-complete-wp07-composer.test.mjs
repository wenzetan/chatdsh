// WP07 组合输入、引用对象与在线队列的真实函数测试。
//
// 输入区状态机、引用范围维护与队列全部走包内导出的真实实现；队列的提交与状态查询由测试提供
// 的真实函数充当服务端，记录每次调用，用来断言「只提交一次」「恢复不自动发送」「按标识查询
// 不重复提交」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_STATE_TEXT,
  Composer,
  PendingQueue,
  SEND_BLOCKER_TEXT,
  describeReference,
  referenceToken,
  toDraftReferences,
} from '../../packages/client/conversation/lib/index.js';

/** 一个可引用的文件条目。 */
const FILE_CANDIDATE = { id: 'src/index.ts', kind: 'file', label: 'index.ts', group: '文件', origin: 'local' };
/** 一个可引用的会话条目。 */
const SESSION_CANDIDATE = { id: 'session-b', kind: 'session', label: '会话乙', group: '会话', origin: 'remote' };
/** 一个记忆条目。 */
const MEMORY_CANDIDATE = { id: 'memory-1', kind: 'memory', label: '偏好记忆', group: '记忆', origin: 'local' };

/** 构造一次按键事件。 */
function key(name, extra = {}) {
  return { key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra };
}

test('输入法组合期间不提交，组合结束才更新正文与字数', () => {
  const composer = new Composer({ maxLength: 100 });
  composer.insert('你好');
  assert.equal(composer.value, '你好');
  assert.equal(composer.lengthReport().length, 2);

  composer.compositionStart();
  composer.compositionUpdate('n');
  composer.compositionUpdate('ni');
  composer.compositionUpdate('你');
  assert.equal(composer.value, '你好', '组合中的文本不进入正文');
  assert.equal(composer.lengthReport().length, 2, '组合中的文本不计入字数');
  assert.equal(composer.state.composing, true);
  assert.equal(composer.state.compositionBuffer, '你');
  assert.equal(composer.keyIntent(key('Enter')), 'none', '组合中 Enter 不发送');
  assert.equal(composer.keyIntent(key('Enter', { isComposing: true })), 'none');
  assert.equal(composer.keyIntent(key('Escape')), 'none', '组合中 Escape 不中断');
  assert.equal(composer.keyIntent(key('Enter', { keyCode: 229 })), 'none');

  composer.compositionEnd('你');
  assert.equal(composer.state.composing, false);
  assert.equal(composer.value, '你好你');
  assert.equal(composer.lengthReport().length, 3);
  assert.equal(composer.keyIntent(key('Enter')), 'send', '组合结束后 Enter 才发送');
});

test('快捷键：Enter 发送、Shift+Enter 换行、Escape 中断、斜杠与引用触发', () => {
  const composer = new Composer();
  assert.equal(composer.keyIntent(key('Enter')), 'send');
  assert.equal(composer.keyIntent(key('Enter', { shiftKey: true })), 'newline');
  assert.equal(composer.keyIntent(key('Escape')), 'interrupt');
  assert.equal(composer.keyIntent(key('Enter', { ctrlKey: true })), 'none');
  assert.equal(composer.keyIntent(key('Enter', { metaKey: true })), 'none');
  assert.equal(composer.keyIntent(key('/')), 'trigger-command', '行首斜杠触发命令面板');
  assert.equal(composer.keyIntent(key('@')), 'trigger-reference', '行首 @ 触发引用面板');

  composer.insert('看这里');
  assert.equal(composer.keyIntent(key('/')), 'none', '正文中间的斜杠不触发');
  composer.insert(' ');
  assert.equal(composer.keyIntent(key('/')), 'trigger-command', '空白之后的斜杠触发');
  composer.insert('a@b');
  assert.equal(composer.keyIntent(key('@')), 'none', '邮箱地址里的 @ 不触发');
});

test('字数与附件条目：超限与未完成上传都阻止发送', () => {
  const composer = new Composer({ maxLength: 5 });
  composer.insert('一二三四五');
  assert.deepEqual(composer.lengthReport(), { length: 5, max: 5, remaining: 0, exceeded: false });
  assert.equal(composer.sendCheck().canSend, true);
  composer.insert('六');
  assert.equal(composer.lengthReport().exceeded, true);
  const tooLong = composer.sendCheck();
  assert.equal(tooLong.canSend, false);
  assert.deepEqual(tooLong.blockers, ['too-long']);
  assert.equal(tooLong.reason, SEND_BLOCKER_TEXT['too-long']);

  const withAttachment = new Composer({ maxLength: 100 });
  assert.equal(withAttachment.sendCheck().blockers[0], 'empty', '空白且没有附件时不能发送');
  const slot = withAttachment.attach({ filename: 'a.txt', mimeType: 'text/plain', size: 12 });
  assert.equal(slot.state, 'uploading');
  assert.equal(withAttachment.sendCheck().canSend, false);
  assert.deepEqual(withAttachment.sendCheck().blockers, ['attachment-pending']);
  assert.equal(ATTACHMENT_STATE_TEXT.uploading, '正在上传');
  withAttachment.updateAttachment(slot.id, { state: 'uploaded', progress: 1 });
  assert.equal(withAttachment.sendCheck().canSend, true, '上传完成之后可以发送');
  withAttachment.updateAttachment(slot.id, { state: 'failed' });
  assert.equal(withAttachment.sendCheck().canSend, false);
  withAttachment.removeAttachment(slot.id);
  assert.equal(withAttachment.sendCheck().blockers[0], 'empty');
  assert.throws(() => withAttachment.updateAttachment('missing', { progress: 1 }), /附件条目不存在/);
  assert.throws(() => withAttachment.attach({ filename: '', mimeType: 'text/plain', size: 1 }), /附件文件名不能为空/);
});

test('引用对象是独立可删除对象，撤销恢复对象边界', () => {
  const composer = new Composer();
  composer.insert('看 ');
  const reference = composer.insertReference(FILE_CANDIDATE);
  assert.equal(composer.value, `看 ${referenceToken('index.ts')}`);
  assert.equal(reference.spanStart, 2);
  assert.equal(reference.spanEnd, 2 + referenceToken('index.ts').length);
  assert.equal(composer.state.selectionStart, reference.spanEnd);

  // 光标在标记末尾时退格整条删除引用。
  composer.setSelection(reference.spanEnd);
  assert.equal(composer.deleteBackward(), true);
  assert.equal(composer.value, '看 ');
  assert.equal(composer.state.references.length, 0);

  assert.equal(composer.undo(), true);
  assert.equal(composer.value, `看 ${referenceToken('index.ts')}`);
  assert.equal(composer.state.references.length, 1, '撤销恢复引用对象');
  assert.equal(composer.state.references[0].spanStart, 2);

  // 在标记之前插入文本时，引用范围整体后移。
  composer.setSelection(0);
  composer.insert('先');
  assert.equal(composer.state.references[0].spanStart, 3);
  assert.equal(composer.state.references[0].spanEnd, 3 + referenceToken('index.ts').length);

  // 删除区间覆盖引用时整条对象一起删除。
  composer.replaceRange(0, composer.value.length, '');
  assert.equal(composer.state.references.length, 0);
  assert.equal(composer.value, '');

  composer.insert('x');
  composer.insertReference(SESSION_CANDIDATE);
  assert.throws(() => composer.insertReference(SESSION_CANDIDATE), /已经在输入区里/);
  composer.removeReference(SESSION_CANDIDATE.id);
  assert.equal(composer.state.references.length, 0);
  assert.equal(composer.value, 'x');
});

test('引用失效标记保留对象，草稿丢弃记忆条目并报告原因', () => {
  const composer = new Composer();
  composer.insert('@');
  composer.insertReference(FILE_CANDIDATE);
  composer.insert(' ');
  composer.insertReference(MEMORY_CANDIDATE);

  const invalidated = composer.invalidateReferences([{ kind: 'file', id: 'src/index.ts', reason: 'deleted' }]);
  assert.equal(invalidated.length, 2, '文件被删除、记忆条目不在可用清单里');
  const file = composer.state.references.find((item) => item.kind === 'file');
  assert.equal(file.available, false);
  assert.equal(file.invalidReason, 'deleted');
  assert.match(describeReference(file), /文件失效：对象已删除/);
  const check = composer.sendCheck();
  assert.equal(check.canSend, false);
  assert.ok(check.blockers.includes('reference-invalid'));

  const draft = composer.snapshotForDraft();
  assert.equal(draft.references.length, 1, '草稿只保留草稿契约允许的种类');
  assert.equal(draft.references[0].kind, 'file');
  assert.equal(draft.dropped.length, 1);
  assert.equal(draft.dropped[0].kind, 'memory');
  assert.equal(draft.dropped[0].reason, 'memory-content-not-persisted');

  const restored = new Composer();
  const outcome = restored.restoreDraft({
    text: draft.text,
    references: draft.references,
    attachments: [{ id: 'attachment-1', filename: 'a.txt', mimeType: 'text/plain', size: 3, needsReselect: true }],
  });
  assert.equal(outcome.references.length, 1);
  assert.equal(outcome.references[0].spanStart, 1);
  assert.equal(outcome.needsReselect.length, 1);
  assert.equal(restored.state.attachments[0].state, 'needs-reselect');
  assert.equal(restored.sendCheck().canSend, false);

  const missingToken = new Composer();
  const withoutToken = missingToken.restoreDraft({
    text: '没有标记',
    references: [{ kind: 'file', id: 'src/index.ts', label: 'index.ts', available: true }],
    attachments: [],
  });
  assert.equal(withoutToken.references[0].available, false, '标记缺失时条目按失效处理');
  assert.equal(withoutToken.references[0].invalidReason, 'stale');
});

test('草稿只保存文本、引用与已确认附件', () => {
  const composer = new Composer();
  composer.insert('草稿正文');
  composer.insertReference(FILE_CANDIDATE);
  const uploading = composer.attach({ filename: 'up.txt', mimeType: 'text/plain', size: 4 });
  const confirmed = composer.attach({ filename: 'done.txt', mimeType: 'text/plain', size: 8 });
  composer.updateAttachment(confirmed.id, { state: 'uploaded', progress: 1 });
  const draft = composer.snapshotForDraft();
  assert.equal(draft.text, '草稿正文@index.ts');
  assert.equal(draft.references.length, 1);
  assert.equal(draft.attachments.length, 1, '未上传完成的附件不进入草稿');
  assert.equal(draft.attachments[0].filename, 'done.txt');
  assert.equal(draft.attachments[0].needsReselect, false);
  assert.equal(uploading.state, 'uploading');

  const converted = toDraftReferences(composer.state.references);
  assert.equal(converted.persisted.length, 1);
  assert.deepEqual(converted.dropped, []);
});

test('队列按入队顺序消费，编辑与删除只作用于待发送条目', async () => {
  const submissions = [];
  const queue = new PendingQueue({
    submit: async (submission) => {
      submissions.push(submission);
      return { accepted: true, seq: submissions.length };
    },
    query: async () => ({ state: 'unknown' }),
    now: () => 1_000,
    createId: (() => {
      let index = 0;
      return () => `item-${String((index += 1))}`;
    })(),
  });
  const first = queue.enqueue({ sessionId: 'session-a', text: '第一条' });
  const second = queue.enqueue({ sessionId: 'session-a', text: '第二条' });
  assert.equal(queue.next().id, first.id, '先入队的先消费');

  const edited = queue.edit(second.id, '第二条改');
  assert.equal(edited.text, '第二条改');
  queue.remove(second.id);
  assert.deepEqual(queue.snapshot().items.map((item) => item.id), [first.id]);
  assert.throws(() => queue.edit('missing', 'x'), /队列条目不存在/);

  const sent = await queue.consume();
  assert.equal(sent.outcome, 'sent');
  assert.equal(sent.seq, 1);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].requestId, first.id, '提交的幂等键就是条目标识');
  assert.equal(queue.confirmedByRequestId(first.id).state, 'confirmed');
  assert.equal(queue.next(), undefined);
  assert.equal((await queue.consume()).outcome, 'empty');
});

test('暂停后不消费，恢复只重新读取状态、不自动发送', async () => {
  const submissions = [];
  let queryState = 'confirmed';
  const queue = new PendingQueue({
    submit: async (submission) => {
      submissions.push(submission);
      return { accepted: true, seq: 7 };
    },
    query: async (requestId) => ({ state: queryState, seq: requestId === 'item-1' ? 9 : undefined }),
    now: () => 1_000,
    createId: (() => {
      let index = 0;
      return () => `item-${String((index += 1))}`;
    })(),
  });
  queue.enqueue({ sessionId: 'session-a', text: '待发送' });
  queue.pause('连接中断');
  assert.equal(queue.isPaused, true);
  const paused = await queue.consume();
  assert.equal(paused.outcome, 'paused');
  assert.equal(submissions.length, 0, '暂停期间不发送');

  const resumed = await queue.resume();
  assert.equal(queue.isPaused, false);
  assert.equal(submissions.length, 0, '恢复不会自动发送');
  assert.equal(resumed.pending.length, 1);
  assert.equal(resumed.pending[0].state, 'pending');

  // 结果不确定的条目在恢复时按标识查询，确认过的直接落定。
  const uncertainQueue = new PendingQueue({
    submit: async () => {
      throw new Error('网络中断');
    },
    query: async () => ({ state: queryState, seq: 9 }),
    now: () => 1_000,
    createId: () => 'item-1',
  });
  uncertainQueue.enqueue({ sessionId: 'session-a', text: '结果不确定' });
  const unconfirmed = await uncertainQueue.consume();
  assert.equal(unconfirmed.outcome, 'unconfirmed');
  assert.equal(uncertainQueue.snapshot().items[0].state, 'unconfirmed');
  const afterResume = await uncertainQueue.resume();
  assert.equal(afterResume.confirmed.length, 1);
  assert.equal(uncertainQueue.confirmedByRequestId('item-1').state, 'confirmed');
  assert.equal(uncertainQueue.confirmedByRequestId('item-1').seq, 9);
});

test('结果不确定的条目先查询：服务端没收到就退回待发送，已确认就不重复提交', async () => {
  let queryState = 'pending';
  const submissions = [];
  const queue = new PendingQueue({
    submit: async (submission) => {
      submissions.push(submission);
      throw new Error('超时');
    },
    query: async () => ({ state: queryState }),
    now: () => 1_000,
    createId: () => 'item-1',
  });
  queue.enqueue({ sessionId: 'session-a', text: '重试' });
  assert.equal((await queue.consume()).outcome, 'unconfirmed');
  const requeued = await queue.resolveUnconfirmed('item-1');
  assert.equal(requeued.outcome, 'requeued');
  assert.equal(queue.snapshot().items[0].state, 'pending');
  assert.equal(submissions.length, 1);

  queryState = 'confirmed';
  assert.equal((await queue.consume()).outcome, 'unconfirmed');
  const already = await queue.resolveUnconfirmed('item-1');
  assert.equal(already.outcome, 'confirmed-already');
  assert.equal(submissions.length, 2, '查询确认之后不再提交');
});

test('同一条目重复消费共享进行中的提交，不重复写入', async () => {
  let calls = 0;
  let release;
  const queue = new PendingQueue({
    submit: async () => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return { accepted: true, seq: 1 };
    },
    query: async () => ({ state: 'unknown' }),
    now: () => 1_000,
    createId: () => 'item-1',
  });
  queue.enqueue({ sessionId: 'session-a', text: '并发' });
  const first = queue.consume();
  const second = queue.consume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(left.outcome, 'sent');
  assert.equal(right.outcome, 'sent');
  assert.equal(queue.snapshot().items[0].state, 'confirmed');
});
