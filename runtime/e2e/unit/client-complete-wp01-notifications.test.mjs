// 通知中心、已读状态与投递设置契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-notifications.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_DELIVERY_MODES,
  NOTIFICATION_FILTERS,
  NOTIFICATION_FIRST_STAGE_MAX_SECONDS,
  NOTIFICATION_KINDS,
  NOTIFICATION_SECOND_STAGE_MAX_SECONDS,
  notificationProbeSchema,
  notificationReadRequestSchema,
  notificationReadResultSchema,
  notificationSchema,
  notificationSettingsSchema,
  pushSubscriptionViewSchema,
} from '../../packages/core/contracts/lib/index.js';
import { assertNoWatermark, expectReject, roundtrip } from './client-complete-wp01-support.mjs';

const NOTIFICATION = {
  id: 'notification-1',
  kind: 'approval',
  title: '运行命令',
  deviceId: 'device-1',
  sessionId: 'session-1',
  objectId: 'call-1',
  createdAt: 1_700_000_000_000,
  tag: 'approval-call-1',
  revocable: true,
};

test('通知字段可以往返且不含内部水位', () => {
  const parsed = roundtrip(notificationSchema, NOTIFICATION, '通知');
  assert.equal(parsed.kind, 'approval');
  assertNoWatermark(parsed, '通知');
  assert.ok(NOTIFICATION_KINDS.includes('run-finished'));
  assert.ok(NOTIFICATION_FILTERS.includes('unread'));
});

test('通知的未知种类被拒绝', () => {
  expectReject(notificationSchema, { ...NOTIFICATION, kind: 'promotion' }, '未知的通知种类');
  expectReject(notificationSchema, { ...NOTIFICATION, createdAt: -1 }, '负的时间戳');
});

test('已读与已处理分别记录', () => {
  const read = roundtrip(
    notificationSchema,
    { ...NOTIFICATION, readAt: 1_700_000_100_000, handledAt: 1_700_000_200_000 },
    '已读且已处理的通知',
  );
  assert.equal(typeof read.readAt, 'number');
  assert.equal(typeof read.handledAt, 'number');
});

test('已读标记要求至少一个通知标识与客户端标识', () => {
  roundtrip(
    notificationReadRequestSchema,
    { ids: ['notification-1', 'notification-2'], clientId: 'client-1' },
    '已读标记请求',
  );
  expectReject(notificationReadRequestSchema, { ids: [], clientId: 'client-1' }, '空的已读标记');
  expectReject(notificationReadRequestSchema, { ids: ['notification-1'] }, '缺少客户端标识');
  const stripped = notificationReadRequestSchema.parse({ ids: ['notification-1'], clientId: 'client-1', extra: 1 });
  assert.equal('extra' in stripped, false, '未声明字段在解析结果里被剥离');
});

test('重复标记已读的结果区分新标记与未变化', () => {
  const first = roundtrip(notificationReadResultSchema, { marked: 2, unchanged: 0 }, '首次标记');
  const again = roundtrip(notificationReadResultSchema, { marked: 0, unchanged: 2 }, '重复标记');
  assert.equal(first.marked, 2);
  assert.equal(again.marked, 0);
});

test('两阶段投递要求第二阶段等待大于第一阶段', () => {
  const settings = roundtrip(
    notificationSettingsSchema,
    {
      deliveryMode: 'two-stage',
      firstStageSeconds: 30,
      secondStageSeconds: 120,
      onTurnEnd: true,
      onApproval: true,
      messagePreview: false,
      quietWhenFocused: true,
    },
    '两阶段通知设置',
  );
  assert.equal(settings.deliveryMode, 'two-stage');
  expectReject(
    notificationSettingsSchema,
    { ...settings, secondStageSeconds: 30 },
    '第二阶段等于第一阶段',
  );
  expectReject(
    notificationSettingsSchema,
    { ...settings, firstStageSeconds: NOTIFICATION_FIRST_STAGE_MAX_SECONDS + 1 },
    '第一阶段超过上限',
  );
  expectReject(
    notificationSettingsSchema,
    { ...settings, secondStageSeconds: NOTIFICATION_SECOND_STAGE_MAX_SECONDS + 1 },
    '第二阶段超过上限',
  );
  expectReject(notificationSettingsSchema, { ...settings, deliveryMode: 'staged' }, '未登记的投递节奏');
  assert.deepEqual([...NOTIFICATION_DELIVERY_MODES], ['all-at-once', 'two-stage']);
  roundtrip(
    notificationSettingsSchema,
    { ...settings, deliveryMode: 'all-at-once', firstStageSeconds: 0, secondStageSeconds: 1 },
    '一次性投递设置',
  );
});

test('推送订阅对外状态不含端点与密钥', () => {
  const view = roundtrip(
    pushSubscriptionViewSchema,
    { state: 'subscribed', permission: 'granted', updatedAt: 1_700_000_000_000 },
    '推送订阅视图',
  );
  assert.deepEqual(Object.keys(view).sort(), ['permission', 'state', 'updatedAt']);
  assertNoWatermark(view, '推送订阅视图');
  expectReject(
    pushSubscriptionViewSchema,
    { state: 'subscribed', permission: 'prompt', updatedAt: 1 },
    '未知的权限状态',
  );
  expectReject(pushSubscriptionViewSchema, { state: 'lost', permission: 'granted', updatedAt: 1 }, '未知的订阅状态');
  const gone = roundtrip(
    pushSubscriptionViewSchema,
    { state: 'gone', permission: 'granted', updatedAt: 1, code: 'push-endpoint-gone' },
    '端点失效的订阅',
  );
  assert.equal(gone.code, 'push-endpoint-gone');
});

test('验证通知同时报告受理与接收', () => {
  roundtrip(
    notificationProbeSchema,
    { acceptedAt: 1_700_000_000_000, receivedAt: 1_700_000_002_000, result: 'delivered' },
    '验证通知成功',
  );
  const pending = roundtrip(
    notificationProbeSchema,
    { acceptedAt: 1_700_000_000_000, result: 'accepted' },
    '仅服务端受理',
  );
  assert.equal(pending.receivedAt, undefined);
  expectReject(notificationProbeSchema, { result: 'maybe' }, '未知的投递结果');
});
