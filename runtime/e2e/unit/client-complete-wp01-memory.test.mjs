// 记忆配置、记忆组与 bank 契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-memory.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_ACCOUNT_BANK,
  MEMORY_GROUP_BANK_PREFIX,
  MEMORY_MAX_TOKENS_RANGE,
  MEMORY_STATES,
  bankCatalogSchema,
  memoryGroupSaveSchema,
  memoryGroupSchema,
  memoryRecallRequestSchema,
  memoryRecallResultSchema,
  memorySettingsSaveSchema,
  memorySettingsViewSchema,
  memoryWorkspaceRefSchema,
  memoryWriteQueueViewSchema,
} from '../../packages/core/contracts/lib/index.js';
import { assertNoWatermark, expectReject, roundtrip } from './client-complete-wp01-support.mjs';

const SETTINGS_VIEW = {
  enabled: true,
  state: 'enabled-available',
  maxTokens: 1024,
  extraBanks: ['project-notes'],
  configSource: '环境变量 HINDSIGHT_URL',
  endpointConfigured: true,
  credentialEnvConfigured: false,
  revision: 4,
};

const GROUP = {
  memoryGroupId: 'group-1',
  displayName: '工作区记忆',
  workspaces: [{ deviceId: 'device-1', path: '/srv/work' }],
  entryCount: 12,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  revision: 2,
};

test('记忆配置视图可以往返并区分状态', () => {
  const parsed = roundtrip(memorySettingsViewSchema, SETTINGS_VIEW, '记忆配置视图');
  assert.equal(parsed.state, 'enabled-available');
  assertNoWatermark(parsed, '记忆配置视图');
  assert.deepEqual([...MEMORY_STATES], ['enabled-available', 'enabled-unreachable', 'disabled', 'read-failed']);
  for (const state of MEMORY_STATES) {
    roundtrip(memorySettingsViewSchema, { ...SETTINGS_VIEW, state }, `记忆状态 ${state}`);
  }
  expectReject(memorySettingsViewSchema, { ...SETTINGS_VIEW, state: 'sleeping' }, '未知的记忆状态');
});

test('召回令牌上限按产品范围校验', () => {
  assert.equal(MEMORY_MAX_TOKENS_RANGE.min, 100);
  assert.equal(MEMORY_MAX_TOKENS_RANGE.max, 16000);
  expectReject(memorySettingsViewSchema, { ...SETTINGS_VIEW, maxTokens: MEMORY_MAX_TOKENS_RANGE.min - 1 }, '下限以下');
  expectReject(memorySettingsViewSchema, { ...SETTINGS_VIEW, maxTokens: MEMORY_MAX_TOKENS_RANGE.max + 1 }, '上限以上');
  expectReject(memorySettingsViewSchema, { ...SETTINGS_VIEW, maxTokens: 1024.5 }, '非整数令牌上限');
});

test('记忆配置保存携带 revision 并只接受已登记的 bank', () => {
  roundtrip(
    memorySettingsSaveSchema,
    { enabled: true, maxTokens: 2048, extraBanks: ['project-notes'], revision: 4 },
    '记忆配置保存',
  );
  expectReject(memorySettingsSaveSchema, { enabled: true, maxTokens: 2048, extraBanks: [] }, '缺少 revision');
  expectReject(
    memorySettingsSaveSchema,
    { enabled: true, maxTokens: 2048, extraBanks: [''], revision: 4 },
    '空的 bank 标识',
  );
});

test('记忆组按稳定标识关联工作区', () => {
  const parsed = roundtrip(memoryGroupSchema, GROUP, '记忆组');
  assert.equal(parsed.memoryGroupId, 'group-1');
  assertNoWatermark(parsed, '记忆组');
  expectReject(memoryGroupSchema, { ...GROUP, workspaces: [] }, '没有关联工作区');
  expectReject(
    memoryGroupSchema,
    { ...GROUP, workspaces: [{ deviceId: 'device-1' }] },
    '工作区缺少路径',
  );
  expectReject(memoryGroupSchema, { ...GROUP, workspaces: [{ path: '/srv/work' }] }, '工作区缺少设备');
  roundtrip(memoryWorkspaceRefSchema, { deviceId: 'device-1', path: '/srv/work' }, '工作区关联');
});

test('记忆组保存允许新建与更新两种形态', () => {
  roundtrip(
    memoryGroupSaveSchema,
    { displayName: '新组', workspaces: [{ deviceId: 'device-1', path: '/srv/other' }] },
    '新建记忆组',
  );
  roundtrip(
    memoryGroupSaveSchema,
    { memoryGroupId: 'group-1', displayName: '改显示名', workspaces: [{ deviceId: 'device-1', path: '/srv/work' }], revision: 2 },
    '更新记忆组',
  );
  expectReject(memoryGroupSaveSchema, { displayName: '空关联', workspaces: [] }, '没有关联工作区');
});

test('bank 目录与召回结果可以往返', () => {
  assert.equal(MEMORY_ACCOUNT_BANK, 'acct');
  assert.equal(MEMORY_GROUP_BANK_PREFIX, 'ws:');
  const catalog = roundtrip(
    bankCatalogSchema,
    {
      items: [
        { bank: MEMORY_ACCOUNT_BANK, displayName: '个人', entryCount: 40, state: 'available' },
        { bank: 'ws:group-1', displayName: '工作区', entryCount: 12, state: 'unreachable' },
      ],
      readAt: 1_700_000_000_000,
    },
    'bank 目录',
  );
  assert.equal(catalog.items.length, 2);
  expectReject(
    bankCatalogSchema,
    { items: [{ bank: 'acct', displayName: '个人', entryCount: 1, state: 'busy' }], readAt: 1 },
    '未知的查询状态',
  );
});

test('检索请求与结果按 schema 校验', () => {
  roundtrip(
    memoryRecallRequestSchema,
    { banks: ['acct', 'ws:group-1'], text: '上次的部署脚本', limit: 5, maxTokens: 512 },
    '检索请求',
  );
  expectReject(memoryRecallRequestSchema, { text: '' }, '空查询文本');
  expectReject(memoryRecallRequestSchema, { text: '问题', limit: 51 }, '条数超过上限');
  expectReject(memoryRecallRequestSchema, { text: '问题', banks: [] }, '空的 bank 范围');
  const result = roundtrip(
    memoryRecallResultSchema,
    {
      hits: [{ bank: 'acct', text: '部署脚本位于 scripts 目录', source: 'session-1', score: 0.82, at: 1_700_000_000_000 }],
      readAt: 1_700_000_100_000,
      degraded: false,
    },
    '检索结果',
  );
  assert.equal(result.hits.length, 1);
  const degraded = roundtrip(
    memoryRecallResultSchema,
    { hits: [], readAt: 1, degraded: true, code: 'memory-recall-timeout' },
    '降级的检索结果',
  );
  assert.equal(degraded.code, 'memory-recall-timeout');
  expectReject(
    memoryRecallResultSchema,
    { hits: [], readAt: 1, degraded: true, code: 'unknown-code' },
    '未登记的错误码',
  );
});

test('待写入与废弃记录只显示数量、时间与错误码', () => {
  const queue = roundtrip(
    memoryWriteQueueViewSchema,
    { pendingCount: 3, oldestPendingAt: 1_700_000_000_000, discardedCount: 1, lastErrorCode: 'memory-backend-unreachable' },
    '写入队列视图',
  );
  assertNoWatermark(queue, '写入队列视图');
  assert.deepEqual(Object.keys(queue).sort(), ['discardedCount', 'lastErrorCode', 'oldestPendingAt', 'pendingCount']);
  expectReject(memoryWriteQueueViewSchema, { pendingCount: -1, discardedCount: 0 }, '负的待写入数量');
});
