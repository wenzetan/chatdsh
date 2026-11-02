// 制品版本契约的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-artifacts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_PREVIEW_MODES,
  artifactDeleteScopeSchema,
  artifactPreviewSchema,
  artifactVersionListSchema,
  artifactVersionRefSchema,
  artifactVersionSchema,
} from '../../packages/core/contracts/lib/index.js';
import { expectReject, roundtrip } from './client-complete-wp01-support.mjs';

const VERSION = {
  artifactId: 'artifact-1',
  version: 1,
  mimeType: 'text/markdown',
  size: 2048,
  createdAt: 1_700_000_000_000,
  immutable: true,
  sourceSessionId: 'session-1',
  sourceTurn: 2,
  downloadable: true,
};

test('制品版本不可改写且保留来源', () => {
  const version = roundtrip(artifactVersionSchema, VERSION, '制品版本');
  assert.equal(version.immutable, true);
  assert.equal(version.sourceTurn, 2);
  expectReject(artifactVersionSchema, { ...VERSION, immutable: false }, '历史版本被标记为可改写');
  expectReject(artifactVersionSchema, { ...VERSION, version: 0 }, '版本号为零');
  expectReject(artifactVersionSchema, { ...VERSION, sourceSessionId: undefined }, '缺少来源会话');
});

test('版本引用由制品标识与版本号配对', () => {
  roundtrip(artifactVersionRefSchema, { artifactId: 'artifact-1', version: 2 }, '版本引用');
  expectReject(artifactVersionRefSchema, { artifactId: 'artifact-1' }, '缺少版本号');
  expectReject(artifactVersionRefSchema, { version: 2 }, '缺少制品标识');
});

test('版本列表要求当前版本在列表内且属于同一制品', () => {
  const list = roundtrip(
    artifactVersionListSchema,
    {
      artifactId: 'artifact-1',
      currentVersion: 2,
      versions: [VERSION, { ...VERSION, version: 2, size: 4096, createdAt: 1_700_000_100_000 }],
    },
    '版本列表',
  );
  assert.equal(list.versions.length, 2);
  expectReject(
    artifactVersionListSchema,
    { artifactId: 'artifact-1', currentVersion: 3, versions: [VERSION] },
    '当前版本不在列表里',
  );
  expectReject(
    artifactVersionListSchema,
    { artifactId: 'artifact-1', currentVersion: 1, versions: [VERSION, { ...VERSION, artifactId: 'artifact-2', version: 2 }] },
    '混入其他制品的版本',
  );
  expectReject(artifactVersionListSchema, { artifactId: 'artifact-1', currentVersion: 1, versions: [] }, '空版本列表');
});

test('删除范围列出全部版本与占用空间', () => {
  const scope = roundtrip(
    artifactDeleteScopeSchema,
    {
      artifactId: 'artifact-1',
      allVersions: true,
      versions: [1, 2],
      affectedVersions: [1, 2],
      totalBytes: 6144,
      requiresConfirm: true,
    },
    '删除范围',
  );
  assert.equal(scope.totalBytes, 6144);
  expectReject(
    artifactDeleteScopeSchema,
    { artifactId: 'artifact-1', allVersions: true, versions: [1, 2], affectedVersions: [1, 2], totalBytes: 6144 },
    '删除范围缺少确认标记',
  );
  expectReject(
    artifactDeleteScopeSchema,
    { artifactId: 'artifact-1', allVersions: true, versions: [], affectedVersions: [], totalBytes: 0, requiresConfirm: true },
    '删除范围没有涉及版本',
  );
});

test('受限预览禁用脚本与宿主访问', () => {
  const preview = roundtrip(
    artifactPreviewSchema,
    { mode: 'html-sandbox', scriptAllowed: false, hostBridgeAllowed: false, formSubmitAllowed: false },
    '受限预览',
  );
  assert.equal(preview.hostBridgeAllowed, false);
  assert.ok(ARTIFACT_PREVIEW_MODES.includes('download-only'));
  expectReject(
    artifactPreviewSchema,
    { mode: 'html-sandbox', scriptAllowed: true, hosstBridgeAllowed: false, formSubmitAllowed: false },
    '允许脚本执行',
  );
  expectReject(
    artifactPreviewSchema,
    { mode: 'html-sandbox', scriptAllowed: false, hostBridgeAllowed: true, formSubmitAllowed: false },
    '允许宿主桥访问',
  );
  expectReject(
    artifactPreviewSchema,
    { mode: 'rich-text', scriptAllowed: false, hostBridgeAllowed: false, formSubmitAllowed: false },
    '未知的预览方式',
  );
});
