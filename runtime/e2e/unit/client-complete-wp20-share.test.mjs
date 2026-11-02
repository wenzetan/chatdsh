// WP20 分享面板的纯逻辑验收：回合边界、附件候选、状态结论、占用统计与错误说明。
//
// 函数来自 `packages/client/share/lib/client/share.js` 与 `.../gateway.js`，输入是控制平面
// 真实返回的形状。这里逐项核对界面渲染之前的判定规则，不涉及网络、浏览器与存储。
//
// 运行：node --test e2e/unit/client-complete-wp20-share.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentCandidatesOf,
  availabilityOf,
  describeBytes,
  describeExpiry,
  describeExpiryAt,
  describeRangeMode,
  describeTurns,
  formatBytes,
  shareUrlOf,
  statsOf,
  statusOf,
  textOf,
  turnRangesOf,
  validateReplicaEvents,
} from '../../packages/client/share/lib/client/share.js';
import { describeFailure, ShareCallError } from '../../packages/client/share/lib/client/gateway.js';

/** 一条副本事件。 */
function eventOf(seq, kind, time, data) {
  return { seq, kind, time, bytes: 64, payload: { seq, type: kind, time, data } };
}

/** 两个完整回合加一个进行中的三回合会话。 */
function sessionEvents() {
  return [
    eventOf(0, 'session/title', 1, { title: '分享验收会话' }),
    eventOf(1, 'turn/start', 2, { turn: 1 }),
    eventOf(2, 'user/message', 3, { content: [{ type: 'text', text: '第一回合的问题' }] }),
    eventOf(3, 'assistant/message', 4, { message: { content: [{ type: 'text', text: '第一回合的回答' }] } }),
    eventOf(4, 'turn/end', 5, { turn: 1 }),
    eventOf(5, 'turn/start', 6, { turn: 2 }),
    eventOf(6, 'user/message', 7, {
      content: [
        { type: 'text', text: '第二回合的提问' },
        { type: 'file', attachment: { attachmentId: 'attach-one', filename: '报告.txt', mimeType: 'text/plain', size: 42 } },
      ],
    }),
    eventOf(7, 'assistant/message', 8, { message: { content: [{ type: 'text', text: '第二回合的回答' }] } }),
    eventOf(8, 'turn/end', 9, { turn: 2 }),
    eventOf(9, 'turn/start', 10, { turn: 3 }),
    eventOf(10, 'user/message', 11, { content: [{ type: 'text', text: '第三回合的提问' }] }),
    eventOf(11, 'assistant/message', 12, { message: { content: [{ type: 'text', text: '第三回合的回答' }] } }),
  ];
}

/** 一条分享记录的基准形状。 */
function recordOf(overrides = {}) {
  return {
    shareId: 'share-token-0123456789',
    sourceSessionId: 'session-alpha',
    title: '分享验收会话',
    scope: { turnFrom: 1, turnTo: 2, eventCount: 9, charCount: 120, compressed: false, attachmentsComplete: true },
    status: 'active',
    createdAt: 1_700_000_000_000,
    visits: 3,
    bytes: 4096,
    path: '/s/share-token-0123456789',
    ...overrides,
  };
}

test('回合范围：编号与宿主一致，进行中的回合不进分享', () => {
  const turns = turnRangesOf(sessionEvents());
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2, 3]);
  assert.deepEqual(turns.map((turn) => [turn.startSeq, turn.endSeq]), [[1, 4], [5, 8], [9, 11]]);
  assert.deepEqual(turns.map((turn) => turn.complete), [true, true, false]);
  assert.equal(turns[0]?.assistantCount, 1);
  assert.equal(turns[0]?.userText, '第一回合的问题');
  assert.equal(turns[1]?.endedAt, 9);
  assert.equal(turns[2]?.endedAt, undefined, '没有结束事件的回合没有结束时刻');

  // 缺少 data.turn 时按上一个回合加一，与宿主侧的回合索引一致。
  const implicit = turnRangesOf([
    eventOf(0, 'turn/start', 1, {}),
    eventOf(1, 'user/message', 2, { content: [{ type: 'text', text: '甲' }] }),
    eventOf(2, 'turn/end', 3, {}),
    eventOf(3, 'turn/start', 4, {}),
    eventOf(4, 'turn/end', 5, {}),
  ]);
  assert.deepEqual(implicit.map((turn) => turn.turn), [1, 2]);
  assert.deepEqual(implicit.map((turn) => turn.complete), [true, true]);

  // 没有回合边界的会话按一个回合处理。
  const whole = turnRangesOf([
    eventOf(0, 'user/message', 1, { content: [{ type: 'text', text: '甲' }] }),
    eventOf(1, 'assistant/message', 2, { message: { content: [{ type: 'text', text: '乙' }] } }),
  ]);
  assert.equal(whole.length, 1);
  assert.equal(whole[0]?.turn, 1);
  assert.equal(whole[0]?.complete, true);
  assert.deepEqual(turnRangesOf([]), []);
});

test('附件候选：只收合法标识，按首次出现去重并保留元数据', () => {
  const candidates = attachmentCandidatesOf(sessionEvents());
  assert.deepEqual(candidates, [{ id: 'attach-one', filename: '报告.txt', mimeType: 'text/plain', size: 42 }]);

  const mixed = attachmentCandidatesOf([
    eventOf(0, 'user/message', 1, {
      content: [
        { type: 'file', attachment: { attachmentId: 'attach-a', filename: '甲.txt' } },
        { type: 'image', attachment: { attachmentId: 'attach-a', filename: '甲.png', size: 8 } },
        { type: 'file', attachment: { attachmentId: '不合法标识', filename: '乙.txt' } },
        { type: 'text', text: '没有附件' },
      ],
      attachments: [{ id: 'attach-b', filename: '丙.txt' }],
    }),
    eventOf(1, 'assistant/message', 2, { message: { content: [{ type: 'attachment', id: 'attach-c' }] } }),
  ]);
  assert.deepEqual(mixed.map((candidate) => candidate.id), ['attach-a', 'attach-b', 'attach-c']);
  assert.equal(mixed[0]?.filename, '甲.txt', '同一条附件保留首次读到的元数据');
  assert.equal(mixed[2]?.filename, 'attach-c', '没有文件名时用标识充当名称');
});

test('记录结论：有效、失效、副本缺失与缺少路径分别给出可访问结论', () => {
  const now = 1_700_000_100_000;
  const active = recordOf();
  assert.equal(statusOf(active, now), 'active');
  assert.equal(availabilityOf(active, now).linkable, true);
  assert.equal(availabilityOf(active, now).kind, 'active');

  const revoked = recordOf({ revokedAt: now - 1000, path: undefined });
  assert.equal(statusOf(revoked, now), 'revoked');
  const revokedAvailability = availabilityOf(revoked, now);
  assert.equal(revokedAvailability.linkable, false);
  assert.match(revokedAvailability.detail, /撤销/);

  const expired = recordOf({ expiresAt: now - 1, path: undefined });
  assert.equal(statusOf(expired, now), 'expired');
  assert.equal(availabilityOf(expired, now).linkable, false);
  assert.match(availabilityOf(expired, now).detail, /过期/);

  const missingContent = recordOf({ bytes: 0 });
  assert.equal(availabilityOf(missingContent, now).kind, 'missing-content');
  assert.equal(availabilityOf(missingContent, now).linkable, false);

  const missingPackage = recordOf({
    scope: { turnFrom: 1, turnTo: 2, eventCount: 9, charCount: 120, compressed: false, attachmentsComplete: false },
  });
  assert.equal(availabilityOf(missingPackage, now).kind, 'missing-package');
  assert.equal(availabilityOf(missingPackage, now).linkable, false);
  assert.match(availabilityOf(missingPackage, now).detail, /附件副本/);

  const noPath = recordOf({ path: undefined });
  assert.equal(availabilityOf(noPath, now).kind, 'no-path');
  assert.equal(availabilityOf(noPath, now).linkable, false);
});

test('总量统计：条数、可访问条数、访问次数与占用字节', () => {
  const now = 1_700_000_100_000;
  const records = [
    recordOf({ shareId: 'a', visits: 3, bytes: 1000 }),
    recordOf({ shareId: 'b', visits: 2, bytes: 2048, expiresAt: now - 1, path: undefined }),
    recordOf({ shareId: 'c', visits: 5, bytes: 0 }),
  ];
  assert.deepEqual(statsOf(records, 3048, now), { count: 3, active: 1, visits: 10, bytes: 3048 });
  assert.deepEqual(statsOf([], 0, now), { count: 0, active: 0, visits: 0, bytes: 0 });
});

test('范围与占用的展示文字', () => {
  assert.equal(describeTurns([1]), '回合 1');
  assert.equal(describeTurns([1, 2, 3]), '回合 1 至 3（共 3 个）');
  assert.equal(describeTurns([1, 3]), '回合 1、3（共 2 个）');
  assert.equal(describeTurns([]), '没有回合');
  assert.equal(describeRangeMode({ mode: 'session' }), '会话全部（截止建立分享时的副本水位）');
  assert.match(describeRangeMode({ mode: 'turns', turns: [2] }), /指定回合集合：回合 2/);
  assert.match(describeRangeMode({ mode: 'range', turnFrom: 1, turnTo: 3 }), /完整回合边界：回合 1 至 3/);
  assert.equal(describeRangeMode({ mode: 'range', turnFrom: 2, turnTo: 2 }), '完整回合边界：回合 2');
  assert.match(describeRangeMode({ mode: 'bound', upToSeq: 9 }), /截止上界/);

  assert.equal(formatBytes(0), '0 字节');
  assert.equal(formatBytes(1023), '1023 字节');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 * 2), '2.0 MB');
  assert.equal(describeBytes(512), '512 字节');
  assert.equal(describeBytes(2048), '2.0 KB（2048 字节）');
  assert.throws(() => formatBytes(-1), /非负有限数值/);
  assert.throws(() => formatBytes(Number.NaN), /非负有限数值/);
});

test('有效期文字：不设期限、剩余时间与已过期', () => {
  const now = 1_700_000_000_000;
  assert.equal(describeExpiryAt(undefined, now), '不过期');
  assert.match(describeExpiryAt(now + 30 * 60_000, now), /^30 分钟后过期/);
  assert.match(describeExpiryAt(now + 5 * 60 * 60_000, now), /^5 小时后过期/);
  assert.match(describeExpiryAt(now + 3 * 24 * 60 * 60_000, now), /^3 天后过期/);
  assert.match(describeExpiryAt(now - 1, now), /过期/);
  assert.match(describeExpiry(recordOf({ expiresAt: now + 60_000 }), now), /分钟后过期/);
  assert.match(describeExpiry(recordOf({ revokedAt: now }), now), /已于 .* 撤销/);
});

test('公开地址：只接受 http 与 https，路径原样拼接', () => {
  assert.equal(shareUrlOf('http://127.0.0.1:3170', '/s/abc'), 'http://127.0.0.1:3170/s/abc');
  assert.equal(shareUrlOf('https://example.test', 's/abc'), 'https://example.test/s/abc');
  assert.throws(() => shareUrlOf('ftp://127.0.0.1', '/s/abc'), /分享地址需要 http 或 https/);
});

test('错误说明：控制平面的错误码与具体条件翻译成界面文字', () => {
  assert.match(describeFailure('request-invalid', 400, 'turn-unknown'), /所选回合不在这个会话里/);
  assert.match(describeFailure('request-invalid', 400, 'attachment-missing'), /所选附件在源设备上已经不存在/);
  assert.match(describeFailure('request-invalid', 400, 'text-selection'), /至少要公开用户消息或助手消息中的一种/);
  assert.match(describeFailure('session-not-found', 404), /没有可读副本/);
  assert.match(describeFailure('auth-required', 401), /访问校验/);
  assert.match(describeFailure('share-unavailable', 410), /已经撤销或过期/);
  assert.match(describeFailure('share-unavailable', 404), /链接不存在/);
  assert.match(describeFailure('payload-too-large', 413), /超过上限/);
  assert.match(describeFailure('unknown-code', 0), /请求失败（unknown-code）/);
  assert.match(describeFailure('unknown-code', 500), /HTTP 500/);

  const error = new ShareCallError('request-invalid', '请求内容不合法', 400, 'turn-unknown');
  assert.equal(error.code, 'request-invalid');
  assert.equal(error.reason, 'turn-unknown');
  assert.equal(error.status, 400);
  assert.equal(error.name, 'ShareCallError');
});

test('副本校验：形状不合法的记录逐条给出原因', () => {
  const good = sessionEvents();
  const ok = validateReplicaEvents(good);
  assert.equal(ok.ok, true);
  assert.equal(ok.events.length, good.length);
  assert.equal(ok.turns, 3);
  assert.ok(ok.characters > 0);

  assert.deepEqual(validateReplicaEvents('不是数组').failures[0], {
    index: -1,
    code: 'events-not-array',
    message: '副本事件不是数组，无法导入',
  });
  assert.ok(validateReplicaEvents([null]).failures.some((item) => item.code === 'event-not-object'));

  const outOfOrder = validateReplicaEvents([eventOf(2, 'user/message', 1, {}), eventOf(1, 'user/message', 2, {})]);
  assert.equal(outOfOrder.ok, false);
  assert.ok(outOfOrder.failures.some((item) => item.code === 'seq-order'));

  const badSeq = validateReplicaEvents([{ seq: -1, kind: 'user/message', time: 1 }]);
  assert.ok(badSeq.failures.some((item) => item.code === 'seq-invalid'));

  const badKind = validateReplicaEvents([{ seq: 1, kind: '', time: 1 }]);
  assert.ok(badKind.failures.some((item) => item.code === 'kind-invalid'));

  const badTime = validateReplicaEvents([{ seq: 1, kind: 'user/message', time: Number.POSITIVE_INFINITY }]);
  assert.ok(badTime.failures.some((item) => item.code === 'time-invalid'));

  const mismatch = validateReplicaEvents([{ seq: 1, kind: 'user/message', time: 1, payload: { type: 'assistant/message' } }]);
  assert.ok(mismatch.failures.some((item) => item.code === 'payload-type-mismatch'));

  const badPayload = validateReplicaEvents([{ seq: 1, kind: 'user/message', time: 1, payload: '文本' }]);
  assert.ok(badPayload.failures.some((item) => item.code === 'payload-invalid'));
});

test('消息文本：只取文本片段，忽略其它片段', () => {
  assert.equal(textOf(eventOf(0, 'user/message', 1, { content: [{ type: 'text', text: '甲' }, { type: 'image', url: 'x' }, { type: 'text', text: '乙' }] })), '甲乙');
  assert.equal(textOf(eventOf(0, 'assistant/message', 1, { text: '直接文本' })), '直接文本');
  assert.equal(textOf(eventOf(0, 'user/message', 1, {})), '');
  assert.equal(textOf({ seq: 0, kind: 'user/message', time: 1 }), '');
});
