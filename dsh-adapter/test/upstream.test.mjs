import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UPSTREAM_BUNDLES,
  UPSTREAM_CLIENT_UI,
  UPSTREAM_PACKAGE_NAMES,
} from '../lib/upstream.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
});

test('登记的上游包在 DSH 安装里存在', (t) => {
  const root = projectedRoot();
  if (root === undefined) {
    t.skip('缺少 .dsh-deps 投影，先运行 node scripts/link-dsh-deps.mjs');
    return;
  }
  const missing = UPSTREAM_PACKAGE_NAMES
    .map((name) => ({ name, root: name.split('/').slice(0, 2).join('/').replace('@deepseek-ai/', '') }))
    .filter(({ root: packageRoot }) => !existsSync(join(root, packageRoot)))
    .map(({ name }) => name);
  assert.deepEqual(missing, [], `这些上游包在 DSH 安装里不存在：${missing.join('、')}`);
});
