// 把 DSH 安装内的依赖投影到仓库的 `.dsh-deps` 目录，供类型检查与本地直接加载使用。
//
// 自建插件的 peerDependencies 与 dependencies 指向 DSH 安装里的包。运行时的解析顺序是
// 「先安装锚点，再 profile 目录」，因此线上加载不依赖这个目录；类型检查需要能解析到这些
// 包的类型声明，`tsconfig.base.json` 的 `paths` 指向这里。
//
// 不投影到 `node_modules`：包管理器会把那里的每个包当成自己管理的依赖并尝试改写其权限，
// 而这些包位于只读的安装目录内。
//
// 投影分两类：`@deepseek-ai/*` 逐个建立链接（dsh 自身不在该目录内，单独指向安装根），
// 其余顶层包与 scope 目录整体链接（zod、@opentelemetry 等因此与运行时同源）。
//
// 用法：node scripts/link-dsh-deps.mjs [--check]
//   --check 只报告将建立的链接，不写入。

import { mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPED = '@deepseek-ai';
const DEPS = join(ROOT, '.dsh-deps');
const CHECK = process.argv.includes('--check');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析一个 dsh 启动脚本真实指向的包目录。
 *
 * 全局安装的启动脚本可能是符号链接（Unix），也可能是转发脚本（Windows 的 `.cmd` 或
 * `.ps1`）。这里按平台逐种读法取出 `<安装根>/lib/bin.js` 的实际路径。
 * @param {string} bin - PATH 上找到的 dsh 入口文件。
 * @returns {string | undefined} 包根目录，无法解析时返回 undefined。
 */
async function resolveLaunchTarget(bin) {
  let current = bin;
  try {
    current = await realpath(bin);
  } catch {
    return undefined;
  }
  if (current.endsWith(`${sep}lib${sep}bin.js`)) return dirname(dirname(current));

  // Windows 的 npm 全局 shim：与启动脚本同目录的 node_modules 下就是包根。
  const sibling = join(dirname(current), 'node_modules', SCOPED, 'dsh');
  if (await exists(join(sibling, 'lib', 'bin.js'))) return sibling;
  return undefined;
}

/** 定位 DSH 安装根：环境变量优先，其次从 PATH 里的 dsh 启动脚本反查，最后用依赖解析。 */
async function resolveDshInstall() {
  const fromEnv = process.env.CHATDSH_DSH_INSTALL;
  if (fromEnv) return resolve(fromEnv);

  // dsh 的 bin 指向 <安装根>/lib/bin.js，因此安装根是它的上两级目录。
  const dirs = (process.env.PATH ?? '').split(sep === '\\' ? ';' : ':').filter(Boolean);
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh'];
  for (const dir of dirs) {
    for (const name of names) {
      const bin = join(dir, name);
      if (!await exists(bin)) continue;
      const install = await resolveLaunchTarget(bin);
      if (install !== undefined) return install;
    }
  }

  const require = createRequire(import.meta.url);
  try {
    return dirname(require.resolve('@deepseek-ai/dsh/package.json', { paths: [ROOT] }));
  } catch {
    throw new Error('未找到 @deepseek-ai/dsh，请把 dsh 加入 PATH，或设置 CHATDSH_DSH_INSTALL 指向 DSH 安装根目录');
  }
}

/** 建立或更新一条符号链接。 */
async function link(linkPath, target) {
  if (CHECK) return 'created';
  let current;
  try {
    current = await readlink(linkPath);
  } catch {
    current = undefined;
  }
  if (current === target) return 'kept';
  const replaced = current !== undefined || await exists(linkPath);
  if (replaced) await rm(linkPath, { recursive: true, force: true });
  await mkdir(dirname(linkPath), { recursive: true });
  // Windows 上创建目录符号链接需要管理员权限，目录联接（junction）不需要；两者都能让
  // 模块解析穿过链接。Unix 上仍用普通目录符号链接。
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(target, linkPath, type);
  return replaced ? 'replaced' : 'created';
}

const install = await resolveDshInstall();
const installModules = join(install, 'node_modules');
const bundled = join(installModules, SCOPED);
if (!await exists(bundled)) {
  throw new Error(`${bundled} 不存在，DSH 安装目录结构不符合预期`);
}

const entries = [[`${SCOPED}/dsh`, join(DEPS, SCOPED, 'dsh'), install]];
for (const entry of await readdir(bundled, { withFileTypes: true })) {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
  entries.push([`${SCOPED}/${entry.name}`, join(DEPS, SCOPED, entry.name), join(bundled, entry.name)]);
}
for (const entry of await readdir(installModules, { withFileTypes: true })) {
  if (entry.name === SCOPED || entry.name === '.bin') continue;
  if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
  entries.push([entry.name, join(DEPS, entry.name), join(installModules, entry.name)]);
}

if (!CHECK) await mkdir(DEPS, { recursive: true });

const tally = { created: 0, kept: 0, replaced: 0 };
const notable = [];
for (const [name, linkPath, target] of entries.sort(([a], [b]) => a.localeCompare(b))) {
  const outcome = await link(linkPath, target);
  tally[outcome] += 1;
  if (outcome !== 'kept' && notable.length < 5) notable.push(`${name} -> ${target}`);
}

console.log(`${CHECK ? '将建立' : '已建立'} ${tally.created} 个链接，更新 ${tally.replaced} 个，已是最新 ${tally.kept} 个；安装根 ${install}`);
for (const line of notable) console.log(`  ${line}`);
if (tally.created + tally.replaced > notable.length) {
  console.log(`  ... 另有 ${tally.created + tally.replaced - notable.length} 个`);
}
