// 把 electron-builder 的 win-unpacked 目录打成单文件 Windows 安装器 exe。
//
// 安装器源码在 desktop/installer/main.go：它从自身末尾读取 zip 载荷，解压到
// %LOCALAPPDATA%\Programs\ChatDSH，创建快捷方式并启动应用。载荷只在首次安装时解压，
// 避免 portable 目标每次启动都重新解压整套运行时。
//
// 用法：
//   node scripts/build-windows-installer.mjs
//   node scripts/build-windows-installer.mjs --from .run/desktop-windows/win-unpacked
//
// 前置：electron-builder 已产出 win-unpacked，且本机有 Go 1.22+。

import { appendFileSync, createReadStream, createWriteStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = join(ROOT, 'desktop', 'electron');
const requireElectron = createRequire(join(ELECTRON, 'package.json'));
const argv = process.argv.slice(2);

/** 读取命令行选项。 */
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

const FROM = resolve(option('from', join(ROOT, '.run', 'desktop-windows', 'win-unpacked')));
const OUT = resolve(option('out', join(ROOT, '.run', 'desktop-windows')));
const VERSION = JSON.parse(readFileSync(join(ELECTRON, 'package.json'), 'utf8')).version;
const PAYLOAD = join(OUT, 'chatdsh-payload.zip');
const INSTALLER = join(OUT, `ChatDSH-Setup-${VERSION}-x64.exe`);

if (!existsSync(join(FROM, 'ChatDSH.exe'))) throw new Error(`找不到 win-unpacked：${FROM}`);

// 1. 用 electron-builder 自带的 7za 生成 zip 载荷。压缩级别 1 换取更快的安装。
const { path7za } = requireElectron('7zip-bin');
console.log(`打包载荷：${FROM}`);
rmSync(PAYLOAD, { force: true });
const zip = spawnSync(path7za, ['a', '-tzip', '-mx=1', '-bd', PAYLOAD, '.'], {
  cwd: FROM,
  stdio: 'inherit',
});
if (zip.status !== 0) throw new Error(`7za 打包失败（退出码 ${zip.status}）`);

// 2. 构建安装器本体。载荷在编译后才追加，Go 编译器不需要读 1GB 的 win-unpacked。
console.log('编译 Windows 安装器');
rmSync(INSTALLER, { force: true });
const go = spawnSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', INSTALLER, './main.go'], {
  cwd: join(ROOT, 'desktop', 'installer'),
  stdio: 'inherit',
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GOCACHE: join(ROOT, '.run', 'go-build-cache') },
});
if (go.status !== 0) throw new Error(`Go 编译失败（退出码 ${go.status}）`);

// 3. 把 zip 载荷与 24 字节页脚追加到 exe 末尾。
const payloadSize = statSync(PAYLOAD).size;
await pipeline(createReadStream(PAYLOAD), createWriteStream(INSTALLER, { flags: 'a' }));
const footer = Buffer.alloc(24);
footer.write('CHATDSHZIP000001', 0, 'ascii');
footer.writeBigUInt64LE(BigInt(payloadSize), 16);
appendFileSync(INSTALLER, footer);
rmSync(PAYLOAD, { force: true });

console.log(`Windows 安装器已生成：${INSTALLER}`);
console.log(`大小：${(statSync(INSTALLER).size / 1024 / 1024).toFixed(0)} MB`);
