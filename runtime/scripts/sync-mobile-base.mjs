// 把上游 dsh-mobile 快照与 ChatDSH 适配层合成 Android 构建目录。
//
// 三层结构：
//   mobile/base/            上游仓库的 Android 子树原样快照，永不修改
//   mobile/overlay/files/   本仓库接管的完整文件，路径与 base 内相对路径一致
//   mobile/android/         合成结果，构建从这里读，不进版本管理
//
// overlay 的每个接管文件在 mobile/overlay/manifest.json 里登记来源路径与上游文件的
// SHA-256。上游升级后如果被接管文件的原文变了，说明上游改过同一处，脚本报出冲突，
// 由人决定把上游改动合进接管文件、还是放弃接管。
//
// 用法：
//   node scripts/sync-mobile-base.mjs           合成到 mobile/android
//   node scripts/sync-mobile-base.mjs --check   只报告漂移与缺失，不写文件
//   node scripts/sync-mobile-base.mjs --record  重新记录 manifest 里全部上游摘要
//
// 退出码 0 表示一致，1 表示存在漂移、缺失或未登记的接管文件。

import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MOBILE = join(ROOT, 'mobile');
const BASE = join(MOBILE, 'base');
const OVERLAY = join(MOBILE, 'overlay');
const OVERLAY_FILES = join(OVERLAY, 'files');
const MANIFEST = join(OVERLAY, 'manifest.json');
const TARGET = join(MOBILE, 'android');
const VERSION_FILE = join(MOBILE, 'version.properties');

const CHECK = process.argv.includes('--check');
const RECORD = process.argv.includes('--record');

/** 递归列出目录下的文件相对路径，跳过版本库与构建产物。 */
function listFiles(dir, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'build' || entry.name === '.gradle' || entry.name === '.kotlin') continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** 文件内容的 SHA-256。 */
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 读版本号；构建与同步都从这里取，避免两处各写一份。 */
function readVersion() {
  if (!existsSync(VERSION_FILE)) throw new Error(`缺少 ${VERSION_FILE}`);
  const values = {};
  for (const line of readFileSync(VERSION_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match !== null) values[match[1]] = match[2].trim();
  }
  for (const key of ['VERSION_NAME', 'VERSION_CODE']) {
    if (values[key] === undefined) throw new Error(`version.properties 缺少 ${key}`);
  }
  if (!/^\d+$/.test(values.VERSION_CODE)) throw new Error(`version.properties 的 VERSION_CODE 不是整数：${values.VERSION_CODE}`);
  return values;
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (!Array.isArray(manifest.entries)) throw new Error(`${MANIFEST} 缺少 entries 数组`);

const failures = [];
const warnings = [];

// 接管目录里的文件必须逐条登记。未登记的文件不会进入构建，静默失效最难排查。
const overlayFiles = listFiles(OVERLAY_FILES);
const registered = new Set(manifest.entries.map((entry) => entry.path));
for (const path of overlayFiles) {
  if (!registered.has(path)) failures.push(`overlay/files/${path} 没有在 manifest.json 里登记`);
}

const targetEntries = [];
for (const entry of manifest.entries) {
  if (typeof entry.path !== 'string' || entry.path === '') {
    failures.push('manifest.json 里存在缺少 path 的条目');
    continue;
  }
  if (typeof entry.reason !== 'string' || entry.reason === '') {
    failures.push(`${entry.path} 缺少接管原因`);
  }
  const overlayPath = join(OVERLAY_FILES, entry.path);
  if (!existsSync(overlayPath)) {
    failures.push(`${entry.path} 在 overlay/files 里不存在`);
    continue;
  }
  // 新增文件是本仓库独有的，上游没有对应原文，因此不参与漂移比对，也不记摘要。
  if (entry.added === true) {
    if (existsSync(join(BASE, entry.path))) {
      failures.push(`${entry.path} 标记为新增，但上游 base 里已有同名文件；应改为接管并记录上游摘要`);
      continue;
    }
    targetEntries.push({ ...entry });
    continue;
  }
  const upstreamPath = join(BASE, entry.path);
  if (!existsSync(upstreamPath)) {
    failures.push(`${entry.path} 在上游 base 里不存在；上游可能改过路径或删过文件`);
    continue;
  }
  const upstreamSha = digest(upstreamPath);
  const overlaySha = digest(overlayPath);
  if (RECORD) {
    targetEntries.push({ ...entry, upstreamSha256: upstreamSha });
    continue;
  }
  if (typeof entry.upstreamSha256 !== 'string' || entry.upstreamSha256 === '') {
    failures.push(`${entry.path} 没有记录上游摘要；先跑 --record 建立基线`);
    continue;
  }
  if (entry.upstreamSha256 !== upstreamSha) {
    failures.push(
      `${entry.path} 的上游原文已变（记录 ${entry.upstreamSha256.slice(0, 12)}，当前 ${upstreamSha.slice(0, 12)}）；` +
      '上游改过同一处，需要人工合并后用 --record 更新基线'
    );
    continue;
  }
  if (overlaySha === upstreamSha) {
    warnings.push(`${entry.path} 的接管内容与上游原文完全相同，这一条接管可以删掉`);
  }
  targetEntries.push({ ...entry, upstreamSha256: upstreamSha });
}

if (RECORD) {
  // 有条目被跳过时绝不写盘：写下去等于把跳过的条目从清单里删掉，接管会静默失效。
  if (failures.length > 0) {
    for (const line of failures) console.log(`失败 ${line}`);
    process.exit(1);
  }
  if (targetEntries.length !== manifest.entries.length) {
    console.log(`失败 记录条数 ${targetEntries.length} 与清单 ${manifest.entries.length} 不一致`);
    process.exit(1);
  }
  writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, entries: targetEntries }, null, 2)}\n`);
  console.log(`已重新记录 ${targetEntries.length} 条上游摘要基线`);
  process.exit(0);
}

if (failures.length > 0) {
  for (const line of failures) console.log(`失败 ${line}`);
  process.exit(1);
}
for (const line of warnings) console.log(`提示 ${line}`);

const version = readVersion();
if (CHECK) {
  console.log(`接管 ${manifest.entries.length} 个文件，上游摘要全部匹配，版本 ${version.VERSION_NAME}`);
  process.exit(0);
}

// 合成：先清掉旧结果，再原样复制 base，最后用接管文件覆盖同名路径。
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
for (const name of readdirSync(BASE)) {
  cpSync(join(BASE, name), join(TARGET, name), { recursive: true, dereference: true });
}
for (const entry of manifest.entries) {
  const destination = join(TARGET, entry.path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(OVERLAY_FILES, entry.path), destination);
}

// 版本号文件是构建的唯一来源，放在合成目录根部供 Gradle 读取。
copyFileSync(VERSION_FILE, join(TARGET, 'version.properties'));

const upstream = JSON.parse(readFileSync(join(MOBILE, 'upstream.json'), 'utf8'));
console.log(`上游 ${upstream.tag}（${upstream.commit.slice(0, 12)}），接管 ${manifest.entries.length} 个文件`);
console.log(`版本 ${version.VERSION_NAME}（${version.VERSION_CODE}），构建目录 ${relative(ROOT, TARGET)}`);
