// 把客户端插件打包成浏览器侧产物。
//
// 浏览器不加载裸模块：宿主通过 `window.__ModuleLoader__.load({ id, factory })` 注册每个
// 客户端插件，工厂收到的 `require` 由模块图解析。本脚本用 esbuild 打成 CJS，再用外壳包成
// 这个形状；宿主提供的包（react 与其余客户端插件）保持外部依赖，不重复打包。
//
// 用法：node scripts/build-client.mjs [包目录 ...]
//   不带参数时打包 packages/clients 下的全部包。
// 输出：<包目录>/lib/client.js 与 sourcemap。

import { build } from 'esbuild';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENTS = join(ROOT, 'packages', 'clients');

/** 宿主在浏览器侧提供的包，必须保持外部依赖。 */
const HOST_PROVIDED = ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 找一个客户端包的入口文件。 */
async function entryOf(dir) {
  for (const candidate of ['src/client/index.tsx', 'src/client/index.ts', 'src/client/index.jsx', 'src/client/index.js']) {
    const full = join(dir, candidate);
    if (await exists(full)) return full;
  }
  return undefined;
}

async function collectTargets() {
  if (process.argv.length > 2) return process.argv.slice(2).map((arg) => resolve(arg));
  if (!await exists(CLIENTS)) return [];
  const out = [];
  for (const entry of await readdir(CLIENTS, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(join(CLIENTS, entry.name));
  }
  return out;
}

let built = 0;
for (const dir of await collectTargets()) {
  const manifestPath = join(dir, 'package.json');
  if (!await exists(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.dsh?.client === undefined) continue;
  const entry = await entryOf(dir);
  if (entry === undefined) {
    console.log(`跳过 ${manifest.name}：缺少 src/client 入口`);
    continue;
  }
  const outfile = join(dir, 'lib', 'client.js');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: true,
    logLevel: 'warning',
    external: HOST_PROVIDED,
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
  });
  built += 1;
  console.log(`已打包 ${manifest.name} → lib/client.js`);
}

console.log(`客户端构建完成，处理 ${built} 个包。`);
