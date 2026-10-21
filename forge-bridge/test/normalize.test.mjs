// 外部投递的规范化测试。
//
// 只验证纯函数：来源判定、事件标识生成与非法请求体的拒绝。网络与鉴权在网关侧覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeWebhook, WebhookInvalidError } from '../lib/index.js';

test('GitHub 头决定来源与事件标识', () => {
  const body = JSON.stringify({ ref: 'refs/heads/main' });
  const event = normalizeWebhook({
    headers: { 'x-github-event': 'push', 'x-github-delivery': 'delivery-1' },
    body,
  });
  assert.deepEqual({ source: event.source, eventId: event.eventId }, { source: 'github', eventId: 'delivery-1' });
  assert.equal(typeof event.receivedAt, 'number');
  assert.equal(event.payload.ref, 'refs/heads/main');
});

test('缺少投递头时按请求体摘要生成事件标识，同一请求体得到同一标识', () => {
  const body = JSON.stringify({ hello: 'world' });
  const expected = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32);
  const first = normalizeWebhook({ headers: {}, body });
  const second = normalizeWebhook({ headers: {}, body });
  assert.equal(first.source, 'generic');
  assert.equal(first.eventId, expected);
  assert.equal(second.eventId, expected);
});

test('投递头大小写不敏感', () => {
  const event = normalizeWebhook({ headers: { 'X-GitHub-Delivery': 'delivery-2' }, body: '{"a":1}' });
  assert.equal(event.eventId, 'delivery-2');
  assert.equal(event.source, 'generic');
});

test('非 JSON 对象就地抛错', () => {
  assert.throws(() => normalizeWebhook({ headers: {}, body: 'not-json' }), (error) => error instanceof WebhookInvalidError);
  assert.throws(() => normalizeWebhook({ headers: {}, body: '[]' }), (error) => error instanceof WebhookInvalidError);
  assert.throws(() => normalizeWebhook({ headers: {}, body: 'null' }), (error) => error instanceof WebhookInvalidError);
});

test('空请求体就地抛错', () => {
  assert.throws(() => normalizeWebhook({ headers: {}, body: '' }), (error) => error.code === 'automation/webhook-invalid');
});
