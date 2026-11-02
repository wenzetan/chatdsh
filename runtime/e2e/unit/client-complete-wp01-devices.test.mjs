// 设备、配对与撤销契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-devices.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_ROLES,
  accessClientSchema,
  deviceLinkCheckSchema,
  deviceListSchema,
  deviceRevokeRequestSchema,
  deviceRevokeResultSchema,
  deviceSchema,
  pairingCodeSchema,
  pairingRequestSchema,
  pairingResultSchema,
} from '../../packages/core/contracts/lib/index.js';
import { assertNoWatermark, expectReject, roundtrip } from './client-complete-wp01-support.mjs';

const DEVICE = {
  id: 'device-1',
  name: '工作站',
  platform: 'linux',
  role: 'both',
  capabilities: ['terminal', 'files'],
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_500_000,
  online: true,
  currentExecutor: true,
};

const ACCESS_CLIENT = {
  id: 'client-1',
  name: 'Chrome on Linux',
  platform: 'linux',
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_500_000,
  current: true,
};

test('执行节点字段可以往返且不含内部水位', () => {
  const parsed = roundtrip(deviceSchema, DEVICE, '执行节点');
  assert.equal(parsed.role, 'both');
  assertNoWatermark(parsed, '执行节点');
  assert.deepEqual([...DEVICE_ROLES], ['host', 'executor', 'both']);
});

test('未知的设备角色与平台字段被拒绝', () => {
  expectReject(deviceSchema, { ...DEVICE, role: 'observer' }, '未知的设备角色');
  expectReject(deviceSchema, { ...DEVICE, platform: '' }, '空的平台标识');
  expectReject(deviceSchema, { ...DEVICE, capabilities: [1] }, '非字符串的能力标识');
});

test('设备列表按访问客户端与执行节点分组', () => {
  const list = roundtrip(
    deviceListSchema,
    { accessClients: [ACCESS_CLIENT], nodes: [DEVICE, { ...DEVICE, id: 'device-2', role: 'executor', currentExecutor: false }] },
    '设备列表',
  );
  assert.equal(list.nodes.length, 2);
  assert.equal(list.accessClients.length, 1);
  assertNoWatermark(list, '设备列表');
  expectReject(deviceListSchema, { nodes: [DEVICE] }, '缺少访问客户端分组');
  roundtrip(accessClientSchema, ACCESS_CLIENT, '访问客户端');
});

test('配对码一次使用并携带有效期', () => {
  const code = roundtrip(
    pairingCodeSchema,
    { kind: 'qr', controlUrl: 'https://control.example.test', code: 'ABCD-EFGH-IJKL-MNOP', expiresAt: 1_700_000_300_000 },
    '配对码',
  );
  assert.equal(code.kind, 'qr');
  expectReject(pairingCodeSchema, { kind: 'nfc', controlUrl: 'https://control.example.test', code: 'ABCD', expiresAt: 1 }, '未知的展示形式');
  expectReject(pairingCodeSchema, { kind: 'manual', controlUrl: 'https://control.example.test', code: 'short', expiresAt: 1 }, '过短的配对码');
});

test('配对请求要求名称、平台与角色', () => {
  const request = {
    controlUrl: 'https://control.example.test',
    code: 'ABCD-EFGH-IJKL-MNOP',
    name: '笔记本',
    platform: 'darwin',
    role: 'executor',
  };
  roundtrip(pairingRequestSchema, request, '配对请求');
  expectReject(pairingRequestSchema, { ...request, name: '' }, '空名称');
  expectReject(pairingRequestSchema, { ...request, name: 'x'.repeat(81) }, '名称超过 80 个字符');
  expectReject(pairingRequestSchema, { ...request, platform: undefined }, '缺少平台');
  expectReject(pairingRequestSchema, { ...request, role: 'cluster' }, '未知角色');
});

test('配对结果的节点令牌只在建立时返回', () => {
  const result = roundtrip(
    pairingResultSchema,
    { deviceId: 'device-2', role: 'executor', pairedAt: 1_700_000_000_000, nodeToken: 'token-value-with-enough-length-0123456789' },
    '配对结果',
  );
  assert.equal(typeof result.nodeToken, 'string');
  expectReject(
    pairingResultSchema,
    { deviceId: 'device-2', role: 'executor', pairedAt: 1, nodeToken: 'short' },
    '过短的节点令牌',
  );
  expectReject(pairingResultSchema, { deviceId: 'device-2', pairedAt: 1, nodeToken: 'x'.repeat(40) }, '缺少角色');
});

test('撤销结果保留历史会话并统计关闭的链路', () => {
  roundtrip(deviceRevokeRequestSchema, { deviceId: 'device-2', reason: 'rotate' }, '撤销请求');
  expectReject(deviceRevokeRequestSchema, { deviceId: 'device-2', reason: 'cleanup' }, '未知的撤销原因');
  const result = roundtrip(
    deviceRevokeResultSchema,
    { deviceId: 'device-2', revokedAt: 1_700_000_000_000, closedLinks: 2, sessionsPreserved: true },
    '撤销结果',
  );
  assert.equal(result.sessionsPreserved, true);
  expectReject(
    deviceRevokeResultSchema,
    { deviceId: 'device-2', revokedAt: 1, closedLinks: 0, sessionsPreserved: false },
    '会话被标记为不保留',
  );
});

test('链路检查区分可达与不可达', () => {
  const ok = roundtrip(
    deviceLinkCheckSchema,
    { deviceId: 'device-2', checkedAt: 1_700_000_000_000, reachable: true, latencyMs: 12 },
    '链路检查可达',
  );
  assert.equal(ok.latencyMs, 12);
  const failed = roundtrip(
    deviceLinkCheckSchema,
    { deviceId: 'device-2', checkedAt: 1_700_000_000_000, reachable: false, code: 'device-offline' },
    '链路检查不可达',
  );
  assert.equal(failed.code, 'device-offline');
  expectReject(
    deviceLinkCheckSchema,
    { deviceId: 'device-2', checkedAt: 1, reachable: false, code: 'unknown-code' },
    '未登记的错误码',
  );
});
