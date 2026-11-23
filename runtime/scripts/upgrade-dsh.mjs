// DSH 升级验证入口。
//
// 顺序执行：读取 dsh 版本、投影并构建适配层、投影并构建运行时与客户端产物、
// 四项静态检查、单元测试、官方 profile 真实安装验证。任一步失败立即以非零退出，
// 并打印失败步骤与失败命令。
//
// 用法：node scripts/upgrade-dsh.mjs
// 退出码 0 表示全部通过。

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(ROOT, '..');
const ADAPTER = resolve(REPO, 'dsh-adapter');
const DSH = dshCommand();
const STATIC_CHECKS = [
  'check:telemetry',
  'check:plugins',
  'check:upstream-names',
  'check:layering',
];

/**
 * 把命令渲染成可以复制执行的文本。
 * @param command - 可执行文件。
 * @param args - 参数列表。
 * @returns 渲染后的命令。
 */
function printableCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[^\w@%+=:,./-]/.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part))
    .join(' ');
}

/**
 * 执行一条命令。
 * @param command - 可执行文件。
 * @param args - 参数列表。
 * @param cwd - 工作目录。
 * @param capture - 是否捕获输出。
 * @returns spawnSync 的结果。
 */
function run(command, args, cwd, capture = false) {
  const printable = printableCommand(command, args);
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: capture ? 'utf8' : undefined,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const output = capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
    throw new Error(`命令失败（退出码 ${String(result.status)}）：${printable}${output}`);
  }
  return result;
}

/**
 * 用 pnpm 执行一条命令。
 * @param args - pnpm 参数。
 * @param cwd - 工作目录。
 */
function pnpm(args, cwd) {
  const entry = process.env.npm_execpath;
  if (entry === undefined) run('pnpm', args, cwd);
  else run(process.execPath, [entry, ...args], cwd);
}

/** 按顺序执行的步骤。 */
const steps = [
  {
    title: '读取 dsh 版本',
    run() {
      const result = run(DSH, ['--version'], REPO, true);
      console.log(`DSH ${result.stdout.trim()}`);
    },
  },
  {
    title: '投影并构建 dsh-adapter',
    run() {
      run(process.execPath, ['scripts/link-dsh-deps.mjs'], ADAPTER);
      pnpm(['--config.verify-deps-before-run=false', 'build'], ADAPTER);
    },
  },
  {
    title: '投影并构建 runtime 与客户端产物',
    run() {
      run(process.execPath, ['scripts/link-dsh-deps.mjs'], ROOT);
      pnpm(['--config.verify-deps-before-run=false', 'build'], ROOT);
      pnpm(['--config.verify-deps-before-run=false', 'build:client'], ROOT);
    },
  },
  {
    title: '四项静态检查',
    run() {
      for (const script of STATIC_CHECKS) {
        pnpm(['--config.verify-deps-before-run=false', script], ROOT);
      }
    },
  },
  {
    title: '单元测试',
    run() {
      pnpm(['--config.verify-deps-before-run=false', 'test'], ROOT);
    },
  },
  {
    title: '官方 profile 真实安装验证',
    run() {
      run(process.execPath, ['scripts/verify-plugin-install.mjs'], ROOT);
    },
  },
];

for (const [index, step] of steps.entries()) {
  console.log('');
  console.log(`[${index + 1}/${steps.length}] ${step.title}`);
  try {
    step.run();
  } catch (error) {
    console.error('');
    console.error(`升级验证失败：第 ${index + 1} 步「${step.title}」`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

console.log('');
console.log('DSH 升级验证全部通过。');
