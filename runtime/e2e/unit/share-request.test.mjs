// 分享请求构造的单元测试。
//
// 直接调用编译后的真实实现，不复制逻辑也不使用替身。上界为 0 的情况单独测：序号 0 是
// 合法取值，不能被当成缺省省略掉。
//
// 运行：node --test e2e/unit/share-request.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareRequest } from '../../packages/tool/share/lib/request.js';

test('只给会话标识时省略可选字段', () => {
  assert.deepEqual(buildShareRequest({ sessionId: 's1' }), { sessionId: 's1' });
});

test('给出上界与有效期时写入它们', () => {
  assert.deepEqual(buildShareRequest({ sessionId: 's1', upToSeq: 7, ttlMs: 60_000 }), {
    sessionId: 's1',
    upToSeq: 7,
    ttlMs: 60_000,
  });
});

test('上界为 0 时仍然写入', () => {
  assert.deepEqual(buildShareRequest({ sessionId: 's1', upToSeq: 0 }), { sessionId: 's1', upToSeq: 0 });
});

test('有效期为 0 时仍然写入', () => {
  assert.deepEqual(buildShareRequest({ sessionId: 's1', ttlMs: 0 }), { sessionId: 's1', ttlMs: 0 });
});
