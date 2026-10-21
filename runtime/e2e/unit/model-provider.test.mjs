// 模型提供方注册信息的测试。
//
// 只验证纯函数：合法输入补全展示名，非法输入抛出带错误码的异常。注册表与宿主插件
// 的行为由组合检查与工具体验覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_PROVIDER, resolveModelProvider } from '../../packages/host/model-provider/lib/client.js';

test('合法输入补全展示名', () => {
  assert.deepEqual(resolveModelProvider({ provider: 'gateway', baseUrl: 'http://127.0.0.1:20128/v1' }), {
    provider: 'gateway',
    displayName: 'gateway',
    baseUrl: 'http://127.0.0.1:20128/v1',
  });
});

test('保留给定的展示名、请求头与模型列表', () => {
  assert.deepEqual(resolveModelProvider({
    provider: 'openclaw',
    displayName: 'OpenClaw',
    baseUrl: 'https://example.invalid/v1',
    headers: { 'x-tenant': 'demo' },
    models: ['a', 'b'],
  }), {
    provider: 'openclaw',
    displayName: 'OpenClaw',
    baseUrl: 'https://example.invalid/v1',
    headers: { 'x-tenant': 'demo' },
    models: ['a', 'b'],
  });
});

test('缺少 provider 时抛出 error.code 为 model-provider/invalid', () => {
  assert.throws(
    () => resolveModelProvider({ provider: '', baseUrl: 'http://127.0.0.1:20128/v1' }),
    (error) => error.code === 'model-provider/invalid' && /provider/.test(error.message),
  );
});

test('provider 形状不合法时就地抛出', () => {
  assert.throws(
    () => resolveModelProvider({ provider: 'Gateway_1', baseUrl: 'http://127.0.0.1:20128/v1' }),
    (error) => error.code === 'model-provider/invalid',
  );
});

test('缺 baseUrl 或协议不合法时抛出 error.code 为 model-provider/invalid', () => {
  assert.throws(
    () => resolveModelProvider({ provider: 'gateway', baseUrl: '' }),
    (error) => error.code === 'model-provider/invalid' && /baseUrl/.test(error.message),
  );
  assert.throws(
    () => resolveModelProvider({ provider: 'gateway', baseUrl: 'ftp://127.0.0.1/v1' }),
    (error) => error.code === 'model-provider/invalid',
  );
});

test('网关提供方的标识固定', () => {
  assert.equal(GATEWAY_PROVIDER, 'gateway');
});
