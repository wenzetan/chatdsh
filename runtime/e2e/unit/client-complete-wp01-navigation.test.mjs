// 导航消息与命令面板契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-navigation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_SCOPES,
  NAVIGATION_ACTIONS,
  NAVIGATION_MESSAGE_VERSION,
  NAVIGATION_TIMEOUT_MS,
  ONBOARDING_STEPS,
  RECENT_COMMANDS_MAX,
  commandDescriptorSchema,
  commandListSchema,
  commandQuerySchema,
  frameMessageSchema,
  messageGuardSchema,
  onboardingCompletedCount,
  onboardingProgressSchema,
  recentCommandsSchema,
  shellMessageSchema,
} from '../../packages/core/contracts/lib/index.js';
import { expectReject, roundtrip } from './client-complete-wp01-support.mjs';

test('导航消息携带版本、请求标识、设备与会话', () => {
  const navigate = roundtrip(
    shellMessageSchema,
    {
      action: 'navigate',
      version: NAVIGATION_MESSAGE_VERSION,
      requestId: 'request-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
    },
    '导航消息',
  );
  assert.equal(navigate.action, 'navigate');
  assert.equal(NAVIGATION_TIMEOUT_MS, 5000);
  assert.ok(NAVIGATION_ACTIONS.includes('query-selection'));
});

test('导航消息缺少会话标识或版本不符时被拒绝', () => {
  expectReject(
    shellMessageSchema,
    { action: 'navigate', version: NAVIGATION_MESSAGE_VERSION, requestId: 'request-1', deviceId: 'device-1' },
    '缺少目标会话',
  );
  expectReject(
    shellMessageSchema,
    { action: 'navigate', version: 2, requestId: 'request-1', deviceId: 'device-1', sessionId: 'session-1' },
    '协议版本不符',
  );
  expectReject(
    shellMessageSchema,
    { action: 'evaluate-script', version: NAVIGATION_MESSAGE_VERSION, requestId: 'request-1', deviceId: 'device-1' },
    '未登记的动作',
  );
});

test('只读状态消息只接受登记的只读原因', () => {
  roundtrip(
    shellMessageSchema,
    {
      action: 'set-readonly',
      version: NAVIGATION_MESSAGE_VERSION,
      requestId: 'request-2',
      deviceId: 'device-1',
      reason: 'replica-only',
    },
    '只读状态消息',
  );
  expectReject(
    shellMessageSchema,
    {
      action: 'set-readonly',
      version: NAVIGATION_MESSAGE_VERSION,
      requestId: 'request-2',
      deviceId: 'device-1',
      reason: 'sleeping',
    },
    '未登记的只读原因',
  );
});

test('内容端确认区分选中与拒绝', () => {
  const selected = roundtrip(
    frameMessageSchema,
    { outcome: 'selected', requestId: 'request-1', deviceId: 'device-1', sessionId: 'session-1' },
    '选中确认',
  );
  assert.equal(selected.outcome, 'selected');
  const rejected = roundtrip(
    frameMessageSchema,
    { outcome: 'rejected', requestId: 'request-1', code: 'navigation-rejected' },
    '拒绝确认',
  );
  assert.equal(rejected.code, 'navigation-rejected');
  expectReject(frameMessageSchema, { outcome: 'rejected', requestId: 'request-1', code: 'unknown-code' }, '未登记的错误码');
  expectReject(frameMessageSchema, { outcome: 'rejected', code: 'navigation-rejected' }, '缺少请求标识');
  expectReject(frameMessageSchema, { outcome: 'selected', requestId: 'request-1', deviceId: 'device-1' }, '缺少选中会话');
});

test('消息通道校验参数登记来源与握手状态', () => {
  const guard = roundtrip(
    messageGuardSchema,
    { sourceOrigin: 'https://control.example.test', expectedOrigin: 'https://control.example.test', handshakeComplete: true },
    '消息通道校验参数',
  );
  assert.equal(guard.handshakeComplete, true);
  expectReject(messageGuardSchema, { expectedOrigin: 'https://control.example.test', handshakeComplete: true }, '缺少来源登记');
});

test('命令描述携带作用范围与禁用原因', () => {
  const command = roundtrip(
    commandDescriptorSchema,
    {
      id: 'command.new-session',
      name: '新建会话',
      group: '会话',
      description: '在当前设备新建会话',
      shortcut: 'Ctrl+N',
      scope: 'device',
      enabled: false,
      disabledReason: '目标设备离线',
    },
    '命令描述',
  );
  assert.equal(command.enabled, false);
  assert.deepEqual([...COMMAND_SCOPES], ['global', 'session', 'device']);
  expectReject(commandDescriptorSchema, { ...command, scope: 'window' }, '未知的作用范围');
  expectReject(commandDescriptorSchema, { ...command, id: '' }, '空的命令标识');
});

test('命令查询与结果可以往返', () => {
  roundtrip(commandQuerySchema, { text: '新建', deviceId: 'device-1', sessionId: 'session-1', limit: 20 }, '命令查询');
  expectReject(commandQuerySchema, { text: '新建', limit: 101 }, '条数超过上限');
  const list = roundtrip(
    commandListSchema,
    {
      items: [
        { id: 'command.settings', name: '打开设置', group: '导航', scope: 'global', enabled: true },
      ],
      readAt: 1_700_000_000_000,
    },
    '命令查询结果',
  );
  assert.equal(list.items.length, 1);
});

test('最近使用命令只保存标识且有条数上限', () => {
  assert.equal(RECENT_COMMANDS_MAX, 20);
  roundtrip(recentCommandsSchema, { ids: ['command.settings', 'command.new-session'] }, '最近使用命令');
  expectReject(recentCommandsSchema, { ids: Array.from({ length: 21 }, (_, index) => `command.${index}`) }, '超过保存上限');
  expectReject(recentCommandsSchema, { ids: [{ id: 'command.settings' }] }, '保存了命令对象');
});

test('首次引导进度按步骤登记并去重计数', () => {
  const progress = roundtrip(
    onboardingProgressSchema,
    { completed: ['welcome', 'model'], current: 'workspace', skipped: ['welcome'], dismissedAt: 1_700_000_000_000 },
    '首次引导进度',
  );
  assert.equal(onboardingCompletedCount(progress), 2);
  assert.deepEqual([...ONBOARDING_STEPS], ['welcome', 'model', 'workspace', 'assistant']);
  expectReject(onboardingProgressSchema, { completed: ['welcome', 'billing'], current: 'model', skipped: [] }, '未登记的步骤');
});
