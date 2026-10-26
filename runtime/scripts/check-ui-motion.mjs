// 界面动效令牌与减少动效的核对。
//
// 设计稿第六节要求：120 毫秒用于悬停与按下，200 毫秒用于面板展开与页签切换，曲线统一为
// cubic-bezier(0.24, 0.72, 0.32, 1)；系统开启减少动态效果时，全部动画与过渡降到 0.001 毫秒。
// 这里核对三件事：
//   1. 令牌文件里三个动效取值与设计稿一致；
//   2. 组件样式在过渡里引用这两个时长与曲线，没有写死时长；
//   3. 组件样式的减少动效分支把动画与过渡时长都压到 0.001 毫秒。
//
// 用法：node scripts/check-ui-motion.mjs

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(import.meta.filename), '..');
const TOKENS = join(ROOT, 'packages', 'client', 'theme', 'src', 'client', 'styles', 'tokens.css');
const KIT_STYLES = join(ROOT, 'packages', 'core', 'ui-kit', 'src', 'styles.ts');

const tokensText = readFileSync(TOKENS, 'utf8');
const kitText = readFileSync(KIT_STYLES, 'utf8');

const failures = [];

/** 读一个令牌取值。 */
function tokenValue(name) {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(tokensText);
  if (match === null) throw new Error(`令牌文件里找不到 ${name}`);
  return match[1].trim();
}

const expected = new Map([
  ['--cdh-dur-1', '120ms'],
  ['--cdh-dur-2', '200ms'],
  ['--cdh-ease', 'cubic-bezier(0.24, 0.72, 0.32, 1)'],
]);
for (const [name, value] of expected) {
  const actual = tokenValue(name);
  if (actual !== value) failures.push(`${name} 为 ${actual}，设计稿要求 ${value}`);
}

if (!/transition:[^;]*var\(--cdh-dur-1\)[^;]*var\(--cdh-ease\)/.test(kitText)) {
  failures.push('组件样式的过渡没有同时引用 --cdh-dur-1 与 --cdh-ease');
}

const reducedLine = /@media \(prefers-reduced-motion: reduce\) \{[^\n]*/.exec(kitText);
if (reducedLine === null) {
  failures.push('组件样式没有减少动效分支');
} else {
  const rule = reducedLine[0];
  if (!rule.includes('animation-duration: 0.001ms')) failures.push('减少动效分支没有把动画时长压到 0.001 毫秒');
  if (!rule.includes('transition-duration: 0.001ms')) failures.push('减少动效分支没有把过渡时长压到 0.001 毫秒');
}

if (failures.length > 0) {
  for (const line of failures) console.log(`失败 ${line}`);
  process.exit(1);
}
console.log('动效时长与曲线取设计稿取值，过渡引用令牌，减少动效压到 0.001 毫秒');
