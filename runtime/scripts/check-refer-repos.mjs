// 参考项目清单的一致性检查。
//
// `runtime/refer-repos.json` 是参考项目的登记处：目录名、上游地址、分支与固定提交。
// 根 `README.md` 的「参考项目」一节是同一份清单的人读版本。两处各写一份，加仓库或
// 换固定提交时容易只改一处，本脚本比对它们，并核对本机已取到的仓库停在记录的提交上。
//
// 用法：node scripts/check-refer-repos.mjs
// 退出码 0 表示两处目录集合一致，且本机已存在的参考仓库都在记录的提交上。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MANIFEST = resolve(import.meta.dirname, '..', 'refer-repos.json');
const TARGET = join(ROOT, 'refer_repos');
const README = join(ROOT, 'README.md');

/** 根 README 里本地快照表的表头。改动那张表的列顺序要同步改这里。 */
const HEADER = '| 目录 | 上游 | 作用 |';

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const failures = [];

/** 读根 README 的表格首列。 */
function readReadmeDirectories() {
  const lines = readFileSync(README, 'utf8').split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === HEADER);
  if (headerIndex < 0) {
    throw new Error(`根 README 里找不到表头「${HEADER}」`);
  }
  const directories = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    const first = line.split('|')[1] ?? '';
    directories.push(first.trim().replace(/`/g, ''));
  }
  return directories;
}

const readmeDirectories = readReadmeDirectories();
const manifestDirectories = [
  ...manifest.repositories.map((entry) => entry.directory),
  ...(manifest.manual ?? []).map((item) => item.directory),
];

for (const name of manifestDirectories) {
  if (!readmeDirectories.includes(name)) failures.push(`${name} 在清单里，但根 README 的表格里没有`);
}
for (const name of readmeDirectories) {
  if (!manifestDirectories.includes(name)) failures.push(`${name} 在根 README 的表格里，但清单里没有`);
}

let present = 0;
for (const entry of manifest.repositories) {
  const dir = join(TARGET, entry.directory);
  if (!existsSync(join(dir, '.git'))) continue;
  present += 1;
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== entry.commit) {
    failures.push(`${entry.directory} 停在 ${head.slice(0, 12)}，清单记录的是 ${entry.commit.slice(0, 12)}`);
  }
}

console.log(`清单登记 ${manifest.repositories.length} 个可克隆仓库与 ${(manifest.manual ?? []).length} 个人工放置目录，本机已取到 ${present} 个`);
if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('参考项目清单检查通过');
process.exit(0);
