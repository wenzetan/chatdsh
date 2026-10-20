/**
 * 后端注册表的单元测试。
 *
 * 只验证注册、解析、能力断言与调用上下文这四件事，不涉及任何具体后端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BackendRegistry, assertCapability, backendKey, callContext } from '../../packages/core/backends/lib/index.js';

/** 一个最小的描述符：配置是对象，服务记录收到的配置。 */
function descriptor(kind, id, capabilities) {
  return {
    kind,
    id,
    version: '0.0.1',
    capabilities,
    configSchema: {
      parse(value) {
        if (typeof value !== 'object' || value === null) throw new Error('配置必须是对象');
        return { ...value };
      },
    },
    create(config) {
      return { kind, id, config };
    },
    async health() {
      return { ok: true };
    },
  };
}

test('注册后可按种类与标识解析，配置在创建前被解析', () => {
  const registry = new BackendRegistry();
  registry.register(descriptor('chat', 'hermes', ['approval', 'steer']));
  const resolved = registry.resolve('chat', 'hermes', { endpoint: 'http://127.0.0.1:8642' });
  assert.equal(resolved.descriptor.id, 'hermes');
  assert.deepEqual(resolved.service.config, { endpoint: 'http://127.0.0.1:8642' });
});

test('同一个键重复注册即抛出', () => {
  const registry = new BackendRegistry();
  registry.register(descriptor('memory', 'hindsight', []));
  assert.throws(() => registry.register(descriptor('memory', 'hindsight', [])), /重复注册/);
});

test('未注册的标识抛出并列出该种类下的可用取值', () => {
  const registry = new BackendRegistry();
  registry.register(descriptor('memory', 'hindsight', []));
  registry.register(descriptor('memory', 'local', []));
  assert.throws(() => registry.resolve('memory', 'missing', {}), /memory:missing.*hindsight、local/s);
});

test('该种类下没有任何实现时给出明确提示', () => {
  const registry = new BackendRegistry();
  assert.throws(() => registry.resolve('model', 'gateway', {}), /该种类下没有任何实现/);
});

test('配置校验失败在创建前抛出', () => {
  const registry = new BackendRegistry();
  registry.register(descriptor('chat', 'hermes', []));
  assert.throws(() => registry.resolve('chat', 'hermes', null), /配置必须是对象/);
});

test('能力断言在缺失时抛出，命中时不抛出', () => {
  const entry = descriptor('chat', 'hermes', ['approval']);
  assert.doesNotThrow(() => assertCapability(entry, 'approval'));
  assert.throws(() => assertCapability(entry, 'steer'), /不支持 steer/);
});

test('调用上下文原样携带 traceparent', () => {
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  assert.deepEqual(callContext(traceparent), { traceparent, signal: undefined });
  assert.deepEqual(callContext(), { signal: undefined });
});

test('注册表的键由种类与标识拼成', () => {
  assert.equal(backendKey('chat', 'hermes'), 'chat:hermes');
});
