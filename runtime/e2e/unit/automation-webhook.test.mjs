// 自动化存储与 webhook 路由的测试。
//
// 存储用内存 SQLite；路由用真的 HTTP 服务端，只验证鉴权、去重与响应码，不依赖模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AutomationStore } from '../../gateway/lib/automation.js';
import { handleWebhook } from '../../gateway/lib/automation.js';

/** 一条测试用的记录。 */
function record(overrides = {}) {
  return {
    id: 'a1',
    name: '构建通知',
    trigger: { kind: 'webhook', secretEnv: 'HOOK_SECRET' },
    action: { kind: 'start-session', prompt: '总结这次构建' },
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

test('store 建表后可写入并查到自动化记录', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create(record());
  assert.equal(store.get('a1').name, '构建通知');
  assert.deepEqual(store.get('a1').trigger, { kind: 'webhook', secretEnv: 'HOOK_SECRET' });
  assert.deepEqual(store.list().map((item) => item.id), ['a1']);
});

test('同一 eventId 只记录一次', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create(record());
  assert.equal(store.recordEvent({ automationId: 'a1', eventId: 'e1', receivedAt: 1, source: 'github' }), true);
  assert.equal(store.recordEvent({ automationId: 'a1', eventId: 'e1', receivedAt: 2, source: 'github' }), false);
  assert.equal(store.hasEvent('a1', 'e1'), true);
  assert.deepEqual(store.eventsOf('a1'), [{ automationId: 'a1', eventId: 'e1', receivedAt: 1, source: 'github' }]);
});

test('未知自动化返回 404，密钥不匹配返回 401，合法投递返回 202', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create(record());
  process.env.HOOK_SECRET = 's3cret';

  assert.equal(handleWebhook(store, 'missing', { 'x-chatdsh-webhook-secret': 's3cret' }, '{"a":1}').status, 404);
  assert.equal(handleWebhook(store, 'a1', { 'x-chatdsh-webhook-secret': 'wrong' }, '{"a":1}').status, 401);
  const accepted = handleWebhook(store, 'a1', { 'x-chatdsh-webhook-secret': 's3cret', 'x-github-delivery': 'd1' }, '{"a":1}');
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, { accepted: true });
  const duplicate = handleWebhook(store, 'a1', { 'x-chatdsh-webhook-secret': 's3cret', 'x-github-delivery': 'd1' }, '{"a":1}');
  assert.equal(duplicate.status, 202);
  assert.deepEqual(duplicate.body, { duplicate: true });
});

test('停用的自动化拒绝投递，非法请求体返回 400', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create(record({ enabled: false }));
  process.env.HOOK_SECRET = 's3cret';
  const disabled = handleWebhook(store, 'a1', { 'x-chatdsh-webhook-secret': 's3cret' }, '{"a":1}');
  assert.equal(disabled.status, 404);
  assert.equal(disabled.body.error, 'automation-disabled');

  store.create(record({ id: 'a2' }));
  const invalid = handleWebhook(store, 'a2', { 'x-chatdsh-webhook-secret': 's3cret' }, 'not-json');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'automation/webhook-invalid');
});

test('环境变量缺失时按未配置处理，返回 503', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create(record({ trigger: { kind: 'webhook', secretEnv: 'MISSING_SECRET' } }));
  const result = handleWebhook(store, 'a1', { 'x-chatdsh-webhook-secret': 'anything' }, '{"a":1}');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'webhook-secret-unconfigured');
});

test('鉴权在解析请求体之前：错密钥加非法请求体返回 401', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  store.create(record());
  process.env.HOOK_SECRET = 's3cret';
  const result = handleWebhook(store, 'a1', { 'x-chatdsh-webhook-secret': 'wrong' }, 'not-json');
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'webhook-unauthorized');
});

test('记录不存在时先返回 404，不读取密钥与请求体', () => {
  const store = new AutomationStore(new DatabaseSync(':memory:'));
  const result = handleWebhook(store, 'missing', {}, 'not-json');
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'automation-not-found');
});
