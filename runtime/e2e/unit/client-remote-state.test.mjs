import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityTime,
  classifyRelayFailure,
  deviceHostPrefix,
  errorCodeOf,
  parseDevicePath,
} from '../../packages/client/remote/lib/client/state.js';

test('解析设备路径', () => {
  assert.equal(parseDevicePath('/d/dev-1/chat'), 'dev-1');
  assert.equal(parseDevicePath('/d/dev-1'), 'dev-1');
  assert.equal(parseDevicePath('/d/%E4%B8%AD/'), '中');
  assert.equal(parseDevicePath('/d/'), undefined);
  assert.equal(parseDevicePath('/devices/d/x'), undefined);
  assert.equal(parseDevicePath('/'), undefined);
});

test('生成宿主端点前缀', () => {
  assert.equal(deviceHostPrefix('/d/dev-1/chat'), '/d/dev-1');
  assert.equal(deviceHostPrefix('/d/a%2Fb/'), '/d/a%2Fb');
  assert.equal(deviceHostPrefix('/'), '');
});

test('归类中继失败', () => {
  assert.deepEqual(classifyRelayFailure({ status: 404 }), { state: 'disconnected', code: 'gateway-missing' });
  assert.deepEqual(classifyRelayFailure({ status: 401 }), { state: 'disconnected', code: 'unauthorized' });
  assert.deepEqual(classifyRelayFailure({ status: 409 }), { state: 'disconnected', code: 'conflict' });
  assert.deepEqual(classifyRelayFailure({ status: 500 }), { state: 'disconnected', code: 'server-error' });
  assert.deepEqual(classifyRelayFailure({ status: 418 }), { state: 'disconnected', code: 'http-418' });
  assert.deepEqual(classifyRelayFailure(new TypeError('offline')), { state: 'disconnected', code: 'network' });
  assert.deepEqual(classifyRelayFailure({ name: 'AbortError' }), { state: 'disconnected', code: 'timeout' });
  assert.deepEqual(classifyRelayFailure({ code: 'custom' }), { state: 'disconnected', code: 'custom' });
});

test('取错误码', () => {
  assert.equal(errorCodeOf({ code: 'x' }), 'x');
  assert.equal(errorCodeOf({ name: 'TypeError' }), 'TypeError');
  assert.equal(errorCodeOf('text'), 'unknown');
});

test('相对时间单位', () => {
  assert.equal(activityTime(1_000, 1_000).unit, 'now');
  assert.deepEqual(activityTime(60_000, 0), { unit: 'minute', value: 1, at: 0 });
  assert.deepEqual(activityTime(3_600_000, 0), { unit: 'hour', value: 1, at: 0 });
  assert.deepEqual(activityTime(86_400_000, 0), { unit: 'day', value: 1, at: 0 });
  assert.deepEqual(activityTime(7 * 86_400_000, 0), { unit: 'date', value: 0, at: 0 });
  assert.equal(activityTime(1_000, 2_000).unit, 'now');
});
