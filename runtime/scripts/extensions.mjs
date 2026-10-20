// 扩展包的安装与卸载。
//
// 一个扩展包就是别的 package：它自己声明 `dsh.bundle.patch`（组合包）或 `dsh.client`
// （客户端插件）。安装做两件事——把包名加进 profile 的 bundles 列表、把依赖写进 profile
// 的 package.json；卸载做反向。补丁层的内容由扩展包自己提供，这里不改它。
//
// 用法：
//   node scripts/extensions.mjs list --profile chatdsh-web
//   node scripts/extensions.mjs install <包名或路径> --profile chatdsh-web
//   node scripts/extensions.mjs remove <包名> --profile chatdsh-web
// 环境变量 DSH_HOME 指定数据根，与 dsh 的解析一致。

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 解析命令行。 */
function parseArgs(argv) {
  const positional = [];
  let profile;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--profile') {
      profile = argv[index + 1];
      index += 1;
      continue;
    }
    positional.push(token);
  }
  if (profile === undefined) throw new Error('必须给出 --profile');
  return { command: positional[0], target: positional[1], profile };
}

/** 找到 profile 目录。返回解析过符号链接的真实路径：依赖的相对路径以清单所在目录为准。 */
function profileDir(name) {
  const home = process.env.DSH_HOME;
  if (home === undefined || home === '') throw new Error('必须设置 DSH_HOME');
  const linked = join(home, 'profiles', name);
  if (!existsSync(join(linked, 'package.json'))) throw new Error(`profile ${name} 不存在：${linked}`);
  return realpathSync(linked);
}

/** 读 JSON 文件。 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 写 JSON 文件，保持两空格缩进。 */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 把一个包名或路径解析成包名与清单。 */
function resolvePackage(target) {
  const candidate = isAbsolute(target) ? target : join(ROOT, target);
  const manifestPath = existsSync(join(candidate, 'package.json'))
    ? join(candidate, 'package.json')
    : undefined;
  if (manifestPath === undefined) throw new Error(`找不到包清单：${target}`);
  const manifest = readJson(manifestPath);
  const kinds = [];
  if (manifest.dsh?.bundle?.patch !== undefined) kinds.push('bundle');
  if (manifest.dsh?.client !== undefined) kinds.push('client');
  if (kinds.length === 0) throw new Error(`${manifest.name} 没有声明 dsh.bundle.patch 或 dsh.client，不是扩展包`);
  return { name: manifest.name, dir: dirname(manifestPath), kinds };
}

/** 列出 profile 的扩展包。 */
function list(dir) {
  const manifest = readJson(join(dir, 'package.json'));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const deps = manifest.dependencies ?? {};
  const rows = bundles.map((name) => {
    const spec = deps[name];
    return { name, spec: spec ?? '（未声明依赖）' };
  });
  if (rows.length === 0) {
    console.log('这个 profile 没有 bundles。');
    return;
  }
  for (const row of rows) console.log(`${row.name}  ${row.spec}`);
}

/** 安装一个扩展包。 */
/** 列出组合包补丁层引用的自建插件名。 */
function pluginNamesOf(packageDir) {
  const patchPath = join(packageDir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return [];
  const text = readFileSync(patchPath, 'utf8');
  const names = [...text.matchAll(/name:\s*['"]?([@\w./-]+)['"]?/g)].map((match) => match[1]);
  return [...new Set(names)].filter((name) => name.startsWith('@chatdsh/'));
}

/** 在仓库里按包名找目录。 */
function findPackageDir(name) {
  const stack = [join(ROOT, 'packages')];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(current, entry.name);
      const manifestPath = join(full, 'package.json');
      if (existsSync(manifestPath)) {
        if (readJson(manifestPath).name === name) return full;
      } else {
        stack.push(full);
      }
    }
  }
  return undefined;
}

function install(dir, target) {
  const pkg = resolvePackage(target);
  const manifestPath = join(dir, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= [];
  if (manifest.dsh.profile.bundles.includes(pkg.name)) throw new Error(`${pkg.name} 已经在 bundles 里`);

  const relativeDir = relative(dir, pkg.dir).split('\\').join('/');
  manifest.dependencies ??= {};
  manifest.dependencies[pkg.name] = `link:${relativeDir}`;
  manifest.dsh.profile.bundles.push(pkg.name);

  // 组合包的补丁层会插入它自己的插件行，这些包的依赖也要在 profile 里可解析，
  // 否则装得上但启动时解析失败。
  for (const name of pluginNamesOf(pkg.dir)) {
    if (manifest.dependencies[name] !== undefined) continue;
    const pluginDir = findPackageDir(name);
    if (pluginDir === undefined) throw new Error(`${pkg.name} 引用的 ${name} 在仓库里找不到`);
    manifest.dependencies[name] = `link:${relative(dir, pluginDir).split('\\').join('/')}`;
  }

  writeJson(manifestPath, manifest);
  console.log(`已安装 ${pkg.name}（${pkg.kinds.join('、')}）到 ${manifest.name}`);
  console.log(`  bundles：${manifest.dsh.profile.bundles.length} 项`);
  console.log('  接下来在 profile 目录执行 pnpm install，再运行一次组合检查。');
}

/** 卸载一个扩展包。 */
function remove(dir, name) {
  const manifestPath = join(dir, 'package.json');
  const manifest = readJson(manifestPath);
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(name)) throw new Error(`${name} 不在 bundles 里`);
  manifest.dsh.profile.bundles = bundles.filter((item) => item !== name);
  if (manifest.dependencies !== undefined) delete manifest.dependencies[name];

  // 安装时补进来的插件依赖在卸载时一并收回；别的在装组合包还在用的保留。
  const removedDir = findPackageDir(name);
  if (removedDir !== undefined && manifest.dependencies !== undefined) {
    for (const pluginName of pluginNamesOf(removedDir)) {
      const stillUsed = manifest.dsh.profile.bundles.some((bundle) => {
        const bundleDir = findPackageDir(bundle);
        return bundleDir !== undefined && pluginNamesOf(bundleDir).includes(pluginName);
      });
      if (!stillUsed) delete manifest.dependencies[pluginName];
    }
  }

  writeJson(manifestPath, manifest);
  console.log(`已卸载 ${name}`);
  console.log('  扩展包创建的会话与记忆留在数据根里，不会被清理。');
}

const { command, target, profile } = parseArgs(process.argv.slice(2));
const dir = profileDir(profile);
if (command === 'list') list(dir);
else if (command === 'install') {
  if (target === undefined) throw new Error('install 需要包名或路径');
  install(dir, target);
} else if (command === 'remove') {
  if (target === undefined) throw new Error('remove 需要包名');
  remove(dir, target);
} else {
  throw new Error(`未知命令：${command ?? '（空）'}`);
}
