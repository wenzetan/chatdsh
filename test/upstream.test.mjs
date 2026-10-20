// 上游包名登记处的单元测试。
//
// 登记的上游包名写错时，补丁层与加载器条目只会被静默跳过，不报错。测试对照 DSH 安装里
// 实际存在的包核对，让错误在构建期暴露。
//
// 运行：node --test test/upstream.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UPSTREAM_AGENT_ROWS,
  UPSTREAM_BUNDLES,
  UPSTREAM_CLIENT_UI,
  UPSTREAM_MCP_CLIENT,
  UPSTREAM_PACKAGE_NAMES,
  UPSTREAM_ROWS,
  UPSTREAM_TOOL_ROWS,
} from '../lib/upstream.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 找到 DSH 安装里依赖投影的目录。
 *
 * 投影由 scripts/link-dsh-deps.mjs 生成。找不到时跳过存在性核对：这一层需要 DSH 安装
 * 才能跑，缺少安装属于环境未就绪，不该被报成包名写错。
 */
function projectedRoot() {
  const path = join(ROOT, '.dsh-deps', '@deepseek-ai');
  return existsSync(path) ? path : undefined;
}

test('登记的上游包名没有重复', () => {
  assert.equal(new Set(UPSTREAM_PACKAGE_NAMES).size, UPSTREAM_PACKAGE_NAMES.length);
});

test('每一类登记都非空', () => {
  assert.ok(Object.keys(UPSTREAM_BUNDLES).length > 0);
  assert.ok(Object.keys(UPSTREAM_CLIENT_UI).length > 0);
  assert.ok(Object.keys(UPSTREAM_TOOL_ROWS).length > 0);
  assert.ok(Object.keys(UPSTREAM_AGENT_ROWS).length > 0);
  assert.ok(Object.keys(UPSTREAM_ROWS).length > 0);
  assert.ok(UPSTREAM_MCP_CLIENT.length > 0);
});

test('登记的上游包在 DSH 安装里存在', (t) => {
  const root = projectedRoot();
  if (root === undefined) {
    t.skip('缺少 .dsh-deps 投影，先运行 node scripts/link-dsh-deps.mjs');
    return;
  }
  const missing = UPSTREAM_PACKAGE_NAMES
    .map((name) => name.replace('@deepseek-ai/', ''))
    .filter((name) => !existsSync(join(root, name)));
  assert.deepEqual(missing, [], `这些上游包在 DSH 安装里不存在：${missing.join('、')}`);
});
