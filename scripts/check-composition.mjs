// 组合成立性检查：逐个 profile 跑配置导出，核对验收清单里的三条。
//
// 1. `dsh --dump-config --profile <name>` 退出码为 0；
// 2. 警告输出为空（stderr 无内容）；
// 3. 同一 loader 条目 id 在整个组合里只出现一次。
//
// 另外跑 `--dump-config-schema`。这个模式在当前上游版本上总会返回非零并打印一批配置
// 投影限制的警告（内置 profile 也一样），因此这里判定的是「是否产出了配置模式文档」，
// 退出码与警告条数一并打印出来，作为已知限制记录，不计入失败。
//
// 用法：node scripts/check-composition.mjs [profile ...]
//   不带参数时检查仓库 profiles 目录下的全部 profile。
//   验收用的 e2e/profiles/chatdsh-acp 由 scripts/verify-acp.mjs 负责，不在默认集合里。

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 收集默认检查的 profile。 */
function defaultProfiles() {
  const names = readdirSync(join(ROOT, 'profiles'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  // 一个都没找到时直接失败：空集合下所有检查都会通过，等于掩盖失配。
  if (names.length === 0) throw new Error('profiles 目录下没有找到任何 profile');
  return names;
}

/** 跑一次 dsh 命令并取回输出。 */
function run(args) {
  // 配置模式的输出是完整的 JSON Schema，体积远超默认缓冲区，需要显式放宽。
  const result = spawnSync(dshCommand(), args, {
    encoding: 'utf8',
    env: process.env,
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    signal: result.signal ?? undefined,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 从配置导出里取条目 id。 */
function entryIds(config) {
  return [...config.matchAll(/^- id: (\S+)$/gm)].map((match) => match[1]);
}

const profiles = process.argv.length > 2 ? process.argv.slice(2) : defaultProfiles();
const failures = [];

for (const profile of profiles) {
  const config = run(['--dump-config', '--profile', profile]);
  if (config.code !== 0) {
    failures.push(`${profile}: 配置导出退出码 ${config.code}`);
    continue;
  }
  const silent = config.stderr.trim() === '';
  if (!silent) {
    failures.push(`${profile}: 警告输出非空 → ${config.stderr.trim().split('\n')[0]}`);
  }
  const ids = entryIds(config.stdout);
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    failures.push(`${profile}: 条目 id 重复 → ${[...duplicates].join('、')}`);
  }
  const schema = run(['--dump-config-schema', '--profile', profile]);
  const schemaDocument = schema.stdout.trimStart().startsWith('{');
  if (!schemaDocument) {
    failures.push(`${profile}: 配置模式没有产出文档（退出码 ${schema.code}）`);
  }
  const schemaWarnings = schema.stderr.split('\n').filter((line) => line.trim() !== '').length;
  const state = failures.some((item) => item.startsWith(`${profile}:`)) ? '不通过' : '通过';
  console.log(`${profile}：${state}（条目 ${ids.length} 个，重复 ${duplicates.size} 个，配置模式文档 ${schemaDocument ? '有' : '无'}，投影警告 ${schemaWarnings} 条）`);
}

if (failures.length > 0) {
  console.log('失败项：');
  for (const item of failures) console.log(`  ${item}`);
  process.exit(1);
}
console.log('组合成立性检查通过');
process.exit(0);
