// 设置版本、作用范围与冲突契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-settings.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_RESOLUTIONS,
  SETTINGS_SCOPES,
  SETTINGS_SECTIONS,
  SENSITIVE_VALUE_MARKERS,
  settingsConflictSchema,
  settingsFieldConflictSchema,
  settingsPatchSchema,
  settingsResolutionSchema,
  settingsSnapshotSchema,
  settingsWriteResultSchema,
} from '../../packages/core/contracts/lib/index.js';
import { expectReject, roundtrip } from './client-complete-wp01-support.mjs';

const SNAPSHOT = {
  section: 'models',
  scope: 'deployment',
  revision: 6,
  values: { defaultModel: 'deepseek-v4', reasoningEffort: 'medium' },
  updatedAt: 1_700_000_000_000,
};

test('设置快照携带区段、范围与版本', () => {
  const snapshot = roundtrip(settingsSnapshotSchema, SNAPSHOT, '设置快照');
  assert.equal(snapshot.revision, 6);
  assert.deepEqual([...SETTINGS_SCOPES], ['deployment', 'device', 'client']);
  assert.ok(SETTINGS_SECTIONS.includes('diagnostics'));
  expectReject(settingsSnapshotSchema, { ...SNAPSHOT, section: 'billing' }, '未知的设置区段');
  expectReject(settingsSnapshotSchema, { ...SNAPSHOT, scope: 'account' }, '未知的设置作用范围');
  expectReject(settingsSnapshotSchema, { section: 'models', scope: 'deployment', values: {}, updatedAt: 1 }, '缺少 revision');
});

test('设备范围的设置必须携带设备标识', () => {
  roundtrip(
    settingsPatchSchema,
    { section: 'runtime', scope: 'device', deviceId: 'device-1', revision: 3, fields: { terminal: 'kitty' } },
    '设备范围设置写入',
  );
  expectReject(
    settingsPatchSchema,
    { section: 'runtime', scope: 'device', revision: 3, fields: { terminal: 'kitty' } },
    '设备范围缺少设备标识',
  );
  expectReject(
    settingsPatchSchema,
    { section: 'models', scope: 'deployment', deviceId: 'device-1', revision: 3, fields: { defaultModel: 'x' } },
    '非设备范围携带了设备标识',
  );
  expectReject(
    settingsPatchSchema,
    { section: 'models', scope: 'deployment', revision: 3, fields: {} },
    '空的字段变更',
  );
  expectReject(
    settingsPatchSchema,
    { section: 'models', scope: 'deployment', fields: { defaultModel: 'x' } },
    '缺少 revision',
  );
});

test('敏感字段的冲突只比较配置状态', () => {
  const plain = roundtrip(
    settingsFieldConflictSchema,
    { field: 'defaultModel', sensitive: false, userValue: 'deepseek-v4', serverValue: 'deepseek-v3' },
    '普通字段冲突',
  );
  assert.equal(plain.sensitive, false);
  const sensitive = roundtrip(
    settingsFieldConflictSchema,
    { field: 'apiKeyEnv', sensitive: true, userValue: 'configured', serverValue: 'unset' },
    '敏感字段冲突',
  );
  assert.equal(sensitive.userValue, 'configured');
  assert.deepEqual([...SENSITIVE_VALUE_MARKERS], ['configured', 'unset']);
  expectReject(
    settingsFieldConflictSchema,
    { field: 'apiKeyEnv', sensitive: true, userValue: 'sk-secret-value', serverValue: 'unset' },
    '敏感字段带原值',
  );
  expectReject(
    settingsFieldConflictSchema,
    { field: 'defaultModel', sensitive: 'no', userValue: 'a', serverValue: 'b' },
    '敏感标记类型不符',
  );
});

test('冲突视图包含作用设备与逐字段冲突', () => {
  const conflict = roundtrip(
    settingsConflictSchema,
    {
      section: 'runtime',
      scope: 'device',
      deviceId: 'device-1',
      changedAt: 1_700_000_000_000,
      currentRevision: 8,
      fields: [
        { field: 'terminal', sensitive: false, userValue: 'kitty', serverValue: 'alacritty' },
        { field: 'apiKeyEnv', sensitive: true, userValue: 'configured', serverValue: 'unset' },
      ],
    },
    '设置冲突',
  );
  assert.equal(conflict.currentRevision, 8);
  expectReject(settingsConflictSchema, { ...conflict, fields: [] }, '没有字段的冲突');
  expectReject(settingsConflictSchema, { ...conflict, currentRevision: undefined }, '缺少服务端版本');
});

test('逐字段解决方式有界', () => {
  roundtrip(settingsResolutionSchema, { field: 'terminal', resolution: 'server' }, '采用服务器值');
  assert.deepEqual([...SETTINGS_RESOLUTIONS], ['server', 'user', 'reload', 'cancel']);
  expectReject(settingsResolutionSchema, { field: 'terminal', resolution: 'overwrite' }, '未知的解决方式');
  expectReject(settingsResolutionSchema, { resolution: 'server' }, '缺少字段名');
});

test('设置写入结果区分落定、冲突与拒绝', () => {
  const applied = roundtrip(
    settingsWriteResultSchema,
    { outcome: 'applied', revision: 9, fields: ['terminal'] },
    '设置写入成功',
  );
  assert.equal(applied.revision, 9);
  const conflict = roundtrip(
    settingsWriteResultSchema,
    {
      outcome: 'conflict',
      conflict: {
        section: 'models',
        scope: 'deployment',
        changedAt: 1,
        currentRevision: 10,
        fields: [{ field: 'defaultModel', sensitive: false, userValue: 'a', serverValue: 'b' }],
      },
    },
    '设置写入冲突',
  );
  assert.equal(conflict.conflict.currentRevision, 10);
  const stale = roundtrip(
    settingsWriteResultSchema,
    { outcome: 'rejected', code: 'revision-conflict' },
    '过期版本被拒绝',
  );
  assert.equal(stale.code, 'revision-conflict');
  const readonly = roundtrip(
    settingsWriteResultSchema,
    { outcome: 'rejected', code: 'settings-readonly', fields: ['serverPort'] },
    '只读字段被拒绝',
  );
  assert.deepEqual([...readonly.fields], ['serverPort']);
  expectReject(settingsWriteResultSchema, { outcome: 'conflict' }, '冲突结果缺少冲突视图');
  expectReject(settingsWriteResultSchema, { outcome: 'rejected', code: 'unknown-code' }, '未登记的错误码');
  expectReject(settingsWriteResultSchema, { outcome: 'saved', revision: 1, fields: [] }, '未知的结果种类');
});
