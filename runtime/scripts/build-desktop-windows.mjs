// 构建 Windows 桌面客户端的便携版 .exe。
//
// 步骤：
//   1. 定位本机的 @deepseek-ai/dsh 安装；
//   2. 把 DSH 安装、desktop profile 与自建包暂存到 .run/desktop-windows-stage/app/dsh；
//   3. 调用 electron-builder 产出 win32 x64 的 portable exe。
//
// 产物默认在 runtime/.run/desktop-windows/ChatDSH-<version>-x64.exe。
//
// 用法：
//   node scripts/build-desktop-windows.mjs
//   node scripts/build-desktop-windows.mjs --dsh-install C:\\path\\to\\dsh
//
// profile 被放在随包 dsh 安装目录内部，自建包对 @deepseek-ai/* 的 peer 依赖才能沿
// 目录向上解析到随包的 DSH 依赖；数据根里的 profile 由桌面壳首次启动时建目录联接。
//
// 未签名说明：跨平台构建使用 win.signAndEditExecutable=false，因此外层 exe 不会写入
// 自定义图标或签名。需要签名/改图标时，在 Windows 构建机上打开该开关并配置证书。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const ELECTRON = join(ROOT, 'desktop', 'electron');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const STAGE = resolve(option('stage', join(ROOT, '.run', 'desktop-windows-stage')));
const OUT = resolve(option('out', join(ROOT, '.run', 'desktop-windows')));
const REGISTRY = option('registry', process.env.NPM_REGISTRY ?? 'https://registry.npmmirror.com');
const BUILD_HOME = join(STAGE, '.home');
const BUILD_CACHE = join(STAGE, '.cache');
const REUSE_STAGE = argv.includes('--reuse-stage');

/** 读取命令行选项。 */
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

/** 定位 DSH 安装根：命令行/环境变量优先，其次按运行时依赖解析。 */
function resolveDshInstall() {
  const explicit = option('dsh-install', process.env.CHATDSH_DSH_INSTALL);
  if (explicit !== undefined) return resolve(explicit);
  let manifest;
  try {
    manifest = require.resolve('@deepseek-ai/dsh/package.json', { paths: [ROOT] });
  } catch {
    throw new Error('找不到 @deepseek-ai/dsh；设置 CHATDSH_DSH_INSTALL 指向它的安装根目录');
  }
  return dirname(realpathSync(manifest));
}

/** 确认自建包的产物已经构建。 */
function assertBuilt() {
  const required = [
    join(ROOT, 'packages', 'core', 'identity', 'lib', 'index.js'),
    join(ROOT, 'packages', 'client', 'projects', 'lib', 'client.js'),
    join(REPO, 'dsh-adapter', 'lib', 'index.js'),
  ];
  for (const file of required) {
    if (!existsSync(file)) throw new Error(`缺少构建产物 ${file}；先在 runtime 与 dsh-adapter 执行构建`);
  }
}

/** 递归复制，默认解引用符号链接，便于 Windows 上分发。 */
function copy(source, dest, options = {}) {
  cpSync(source, dest, { recursive: true, dereference: true, force: true, ...options });
}

/** 复制一个自建包，只保留运行时需要的文件。 */
function copyRuntimePackage(source, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (entry === 'node_modules' || entry === 'src' || entry.startsWith('tsconfig') || entry.endsWith('.tsbuildinfo')) continue;
    copy(join(source, entry), join(dest, entry));
  }
}

/** 读取包清单。 */
function manifestOf(path) {
  return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
}

/** 收集自建包声明过的非 DSH 外部依赖。 */
function externalDependencies(packageDirs) {
  const deps = new Map();
  for (const dir of packageDirs) {
    const manifest = manifestOf(dir);
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith('@chatdsh/') || name.startsWith('@deepseek-ai/') || name.startsWith('@types/')) continue;
        if (!deps.has(name)) deps.set(name, spec);
      }
    }
  }
  return Object.fromEntries([...deps.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** 安装 profile 需要的外部依赖；npm 的 hoisted 布局避免把 pnpm 的符号链接带进安装包。 */
function installExternalDependencies(profileModules, dependencies) {
  const depsDir = join(STAGE, '.deps');
  rmSync(depsDir, { recursive: true, force: true });
  mkdirSync(depsDir, { recursive: true });
  writeFileSync(join(depsDir, 'package.json'), JSON.stringify({
    name: 'chatdsh-desktop-bundled-deps',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, [
    'install', '--omit=dev', '--install-strategy=hoisted', '--ignore-scripts',
    '--no-audit', '--no-fund', `--registry=${REGISTRY}`,
  ], {
    cwd: depsDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_cache: join(BUILD_CACHE, 'npm') },
  });
  if (result.status !== 0) throw new Error(`外部依赖安装失败（退出码 ${result.status}）`);
  copy(join(depsDir, 'node_modules'), profileModules);
}

/** 暂存 DSH 安装与 profile。 */
function stage(dshInstall) {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, 'app'), { recursive: true });
  console.log(`暂存 DSH 安装：${dshInstall}`);
  copy(dshInstall, join(STAGE, 'app', 'dsh'));

  const profileSource = join(ROOT, 'profiles', 'chatdsh-desktop');
  const profileDest = join(STAGE, 'app', 'dsh', 'profiles', 'chatdsh-desktop');
  mkdirSync(profileDest, { recursive: true });
  for (const entry of readdirSync(profileSource)) {
    if (entry === 'node_modules') continue;
    copy(join(profileSource, entry), join(profileDest, entry));
  }
  mkdirSync(join(profileDest, 'node_modules'), { recursive: true });

  // 自建包清单：runtime 下全部工作区包，加上同级适配层。
  const packageDirs = [];
  for (const role of ['core', 'host', 'tool', 'client', 'bundle', 'preset']) {
    const base = join(ROOT, 'packages', role);
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (existsSync(join(dir, 'package.json'))) packageDirs.push(dir);
    }
  }
  packageDirs.push(join(REPO, 'dsh-adapter'));

  const profileModules = join(profileDest, 'node_modules');
  installExternalDependencies(profileModules, externalDependencies(packageDirs));

  // profile 自己的非 @chatdsh 运行时依赖（mcp-client、schemastery 等）。
  const sourceModules = join(profileSource, 'node_modules');
  for (const entry of readdirSync(sourceModules)) {
    if (entry === '.bin' || entry === '@chatdsh') continue;
    copy(join(sourceModules, entry), join(profileModules, entry));
  }

  // 自建包以物理目录放进 profile/node_modules，包之间互相解析不依赖 pnpm 链接。
  for (const dir of packageDirs) {
    const manifest = manifestOf(dir);
    if (!manifest.name.startsWith('@chatdsh/')) continue;
    const dest = join(profileModules, '@chatdsh', manifest.name.slice('@chatdsh/'.length));
    copyRuntimePackage(dir, dest);
  }

  console.log(`暂存完成：${join(STAGE, 'app', 'dsh')}`);
}

/** 调用 electron-builder 产出 portable exe。 */
function packageWindows() {
  // 清掉旧产物，避免把上一次的 exe 当成这一次的结果。
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(BUILD_HOME, { recursive: true });
  mkdirSync(join(BUILD_CACHE, 'electron'), { recursive: true });
  mkdirSync(join(BUILD_CACHE, 'builder'), { recursive: true });
  mkdirSync(join(BUILD_CACHE, 'xdg'), { recursive: true });
  const cli = join(ELECTRON, 'node_modules', 'electron-builder', 'cli.js');
  if (!existsSync(cli)) throw new Error(`找不到 electron-builder：${cli}；先在 desktop/electron 执行 npm install`);
  const result = spawnSync(process.execPath, [
    cli, '--win', 'portable', '--x64',
    '--config', join(ELECTRON, 'electron-builder.yml'),
    `--config.directories.output=${OUT}`,
  ], {
    cwd: ELECTRON,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: BUILD_HOME,
      XDG_CACHE_HOME: join(BUILD_CACHE, 'xdg'),
      ELECTRON_CACHE: join(BUILD_CACHE, 'electron'),
      ELECTRON_BUILDER_CACHE: join(BUILD_CACHE, 'builder'),
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
      // electron-builder 的 extraResources.from 按项目目录解析，这里传相对路径。
      CHATDSH_DESKTOP_STAGE: relative(ELECTRON, STAGE),
    },
  });
  if (result.status !== 0) throw new Error(`electron-builder 失败（退出码 ${result.status}）`);
  const artifact = readdirSync(OUT).find((name) => name.endsWith('.exe'));
  if (artifact === undefined) throw new Error(`没有找到 exe 产物：${OUT}`);
  console.log(`Windows 便携版已生成：${join(OUT, artifact)}`);
  console.log(`大小：${(statSync(join(OUT, artifact)).size / 1024 / 1024).toFixed(0)} MB`);
}

assertBuilt();
if (REUSE_STAGE) {
  if (!existsSync(join(STAGE, 'app', 'dsh', 'lib', 'bin.js'))) throw new Error(`--reuse-stage 指定的暂存目录不存在：${STAGE}`);
  console.log(`复用暂存目录：${STAGE}`);
} else {
  stage(resolveDshInstall());
}
packageWindows();
