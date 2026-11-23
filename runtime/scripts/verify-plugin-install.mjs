// 官方 web profile 真实插件安装验收。
//
// 依次执行：在 runtime/.run 下建立隔离 DSH_HOME 并初始化官方 web profile、把
// @chatdsh 的发布 tarball 打包到同一临时目录、在 profile 的 pnpm-workspace.yaml
// 写入本地 tarball 覆盖、执行一次真实的 `dsh plugin --profile web add`、核对
// dump-config、启动真实 Web 服务核对遥测与客户端模块图，最后以
// CHATDSH_TELEMETRY=off 重启同一 profile 核对关闭状态。
//
// 安装方式：先打包组合包、它的直接依赖与传递工作区依赖（共 11 个 tarball），
// 在 profile 的 pnpm-workspace.yaml 写入 @chatdsh/* -> file:<tarball> 的
// overrides，再用一条 dsh plugin add 安装组合包 tarball。profile 内不创建
// 符号链接，仓库内也不存在指向工作区目录的链接。
//
// 发布依赖：各包的 package.json 对 @chatdsh/adapter 使用版本号 0.1.0，
// pnpm pack 会把 workspace:* 改写为版本号，因此 tarball 可以直接发布；
// 本地工作区用 runtime/pnpm-workspace.yaml 的 overrides 指到 ../dsh-adapter。
//
// 用法：node scripts/verify-plugin-install.mjs
// 退出码 0 表示全部通过。设置 CHATDSH_KEEP_RUN=1 可以保留临时目录便于排查。

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = resolve(ROOT, '..');
let activeServer;
process.on('exit', () => {
  if (activeServer === undefined) return;
  if (activeServer.exitCode !== null || activeServer.signalCode !== null) return;
  activeServer.kill('SIGKILL');
});
const HOME = tempHome('verify-plugin-install');
const TARBALLS = join(HOME, 'tarballs');
const PROFILE = join(HOME, 'profiles', 'web');
const DSH = dshCommand();
const STORE = resolveStore();

/** 组合包补丁层插入的全部条目，必须与 cordis.patch.yml 保持一致。 */
const EXPECTED_ENTRIES = [
  ['chatdsh-telemetry', '@chatdsh/host-telemetry'],
  ['chatdsh-device-link', '@chatdsh/host-device-link'],
  ['chatdsh-push', '@chatdsh/host-push'],
  ['chatdsh-import', '@chatdsh/host-import'],
  ['chatdsh-settings-sync', '@chatdsh/host-settings-sync'],
  ['chatdsh-client-telemetry', '@chatdsh/client-telemetry'],
  ['chatdsh-client-pwa', '@chatdsh/client-pwa'],
];

/** 参与打包的包目录，包含组合包、它的直接依赖与传递工作区依赖。 */
const PACKAGE_DIRS = [
  join(REPO, 'dsh-adapter'),
  join(ROOT, 'packages/bundle/chatdsh'),
  join(ROOT, 'packages/client/pwa'),
  join(ROOT, 'packages/client/telemetry'),
  join(ROOT, 'packages/core/contracts'),
  join(ROOT, 'packages/core/diagnostics'),
  join(ROOT, 'packages/host/device-link'),
  join(ROOT, 'packages/host/import'),
  join(ROOT, 'packages/host/push'),
  join(ROOT, 'packages/host/settings-sync'),
  join(ROOT, 'packages/host/telemetry'),
];

/** 验收依赖的构建产物。缺失时直接失败，并给出构建命令。 */
const REQUIRED_ARTIFACTS = [
  join(REPO, 'dsh-adapter/lib/index.js'),
  join(ROOT, 'packages/bundle/chatdsh/lib/index.js'),
  join(ROOT, 'packages/client/pwa/lib/index.js'),
  join(ROOT, 'packages/client/pwa/lib/client.js'),
  join(ROOT, 'packages/client/telemetry/lib/index.js'),
  join(ROOT, 'packages/client/telemetry/lib/client.js'),
  join(ROOT, 'packages/core/contracts/lib/index.js'),
  join(ROOT, 'packages/core/diagnostics/lib/index.js'),
  join(ROOT, 'packages/host/device-link/lib/index.js'),
  join(ROOT, 'packages/host/import/lib/index.js'),
  join(ROOT, 'packages/host/push/lib/index.js'),
  join(ROOT, 'packages/host/settings-sync/lib/index.js'),
  join(ROOT, 'packages/host/telemetry/lib/index.js'),
];

/** 本次运行使用过的复现命令。 */
const commands = [];

/**
 * 选择 pnpm store。
 * @returns store 的绝对路径。
 */
function resolveStore() {
  const fromEnv = process.env.CHATDSH_VERIFY_PNPM_STORE
    ?? process.env.pnpm_config_store_dir
    ?? process.env.npm_config_store_dir;
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  return join(ROOT, '.run', 'pnpm-store');
}

/**
 * 把命令渲染成可以复制执行的文本。
 * @param command - 可执行文件。
 * @param args - 参数列表。
 * @returns 渲染后的命令。
 */
function printableCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[^\w@%+=:,./-]/.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part))
    .join(' ');
}

/**
 * 执行一条命令。
 * @param command - 可执行文件。
 * @param args - 参数列表。
 * @param options - cwd、env 与是否继承输出。
 * @returns spawnSync 的结果。
 */
function run(command, args, options = {}) {
  const printable = printableCommand(command, args);
  console.log(`$ ${printable}`);
  commands.push(printable);
  const inherit = options.inherit === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: inherit ? undefined : 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const output = inherit ? '' : `\n${result.stdout ?? ''}${result.stderr ?? ''}`;
    throw new Error(`命令失败（退出码 ${String(result.status)}）：${printable}${output}`);
  }
  return result;
}

/**
 * 用 pnpm 执行一条命令。
 * @param args - pnpm 参数。
 * @param cwd - 工作目录。
 */
function pnpm(args, cwd) {
  const entry = process.env.npm_execpath;
  if (entry === undefined) run('pnpm', args, { cwd });
  else run(process.execPath, [entry, ...args], { cwd });
}

/**
 * 生成 dsh 子进程环境。
 * @param telemetry - `on` 或 `off`。
 * @returns 环境变量。
 */
function dshEnv(telemetry) {
  const env = {
    ...process.env,
    DSH_HOME: HOME,
    npm_config_store_dir: STORE,
    pnpm_config_store_dir: STORE,
    CHATDSH_TELEMETRY: telemetry,
  };
  delete env.DSH_TELEMETRY_DISABLED;
  return env;
}

/**
 * 读取包的清单。
 * @param dir - 包目录。
 * @returns 解析后的 package.json。
 */
function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/**
 * 计算 pnpm pack 生成的 tarball 路径。
 * @param manifest - 包清单。
 * @returns tarball 的绝对路径。
 */
function tarballOf(manifest) {
  const base = manifest.name.startsWith('@')
    ? manifest.name.slice(1).replace('/', '-')
    : manifest.name;
  return join(TARBALLS, `${base}-${manifest.version}.tgz`);
}

/**
 * 把全部参与安装的包打成 tarball。
 * @returns 包名到 tarball 路径的映射。
 */
function packPackages() {
  mkdirSync(TARBALLS, { recursive: true });
  const packed = new Map();
  for (const dir of PACKAGE_DIRS) {
    const manifest = manifestOf(dir);
    pnpm([
      `--config.store-dir=${STORE}`,
      '--config.verify-deps-before-run=false',
      '--dir',
      dir,
      'pack',
      '--pack-destination',
      TARBALLS,
    ], ROOT);
    const tarball = tarballOf(manifest);
    if (!existsSync(tarball)) throw new Error(`pnpm pack 没有生成 ${tarball}`);
    packed.set(manifest.name, tarball);
  }
  return packed;
}

/**
 * 检查全部发布 tarball 的依赖不再包含仓库内路径协议。
 * @param packed - 包名到 tarball 路径的映射。
 */
function assertPublishableTarballs(packed) {
  for (const [packageName, tarball] of packed) {
    const result = run('tar', ['-xOf', tarball, 'package/package.json']);
    const manifest = JSON.parse(result.stdout);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('workspace:') || spec.startsWith('file:'))) {
          throw new Error(`${packageName} 的 ${field}.${name} 仍是 ${spec}`);
        }
      }
    }
  }
}

/**
 * 在 profile 的 pnpm-workspace.yaml 写入本地 tarball 覆盖。
 * @param packed - 包名到 tarball 路径的映射。
 */
function writeOverrides(packed) {
  const path = join(PROFILE, 'pnpm-workspace.yaml');
  const text = readFileSync(path, 'utf8');
  if (/^overrides:/m.test(text)) throw new Error(`${path} 已包含 overrides，拒绝覆盖`);
  const lines = ['', 'overrides:'];
  for (const [name, tarball] of packed) lines.push(`  '${name}': file:${tarball}`);
  writeFileSync(path, `${text.trimEnd()}\n${lines.join('\n')}\n`);
}

/**
 * 读取 dump-config 输出并断言组合包追加的条目。
 * @param baseline - 安装前的输出。
 * @param composed - 安装后的输出。
 * @param stderr - 安装后的标准错误。
 */
function assertComposedConfig(baseline, composed, stderr) {
  if (stderr.trim() !== '') throw new Error(`dump-config 标准错误不为空：\n${stderr}`);
  if (!composed.startsWith(baseline)) throw new Error('dump-config 的安装前内容不再是安装后内容的前缀，上游条目被改动');
  const appended = composed.slice(baseline.length).trimEnd();
  const lines = appended.split('\n');
  if (lines[0] !== '# == @chatdsh/bundle') throw new Error(`组合包段落的标题不正确：${lines[0]}`);
  const rows = lines.slice(1);
  const expectedRows = EXPECTED_ENTRIES.length * 2;
  if (rows.length !== expectedRows) throw new Error(`组合包段落有 ${rows.length} 行，期望 ${expectedRows} 行`);
  for (const [index, [id, name]] of EXPECTED_ENTRIES.entries()) {
    const idLine = rows[index * 2];
    const nameLine = rows[index * 2 + 1];
    if (idLine !== `- id: ${id}`) throw new Error(`第 ${index + 1} 个条目的 id 行是 ${idLine}`);
    if (nameLine !== `  name: '${name}'` && nameLine !== `  name: "${name}"`) {
      throw new Error(`第 ${index + 1} 个条目的 name 行是 ${nameLine}`);
    }
  }
  if (appended.includes('disabled')) throw new Error('组合包段落包含 disabled 字段');
}

/**
 * 等待一段时间。
 * @param ms - 毫秒。
 */
function delay(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

/**
 * 启动 Web 服务并等待它打印访问地址。
 * @param telemetry - `on` 或 `off`。
 * @returns 子进程、访问地址与累计输出。
 */
function startWeb(telemetry) {
  const args = ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
  const printable = printableCommand(DSH, args);
  console.log(`$ ${printable}`);
  commands.push(printable);
  const child = spawn(DSH, args, {
    cwd: ROOT,
    env: dshEnv(telemetry),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  activeServer = child;
  let output = '';
  return new Promise((settle, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`dsh 在 120 秒内没有打印访问地址：\n${output}`));
    }, 120000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/dsh web: (http:\/\/\S+)/);
      if (match === null) return;
      clearTimeout(timer);
      settle({ child, url: match[1], output: () => output });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dsh 在打印访问地址前退出（退出码 ${String(code)}）：\n${output}`));
    });
  });
}

/**
 * 终止 Web 服务并等待端口释放。
 * @param server - startWeb 的返回值。
 */
async function stopWeb(server) {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (activeServer === child) activeServer = undefined;
    return;
  }
  if (process.platform === 'win32') child.kill('SIGTERM');
  else process.kill(-child.pid, 'SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    delay(15000).then(() => false),
  ]);
  if (exited) {
    if (activeServer === child) activeServer = undefined;
    return;
  }
  if (process.platform === 'win32') child.kill('SIGKILL');
  else process.kill(-child.pid, 'SIGKILL');
  await Promise.race([once(child, 'exit'), delay(5000)]);
  if (activeServer === child) activeServer = undefined;
}

/**
 * 请求 JSON 端点。
 * @param url - 地址。
 * @param options - fetch 选项。
 * @returns 状态码与解析后的 JSON。
 */
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), ...options });
  const text = await response.text();
  const body = JSON.parse(text);
  return { status: response.status, body };
}

/**
 * 用打印出的令牌打开首页并取得登录 Cookie。
 * @param url - dsh 打印的带令牌地址。
 * @returns Cookie 与首页 HTML。
 */
async function openHome(url) {
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (auth.status !== 303) throw new Error(`带令牌访问首页返回 ${auth.status}，期望 303`);
  const setCookie = auth.headers.getSetCookie()[0] ?? auth.headers.get('set-cookie');
  if (setCookie === undefined || setCookie === null) throw new Error('带令牌访问首页没有返回 Set-Cookie');
  const cookie = setCookie.split(';')[0];
  const home = await fetch(new URL('/', url), {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  });
  if (home.status !== 200) throw new Error(`首页返回 ${home.status}，期望 200`);
  return { cookie, html: await home.text() };
}

/**
 * 从首页 HTML 提取 __DSH_BOOT__ 模块图。
 * @param html - 首页 HTML。
 * @returns 模块图。
 */
function bootGraph(html) {
  const match = html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/s);
  if (match === null) throw new Error('首页没有 __DSH_BOOT__ 模块图');
  return JSON.parse(match[1]);
}

/**
 * 核对客户端插件出现在模块图并可以取回产物。
 * @param url - dsh 打印的带令牌地址。
 * @param cookie - 登录 Cookie。
 * @param html - 首页 HTML。
 */
async function assertClientModules(url, cookie, html) {
  const graph = bootGraph(html);
  for (const id of ['@chatdsh/client-telemetry', '@chatdsh/client-pwa']) {
    const entry = graph.entries.find((item) => item.id === id);
    if (entry === undefined) throw new Error(`__DSH_BOOT__ 缺少 ${id}`);
    if (entry.url !== `plugins/??${id}/client.js&rev=${entry.rev}`) {
      throw new Error(`${id} 的模块地址是 ${entry.url}`);
    }
    const response = await fetch(new URL(entry.url, url), {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) throw new Error(`${id} 的客户端产物返回 ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('text/javascript')) throw new Error(`${id} 的客户端产物类型是 ${type}`);
    const body = await response.text();
    if (!body.includes('__ModuleLoader__')) throw new Error(`${id} 的客户端产物没有注册模块`);
    if (!body.includes(id)) throw new Error(`${id} 的客户端产物没有包含模块标识`);
  }
}

/**
 * 核对遥测开启状态。
 * @param origin - 服务根地址。
 */
async function assertTelemetryEnabled(origin) {
  const status = await fetchJson(`${origin}/chatdsh/telemetry/status`);
  if (status.status !== 200) throw new Error(`遥测状态端点返回 ${status.status}`);
  if (status.body.enabled !== true) throw new Error(`遥测没有开启：${JSON.stringify(status.body)}`);
}

/**
 * 核对遥测关闭状态。
 * @param origin - 服务根地址。
 */
async function assertTelemetryDisabled(origin) {
  const status = await fetchJson(`${origin}/chatdsh/telemetry/status`);
  if (status.status !== 200) throw new Error(`遥测状态端点返回 ${status.status}`);
  if (status.body.enabled !== false) throw new Error(`遥测没有关闭：${JSON.stringify(status.body)}`);
  if (status.body.reason !== 'env') throw new Error(`遥测关闭原因是 ${String(status.body.reason)}，期望 env`);
  const relay = await fetch(`${origin}/chatdsh/telemetry/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records: [] }),
    signal: AbortSignal.timeout(10000),
  });
  if (relay.status !== 404) throw new Error(`关闭后浏览器上报端点返回 ${relay.status}，期望 404`);
}

/**
 * 打印失败信息与可复现命令。
 * @param error - 失败原因。
 */
function reportFailure(error) {
  const bundleTarball = tarballOf(manifestOf(join(ROOT, 'packages/bundle/chatdsh')));
  console.error(`验收失败：${error instanceof Error ? error.message : String(error)}`);
  console.error('');
  console.error('可复现命令（设置 CHATDSH_KEEP_RUN=1 可保留本次临时目录）：');
  console.error(`  DSH_HOME=${HOME} dsh plugin --profile web --config.store-dir=${STORE} add ${bundleTarball}`);
  console.error(`  DSH_HOME=${HOME} dsh --profile web --dump-config`);
  console.error(`  DSH_HOME=${HOME} dsh --profile web --no-open --host 127.0.0.1 --port 0`);
  console.error('');
  console.error('本次执行过的命令：');
  for (const command of commands) console.error(`  ${command}`);
}

try {
  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!existsSync(artifact)) {
      throw new Error(`缺少构建产物 ${artifact}；先运行 pnpm build && pnpm build:client`);
    }
  }

  const patchText = readFileSync(join(ROOT, 'packages/bundle/chatdsh/cordis.patch.yml'), 'utf8');
  if (/^\s*disabled\s*:/m.test(patchText)) throw new Error('cordis.patch.yml 包含 disabled 字段');

  run(DSH, ['plugin', '--profile', 'web', `--config.store-dir=${STORE}`, 'list'], { env: dshEnv('on') });
  if (!existsSync(join(PROFILE, 'package.json'))) throw new Error(`profile 没有初始化：${PROFILE}`);

  const baselineDump = run(DSH, ['--profile', 'web', '--dump-config'], { env: dshEnv('on') });
  if (baselineDump.stderr.trim() !== '') throw new Error(`安装前 dump-config 标准错误不为空：\n${baselineDump.stderr}`);
  if (baselineDump.stdout.includes('chatdsh-')) throw new Error('安装前 dump-config 已经包含 ChatDSH 条目');

  const packed = packPackages();
  const bundleTarball = packed.get('@chatdsh/bundle');
  if (bundleTarball === undefined) throw new Error('没有找到 @chatdsh/bundle 的 tarball');
  assertPublishableTarballs(packed);
  writeOverrides(packed);

  run(DSH, [
    'plugin',
    '--profile',
    'web',
    `--config.store-dir=${STORE}`,
    'add',
    bundleTarball,
  ], { env: dshEnv('on') });

  const profileManifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'));
  if (!(profileManifest.dsh?.profile?.bundles ?? []).includes('@chatdsh/bundle')) {
    throw new Error('profile 的 bundles 没有包含 @chatdsh/bundle');
  }
  if (!existsSync(join(PROFILE, 'node_modules', '@chatdsh', 'bundle', 'package.json'))) {
    throw new Error('profile 的 node_modules 没有安装 @chatdsh/bundle');
  }

  const composedDump = run(DSH, ['--profile', 'web', '--dump-config'], { env: dshEnv('on') });
  assertComposedConfig(baselineDump.stdout, composedDump.stdout, composedDump.stderr);

  const enabledServer = await startWeb('on');
  try {
    const origin = new URL(enabledServer.url).origin;
    await assertTelemetryEnabled(origin);
    const { cookie, html } = await openHome(enabledServer.url);
    await assertClientModules(enabledServer.url, cookie, html);
  } finally {
    await stopWeb(enabledServer);
  }

  const disabledServer = await startWeb('off');
  try {
    const origin = new URL(disabledServer.url).origin;
    await assertTelemetryDisabled(origin);
  } finally {
    await stopWeb(disabledServer);
  }

  console.log('');
  console.log('官方 web profile 真实插件安装验收通过。');
  console.log(`安装命令：DSH_HOME=${HOME} dsh plugin --profile web --config.store-dir=${STORE} add ${bundleTarball}`);
  console.log(`dump-config：${EXPECTED_ENTRIES.length} 个组合包条目全部出现，且没有改动上游条目`);
  console.log('遥测开启：status.enabled=true；遥测关闭：status.enabled=false、reason=env、browser 上报 404');
  console.log(`客户端模块：@chatdsh/client-telemetry 与 @chatdsh/client-pwa 的产物均返回 200`);
  console.log('临时 DSH_HOME 会在进程退出时清理；设置 CHATDSH_KEEP_RUN=1 可以保留现场。');
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
}
