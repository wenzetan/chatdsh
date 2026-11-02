// 环境探测与独立数据根。
//
// WP00 的环境条件检查，后续工作包的验收脚本共用。版本取法见 docs/README.md 第二节，
// 兼容范围见 docs/compatibility.md 第一节。探测结果只记录事实：不可达的服务与缺失的
// 命令都出现在返回结构里，由调用方决定停止哪一项验证。

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import semver from 'semver';

const RUNTIME_ROOT = resolve(import.meta.dirname, '..', '..');
const WORKSPACE_ROOT = resolve(RUNTIME_ROOT, '..');
const allocatedHomes = new Map();

/** 仓库钉住的版本基线。 */
export const BASELINE = Object.freeze({
  node: '>=22',
  dsh: '>=0.2.1-rc.2 <0.3.0-0',
  dshTui: '0.16.1',
});

/** DSH 安装根，默认取本机安装。 */
export function dshInstallRoot() {
  return (
    process.env.CHATDSH_DSH_INSTALL ??
    '/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh'
  );
}

/**
 * 读取 DSH 安装里的包版本。
 * @returns {{ version: string, entries: number }}
 */
export function readDshInstall() {
  const root = dshInstallRoot();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entries = readdirSync(join(root, 'node_modules', '@deepseek-ai')).length;
  return { version: manifest.version, entries };
}

/**
 * 读取 dsh-tui 的安装版本。
 * 本机装法把 dsh-tui 放在 profile 依赖里，因此按 profile 目录查找。
 * @returns {{ available: boolean, version?: string, reason?: string }}
 */
export function readDshTui() {
  const root = dshInstallRoot();
  const candidates = [
    join(root, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'),
    join('/root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/package.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
    return { available: true, version: manifest.version, path: candidate };
  }
  return { available: false, reason: '没有找到 dsh-tui 安装' };
}

/**
 * 探测一条命令的版本。
 * @param {{ name: string, command: string, args?: string[], hint?: string }} spec
 */
export function probeCommand(spec) {
  try {
    const output = execFileSync(spec.command, spec.args ?? ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { name: spec.name, available: true, version: output };
  } catch (error) {
    // 命令缺失是探测结论，按事实记录，不当作通过。
    return {
      name: spec.name,
      available: false,
      reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
      hint: spec.hint,
    };
  }
}

/**
 * 探测一个 HTTP 服务。
 * 可达性与预期状态分别报告，认证拒绝不能满足能力就绪条件。
 * @param {{ name: string, url: string, method?: string, note?: string, expectedStatuses?: number[] }} spec
 */
export async function probeHttpService(spec) {
  const started = Date.now();
  try {
    const response = await fetch(spec.url, {
      method: spec.method ?? 'GET',
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    return {
      name: spec.name,
      url: spec.url,
      reachable: true,
      ready: (spec.expectedStatuses ?? [200]).includes(response.status),
      status: response.status,
      latencyMs: Date.now() - started,
      note: spec.note,
    };
  } catch (error) {
    return {
      name: spec.name,
      url: spec.url,
      reachable: false,
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      note: spec.note,
    };
  }
}

/** 版本探测。 */
export function probeVersions() {
  const dshInstall = readDshInstall();
  const tui = readDshTui();
  return {
    node: { version: process.version },
    pnpm: probeCommand({ name: 'pnpm', command: 'pnpm', hint: 'corepack enable 或在 PATH 里加入 DSH 安装的 bin' }),
    dsh: { version: dshInstall.version, installRoot: dshInstallRoot(), entries: dshInstall.entries },
    dshTui: tui.available
      ? { available: true, version: tui.version, path: tui.path }
      : { available: false, reason: tui.reason },
    chrome: probeCommand({ name: 'chrome', command: 'google-chrome', args: ['--version'], hint: '安装 Google Chrome' }),
    git: probeCommand({ name: 'git', command: 'git', args: ['--version'] }),
    platform: { os: process.platform, arch: process.arch, kernel: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim() },
  };
}

/**
 * 仓库基线要求的环境条件，逐项给出是否满足与依据。
 * @param {ReturnType<typeof probeVersions>} versions
 */
export function checkBaseline(versions) {
  const items = [];
  const nodeOk = semver.satisfies(versions.node.version.replace(/^v/, ''), BASELINE.node);
  items.push({ item: 'node', required: BASELINE.node, actual: versions.node.version, ok: nodeOk });
  const dshOk = semver.satisfies(versions.dsh.version, BASELINE.dsh, { includePrerelease: true });
  items.push({ item: 'dsh', required: BASELINE.dsh, actual: versions.dsh.version, ok: dshOk, note: '仓库钉住 0.2.1-rc.2，本机安装不在范围内时需要先按 compatibility 第三节升级' });
  if (versions.dshTui.available === true) {
    items.push({ item: 'dsh-tui', required: BASELINE.dshTui, actual: versions.dshTui.version, ok: versions.dshTui.version === BASELINE.dshTui });
  } else {
    items.push({ item: 'dsh-tui', required: BASELINE.dshTui, actual: '缺失', ok: false, note: versions.dshTui.reason });
  }
  return items;
}

/** 工作区根。 */
export function workspaceRoot() {
  return WORKSPACE_ROOT;
}

/**
 * 断言一个绝对值落在当前工作区之内。
 * @param {string} target
 */
export function assertInsideWorkspace(target) {
  if (!isAbsolute(target)) throw new Error(`需要绝对路径：${target}`);
  const root = realpathSync(WORKSPACE_ROOT);
  const resolved = resolve(target);
  const lexical = relative(root, resolved);
  if (lexical === '' || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error(`目标不在工作区内：${resolved}`);
  }
  let existing = resolved;
  while (!existsSync(existing)) existing = dirname(existing);
  const physical = relative(root, realpathSync(existing));
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
    throw new Error(`目标不在工作区内：${resolved}`);
  }
  return resolved;
}

/**
 * 分配本次运行专用的独立数据根。
 * 位置固定在 runtime/.run 下，创建后断言它属于工作区，并且不与用户数据根重合。
 * @param {string} prefix
 */
export function allocateIndependentHome(prefix) {
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(prefix)) {
    throw new Error('数据根前缀只允许字母、数字、连字符和下划线');
  }
  const base = assertInsideWorkspace(resolve(RUNTIME_ROOT, '.run'));
  mkdirSync(base, { recursive: true });
  if (lstatSync(base).isSymbolicLink() || realpathSync(base) !== base) {
    throw new Error(`数据根父目录包含符号链接：${base}`);
  }
  const userHome = process.env.DSH_HOME;
  if (userHome !== undefined && userHome !== '') {
    const userPath = existsSync(userHome) ? realpathSync(userHome) : resolve(userHome);
    const overlap = relative(userPath, base);
    if (overlap === '' || (!isAbsolute(overlap) && overlap !== '..' && !overlap.startsWith(`..${sep}`))) {
      throw new Error(`测试父目录位于用户数据根内：${base}`);
    }
  }
  const home = mkdtempSync(join(base, `${prefix}-`));
  chmodSync(home, 0o700);
  const info = lstatSync(home);
  allocatedHomes.set(home, { dev: info.dev, ino: info.ino });
  return home;
}

/**
 * 释放独立数据根，删除前后都做断言。
 * @param {string} home
 */
export function releaseIndependentHome(home) {
  const resolved = assertInsideWorkspace(home);
  const owned = allocatedHomes.get(resolved);
  if (owned === undefined) throw new Error(`数据根未由本次执行分配：${resolved}`);
  const info = lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(resolved) !== resolved) {
    throw new Error(`数据根类型或真实路径不匹配：${resolved}`);
  }
  if (owned.dev !== info.dev || owned.ino !== info.ino) {
    throw new Error(`数据根已被替换：${resolved}`);
  }
  rmSync(resolved, { recursive: true });
  if (existsSync(resolved)) throw new Error(`数据根没有删除干净：${resolved}`);
  allocatedHomes.delete(resolved);
  return { removed: resolved };
}

/** 用户数据根在本次运行期间保持不变的依据。 */
export function snapshotUserHome() {
  const home = process.env.DSH_HOME;
  if (home === undefined || home === '') return { configured: false };
  const stat = statSync(home);
  return { configured: true, path: resolve(home), size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * 汇总环境报告。
 * @param {{ services: Array<{ name: string, url: string, method?: string, note?: string }> }} options
 */
export async function probeEnvironment(options) {
  const versions = probeVersions();
  const baseline = checkBaseline(versions);
  const services = [];
  for (const spec of options.services) services.push(await probeHttpService(spec));
  const missing = [
    ...baseline.filter((item) => !item.ok).map((item) => `${item.item}（要求 ${item.required}，实际 ${item.actual}）`),
    ...services.filter((item) => !item.ready).map((item) => `${item.name}（${item.reachable ? `HTTP ${item.status} 未满足预期状态` : '不可达'}）`),
  ];
  return { checkedAt: new Date().toISOString(), versions, baseline, services, missing };
}
