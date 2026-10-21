// DSH 内核升级脚本。
//
// 升级顺序固定：先改适配层的版本声明与实现，再让业务包跟上。默认只打印计划（--dry-run），
// 带 --apply 才写文件。版本号由 --to 给出，缺省取 `dsh --version`。
//
// 用法：
//   node scripts/upgrade-dsh.mjs --dry-run            # 打印当前版本与五步计划
//   node scripts/upgrade-dsh.mjs --to 0.3.0-rc.1      # 改文件
//   node scripts/upgrade-dsh.mjs --to 0.3.0-rc.1 --dry-run
//
// 退出码 0 表示计划打印完成或全部步骤成功，1 表示任一步骤失败。

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(ROOT, '..');
const ADAPTER = join(REPO, 'dsh-adapter');
const APPLY = process.argv.includes('--apply');
const TO_INDEX = process.argv.indexOf('--to');
const TO = TO_INDEX < 0 ? undefined : process.argv[TO_INDEX + 1];
const DSH_BIN = process.env.DSH_BIN ?? 'dsh';

/** 读当前 DSH 版本。 */
function currentVersion() {
  return execFileSync(DSH_BIN, ['--version'], { encoding: 'utf8' }).trim();
}

/** 五步计划。 */
function plan(target, current) {
  return [
    { id: 1, title: `读当前版本：${current}` },
    { id: 2, title: `改 dsh-adapter/package.json 的 engines.dsh 与 ${String(precisePeerCount())} 个精确版本 peer：${target}` },
    { id: 3, title: '改 dsh-adapter/src/upstream.ts 的登记（仅在上游改名时）' },
    { id: 4, title: '构建适配层：pnpm --dir dsh-adapter build' },
    { id: 5, title: '构建运行时并核对上游包名：pnpm build 与 check:upstream-names' },
  ];
}

/** 精确版本 peer 的数量。 */
function precisePeerCount() {
  const manifest = JSON.parse(readFileSync(join(ADAPTER, 'package.json'), 'utf8'));
  return Object.keys(manifest.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/')).length;
}

/** 把适配层清单里的版本替换掉。 */
function rewriteManifest(target) {
  const path = join(ADAPTER, 'package.json');
  const text = readFileSync(path, 'utf8');
  const manifest = JSON.parse(text);
  manifest.engines = { ...(manifest.engines ?? {}), dsh: target };
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) manifest.peerDependencies[name] = target;
  }
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  JSON.parse(next);
  writeFileSync(path, next);
}

/** pnpm 的入口：跟随运行本脚本的那个 pnpm，缺省用 PATH 里的 pnpm。 */
function pnpmEntry() {
  const fromEnv = process.env.npm_execpath;
  return fromEnv === undefined ? undefined : resolve(fromEnv);
}

/** 跑一条子命令，失败即抛。 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${String(result.status)}`);
}

/** 用 pnpm 跑一个脚本。 */
function pnpm(args, cwd) {
  const entry = pnpmEntry();
  if (entry === undefined) throw new Error('找不到 pnpm：请用 pnpm 运行本脚本，或把 pnpm 加进 PATH');
  run(process.execPath, [entry, ...args], cwd);
}

const current = currentVersion();
const target = TO ?? current;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) {
  throw new Error(`版本号不合法：${target}`);
}

for (const step of plan(target, current)) console.log(`[${step.id}/5] ${step.title}`);
if (!APPLY) {
  console.log('只打印计划，未写文件；要执行请加 --apply。');
  process.exit(0);
}

try {
  console.log(`[2/5] 写入 ${join(ADAPTER, 'package.json')}`);
  rewriteManifest(target);
  console.log('[3/5] 登记表无需自动改写；若上游改名，手动更新 dsh-adapter/src/upstream.ts');
  console.log('[4/5] 构建适配层');
  pnpm(['build'], ADAPTER);
  console.log('[5/5] 构建运行时并核对上游包名');
  pnpm(['build'], ROOT);
  pnpm(['check:upstream-names'], ROOT);
} catch (error) {
  console.log(`升级中断：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log('升级完成。');
