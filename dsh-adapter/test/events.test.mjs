import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_EVENTS,
  SESSION_EVENT_TYPES,
} from '../lib/events.js';

test('会话事件名与上游一致', () => {
  assert.equal(SESSION_EVENTS.created, 'session/created');
  assert.equal(SESSION_EVENTS.event, 'session/event');
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
  const all = Object.values(SESSION_EVENTS);
  assert.equal(new Set(all).size, all.length);
});
