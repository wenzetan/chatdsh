// 客户端面板组件的令牌与色彩约束检查。
//
// 设计约束要求所有颜色、字号、间距、圆角引用令牌，业务组件不写颜色字面值。这里对共享
// 组件包的样式文本做静态核对：
//   1. 组件样式里引用的自定义属性，全部由主题插件的令牌与别名映射、或组件样式自身的
//      派生声明给出（例如由令牌算出的行高变量）；
//   2. 组件样式里不出现十六进制、rgb、rgba、hsl、hsla 颜色字面值；
//   3. 组件样式确实随主题插件的样式一起注入文档。
// 任一条不成立即退出 1。
//
// 用法：node scripts/check-ui-kit-tokens.mjs

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(import.meta.filename), '..');
const KIT_STYLES = join(ROOT, 'packages', 'core', 'ui-kit', 'src', 'styles.ts');
const THEME_DIR = join(ROOT, 'packages', 'client', 'theme', 'src', 'client');
const TOKENS = join(THEME_DIR, 'styles', 'tokens.css');
const ALIASES = join(THEME_DIR, 'styles', 'shell.css');
const APPLY = join(THEME_DIR, 'apply-styles.ts');

const kitText = readFileSync(KIT_STYLES, 'utf8');
const definitionsText = `${readFileSync(TOKENS, 'utf8')}\n${readFileSync(ALIASES, 'utf8')}`;
const applyText = readFileSync(APPLY, 'utf8');

const failures = [];

const used = new Set([...kitText.matchAll(/var\((--[A-Za-z0-9-]+)\)/g)].map((match) => match[1]));
const defined = new Set([...`${definitionsText}\n${kitText}`.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((match) => match[1]));
const missing = [...used].filter((name) => !defined.has(name)).sort();
if (missing.length > 0) {
  failures.push(`组件样式引用了未定义的令牌：${missing.join('、')}`);
}

const literals = [...kitText.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)].map((match) => match[0]);
if (literals.length > 0) {
  failures.push(`组件样式出现颜色字面值：${[...new Set(literals)].join('、')}`);
}

if (!applyText.includes('UI_KIT_CSS')) {
  failures.push('主题插件没有把组件样式注入文档');
}

console.log(`组件样式引用 ${used.size} 个自定义属性，主题与组件共定义 ${defined.size} 个`);
if (failures.length > 0) {
  for (const line of failures) console.log(`失败 ${line}`);
  process.exit(1);
}
console.log('组件样式只引用已定义属性，没有颜色字面值，且随主题一起注入');
