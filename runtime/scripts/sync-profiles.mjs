// 把仓库里的 profile 接到 DSH 的数据根上。
//
// DSH 按名寻找 `$DSH_HOME/profiles/<name>`。仓库里的 `profiles/<name>` 就是这些目录的源，
// 本脚本用符号链接把它们接进数据根，使 profile 的依赖声明与补丁层始终是仓库里的那一份，
// 不在数据根留下会与仓库分叉的副本。
//
// 用法：node scripts/sync-profiles.mjs [--check] [--install]
//   --check    只报告将建立或需要修正的链接，不写入。
//   --install  建立链接后，在每个 profile 目录里执行一次 pnpm install。
//
// 环境变量：DSH_HOME 指定数据根，缺省用 ~/.dsh。

import { mkdir, readdir, readlink, rm, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES = join(ROOT, 'profiles');
const CHECK = process.argv.includes('--check');
const INSTALL = process.argv.includes('--install');
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const TARGET = join(HOME, 'profiles');
const run = promisify(execFile);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!await exists(PROFILES)) {
  console.log('仓库里还没有 profiles 目录。');
  process.exit(0);
}

const names = [];
for (const entry of await readdir(PROFILES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (await exists(join(PROFILES, entry.name, 'package.json'))) names.push(entry.name);
}
names.sort();

if (names.length === 0) {
  console.log('profiles 目录下还没有 profile。');
  process.exit(0);
}

if (!CHECK) await mkdir(TARGET, { recursive: true });

const linked = [];
const skipped = [];
for (const name of names) {
  const source = join(PROFILES, name);
  const link = join(TARGET, name);
  if (CHECK) {
    linked.push(`${name} -> ${source}`);
    continue;
  }
  let current;
  try {
    current = await readlink(link);
  } catch {
    current = undefined;
  }
  if (current === source) {
    skipped.push(name);
    continue;
  }
  if (current !== undefined) await rm(link, { force: true });
  else if (await exists(link)) {
    throw new Error(`${link} 已存在且不是符号链接，请先自行处理，本脚本不覆盖真实目录`);
  }
  await symlink(source, link, 'dir');
  linked.push(`${name} -> ${source}`);
}

console.log(`${CHECK ? '将建立' : '已建立'} ${linked.length} 个 profile 链接，${skipped.length} 个已是最新；数据根 ${HOME}`);
for (const line of linked) console.log(`  ${line}`);

if (INSTALL && !CHECK) {
  for (const name of names) {
    const dir = join(PROFILES, name);
    console.log(`安装 ${name} 的依赖…`);
    await run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: dir, env: { ...process.env, CI: 'true' } });
  }
}
