import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlUrlError,
  endpointOf,
  normalizeControlUrl,
} from '../../packages/client/remote/lib/client/control-url.js';

test('空输入表示同源根路径', () => {
  assert.equal(normalizeControlUrl(''), '');
  assert.equal(normalizeControlUrl('   '), '');
});

test('去掉末尾斜杠并保留反向代理前缀', () => {
  assert.equal(normalizeControlUrl('http://127.0.0.1:3170/'), 'http://127.0.0.1:3170');
  assert.equal(normalizeControlUrl('https://relay.example/chatdsh/'), 'https://relay.example/chatdsh');
  assert.equal(normalizeControlUrl('http://relay.example:8080/base'), 'http://relay.example:8080/base');
});

test('拒绝非 HTTP 协议', () => {
  assert.throws(
    () => normalizeControlUrl('ftp://relay.example'),
    (error) => error instanceof ControlUrlError && error.code === 'control-url-protocol',
  );
});

test('拒绝登录凭据', () => {
  assert.throws(
    () => normalizeControlUrl('http://user@relay.example'),
    (error) => error instanceof ControlUrlError && error.code === 'control-url-credentials',
  );
});

test('拒绝查询串与片段', () => {
  assert.throws(
    () => normalizeControlUrl('http://relay.example/?token=1'),
    (error) => error instanceof ControlUrlError && error.code === 'control-url-query',
  );
  assert.throws(
    () => normalizeControlUrl('http://relay.example/#section'),
    (error) => error instanceof ControlUrlError && error.code === 'control-url-hash',
  );
});

test('拒绝无法解析的地址', () => {
  assert.throws(
    () => normalizeControlUrl('http://'),
    (error) => error instanceof ControlUrlError && error.code === 'control-url-invalid',
  );
});

test('按地址拼接端点', () => {
  assert.equal(endpointOf('', '/chatdsh/gateway/devices'), '/chatdsh/gateway/devices');
  assert.equal(endpointOf('http://relay.example', '/chatdsh/gateway/devices'), 'http://relay.example/chatdsh/gateway/devices');
  assert.equal(endpointOf('http://relay.example/base', 'chatdsh/gateway/devices'), 'http://relay.example/base/chatdsh/gateway/devices');
});
