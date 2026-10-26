// 共享组件包的元件测试。
//
// 十二个客户端面板都从 @chatdsh/core-ui-kit 取元件，这里逐个服务端渲染，核对产出的结构、
// 状态类名与令牌引用：面板外壳、列表行、徽标、按钮、进度条、骨架、空状态、错误条与状态行。
// 断言不含十六进制或 rgba 颜色字面值，颜色只以 var() 形式出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = join(import.meta.dirname, '../..');

async function loadKit() {
  const dir = join(ROOT, '.run', `ui-kit-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, 'kit.mjs');
  await build({
    entryPoints: [join(ROOT, 'packages/core/ui-kit/src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    outfile,
  });
  const module = await import(outfile);
  rmSync(dir, { recursive: true, force: true });
  return module;
}

const kit = await loadKit();

/** 渲染一个元件。 */
function render(element) {
  return renderToStaticMarkup(element);
}

/** 断言输出里没有颜色字面值。 */
function assertNoColourLiterals(html) {
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/, '出现十六进制颜色');
  assert.doesNotMatch(html, /rgba?\(/, '出现 rgb 颜色');
}

test('面板外壳渲染标题、计数与副标题', () => {
  const html = render(createElement(kit.Panel, { title: '项目', subtitle: '两个', count: '2' }, '正文'));
  assert.match(html, /<section class="chdsh-panel">/);
  assert.match(html, /chdsh-panel__title">项目</);
  assert.match(html, /chdsh-panel__count">2</);
  assert.match(html, /chdsh-panel__sub">两个</);
  assertNoColourLiterals(html);
});

test('骨架按行数渲染并隐藏于辅助技术', () => {
  const html = render(createElement(kit.Skeleton, { rows: 3 }));
  assert.equal((html.match(/chdsh-skeleton/g) ?? []).length, 3);
  assert.match(html, /aria-hidden="true"/);
});

test('空状态带说明与下一步动作', () => {
  const html = render(createElement(kit.EmptyState, { action: '记录一个' }, '还没有项目'));
  assert.match(html, /class="chdsh-empty"/);
  assert.match(html, /还没有项目/);
  assert.match(html, /chdsh-empty__action">记录一个</);
});

test('列表行渲染圆点、徽标、副行与动作', () => {
  const html = render(createElement(kit.List, null,
    createElement(kit.Row, {
      title: '标题',
      meta: '/home/user',
      dot: 'ok',
      badge: createElement(kit.Badge, { tone: 'warn' }, '等待'),
      actions: createElement(kit.Button, { tone: 'danger' }, '拒绝'),
    }),
  ));
  assert.match(html, /<ul class="chdsh-list">/);
  assert.match(html, /class="chdsh-dot chdsh-dot--ok"/);
  assert.match(html, /chdsh-row__title/);
  assert.match(html, /chdsh-row__meta">\/home\/user</);
  assert.match(html, /chdsh-row__acts/);
  assert.match(html, /chdsh-badge chdsh-badge--warn/);
  assert.match(html, /chdsh-btn chdsh-btn--danger/);
  assert.match(html, /type="button"/);
  assertNoColourLiterals(html);
});

test('徽标五档语气各有对应类名', () => {
  for (const tone of ['neutral', 'ok', 'warn', 'danger', 'brand']) {
    const html = render(createElement(kit.Badge, { tone }, 'x'));
    if (tone === 'neutral') assert.match(html, /class="chdsh-badge"/);
    else assert.match(html, new RegExp(`chdsh-badge chdsh-badge--${tone}`));
  }
});

test('按钮三档语气与禁用状态', () => {
  assert.match(render(createElement(kit.Button, null, 'x')), /class="chdsh-btn"/);
  assert.match(render(createElement(kit.Button, { tone: 'primary' }, 'x')), /chdsh-btn--primary/);
  assert.match(render(createElement(kit.Button, { tone: 'danger' }, 'x')), /chdsh-btn--danger/);
  assert.match(render(createElement(kit.Button, { disabled: true }, 'x')), /disabled=""/);
});

test('进度条把比例夹到零到一之间', () => {
  assert.match(render(createElement(kit.ProgressBar, { ratio: 0.5 })), /style="width:50%"/);
  assert.match(render(createElement(kit.ProgressBar, { ratio: 2 })), /style="width:100%"/);
  assert.match(render(createElement(kit.ProgressBar, { ratio: -1 })), /style="width:0%"/);
  assert.match(render(createElement(kit.ProgressBar, { ratio: 0.5, tone: 'warn' })), /chdsh-bar__fill chdsh-bar__fill--warn/);
});

test('错误条与状态行使用令牌取色', () => {
  const error = render(createElement(kit.ErrorNote, null, '出错了'));
  assert.match(error, /class="chdsh-error"/);
  assertNoColourLiterals(error);
  const muted = render(createElement(kit.StatusLine, null, '普通'));
  const danger = render(createElement(kit.StatusLine, { tone: 'danger' }, '危险'));
  assert.match(muted, /var\(--chatdsh-muted\)/);
  assert.match(danger, /var\(--chatdsh-danger\)/);
  assertNoColourLiterals(muted);
  assertNoColourLiterals(danger);
});

test('组件样式文本只引用令牌且不含颜色字面值', () => {
  const css = kit.UI_KIT_CSS;
  assert.match(css, /var\(--chatdsh-/);
  assert.match(css, /var\(--cdh-/);
  assertNoColourLiterals(css);
  assert.match(css, /prefers-reduced-motion/);
});
