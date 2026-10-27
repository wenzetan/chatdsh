// 核对上游 dsh-mobile 快照与仓库记录的版本是否一致，并报告接管文件的上游漂移。
//
// 这条检查把「升级上游」从一个不可见的手工动作变成一次显式的、可核对的改动：
// 上游发新版时，先按记录的方式替换 mobile/base，再跑本脚本，它会指出哪些接管文件
// 的上游原文变了、哪些上游文件被删了、哪些新增文件没有纳入记录。
//
// 用法：
//   node scripts/check-mobile-upstream.mjs            核对已记录的版本与漂移
//   node scripts/check-mobile-upstream.mjs --online   另外向远程仓库查询最新 tag
//
// 退出码 0 表示一致，1 表示存在漂移或版本不符。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MOBILE = join(ROOT, 'mobile');
const UPSTREAM = JSON.parse(readFileSync(join(MOBILE, 'upstream.json'), 'utf8'));
const ONLINE = process.argv.includes('--online');

const failures = [];

// 快照目录必须存在，且不能混入上游仓库里被排除的 iOS 工程。
if (!existsSync(join(MOBILE, 'base'))) failures.push('mobile/base 不存在；上游快照缺失');
for (const excluded of ['DeepSeekHarnessMobile.xcodeproj', 'DeepSeekHarnessMobile', 'Vendor']) {
  if (existsSync(join(MOBILE, 'base', excluded))) {
    failures.push(`mobile/base 里出现了本仓库不构建的 ${excluded}；快照范围与 upstream.json 不符`);
  }
}
for (const required of UPSTREAM.subtree) {
  if (!existsSync(join(MOBILE, 'base', required))) failures.push(`mobile/base 缺少声明的子树 ${required}`);
}

// 版本记录必须自洽：tag 与 commit 都要有，且应用版本要与上游工程里的实际取值一致。
for (const key of ['tag', 'commit', 'repository', 'appVersionName', 'appVersionCode']) {
  if (UPSTREAM[key] === undefined || UPSTREAM[key] === '') failures.push(`upstream.json 缺少 ${key}`);
}
if (UPSTREAM.commit !== undefined && !/^[0-9a-f]{40}$/.test(UPSTREAM.commit)) {
  failures.push(`upstream.json 的 commit 不是完整的 40 位哈希：${UPSTREAM.commit}`);
}

const appBuild = join(MOBILE, 'base', 'androidApp', 'build.gradle.kts');
if (existsSync(appBuild)) {
  const text = readFileSync(appBuild, 'utf8');
  const versionCode = text.match(/versionCode\s*=\s*(\d+)/);
  const versionName = text.match(/versionName\s*=\s*"([^"]+)"/);
  if (versionCode === null) failures.push('上游 androidApp/build.gradle.kts 里找不到 versionCode');
  else if (Number(versionCode[1]) !== UPSTREAM.appVersionCode) {
    failures.push(`upstream.json 记录的 appVersionCode ${UPSTREAM.appVersionCode} 与上游工程 ${versionCode[1]} 不符`);
  }
  if (versionName === null) failures.push('上游 androidApp/build.gradle.kts 里找不到 versionName');
  else if (versionName[1] !== UPSTREAM.appVersionName) {
    failures.push(`upstream.json 记录的 appVersionName ${UPSTREAM.appVersionName} 与上游工程 ${versionName[1]} 不符`);
  }
}

// 接管文件的上游摘要漂移由同步脚本判定，这里把它跑一遍，避免两处规则各写一份。
let syncOk = true;
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'sync-mobile-base.mjs'), '--check'], { stdio: 'inherit' });
} catch {
  syncOk = false;
  failures.push('接管文件的上游摘要不一致，见上面的同步检查输出');
}

if (ONLINE) {
  const tags = execFileSync('git', ['ls-remote', '--tags', '--refs', UPSTREAM.repository], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter((ref) => ref !== undefined && ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice('refs/tags/'.length))
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const compare = (left, right) => {
    const a = left.replace(/^v/, '').split('.').map(Number);
    const b = right.replace(/^v/, '').split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  };
  const latest = tags.sort(compare).at(-1);
  if (latest === undefined) failures.push('远程仓库没有任何形如 vX.Y.Z 的 tag');
  else if (compare(latest, UPSTREAM.tag) > 0) {
    failures.push(`上游已有更新的 tag ${latest}，当前快照停在 ${UPSTREAM.tag}`);
  } else {
    console.log(`远程最新 tag ${latest}，当前快照 ${UPSTREAM.tag}`);
  }
}

if (failures.length > 0) {
  for (const line of failures) console.log(`失败 ${line}`);
  process.exit(1);
}
console.log(`上游快照 ${UPSTREAM.tag}（${UPSTREAM.commit.slice(0, 12)}）与本仓库记录一致`);
