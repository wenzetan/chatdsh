// 插件契约的静态检查。
//
// 架构文档要求自建插件包声明 `engines.dsh` 与 `dsh.client`，组合包声明 `dsh.bundle.patch`，
// profile 声明 `dsh.profile.bundles`。这些都能在清单层面核对；`dsh plugin add` 从登记处
// 拉取那一半需要已发布的包，本机做不到。
//
// 用法：node scripts/check-plugin-contract.mjs
// 退出码 0 表示清单声明齐备且指向的文件存在。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const failures = [];
const counts = { plugin: 0, client: 0, bundle: 0, profile: 0, library: 0, tool: 0 };

/** 找出所有包的目录。 */
function packageDirs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (existsSync(join(full, 'package.json'))) out.push(full);
    else out.push(...packageDirs(full));
  }
  return out;
}

const dirs = [...packageDirs(join(ROOT, 'packages')), ...packageDirs(join(ROOT, 'e2e', 'profiles')), ...packageDirs(join(ROOT, 'profiles'))];

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
  }

  // profile：bundles 必须是非空字符串数组。
  if (dsh.profile !== undefined) {
    counts.profile += 1;
    const bundles = dsh.profile.bundles;
    if (!Array.isArray(bundles) || bundles.length === 0) failures.push(`${where} 的 dsh.profile.bundles 必须是非空数组`);
    else if (bundles.some((name) => typeof name !== 'string')) failures.push(`${where} 的 bundles 里有非字符串项`);
  }

  // 角色目录：packages/<角色>/<对象> 一律声明 engines.dsh，包名前缀必须与角色目录一致。
  const where_ = relative(ROOT, dir).split('\\').join('/');
  const roleMatch = where_.match(/^packages\/([a-z]+)\/([^/]+)$/);
  if (roleMatch !== null) {
    const [, role, objectName] = roleMatch;
    if (manifest.engines?.dsh === undefined) failures.push(`${where} 缺少 engines.dsh`);
    const expected = `@chatdsh/${role}-${objectName}`;
    if (manifest.name !== expected) failures.push(`${where} 的包名应为 ${expected}，实际 ${manifest.name}`);
    if (dsh.bundle === undefined && dsh.profile === undefined && dsh.client === undefined) counts.plugin += 1;
  } else if (dsh.bundle === undefined && dsh.profile === undefined && dsh.client === undefined) {
    counts.library += 1;
  }
}

// 工具包与预设挂载：packages/tool/<对象> 每个注册一个工具，预设挂载除浏览器外的六个。
const toolNames = new Map();
for (const dir of dirs) {
  const name = relative(ROOT, dir).split('\\').join('/');
  if (!name.startsWith('packages/tool/')) continue;
  const entry = join(dir, 'src', 'index.ts');
  if (!existsSync(entry)) continue;
  const registered = [...readFileSync(entry, 'utf8').matchAll(/name: '([a-z_]+)'/g)]
    .map((match) => match[1])
    .filter((value) => !value.startsWith('chatdsh'));
  const packageName = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
  if (registered.length !== 1) failures.push(`${packageName} 应当注册恰好一个工具，实际 ${registered.length} 个`);
  toolNames.set(packageName, registered[0] ?? '');
}
counts.tool = toolNames.size;

const presetFile = join(ROOT, 'packages/preset/chat/cordis.patch.yml');
if (existsSync(presetFile)) {
  const presetText = readFileSync(presetFile, 'utf8');
  const mounted = [...new Set([...presetText.matchAll(/'(@chatdsh\/tool-[a-z]+)'/g)].map((match) => match[1]))];
  console.log(`工具 ${toolNames.size} 个；预设挂载 ${mounted.length} 个：${mounted.map((value) => value.replace('@chatdsh/', '')).join('、')}`);
  if (mounted.length === 0) failures.push('预设补丁层里没有解析出任何工具挂载，检查失配');
  for (const packageName of mounted) {
    if (!toolNames.has(packageName)) failures.push(`预设挂载了 ${packageName}，但没有对应的工具包`);
  }

  // 浏览器工具只能出现在显式选用的档位里，默认档位不许挂。
  // 按补丁层切分：以 `- id: preset-` 开头的一段属于同一个 preset。
  const blocks = presetText.split(/^\s*- id: preset-/m).slice(1);
  for (const block of blocks) {
    const id = block.match(/^([a-z0-9-]+)/)?.[1] ?? '';
    const mentioned = block.includes('@chatdsh/tool-browser');
    if (mentioned && id === 'chatdsh-work') failures.push('浏览器工具不应当默认挂进工作档');
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
  scan(join(ROOT, 'packages'));
  scan(join(ROOT, 'gateway'));
  scan(join(ROOT, 'desktop'));
  failures.push(...offenders);
}

// 组合包与 profile 的引用关系：bundles 里的本仓库组合包必须存在，且每个组合包都有人用。
const bundleNames = new Set();
const bundleUsers = new Map();
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (manifest.dsh?.bundle !== undefined) {
    bundleNames.add(manifest.name);
    bundleUsers.set(manifest.name, []);
  }
}
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const profileName = manifest.dsh?.profile === undefined ? undefined : manifest.name;
  for (const entry of manifest.dsh?.profile?.bundles ?? []) {
    if (!entry.startsWith('@chatdsh/')) continue;
    if (!bundleNames.has(entry)) failures.push(`${manifest.name} 的 bundles 里有 ${entry}，但本仓库没有这个组合包`);
    else bundleUsers.get(entry).push(profileName ?? '');
  }
}
for (const [name, users] of bundleUsers) {
  if (users.length === 0) failures.push(`${name} 没有被任何 profile 引用`);
}

console.log(`插件 ${counts.plugin} 个、客户端插件 ${counts.client} 个、组合包 ${counts.bundle} 个、profile ${counts.profile} 个、纯库 ${counts.library} 个`);
if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('插件契约检查通过');
process.exit(0);
