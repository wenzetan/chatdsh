// 界面配色的对比度核对。
//
// 设计稿按用途分三档下限：标题 7:1，正文与按钮文字 4.5:1，辅助文字与状态标识 3:1，
// 并对两套配色逐对实测。这里从令牌文件里读出两套取值，按 WCAG 2.1 相对亮度计算对比度，
// 核对每一对都不低于下限，且与设计稿记录值相差不超过 0.6。
// 令牌缺失或不是不透明颜色时直接失败，不做跳过。
//
// 用法：node scripts/check-ui-contrast.mjs

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(import.meta.filename), '..');
const TOKENS = join(ROOT, 'packages', 'client', 'theme', 'src', 'client', 'styles', 'tokens.css');

/** 设计稿 2.3 节的配对、两套取值与下限。 */
const PAIRS = [
  { label: 'ink 在 bg 上', fg: 'ink', bg: 'bg', min: 7, dark: 17.67, light: 17.17 },
  { label: 'ink 在 panel 上', fg: 'ink', bg: 'panel', min: 7, dark: 16.25, light: 18.41 },
  { label: 'ink-2 在 panel 上', fg: 'ink-2', bg: 'panel', min: 4.5, dark: 11.01, light: 10.42 },
  { label: 'ink-2 在 panel-2 上', fg: 'ink-2', bg: 'panel-2', min: 4.5, dark: 10.47, light: 9.38 },
  { label: 'muted 在 panel 上', fg: 'muted', bg: 'panel', min: 4.5, dark: 6.82, light: 5.20 },
  { label: 'muted 在 code-bg 上', fg: 'muted', bg: 'code-bg', min: 4.5, dark: 7.14, light: 4.77 },
  { label: 'faint 在 panel-2 上', fg: 'faint', bg: 'panel-2', min: 3, dark: 5.04, light: 3.39 },
  { label: 'faint 在 bg 上', fg: 'faint', bg: 'bg', min: 3, dark: 5.76, light: 3.51 },
  { label: 'brand-text 在 panel 上', fg: 'brand-text', bg: 'panel', min: 3, dark: 5.38, light: 7.12 },
  { label: 'on-brand 在 brand-fill 上', fg: 'on-brand', bg: 'brand-fill', min: 4.5, dark: 5.68, light: 5.68 },
  { label: 'bubble-ink 在 bubble 上', fg: 'bubble-ink', bg: 'bubble', min: 4.5, dark: 7.57, light: 5.68 },
  { label: 'ok 在 panel 上', fg: 'ok', bg: 'panel', min: 3, dark: 6.73, light: 3.46 },
  { label: 'warn 在 panel 上', fg: 'warn', bg: 'panel', min: 3, dark: 9.07, light: 3.70 },
  { label: 'danger 在 panel 上', fg: 'danger', bg: 'panel', min: 3, dark: 7.07, light: 4.38 },
  { label: 'danger 在 bg 上', fg: 'danger', bg: 'bg', min: 3, dark: 7.69, light: 4.08 },
];

const text = readFileSync(TOKENS, 'utf8');

/** 取出一段选择器块里的令牌取值。 */
function block(selector) {
  const start = text.indexOf(selector);
  if (start < 0) throw new Error(`令牌文件里找不到 ${selector}`);
  const open = text.indexOf('{', start);
  const close = text.indexOf('}', open);
  if (open < 0 || close < 0) throw new Error(`${selector} 块不完整`);
  const body = text.slice(open + 1, close);
  const values = new Map();
  for (const match of body.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    values.set(match[1], match[2].trim());
  }
  return values;
}

const dark = block(':root {');
const light = block('body[data-color-scheme="light"] {');

/** 令牌名到变量名的映射：带品牌前缀的走 --chatdsh-，其余派生量走 --cdh-。 */
function variableOf(name) {
  if (name === 'on-brand') return '--cdh-on-brand';
  return `--chatdsh-${name}`;
}

/** 解析不透明十六进制颜色。 */
function parseHex(value, variable) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (match === null) throw new Error(`${variable} 的取值 ${value} 不是六位十六进制，无法直接计算对比度`);
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** WCAG 2.1 相对亮度。 */
function luminance([r, g, b]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 对比度。 */
function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return (high + 0.05) / (low + 0.05);
}

const failures = [];
const rows = [];

for (const scheme of [
  { name: '暗色', values: dark, expected: (pair) => pair.dark },
  { name: '亮色', values: light, expected: (pair) => pair.light },
]) {
  for (const pair of PAIRS) {
    const fgVariable = variableOf(pair.fg);
    const bgVariable = variableOf(pair.bg);
    const fgValue = scheme.values.get(fgVariable);
    const bgValue = scheme.values.get(bgVariable);
    if (fgValue === undefined) throw new Error(`${scheme.name}缺少令牌 ${fgVariable}`);
    if (bgValue === undefined) throw new Error(`${scheme.name}缺少令牌 ${bgVariable}`);
    const ratio = Math.round(contrast(parseHex(fgValue, fgVariable), parseHex(bgValue, bgVariable)) * 100) / 100;
    const expected = scheme.expected(pair);
    const meetsFloor = ratio >= pair.min;
    const matchesDoc = Math.abs(ratio - expected) <= 0.6;
    rows.push({ scheme: scheme.name, label: pair.label, ratio, expected, min: pair.min });
    if (!meetsFloor) failures.push(`${scheme.name} ${pair.label} 为 ${ratio}:1，低于下限 ${pair.min}:1`);
    else if (!matchesDoc) failures.push(`${scheme.name} ${pair.label} 实测 ${ratio}:1，与设计稿记录 ${expected}:1 相差超过 0.6`);
  }
}

for (const row of rows) {
  console.log(`${row.scheme} ${row.label}：${row.ratio}:1（下限 ${row.min}，设计稿 ${row.expected}）`);
}

if (failures.length > 0) {
  for (const line of failures) console.log(`失败 ${line}`);
  process.exit(1);
}
console.log(`十五组配对在两套配色下都满足下限，且与设计稿记录一致`);
