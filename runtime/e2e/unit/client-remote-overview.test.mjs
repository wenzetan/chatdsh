import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOverview } from '../../packages/client/remote/lib/client/model.js';

function session(sessionId, title, updatedAt) {
  return { sessionId, title, updatedAt, cwd: `/work/${title}`, workspaceName: title, kind: 'work' };
}

test('设备按在线状态与最近活动排序，会话按更新时间倒序', () => {
  const devices = [
    { id: 'a', name: 'Alpha', platform: 'linux', online: false, lastSeenAt: 100 },
    { id: 'b', name: 'Beta', platform: 'darwin', online: true, lastSeenAt: 50 },
  ];
  const groups = [
    {
      deviceId: 'a',
      name: 'Alpha',
      platform: 'linux',
      online: false,
      lastSeenAt: 100,
      sessions: [session('s1', 'Older', 10), session('s2', 'Newer', 30)],
    },
    {
      deviceId: 'b',
      name: 'Beta',
      platform: 'darwin',
      online: true,
      lastSeenAt: 50,
      sessions: [session('s3', 'BetaWork', 20)],
    },
    {
      deviceId: 'c',
      name: 'Gamma',
      platform: 'win32',
      online: false,
      lastSeenAt: 10,
      sessions: [session('s4', 'Ghost', 5)],
    },
  ];
  const overview = buildOverview(devices, groups);
  assert.deepEqual(overview.devices.map((device) => device.id), ['b', 'a', 'c']);
  assert.deepEqual(overview.sessions.map((row) => row.sessionId), ['s2', 's3', 's1', 's4']);
  assert.equal(overview.devices.find((device) => device.id === 'a').sessionCount, 2);
  assert.equal(overview.devices.find((device) => device.id === 'c').sessionCount, 1);
  assert.equal(overview.sessions.find((row) => row.sessionId === 's3').deviceName, 'Beta');
  assert.equal(overview.sessions.find((row) => row.sessionId === 's3').online, true);
  assert.equal(overview.sessions.find((row) => row.sessionId === 's4').online, false);
});

test('同一会话重复出现时保留更新时间较新的一份', () => {
  const devices = [
    { id: 'a', name: 'Alpha', platform: 'linux', online: false, lastSeenAt: 100 },
    { id: 'b', name: 'Beta', platform: 'darwin', online: true, lastSeenAt: 50 },
  ];
  const groups = [
    {
      deviceId: 'a',
      name: 'Alpha',
      platform: 'linux',
      online: false,
      lastSeenAt: 100,
      sessions: [session('same', 'Fresh', 90)],
    },
    {
      deviceId: 'b',
      name: 'Beta',
      platform: 'darwin',
      online: true,
      lastSeenAt: 50,
      sessions: [session('same', 'Stale', 10)],
    },
  ];
  const overview = buildOverview(devices, groups);
  assert.equal(overview.sessions.length, 1);
  assert.equal(overview.sessions[0].title, 'Fresh');
  assert.equal(overview.sessions[0].deviceId, 'a');
  assert.equal(overview.devices.find((device) => device.id === 'a').sessionCount, 1);
  assert.equal(overview.devices.find((device) => device.id === 'b').sessionCount, 0);
});

test('会话列表里出现未登记设备时补一条设备行', () => {
  const overview = buildOverview([], [{
    deviceId: 'unknown',
    name: 'Unknown',
    platform: 'linux',
    online: true,
    lastSeenAt: 7,
    sessions: [session('s1', 'Work', 3)],
  }]);
  assert.equal(overview.devices.length, 1);
  assert.equal(overview.devices[0].id, 'unknown');
  assert.equal(overview.devices[0].sessionCount, 1);
  assert.equal(overview.sessions[0].deviceName, 'Unknown');
});
