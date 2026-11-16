// 把参考仓库取到仓库根的 refer_repos/。
//
// 登记处是 `runtime/refer-repos.json`：目录名、上游地址、分支与固定提交都记在那里。
// 脚本按记录的提交取源码，换机器或删掉目录之后重跑就能得到同一份快照。
// `refer_repos/` 不纳入版本管理，读取约束见 `AGENTS.md` 的「参考目录」一节。
//
// 用法：
//   node scripts/clone-refer-repos.mjs                 取清单里的全部仓库
//   node scripts/clone-refer-repos.mjs --only ZCode    只取指定的，可重复
//   node scripts/clone-refer-repos.mjs --list          只打印清单，不取源码
//
// 已存在的仓库不重复克隆：HEAD 与记录相同则跳过，不同则补取记录的提交并切过去。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MANIFEST = resolve(import.meta.dirname, '..', 'refer-repos.json');
const TARGET = join(ROOT, 'refer_repos');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** 执行一条 git 命令。stderr 直接透传，进度与失败原因由 git 自己打印。 */
function git(args) {
  execFileSync('git', args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** 读一个仓库当前的 HEAD。 */
function headOf(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/**
 * 判断一个提交是否已在本地对象库里。
 *
 * 已经完整克隆的仓库里，目标提交通常就在本地，直接切过去即可；这类仓库不该因为
 * 切一次提交就被降级成浅克隆，所以取源码之前先看对象在不在。
 */
function hasCommit(dir, commit) {
  const result = spawnSync('git', ['-C', dir, 'cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  return result.status === 0;
}

/** 解析参数。 */
function parseArgs(argv) {
  const only = [];
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      list = true;
    } else if (arg === '--only') {
      const value = argv[i + 1];
      if (!value) throw new Error('--only 后面要跟目录名');
      only.push(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      const header = [];
      for (const line of readFileSync(import.meta.filename, 'utf8').split('\n')) {
        if (!line.startsWith('//')) break;
        header.push(line);
      }
      console.log(header.join('\n'));
      process.exit(0);
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  for (const name of only) {
    if (!manifest.repositories.some((entry) => entry.directory === name)) {
      throw new Error(`清单里没有 ${name}`);
    }
  }
  return { only, list };
}

const { only, list } = parseArgs(process.argv.slice(2));
const entries = manifest.repositories.filter((entry) => only.length === 0 || only.includes(entry.directory));

if (list) {
  for (const entry of entries) {
    console.log(`${entry.directory}  ${entry.commit.slice(0, 12)}  ${entry.url}`);
  }
  for (const item of manifest.manual ?? []) {
    console.log(`${item.directory}  人工放置  ${item.note}`);
  }
  process.exit(0);
}

let created = 0;
let switched = 0;
let skipped = 0;

for (const entry of entries) {
  const dir = join(TARGET, entry.directory);
  console.log(`\n==> ${entry.directory}`);

  if (existsSync(dir)) {
    if (!existsSync(join(dir, '.git'))) {
      throw new Error(`${dir} 已存在但不是 Git 仓库，先把它移走再跑`);
    }
    if (headOf(dir) === entry.commit) {
      console.log('    已在记录的提交上，跳过');
      skipped += 1;
      continue;
    }
    console.log(`    切到记录的提交 ${entry.commit.slice(0, 12)}`);
    if (!hasCommit(dir, entry.commit)) {
      git(['-C', dir, 'fetch', '--depth', '1', 'origin', entry.commit]);
    }
    git(['-C', dir, 'checkout', '--quiet', '--detach', entry.commit]);
    switched += 1;
  } else {
    console.log(`    取 ${entry.url}`);
    git(['init', '--quiet', dir]);
    git(['-C', dir, 'remote', 'add', 'origin', entry.url]);
    git(['-C', dir, 'fetch', '--depth', '1', 'origin', entry.commit]);
    git(['-C', dir, 'checkout', '--quiet', '--detach', entry.commit]);
    created += 1;
  }

  const head = headOf(dir);
  if (head !== entry.commit) {
    throw new Error(`${entry.directory} 的 HEAD 是 ${head}，与清单记录的 ${entry.commit} 不一致`);
  }
}

console.log(`\n新取 ${created} 个，切换提交 ${switched} 个，跳过 ${skipped} 个`);

const manual = manifest.manual ?? [];
if (manual.length > 0) {
  console.log('需要人工放置的目录：');
  for (const item of manual) {
    const present = existsSync(join(TARGET, item.directory));
    console.log(`  ${item.directory}  ${present ? '已存在' : item.note}`);
  }
}

if (!existsSync(join(TARGET, 'AGENTS.md'))) {
  console.log('refer_repos/AGENTS.md 缺失，按 AGENTS.md「参考目录」一节的规则重建该文件。');
}
