// 客户端面板按界面基础设计渲染的回归测试。
//
// 十二个自建面板的初始帧都用 @chatdsh/core-ui-kit 的组件渲染：外壳带 `chdsh-panel`，
// 加载态是与真实行等高的骨架。面板源码不写颜色字面值，颜色全部来自令牌（`var(--chatdsh-*)`），
// 因此产物 HTML 里不应出现十六进制或 rgba 颜色。这里用 esbuild 逐个打包再服务端渲染，断言
// 上面三条对十二个面板都成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = join(import.meta.dirname, '../..');

const PANELS = [
  ['projects', 'ProjectsEntry'],
  ['context-insights', 'ContextInsightsEntry'],
  ['artifacts', 'ArtifactsSection'],
  ['assistants', 'AssistantsSection'],
  ['model-provider', 'ModelProviderSection'],
  ['skills', 'SkillsSection'],
  ['memory', 'MemorySection'],
  ['account', 'DeviceSection'],
  ['share', 'ShareSection'],
  ['connectors', 'ConnectorsSection'],
  ['approval', 'ApprovalSection'],
  ['automation', 'AutomationSection'],
];

test('十二个面板的初始帧都用设计系统渲染且不含颜色字面值', async () => {
  const dir = join(ROOT, '.run', `panel-design-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    for (const [pkg, component] of PANELS) {
      const outfile = join(dir, `${pkg}.mjs`);
      await build({
        entryPoints: [join(ROOT, `packages/client/${pkg}/src/client/index.tsx`)],
        bundle: true,
        format: 'esm',
        platform: 'node',
        jsx: 'automatic',
        external: ['react', 'react-dom', 'react/jsx-runtime'],
        outfile,
      });
      const mod = await import(outfile);
      const Component = mod[component];
      assert.equal(typeof Component, 'function', `${pkg} 没有导出 ${component}`);
      const html = renderToStaticMarkup(createElement(Component));
      assert.match(html, /chdsh-panel/, `${pkg} 的初始帧没有使用面板外壳`);
      assert.match(html, /chdsh-skeleton/, `${pkg} 的初始帧没有加载骨架`);
      assert.doesNotMatch(html, /#[0-9a-fA-F]{6}\b/, `${pkg} 的初始帧出现十六进制颜色`);
      assert.doesNotMatch(html, /rgba?\(/, `${pkg} 的初始帧出现 rgba 颜色`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
