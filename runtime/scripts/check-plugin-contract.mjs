// 插件契约的静态检查。
//
// 架构文档要求客户端插件声明 `dsh.client`，组合包声明 `dsh.bundle.patch`，
// profile 声明 `dsh.profile.bundles`。这些都能在清单层面核对；`dsh plugin add` 从登记处
// 拉取那一半需要已发布的包，本机做不到。
//
// 用法：node scripts/check-plugin-contract.mjs
// 退出码 0 表示清单声明齐备且指向的文件存在。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const failures = [];
const counts = { plugin: 0, client: 0, bundle: 0, profile: 0, library: 0 };

/** 找出所有包的目录。 */
function packageDirs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (existsSync(join(full, 'package.json'))) out.push(full);
    else out.push(...packageDirs(full));
  }
  return out;
}

const dirs = [join(ROOT, 'packages'), join(ROOT, 'e2e', 'profiles'), join(ROOT, 'profiles')]
  .flatMap((root) => packageDirs(root));

for (const dir of dirs) {
  const manifestPath = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const where = relative(ROOT, manifestPath);
  const dsh = manifest.dsh ?? {};

  // 组合包：必须声明补丁文件且文件存在。
  if (dsh.bundle !== undefined) {
    counts.bundle += 1;
    const patch = dsh.bundle.patch;
    if (patch === undefined) {
      failures.push(`${where} 声明了 dsh.bundle 但没有 patch`);
    } else {
      const files = Array.isArray(patch) ? patch : [patch];
      for (const file of files) {
        if (!existsSync(join(dir, file))) failures.push(`${where} 的补丁文件不存在：${file}`);
      }
    }
  }

  // 客户端插件：必须声明 dsh.client 并提供 ./client 子路径。
  if (dsh.client !== undefined) {
    counts.client += 1;
    if (dsh.client.platform !== 'web') failures.push(`${where} 的 dsh.client 缺少 platform: web`);
    if (!Array.isArray(dsh.client.inject)) failures.push(`${where} 的 dsh.client 缺少 inject 数组`);
    if (manifest.exports?.['./client'] === undefined) failures.push(`${where} 声明了 dsh.client 但没有导出 ./client`);
    if (!existsSync(join(dir, 'lib', 'client.js'))) failures.push(`${where} 声明了 dsh.client 但没有客户端产物 lib/client.js`);
  }

  // profile：bundles 必须是非空字符串数组。
  if (dsh.profile !== undefined) {
    counts.profile += 1;
    const bundles = dsh.profile.bundles;
    if (!Array.isArray(bundles) || bundles.length === 0) failures.push(`${where} 的 dsh.profile.bundles 必须是非空数组`);
    else if (bundles.some((name) => typeof name !== 'string')) failures.push(`${where} 的 bundles 里有非字符串项`);
  }

  // 角色目录：包名前缀必须与角色目录一致。DSH 版本由发布标签与实际组合检查管理。
  const where_ = relative(ROOT, dir).split('\\').join('/');
  const roleMatch = where_.match(/^packages\/([a-z]+)\/([^/]+)$/);
  if (roleMatch !== null) {
    const [, role, objectName] = roleMatch;
    const expected = role === 'bundle' && objectName === 'chatdsh' ? '@chatdsh/bundle' : `@chatdsh/${role}-${objectName}`;
    if (manifest.name !== expected) failures.push(`${where} 的包名应为 ${expected}，实际 ${manifest.name}`);
    if (dsh.bundle === undefined && dsh.profile === undefined && dsh.client === undefined) counts.plugin += 1;
  } else if (dsh.bundle === undefined && dsh.profile === undefined && dsh.client === undefined) {
    counts.library += 1;
  }
}

// 依赖声明：src 里 import 的框架包必须写进 peerDependencies 或 dependencies。
// 类型引入同样算依赖——运行时不需要，编译期需要它能被解析。
for (const dir of dirs) {
  const src = join(dir, 'src');
  if (!existsSync(src)) continue;
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.dependencies ?? {}),
  ]);
  const used = new Set();
  const collect = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        const text = readFileSync(full, 'utf8');
        for (const match of text.matchAll(/from '(@deepseek-ai\/[a-z-]+)'/g)) used.add(match[1]);
      }
    }
  };
  collect(src);
  for (const name of used) {
    if (!declared.has(name)) failures.push(`${manifest.name} 导入了 ${name} 但没有声明依赖`);
  }
}

// 适配层边界：DSH 内部包只允许经由 @chatdsh/adapter 引用。
//
// 上游发版频繁，内部 API 的引用面越散，升级时要改的位置越多。适配层是独立仓库
// （@chatdsh/adapter），本仓库的业务包一律从它取上游能力，不直接 import 上游内部包。
//
// 唯一豁免是模块增强：`declare module '@deepseek-ai/...'` 必须写成真实包名，
// 否则增强挂不到上游接口上。这类文件用 `import type {}` 引入同一个包名，
// 属于声明合并的必需品，不是能力引用。
{
  const offenders = [];
  const scan = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!full.endsWith('.ts') && !full.endsWith('.tsx')) continue;
      const text = readFileSync(full, 'utf8');
      // 模块增强文件：声明了 declare module 且只有 import type {} 形式的引入。
      const augments = /declare module '@deepseek-ai\//.test(text);
      for (const match of text.matchAll(/^import (?!type \{\})[^\n]*from '(@deepseek-ai\/[a-z-]+)'/gm)) {
        if (augments) continue;
        offenders.push(`${relative(ROOT, full)} 直接引用了 ${match[1]}，应当改从 @chatdsh/adapter 取`);
      }
    }
  };
  for (const root of ['packages', 'gateway', 'desktop']) {
    const dir = join(ROOT, root);
    if (existsSync(dir)) scan(dir);
  }
  failures.push(...offenders);
}

// 组合包与客户端插件的引用关系：组合包声明的本仓库依赖必须存在，客户端插件必须随组合包发布。
const packageNames = new Set();
const bundleManifests = [];
const clientNames = new Set();
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  packageNames.add(manifest.name);
  if (manifest.dsh?.client !== undefined) clientNames.add(manifest.name);
  if (manifest.dsh?.bundle !== undefined) {
    bundleManifests.push(manifest);
  }
}
const bundled = new Set();
for (const manifest of bundleManifests) {
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!name.startsWith('@chatdsh/') || name === '@chatdsh/adapter') continue;
    if (!packageNames.has(name)) failures.push(`${manifest.name} 依赖了 ${name}，但本仓库没有这个包`);
    else bundled.add(name);
  }
}
for (const name of clientNames) {
  if (!bundled.has(name)) failures.push(`${name} 没有被任何组合包依赖`);
}

console.log(`插件 ${counts.plugin} 个、客户端插件 ${counts.client} 个、组合包 ${counts.bundle} 个、profile ${counts.profile} 个、纯库 ${counts.library} 个`);
if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('插件契约检查通过');
process.exit(0);
