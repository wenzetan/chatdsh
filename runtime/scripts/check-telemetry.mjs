// 校验遥测声明、源码与文档三处一致。
//
// 规则：
//   1. 包内源码出现的每个 `chatdsh.` 事件名与 `chatdsh_` 指标名，必须在本包 package.json 的
//      chatdsh.telemetry 里声明；没有声明遥测面的包出现这类名称同样按失败处理。
//   2. chatdsh.telemetry 里声明的每个名称，必须在包内源码里出现。
//   3. chatdsh.telemetry 里声明的每个名称，必须登记在 docs/telemetry.md 第六节的清单里。
//
// 第五节登记的属性键在比对时排除，它们不是信号名。
//
// 用法：node scripts/check-telemetry.mjs [仓库根目录]
// 退出码 0 表示一致，1 表示存在缺失、未登记的信号。仓库还没有 packages 目录或包时打印提示并通过。

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? process.cwd());
const PACKAGES_DIR = join(ROOT, 'packages');
const DOC = join(ROOT, 'docs', 'telemetry.md');
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// 事件名与 span 名至少三段：chatdsh.<domain>.<fact>
const EVENT = /\bchatdsh\.[a-z0-9]+(?:\.[a-z0-9]+)+\b/g;
// 指标名的后缀随类型变化，按前缀整体收集
const METRIC = /\bchatdsh_[a-z0-9_]+\b/g;
// docs/telemetry.md 第五节登记的属性键
const ATTRIBUTE_KEYS = new Set([
  'chatdsh.surface',
  'chatdsh.component',
  'chatdsh.instance.id',
  'chatdsh.version',
]);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectSources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'lib') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectSources(full));
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

// 包可以嵌套在 packages 的子目录下（例如 packages/host/<name>），因此按目录递归找清单文件。
async function collectManifests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'lib' || entry.name === 'src') continue;
    const full = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    const manifestPath = join(full, 'package.json');
    if (await exists(manifestPath)) out.push(manifestPath);
    out.push(...await collectManifests(full));
  }
  return out;
}

function collectUsedNames(text) {
  const names = new Set();
  for (const name of text.match(EVENT) ?? []) {
    if (!ATTRIBUTE_KEYS.has(name)) names.add(name);
  }
  for (const name of text.match(METRIC) ?? []) names.add(name);
  return names;
}

function readDeclared(manifest, manifestPath, failures) {
  const telemetry = manifest.chatdsh?.telemetry;
  if (telemetry === undefined) return undefined;
  const names = new Set();
  for (const group of ['events', 'spans', 'metrics']) {
    const values = telemetry[group] ?? [];
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      failures.push(`${relative(ROOT, manifestPath)} 的 chatdsh.telemetry.${group} 必须是字符串数组`);
      continue;
    }
    for (const value of values) names.add(value);
  }
  return names;
}

if (!await exists(DOC)) {
  console.error(`未找到 ${DOC}，遥测接口清单是声明校验的基准。`);
  process.exit(1);
}

if (!await exists(PACKAGES_DIR)) {
  console.log('仓库还没有 packages 目录，遥测声明比对在出现包之后生效。');
  process.exit(0);
}

const manifestPaths = await collectManifests(PACKAGES_DIR);

if (manifestPaths.length === 0) {
  console.log('packages 目录下还没有包，遥测声明比对在出现包之后生效。');
  process.exit(0);
}

const docText = await readFile(DOC, 'utf8');
const failures = [];
let checkedCount = 0;

for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const declared = readDeclared(manifest, manifestPath, failures);

  const used = new Set();
  for (const file of await collectSources(dirname(manifestPath))) {
    for (const name of collectUsedNames(await readFile(file, 'utf8'))) used.add(name);
  }

  if (declared === undefined) {
    if (used.size > 0) {
      failures.push(`${relative(ROOT, manifestPath)} 的源码出现 ${[...used].sort().join(' ')}，package.json 没有声明 chatdsh.telemetry`);
    }
    continue;
  }

  checkedCount += 1;
  for (const name of declared) {
    if (!used.has(name)) failures.push(`${relative(ROOT, manifestPath)} 声明了 ${name}，源码里没有出现`);
    if (!docText.includes(name)) failures.push(`${relative(ROOT, manifestPath)} 声明了 ${name}，docs/telemetry.md 的清单里没有登记`);
  }
  for (const name of used) {
    if (!declared.has(name)) failures.push(`${relative(ROOT, manifestPath)} 的源码出现 ${name}，package.json 没有声明`);
  }
}

// 属性一致性：文档里每个 span 行的属性列必须覆盖源码里同名调用设置的全部键。
{
  const spanRows = docText
    .split('\n')
    .map((line) => line.match(/^\| span \| `([a-z0-9.]+)` \|.*\| (.+) \|\s*$/))
    .filter((match) => match !== null)
    .map((match) => ({
      name: match[1],
      attributes: [...match[2].matchAll(/`([\w.]+)`/g)].map((item) => item[1]),
    }));

  const sourceTexts = [];
  for (const manifestPath of manifestPaths) {
    for (const file of await collectSources(dirname(manifestPath))) {
      sourceTexts.push({ file, text: await readFile(file, 'utf8') });
    }
  }

  for (const row of spanRows) {
    for (const { file, text } of sourceTexts) {
      const lines = text.split('\n');
      const start = lines.findIndex((line) => line.includes(`'${row.name}'`));
      if (start < 0) continue;
      const keys = new Set();
      for (let index = start; index < lines.length && index < start + 40; index += 1) {
        // 遇到下一个 span 调用就停，避免把相邻信号的属性算进来。
        if (index > start && /runSpan(Sync)?\(/.test(lines[index])) break;
        for (const match of lines[index].matchAll(/setAttribute\('([\w.]+)'/g)) keys.add(match[1]);
      }
      for (const key of keys) {
        if (!row.attributes.includes(key)) {
          failures.push(`${relative(ROOT, file)} 的 ${row.name} 设置了 ${key}，docs/telemetry.md 的属性列里没有`);
        }
      }
    }
  }
  // 事件属性：同名 event 调用带的键必须在文档的属性列里。
  const eventRows = docText
    .split('\n')
    .map((line) => line.match(/^\| event \| `([a-z0-9.]+)` \|.*\| (.+) \|\s*$/))
    .filter((match) => match !== null)
    .map((match) => ({
      name: match[1],
      attributes: [...match[2].matchAll(/`([\w.]+)`/g)].map((item) => item[1]),
    }));

  for (const row of eventRows) {
    for (const { file, text } of sourceTexts) {
      const lines = text.split('\n');
      const start = lines.findIndex((line) => line.includes(`'${row.name}'`));
      if (start < 0) continue;
      const keys = new Set();
      for (let index = start; index < lines.length && index < start + 12; index += 1) {
        for (const match of lines[index].matchAll(/'([\w.]+)':/g)) keys.add(match[1]);
        if (index > start && /\}\);/.test(lines[index])) break;
      }
      for (const key of keys) {
        if (!row.attributes.includes(key)) {
          failures.push(`${relative(ROOT, file)} 的 ${row.name} 带了 ${key}，docs/telemetry.md 的属性列里没有`);
        }
      }
    }
  }
  console.log(`属性一致性核对了 ${spanRows.length} 个 span、${eventRows.length} 个 event 声明。`);
}

if (failures.length > 0) {
  console.error('遥测声明校验失败：');
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`遥测声明校验通过，检查了 ${manifestPaths.length} 个包，其中 ${checkedCount} 个声明了遥测面。`);
