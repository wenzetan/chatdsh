// DSH 内核跟进脚本。
//
// 上游依赖在清单里使用 next 或 latest 发布标签，本脚本不改写版本号。默认只打印计划，
// 带 --apply 才更新各 profile 的依赖并执行构建与静态检查。
//
// 用法：
//   node scripts/upgrade-dsh.mjs --dry-run
//   node scripts/upgrade-dsh.mjs --apply
//
// 退出码 0 表示计划打印完成或全部步骤成功，1 表示任一步骤失败。

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(ROOT, '..');
const ADAPTER = join(REPO, 'dsh-adapter');
const APPLY = process.argv.includes('--apply');
const DSH_BIN = dshCommand();

/** 读当前 DSH 版本。 */
function currentVersion() {
  return execFileSync(DSH_BIN, ['--version'], { encoding: 'utf8' }).trim();
}

/** 找出使用发布标签的上游依赖所在的 profile。 */
function taggedProfiles() {
  const groups = ['profiles', 'e2e/profiles'];
  const result = [];
  for (const group of groups) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(ROOT, group, entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const names = Object.entries(manifest.dependencies ?? {})
        .filter(([name, range]) => (name.startsWith('@deepseek-ai/') || name.startsWith('@deepseek-harness-tui/')) && (range === 'next' || range === 'latest'))
        .map(([name]) => name);
      if (names.length > 0) result.push({ dir, names });
    }
  }
  return result;
}

/** 五步计划。 */
function plan(current, profiles) {
  return [
    { id: 1, title: `读当前版本：${current}；DSH 跟随 next，dsh-tui 跟随 latest` },
    { id: 2, title: `更新 ${profiles.length} 个 profile 里的上游发布标签依赖` },
    { id: 3, title: '按补丁警告更新 dsh-adapter/src/upstream.ts 的登记与对应补丁层' },
    { id: 4, title: '构建适配层：pnpm --dir dsh-adapter build' },
    { id: 5, title: '构建运行时并执行组合、包名、安装面与能力检查' },
  ];
}

/** pnpm 的入口：跟随运行本脚本的那个 pnpm，缺省用 PATH 里的 pnpm。 */
function pnpmEntry() {
  const fromEnv = process.env.npm_execpath;
  return fromEnv === undefined ? 'pnpm' : resolve(fromEnv);
}

/** 跑一条子命令，失败即抛。 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${String(result.status)}`);
}

/** 用 pnpm 跑一个命令。 */
function pnpm(args, cwd) {
  const entry = pnpmEntry();
  if (entry === 'pnpm') run('pnpm', args, cwd);
  else run(process.execPath, [entry, ...args], cwd);
}

const current = currentVersion();
const profiles = taggedProfiles();
for (const step of plan(current, profiles)) console.log(`[${step.id}/5] ${step.title}`);
if (!APPLY) {
  console.log('只打印计划，未更新依赖；要执行请加 --apply。');
  process.exit(0);
}

for (const profile of profiles) {
  console.log(`[2/5] 更新 ${profile.dir}`);
  pnpm(['update', '--latest', ...profile.names], profile.dir);
}
console.log('[3/5] 登记表与补丁层由构建和组合检查核对；存在警告时按实际行 id 更新');
console.log('[4/5] 构建适配层');
pnpm(['build'], ADAPTER);
console.log('[5/5] 构建运行时并核对上游组合');
pnpm(['build'], ROOT);
pnpm(['check:upstream-names'], ROOT);
pnpm(['check:surface'], ROOT);
pnpm(['check:capabilities'], ROOT);
pnpm(['check:composition'], ROOT);

console.log('DSH 跟进检查完成。');
