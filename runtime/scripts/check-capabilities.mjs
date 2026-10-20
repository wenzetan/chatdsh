#!/usr/bin/env node
// 上游能力处置清单的核对。
//
// 依据 docs/upstream-capabilities.md 的表格，核对两件事：
//   1. 补丁层里被 `disabled: true` 关掉的行，清单必须登记为「禁用」或「受限挂载」；
//   2. 清单标为「禁用」的行，任何补丁层提到它时都必须禁用，不允许某处又打开。
//
// 另外核对清单里的上游包名都在适配层的登记表里，包名写错时能在这里发现。
//
// 用法：node scripts/check-capabilities.mjs
// 退出码 0 表示一致，1 表示存在漂移。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(import.meta.filename), '..');
const DOC = join(ROOT, 'docs', 'upstream-capabilities.md');
const REGISTRY = resolve(ROOT, '..', 'dsh-adapter', 'lib', 'upstream.js');

const failures = [];

if (!existsSync(DOC)) {
  console.error(`缺少能力清单：${DOC}`);
  process.exit(1);
}

/** 清单里的一行：行 id、包名与处置。 */
function docRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\|\s*`([A-Za-z0-9_-]+)`\s*\|\s*`([^`]+)`\s*\|\s*(保留|禁用|受限挂载|可选未装|实验性)\s*\|/);
    if (match === null) continue;
    rows.push({ id: match[1], pkg: match[2], disposition: match[3] });
  }
  return rows;
}

/** 收集补丁文件里的条目：行 id 与被禁用状态。 */
function patchEntries() {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === 'cordis.patch.yml') files.push(full);
    }
  };
  walk(join(ROOT, 'packages'));
  walk(join(ROOT, 'profiles'));
  walk(join(ROOT, 'e2e', 'profiles'));

  const entries = [];
  for (const file of files) {
    let current;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const idMatch = line.match(/^\s*-\s+id:\s*(\S+)\s*$/);
      if (idMatch !== null) {
        current = { id: idMatch[1], file, disabled: false };
        entries.push(current);
        continue;
      }
      if (current !== undefined && /^\s*disabled:\s*true\s*$/.test(line)) current.disabled = true;
    }
  }
  return entries;
}

const rows = docRows(readFileSync(DOC, 'utf8'));
if (rows.length === 0) failures.push('能力清单里没有解析出任何行，检查表格格式');

const byId = new Map(rows.map((row) => [row.id, row]));
const entries = patchEntries();

for (const entry of entries) {
  if (!entry.disabled) continue;
  const row = byId.get(entry.id);
  if (row === undefined) {
    failures.push(`${entry.file} 禁用了 ${entry.id}，能力清单里没有这一行`);
    continue;
  }
  if (row.disposition !== '禁用' && row.disposition !== '受限挂载') {
    failures.push(`能力清单把 ${entry.id} 登记为「${row.disposition}」，但补丁层把它禁用了`);
  }
}

for (const row of rows) {
  if (row.disposition !== '禁用') continue;
  for (const entry of entries) {
    if (entry.id !== row.id || entry.disabled) continue;
    failures.push(`能力清单把 ${row.id} 标为禁用，但 ${entry.file} 提到了它却没有禁用`);
  }
}

if (existsSync(REGISTRY)) {
  const { UPSTREAM_PACKAGE_NAMES } = await import(REGISTRY);
  const registered = new Set(UPSTREAM_PACKAGE_NAMES);
  for (const row of rows) {
    if (!row.pkg.startsWith('@deepseek-ai/')) continue;
    if (!registered.has(row.pkg)) failures.push(`能力清单里的 ${row.pkg} 没有在适配层登记`);
  }
} else {
  failures.push(`适配层尚未编译：${REGISTRY}`);
}

console.log(`能力清单 ${rows.length} 行；补丁条目 ${entries.length} 个，其中禁用 ${entries.filter((entry) => entry.disabled).length} 个`);
if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('能力处置清单核对通过');
