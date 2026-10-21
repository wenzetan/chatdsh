// 连接器面板的渲染测试。
//
// 客户端组件源码是 TSX，产品构建产物是浏览器 IIFE，不能直接被 Node 导入。这里用
// esbuild 把组件单独打成 ESM，再用 react-dom/server 渲染初始帧，断言面板在远程
// 上下文缺失时给出可读提示。测试不替身 remote，也不执行网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = join(import.meta.dirname, '../..');

test('连接器面板在初始帧渲染加载提示', async () => {
  const dir = join(ROOT, '.run', `connector-panel-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    const outfile = join(dir, 'connector-panel.mjs');
    await build({
      entryPoints: [join(ROOT, 'packages/client/connectors/src/client/index.tsx')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      outfile,
    });
    const { ConnectorsSection } = await import(outfile);
    const html = renderToStaticMarkup(createElement(ConnectorsSection));
    assert.match(html, /正在读取连接器/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
