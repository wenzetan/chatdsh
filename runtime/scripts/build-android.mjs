// 构建 Android release APK，并把可下载文件放到固定目录。
//
// 流程：合成 mobile/android → 自有签名 → Gradle assembleRelease → 复制成
// `.run/apk/chatdsh<版本号>.apk` → 确保下载服务运行并打印下载地址。
// 首次构建会生成签名密钥到 `.run/android-signing/`，后续构建复用同一把密钥以便覆盖安装。
//
// 用法：node scripts/build-android.mjs [--skip-sync]
// 环境变量：CHATDSH_APK_BIND、CHATDSH_APK_PORT、CHATDSH_ANDROID_HOME（可写主目录）

import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = join(ROOT, 'mobile', 'android');
const BUILD_OUTPUT = join(ANDROID_DIR, 'androidApp', 'build', 'outputs', 'apk', 'release', 'androidApp-release.apk');
const APK_DIR = join(ROOT, '.run', 'apk');
const SIGNING_DIR = join(ROOT, '.run', 'android-signing');
const KEYSTORE = join(SIGNING_DIR, 'chatdsh-release.keystore');
const ANDROID_HOME_DIR = process.env.CHATDSH_ANDROID_HOME ?? join(ROOT, '.run', 'android-home');
const GRADLE_HOME = process.env.CHATDSH_GRADLE_HOME ?? join(ROOT, '.run', 'gradle-home');
// 监听地址由 CHATDSH_APK_BIND 给出；缺省只监听回环，不把安装包暴露到未预期的网卡。
const APK_BIND = process.env.CHATDSH_APK_BIND ?? '127.0.0.1';
const APK_PORT = process.env.CHATDSH_APK_PORT ?? '8099';
// 签名口令不写进仓库：首次生成密钥时随机创建并存到 .run/android-signing，
// 之后每次构建从那里读回。允许用环境变量整体覆盖。
const PASSWORD_FILE = join(SIGNING_DIR, 'password');
const SKIP_SYNC = process.argv.includes('--skip-sync');

/** 读版本号的唯一来源。 */
function versionProperties() {
  const text = readFileSync(join(ROOT, 'mobile', 'version.properties'), 'utf8');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match !== null) values[match[1]] = match[2].trim();
  }
  if (values.VERSION_NAME === undefined) throw new Error('version.properties 缺少 VERSION_NAME');
  if (values.VERSION_CODE === undefined) throw new Error('version.properties 缺少 VERSION_CODE');
  return values;
}

/** 选一个带 javac 的 JDK。 */
function javaHome() {
  const candidates = [process.env.JAVA_HOME, '/usr/lib/jvm/java-17-openjdk-amd64'];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(join(candidate, 'bin', 'javac'))) return candidate;
  }
  throw new Error('找不到带 javac 的 JDK；设置 JAVA_HOME 指向 JDK 17 或更高版本');
}

/**
 * 取签名口令。
 *
 * 口令不写进仓库：优先用环境变量；否则读 `.run/android-signing/password`；
 * 都没有时说明还没生成过密钥，由 {@link ensureKeystore} 创建。
 */
function readPassword() {
  const fromEnv = process.env.CHATDSH_ANDROID_STORE_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (!existsSync(PASSWORD_FILE)) return undefined;
  const stored = readFileSync(PASSWORD_FILE, 'utf8').trim();
  return stored === '' ? undefined : stored;
}

/** 首次构建生成自用签名密钥；后续构建复用同一把，保证覆盖安装。 */
function ensureKeystore(home) {
  if (existsSync(KEYSTORE)) return;
  mkdirSync(SIGNING_DIR, { recursive: true });
  // 口令由 randomBytes 现场生成并写入 .run（已忽略），仓库里不出现任何口令字面值。
  const password = readPassword() ?? randomBytes(24).toString('base64url'); // gitleaks:allow
  if (!existsSync(PASSWORD_FILE)) writeFileSync(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  const keytool = join(home, 'bin', 'keytool');
  const result = spawnSync(keytool, [
    '-genkeypair', '-keystore', KEYSTORE,
    '-storepass', password, '-keypass', password,
    '-alias', 'chatdsh', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=ChatDSH, OU=Self Hosted, O=ChatDSH, L=Local, ST=Local, C=CN',
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`生成签名密钥失败（退出码 ${result.status}）`);
}

/** 合成构建目录；上游快照与适配层的合成规则全部在同步脚本里。 */
function sync() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-mobile-base.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`合成移动端构建目录失败（退出码 ${result.status}）`);
}

/** 调 Gradle 产出 release APK。 */
function build(home, password) {
  mkdirSync(ANDROID_HOME_DIR, { recursive: true });
  const result = spawnSync(join(ANDROID_DIR, 'gradlew'), [
    ':androidApp:assembleRelease', '--no-daemon',
    `-Duser.home=${ANDROID_HOME_DIR}`, // gitleaks:allow
  ], {
    cwd: ANDROID_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: ANDROID_HOME_DIR,
      JAVA_HOME: home,
      GRADLE_USER_HOME: GRADLE_HOME,
      ANDROID_HOME: process.env.ANDROID_HOME ?? '/opt/android-sdk',
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT ?? '/opt/android-sdk',
      CHATDSH_ANDROID_KEYSTORE: KEYSTORE,
      CHATDSH_ANDROID_STORE_PASSWORD: password,
      CHATDSH_ANDROID_KEY_ALIAS: 'chatdsh',
      CHATDSH_ANDROID_KEY_PASSWORD: password,
    },
  });
  if (result.status !== 0) throw new Error(`Android 构建失败（退出码 ${result.status}）`);
}

/** 探测地址是否可访问。 */
async function probe(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** 确保下载服务在跑；未运行时拉起一个脱离终端的实例。 */
async function ensureServer(url) {
  if (await probe(url)) return;
  mkdirSync(join(ROOT, '.run'), { recursive: true });
  const log = join(ROOT, '.run', 'apk-server.log');
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'serve-apk.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, CHATDSH_APK_BIND: APK_BIND, CHATDSH_APK_PORT: APK_PORT, CHATDSH_APK_DIR: APK_DIR },
  });
  child.unref();
  writeFileSync(join(ROOT, '.run', 'apk-server.pid'), String(child.pid ?? ''));
  writeFileSync(log, `APK 下载服务进程 ${child.pid ?? 'unknown'}\n`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await probe(url)) return;
    await new Promise((settle) => setTimeout(settle, 250));
  }
  throw new Error(`APK 下载服务没有在 ${APK_BIND}:${APK_PORT} 就绪；日志见 ${log}`);
}

const version = versionProperties();
const home = javaHome();
if (!SKIP_SYNC) sync();
ensureKeystore(home);
const password = readPassword(); // gitleaks:allow
if (password === undefined) throw new Error(`找不到签名口令：${PASSWORD_FILE}`);
build(home, password);
if (!existsSync(BUILD_OUTPUT)) throw new Error(`构建结束但没有找到 APK：${BUILD_OUTPUT}`);
mkdirSync(APK_DIR, { recursive: true });
const name = `chatdsh${version.VERSION_NAME}.apk`;
const target = join(APK_DIR, name);
copyFileSync(BUILD_OUTPUT, target);
const url = `http://${APK_BIND}:${APK_PORT}/${name}`;
await ensureServer(url);
console.log(`APK 已生成：${target}`);
console.log(`APK 下载地址：${url}`);
