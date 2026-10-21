// 自建 Remote 客户端贡献的构造测试。
//
// 自建服务没有 typert 生成器，客户端要手写 descriptor。这一层只负责把「服务名 +
// 方法参数」翻译成 $mount 接受的 contribution，不发起网络，也不依赖浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildRemoteContribution, unwrapRemoteResult } from '../../packages/core/remote-client/lib/index.js';

test('contribution 的 id、命名空间与参数按服务与方法生成', () => {
  const contribution = buildRemoteContribution('chatdshApprovals', {
    'chatdshApprovals/pending': { parameters: [] },
    'chatdshApprovals/answer': { parameters: [{ name: 'id', kind: 'string' }, { name: 'outcome', kind: 'string' }] },
  }, z);

  assert.equal(contribution.package, 'chatdshApprovals');
  assert.deepEqual(contribution.descriptors.map((descriptor) => descriptor.id), [
    'chatdshApprovals#chatdshApprovals/pending',
    'chatdshApprovals#chatdshApprovals/answer',
  ]);
  const answer = contribution.descriptors[1];
  assert.equal(answer.namespace, 'chatdshApprovals');
  assert.equal(answer.method, 'answer');
  assert.deepEqual(answer.parameters.map((parameter) => parameter.wire), ['id', 'outcome']);
  assert.equal(answer.parameters[0].codec.mode, 'strict');
  assert.equal(answer.result.mode, 'strict');
});

test('参数种类映射到对应 zod 校验器', () => {
  const contribution = buildRemoteContribution('chatdshSkills', {
    'chatdshSkills/toggle': { parameters: [{ name: 'id', kind: 'string' }, { name: 'enabled', kind: 'boolean' }] },
    'chatdshSkills/count': { parameters: [{ name: 'limit', kind: 'number' }] },
    'chatdshSkills/raw': { parameters: [{ name: 'payload', kind: 'json' }] },
  }, z);
  const [toggle, count, raw] = contribution.descriptors;
  assert.equal(toggle.parameters[1].codec.create().safeParse(true).success, true);
  assert.equal(toggle.parameters[1].codec.create().safeParse('true').success, false);
  assert.equal(count.parameters[0].codec.create().safeParse(3).success, true);
  assert.equal(raw.parameters[0].codec.create().safeParse({ any: 1 }).success, true);
});

test('服务名与方法前缀不一致时就地抛出', () => {
  assert.throws(
    () => buildRemoteContribution('chatdshSkills', { 'otherService/list': { parameters: [] } }, z),
    /前缀/,
  );
});

test('Remote 调用结果按成功与失败解包', () => {
  assert.deepEqual(unwrapRemoteResult({ ok: true, value: [1, 2] }), [1, 2]);
  assert.equal(unwrapRemoteResult({ ok: true, value: 'value' }), 'value');
  assert.throws(() => unwrapRemoteResult({ ok: false, error: { code: 'gateway/internal' } }), /gateway\/internal/);
  assert.deepEqual(unwrapRemoteResult([1]), [1]);
});
