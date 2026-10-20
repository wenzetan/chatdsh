// 校验 profile 的依赖声明覆盖它引用的组合包所插入的全部自建插件。
//
// 组合包的补丁层用 `name:` 按包名插入插件行，而插件的解析走 profile 目录，
// 因此 profile 必须把每个被引用的包写进 dependencies。漏写不会在配置转储里暴露
// （转储只组合配置，不导入模块），只在运行时表现为「未激活」，本脚本把这一项提前到构建期。
//
// 用法：node scripts/check-profile-deps.mjs
// 退出码 0 表示全部覆盖，1 表示存在缺失或指向仓库外的包。

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIRS = [join(ROOT, 'profiles'), join(ROOT, 'e2e', 'profiles')];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 仓库内自建包的包名到目录。 */
async function collectOwnPackages() {
  const table = new Map();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'lib') continue;
      const full = join(dir, entry.name);
      const manifest = join(full, 'package.json');
      if (await exists(manifest)) {
        const parsed = JSON.parse(await readFile(manifest, 'utf8'));
        if (typeof parsed.name === 'string') table.set(parsed.name, full);
      }
      await walk(full);
    }
  }
  if (await exists(join(ROOT, 'packages'))) await walk(join(ROOT, 'packages'));
  return table;
}

/** 一个组合包声明的补丁文件路径。 */
function patchFiles(manifest, dir) {
  const declaration = manifest.dsh?.bundle?.patch;
  if (typeof declaration === 'string') return [join(dir, declaration)];
  if (Array.isArray(declaration)) return declaration.filter((item) => typeof item === 'string').map((item) => join(dir, item));
  return [];
}

const own = await collectOwnPackages();
const failures = [];
let checkedProfiles = 0;

for (const profilesDir of PROFILE_DIRS) {
  if (!await exists(profilesDir)) continue;
  for (const entry of await readdir(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(profilesDir, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!await exists(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
    const referenced = new Map();

    for (const bundleName of bundles) {
      const bundleDir = own.get(bundleName);
      if (bundleDir === undefined) continue; // 内置组合包由 DSH 安装提供，不在本仓库内。
      if (!dependencies.has(bundleName)) {
        failures.push(`${entry.name} 引用了组合包 ${bundleName}，但没有把它写进 dependencies`);
      }
      const bundleManifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'));
      for (const file of patchFiles(bundleManifest, bundleDir)) {
        if (!await exists(file)) {
          failures.push(`${bundleName} 声明的补丁文件不存在：${file}`);
          continue;
        }
        const text = await readFile(file, 'utf8');
        for (const match of text.matchAll(/name:\s*'(@chatdsh\/[^']+)'/g)) {
          referenced.set(match[1], bundleName);
        }
      }
    }

    for (const [packageName, bundleName] of referenced) {
      if (!own.has(packageName)) {
        failures.push(`${entry.name} 引用的 ${packageName}（来自 ${bundleName}）不在本仓库的 packages 下`);
        continue;
      }
      if (!dependencies.has(packageName)) {
        failures.push(`${entry.name} 缺少依赖 ${packageName}（由组合包 ${bundleName} 的补丁层引用）`);
      }
    }

    // 适配层：任何引用本仓库插件的 profile 都要能解析到 @chatdsh/adapter。
    // 插件的运行期 import 里有 `@chatdsh/adapter`，缺这条依赖时 profile 装不出对应
    // 的 node_modules 链接，插件在加载阶段就报「找不到包」，整片插件不激活。
    if (referenced.size > 0 && !dependencies.has('@chatdsh/adapter')) {
      failures.push(`${entry.name} 引用了本仓库的插件，但没有声明 @chatdsh/adapter 依赖`);
    }
    checkedProfiles += 1;
  }
}

if (failures.length > 0) {
  console.error('profile 依赖校验失败：');
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
if (checkedProfiles === 0) {
  console.log('没有找到任何 profile，检查失配');
  process.exit(1);
}
console.log(`profile 依赖校验通过，检查了 ${checkedProfiles} 个 profile。`);
