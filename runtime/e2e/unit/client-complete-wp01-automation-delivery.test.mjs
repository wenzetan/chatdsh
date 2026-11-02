// 自动化投递结果与设备定时任务契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-automation-delivery.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_DELIVERY_STATES,
  AUTOMATION_DEDUPE_RESULTS,
  SCHEDULE_KINDS,
  SCHEDULE_MIN_INTERVAL_SECONDS,
  automationDeliveryQuerySchema,
  automationDeliverySchema,
  automationRetryRequestSchema,
  cronScheduleSchema,
  dailyScheduleSchema,
  intervalScheduleSchema,
  onceScheduleSchema,
  scheduleSpecSchema,
  scheduleViewSchema,
  weeklyScheduleSchema,
} from '../../packages/core/contracts/lib/index.js';
import {
  OPERATION_ID,
  REQUEST_DIGEST,
  expectReject,
  roundtrip,
} from './client-complete-wp01-support.mjs';

const DELIVERY = {
  deliveryId: 'delivery-1',
  automationId: 'automation-1',
  eventId: 'github:push:1234',
  source: 'github',
  receivedAt: 1_700_000_000_000,
  dedupe: 'new',
  state: 'accepted',
  sessionId: 'session-1',
};

test('投递记录携带事件标识与去重结果', () => {
  const delivery = roundtrip(automationDeliverySchema, DELIVERY, '投递记录');
  assert.equal(delivery.dedupe, 'new');
  assert.deepEqual([...AUTOMATION_DEDUPE_RESULTS], ['new', 'duplicate']);
  assert.deepEqual([...AUTOMATION_DELIVERY_STATES], [
    'received',
    'validated',
    'dispatching',
    'accepted',
    'completed',
    'failed',
    'unconfirmed',
  ]);
  const duplicate = roundtrip(automationDeliverySchema, { ...DELIVERY, dedupe: 'duplicate', state: 'completed' }, '重复投递');
  assert.equal(duplicate.dedupe, 'duplicate');
  expectReject(automationDeliverySchema, { ...DELIVERY, dedupe: 'ignored' }, '未知的去重结果');
  expectReject(automationDeliverySchema, { ...DELIVERY, state: 'queued' }, '未知的投递状态');
  expectReject(automationDeliverySchema, { ...DELIVERY, source: 'gitlab' }, '未登记的来源');
  expectReject(automationDeliverySchema, { ...DELIVERY, state: 'failed', code: 'unknown-code' }, '未登记的错误码');
});

test('投递查询与人工重试沿用原事件语义', () => {
  roundtrip(
    automationDeliveryQuerySchema,
    { automationId: 'automation-1', source: 'generic', state: 'failed', limit: 50 },
    '投递查询',
  );
  expectReject(automationDeliveryQuerySchema, { limit: 201 }, '条数超过上限');
  expectReject(automationDeliveryQuerySchema, { state: 'queued' }, '未知的投递状态');
  roundtrip(
    automationRetryRequestSchema,
    { deliveryId: 'delivery-1', eventId: 'github:push:1234', operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '人工重试',
  );
  expectReject(
    automationRetryRequestSchema,
    { deliveryId: 'delivery-1', operationId: OPERATION_ID, requestDigest: REQUEST_DIGEST },
    '重试缺少事件标识',
  );
});

test('定时任务的五种时间方式互斥且各自校验', () => {
  assert.deepEqual([...SCHEDULE_KINDS], ['once', 'interval', 'daily', 'weekly', 'cron']);
  assert.equal(SCHEDULE_MIN_INTERVAL_SECONDS, 60);
  roundtrip(onceScheduleSchema, { kind: 'once', at: 1_700_000_000_000, timeZone: 'Asia/Shanghai' }, '单次任务');
  roundtrip(intervalScheduleSchema, { kind: 'interval', everySeconds: 300, timeZone: 'UTC' }, '间隔任务');
  roundtrip(dailyScheduleSchema, { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, '每日任务');
  roundtrip(weeklyScheduleSchema, { kind: 'weekly', weekdays: [1, 3, 5], time: '18:30', timeZone: 'Asia/Shanghai' }, '每周任务');
  roundtrip(cronScheduleSchema, { kind: 'cron', expression: '*/5 9-17 * * 1-5', timeZone: 'UTC' }, 'cron 任务');
  expectReject(scheduleSpecSchema, { kind: 'interval', everySeconds: 59, timeZone: 'UTC' }, '间隔低于 60 秒');
  expectReject(scheduleSpecSchema, { kind: 'daily', time: '24:00', timeZone: 'UTC' }, '非法的当日时刻');
  expectReject(scheduleSpecSchema, { kind: 'weekly', weekdays: [1, 1], time: '09:00', timeZone: 'UTC' }, '重复的星期编号');
  expectReject(scheduleSpecSchema, { kind: 'weekly', weekdays: [], time: '09:00', timeZone: 'UTC' }, '空的星期列表');
  expectReject(scheduleSpecSchema, { kind: 'weekly', weekdays: [8], time: '09:00', timeZone: 'UTC' }, '星期编号越界');
  expectReject(scheduleSpecSchema, { kind: 'once', at: 1_700_000_000_000, timeZone: 'Mars/Olympus' }, '未知时区');
  expectReject(scheduleSpecSchema, { kind: 'hourly', everySeconds: 3600, timeZone: 'UTC' }, '未登记的时间方式');
});

test('定时任务视图跟随原会话并显示下次发生时间', () => {
  const view = roundtrip(
    scheduleViewSchema,
    {
      scheduleId: 'schedule-1',
      sessionId: 'session-1',
      name: '每日检查',
      prompt: '检查依赖更新',
      spec: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
      enabled: true,
      nextRunAt: 1_700_003_600_000,
    },
    '定时任务视图',
  );
  assert.equal(view.spec.kind, 'daily');
  expectReject(scheduleViewSchema, { ...view, sessionId: undefined }, '缺少原会话');
  expectReject(scheduleViewSchema, { ...view, spec: { kind: 'weekly', weekdays: [0], time: '09:00', timeZone: 'UTC' } }, '非法星期编号');
});
