// 上游安装面与登记表的核对。
//
// check-upstream-names 核对「本仓库写的上游名字都在登记表里」，这个脚本核对反过来的一侧：
//   1. 登记表里的每个包在 DSH 安装里真实存在（可选未装的提供方组合包在允许清单里豁免）；
//   2. 每个补丁条目的 `name:` 都能在登记表里找到来源；
//   3. 能力清单的每一行要么在补丁层里出现，要么是登记表里的行 id。
//
// 用法：node scripts/check-upstream-surface.mjs [--allow-missing a,b]
// 退出码 0 表示三侧一致，1 表示存在漂移。

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ADAPTER = resolve(ROOT, '..', 'dsh-adapter');
const DOC = join(ROOT, 'docs', 'upstream-capabilities.md');

/** 允许未安装的提供方组合包：它们按需装入 profile，不进默认安装。 */
const DEFAULT_OPTIONAL = [
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
  '@deepseek-ai/dsh-subagent-acp',
  '@deepseek-ai/dsh-subagent-dsh-sdk',
];

/** 解析 --allow-missing。 */
function optionalNames() {
  const index = process.argv.indexOf('--allow-missing');
  if (index < 0) return new Set(DEFAULT_OPTIONAL);
  const value = process.argv[index + 1] ?? '';
  return new Set([...DEFAULT_OPTIONAL, ...value.split(',').map((item) => item.trim()).filter(Boolean)]);
}

/** 定位 DSH 安装里的 @deepseek-ai 目录。 */
function dshScope() {
  // DSH 自己的包是安装根下的 @deepseek-ai/dsh；上游的其余包装在它的 node_modules 里。
  // 安装根可从 dsh 可执行文件的真实路径上两级得到（bin 指向 <安装根>/lib/bin.js）。
  const candidates = [];
  if (process.env.CHATDSH_DSH_INSTALL !== undefined) candidates.push(resolve(process.env.CHATDSH_DSH_INSTALL));
  if (process.env.DSH_BIN !== undefined) {
    candidates.push(resolve(realpathSync(process.env.DSH_BIN), '..', '..'));
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const bin = join(dir, 'dsh');
    if (!existsSync(bin)) continue;
    candidates.push(resolve(realpathSync(bin), '..', '..'));
  }
  for (const install of candidates) {
    // 两种布局都要认：安装根本身的 node_modules，以及 DSH 包自己的 node_modules。
    for (const scope of [
      join(install, 'node_modules', '@deepseek-ai'),
      join(install, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    ]) {
      if (existsSync(scope)) return scope;
    }
  }
  throw new Error('找不到 DSH 安装；设置 CHATDSH_DSH_INSTALL 或把 dsh 加进 PATH');
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

const registry = await import(join(ADAPTER, 'lib', 'upstream.js'));
const registered = new Set(registry.UPSTREAM_PACKAGE_NAMES);
const optional = optionalNames();
const failures = [];

const installed = new Set(readdirSync(dshScope()).map((name) => `@deepseek-ai/${name}`));
for (const name of registered) {
  if (installed.has(name) || optional.has(name)) continue;
  failures.push(`登记表里的 ${name} 在 DSH 安装里不存在，也不在可选清单里`);
}

// 补丁层：每个 `name:` 必须能在登记表里找到来源。
const patchFiles = [
  ...filesUnder(join(ROOT, 'packages'), (path) => path.endsWith('cordis.patch.yml')),
  ...filesUnder(join(ROOT, 'profiles'), (path) => path.endsWith('cordis.patch.yml')),
  ...filesUnder(join(ROOT, 'e2e', 'profiles'), (path) => path.endsWith('cordis.patch.yml')),
];
let patchRows = 0;
for (const file of patchFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/name:\s*'(@deepseek-ai\/[^']+)'/g)) {
    patchRows += 1;
    if (!registered.has(match[1])) failures.push(`${file} 的补丁行引用了没登记的 ${match[1]}`);
  }
}

// 能力清单：每行的 id 要么在登记表里，要么在补丁层里出现过。
// 能力清单里有一批能力直接挂在上游组合包（dsh-base）里，没有单独的行 id 登记，
// 这些能力由登记过的包名本身证明来源：按包名反查登记表。
const registeredByPackage = new Set(registered);
const knownIds = new Set([
  ...Object.keys(registry.UPSTREAM_ROWS),
  ...Object.keys(registry.UPSTREAM_TOOL_ROWS),
  ...Object.keys(registry.UPSTREAM_AGENT_ROWS),
  // 能力清单第一列是行 id，第三列是包名；没有行 id 登记的行用包名判定。
  ...(registry.UPSTREAM_PACKAGE_NAMES ?? []).map((name) => name.replace('@deepseek-ai/', '')),
]);
const patchIds = new Set();
for (const file of patchFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)) patchIds.add(match[1]);
}
const capabilityRows = readFileSync(DOC, 'utf8').split('\n').filter((line) => /^\|\s*`[A-Za-z0-9_-]+`\s*\|\s*`[^`]+`\s*\|\s*(保留|禁用|受限挂载|可选未装|实验性)\s*\|/.test(line));
for (const line of capabilityRows) {
  const id = /^\|\s*`([A-Za-z0-9_-]+)`/.exec(line)?.[1];
  if (id === undefined) continue;
  if (knownIds.has(id) || patchIds.has(id)) continue;
  const pkg = new RegExp('^\\|\\s*`' + id + '`\\s*\\|\\s*`([^`]+)`').exec(line)?.[1];
  if (pkg !== undefined && registeredByPackage.has(pkg)) continue;
  failures.push(`能力清单的 ${id} 既不在登记表里，也不在任何补丁层里`);
}

console.log(`实装包 ${installed.size} 个，登记 ${registered.size} 个，可选 ${optional.size} 个`);
console.log(`补丁文件 ${patchFiles.length} 个，补丁行 ${patchRows} 个`);
console.log(`能力清单 ${capabilityRows.length} 行`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const item of failures) console.log(`  ${item}`);
  process.exit(1);
}
console.log('上游安装面核对通过');
