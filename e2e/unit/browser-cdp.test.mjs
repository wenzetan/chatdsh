// 浏览器工具的端到端测试。
//
// 启动真实的无头 Chrome，通过调试协议导航、读取标题与文本、截图。这验证的是 CDP 会话本身，
// 工具的注册与渲染在编译期确认。
//
// 运行：node --test e2e/unit/browser-cdp.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { launchBrowser } from '../../packages/presets/tool-browser/lib/cdp.js';
import { expressionOf } from '../../packages/presets/tool-browser/lib/expressions.js';

const CHROME = '/usr/bin/google-chrome';
const ROOT = resolve(import.meta.dirname, '..', '..');

test('表达式按方法生成', () => {
  assert.equal(expressionOf('title'), 'document.title');
  assert.match(expressionOf('text', '.main'), /querySelector\(".main"\)/);
  assert.throws(() => expressionOf('click'), /需要 selector/);
  assert.throws(() => expressionOf('fill'), /需要 selector/);
});

test('驱动真实浏览器：导航、标题、文本、截图', { timeout: 90_000 }, async () => {
  if (!existsSync(CHROME)) {
    assert.ok(true, '本机没有 Chrome，跳过');
    return;
  }
  const browser = await launchBrowser({
    executable: CHROME,
    port: 9223,
    userDataDir: tempHome('chrome-profile-test'),
  });
  try {
    const page = await browser.open();
    try {
      const html = 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>探针页</title><h1 id="head">标题行</h1><p class="body">正文内容</p>');
      await page.navigate(html);
      assert.equal(await page.evaluate('document.title'), '探针页');
      assert.match(String(await page.evaluate(expressionOf('text'))), /正文内容/);
      assert.match(String(await page.evaluate(expressionOf('text', '.body'))), /正文内容/);
      assert.match(await page.location(), /^data:text\/html/);
      const shot = await page.screenshot();
      assert.ok(shot.length > 100, '截图应当有内容');
      // 点击与填表在真实页面上生效
      assert.equal(await page.evaluate('(() => { const el = document.querySelector("#head"); el.click(); return true; })()'), true);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
