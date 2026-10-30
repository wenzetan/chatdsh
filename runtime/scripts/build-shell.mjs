// 把客户端外壳打成一个浏览器脚本。
//
// 外壳是控制平面托管的静态页面，脚本由控制平面自己下发，不经过 DSH 的客户端模块图：
// 用 esbuild 打成 IIFE 单文件，样式以文本内联在脚本里。产物落在控制平面的编译目录下
// （gateway/lib/shell/shell.js），控制平面按自身产物位置读取，因此页面与运行时的前端
// 产物完全无关。产物不入库。
//
// 用法：node scripts/build-shell.mjs
// 退出码 0 表示产物已写出。

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(await readFile(join(ROOT, 'packages', 'client', 'shell', 'package.json'), 'utf8'));
const shell = manifest.chatdsh?.shell;
if (typeof shell?.entry !== 'string' || typeof shell?.asset !== 'string') {
  throw new Error('@chatdsh/client-shell 的 package.json 没有声明 chatdsh.shell 的 entry 与 asset');
}

const outfile = join(ROOT, shell.asset);
await build({
  entryPoints: [join(ROOT, 'packages', 'client', 'shell', shell.entry)],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
  // 样式以文本内联：产物仍是单个脚本，页面不需要再取一份样式文件。
  loader: { '.css': 'text' },
});

console.log(`已打包 ${manifest.name} → ${shell.asset}`);
