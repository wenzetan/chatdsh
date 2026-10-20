// 事件名与关联键的单元测试。
//
// 这个子路径只含常量与纯函数，不引任何上游包，因此测试可以脱离 DSH 安装单独运行。
//
// 运行：node --test test/events.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_EVENTS,
  APPROVAL_EVENTS,
  SESSION_EVENTS,
  SESSION_EVENT_TYPES,
} from '../lib/events.js';

test('agent 事件名与上游一致', () => {
  assert.equal(AGENT_EVENTS.created, 'agent/created');
  assert.equal(AGENT_EVENTS.preStep, 'agent/pre-step');
});

test('会话事件名与上游一致', () => {
  assert.equal(SESSION_EVENTS.created, 'session/created');
  assert.equal(SESSION_EVENTS.event, 'session/event');
});

test('审批事件名与上游一致', () => {
  assert.equal(APPROVAL_EVENTS.request, 'approval/request');
});

test('会话事件类型名与上游一致', () => {
  assert.equal(SESSION_EVENT_TYPES.userMessage, 'user/message');
  assert.equal(SESSION_EVENT_TYPES.assistantMessage, 'assistant/message');
  assert.equal(SESSION_EVENT_TYPES.toolCall, 'tool/call');
  assert.equal(SESSION_EVENT_TYPES.toolResult, 'tool/result');
  assert.equal(SESSION_EVENT_TYPES.approvalAsked, 'approval/asked');
  assert.equal(SESSION_EVENT_TYPES.approvalDecided, 'approval/decided');
});

test('事件名集合内没有重复值', () => {
  const all = [
    ...Object.values(AGENT_EVENTS),
    ...Object.values(SESSION_EVENTS),
    ...Object.values(APPROVAL_EVENTS),
  ];
  assert.equal(new Set(all).size, all.length);
});
