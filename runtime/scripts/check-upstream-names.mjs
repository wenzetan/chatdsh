// 上游包名的收拢检查。
//
// 上游内核发版频繁，包名改动会让补丁层与加载器条目静默失效：补丁层按 `name` 匹配
// 上游的行，名字写错时整条补丁被跳过，只是不生效。适配层 @chatdsh/adapter 是上游包名
// 与行 id 的唯一登记处（`UPSTREAM_PACKAGE_NAMES`），本脚本核对本仓库各处出现的上游包名
// 都在登记处出现过。
//
// 覆盖三处：
//   1. 源码里的字符串字面量（`packages/**/src/**`）
//   2. 补丁层里的 `name:` 字段（`packages/**/cordis.patch.yml`、`profiles/**/cordis.patch.yml`）
//   3. 客户端插件的 `dsh.client.inject` 列表（`packages/clients/**/package.json`）
//
// 适配层自身的源码不参与检查：它就是登记处。
//
// 用法：node scripts/check-upstream-names.mjs
// 退出码 0 表示各处上游包名都已在适配层登记。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ADAPTER = resolve(ROOT, '..', 'chatdsn-adapter');

/** 上游包名的形状：@deepseek-ai/ 后跟小写字母与连字符。 */
const UPSTREAM_NAME = /@deepseek-ai\/[a-z][a-z0-9-]*/g;

/**
 * 读适配层的登记表。
 *
 * 适配层是独立仓库，登记表编译在它的 lib/upstream.js 里。读编译产物而不是源码，
 * 保证核对的是实际会随包发布出去的那一份。
 */
async function readRegistry() {
  const file = join(ADAPTER, 'lib', 'upstream.js');
  if (!existsSync(file)) {
    throw new Error(`适配层尚未编译，找不到 ${file}；先在 chatdsn-adapter 目录执行 npm run build`);
  }
  const module = await import(file);
  const names = module.UPSTREAM_PACKAGE_NAMES;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`${file} 没有导出 UPSTREAM_PACKAGE_NAMES`);
  }
  return new Set(names);
}

/** 收集目录下的文件路径。 */
function filesUnder(dir, filter) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (filter(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const registry = await readRegistry();
const failures = [];

/** 核对一处文本里的上游包名。 */
function checkText(file, text) {
  for (const match of text.matchAll(UPSTREAM_NAME)) {
    const name = match[0];
    if (!registry.has(name)) {
      failures.push(`${relative(ROOT, file)} 里的 ${name} 没有在适配层登记`);
    }
  }
}

// 1. 源码里的字面量
for (const file of filesUnder(join(ROOT, 'packages'), (path) => path.endsWith('.ts') || path.endsWith('.tsx'))) {
  checkText(file, readFileSync(file, 'utf8'));
}

// 2. 补丁层里的 name 字段。扫描范围限于受版本管理的三个位置：组合包、profile、验收 profile。
for (const dir of [join(ROOT, 'packages'), join(ROOT, 'profiles'), join(ROOT, 'e2e', 'profiles')]) {
  for (const file of filesUnder(dir, (path) => path.endsWith('cordis.patch.yml'))) {
    checkText(file, readFileSync(file, 'utf8'));
  }
}

// 3. 客户端插件的 inject 列表
for (const file of filesUnder(join(ROOT, 'packages', 'clients'), (path) => path.endsWith('package.json'))) {
  checkText(file, readFileSync(file, 'utf8'));
}

console.log(`适配层登记的上游包名 ${registry.size} 个`);
if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('上游包名收拢检查通过');
process.exit(0);
