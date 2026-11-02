import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { connectMeasurementSession } from './client-complete-wp02-color-cdp.mjs';

const execute = promisify(execFile);
const ROOT = new URL('../../', import.meta.url);

test('真实 Chrome 验证交互、三色配色、forced-colors 与文字重排', { timeout: 180000 }, async (t) => {
  const home = allocateIndependentHome('wp02-browser');
  const session = `wp02-${randomUUID().slice(0, 8)}`;
  const env = { ...process.env, TMPDIR: home, HOME: home, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome', AGENT_BROWSER_PROFILE: join(home, 'chrome'), AGENT_BROWSER_ARGS: '--no-sandbox' };
  const cli = async (...args) => {
    const result = await execute('/usr/local/nvm/versions/node/v24.19.0/bin/agent-browser', ['--session', session, '--json', ...args], { env, timeout: 30000, maxBuffer: 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, `agent-browser ${args[0]}：${result.stdout}`);
    return response;
  };
  let server;
  let cdp;
  let opened = false;
  try {
    const bundle = await build({ entryPoints: [new URL('./client-complete-wp02-fixture.tsx', import.meta.url).pathname], bundle: true, write: false, format: 'iife', jsx: 'automatic' });
    const colors = await build({ entryPoints: [new URL('./client-complete-wp02-color-browser.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'iife', jsx: 'automatic' });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>组件交互验证</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
    server = createServer((request, response) => {
      if (request.url === '/colors.js') { response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); response.end(colors.outputFiles[0].text); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const pageUrl = `http://127.0.0.1:${server.address().port}/`;
    await cli('open', pageUrl);
    opened = true;
    await cli('wait', '#project-name');
    const evaluate = async (expression) => (await cli('eval', expression)).data.result;
    await evaluate('new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "/colors.js"; script.onload = () => resolve(true); script.onerror = () => reject(new Error("配色测量模块加载失败")); document.body.append(script); })');
    await cli('wait', '.chdsh-badge--ok');
    assert.equal(await evaluate('document.querySelector("#project-name").getAttribute("aria-invalid")'), 'true');
    await cli('focus', '[role=tab][aria-selected=true]');
    await cli('press', 'ArrowRight');
    assert.equal(await evaluate('document.activeElement.textContent'), '高级设置');
    await cli('press', 'Enter');
    assert.equal(await evaluate('document.querySelector("[role=tab][aria-selected=true]").textContent'), '高级设置');
    await cli('press', 'Home');
    assert.equal(await evaluate('document.activeElement.textContent'), '基本设置');
    await cli('press', 'End');
    assert.equal(await evaluate('document.activeElement.textContent'), '高级设置');
    await cli('click', '.chdsh-error-summary a');
    assert.equal(await evaluate('document.activeElement.id'), 'project-name');
    await cli('focus', '#open-dialog');
    await cli('press', 'Enter');
    await cli('wait', 'dialog[open]');
    assert.equal(await evaluate('document.querySelector("dialog").contains(document.activeElement)'), true);
    for (let step = 0; step < 6; step += 1) {
      await cli('press', 'Tab');
      assert.equal(await evaluate('document.querySelector("dialog").contains(document.activeElement)'), true);
    }
    await cli('press', 'Shift+Tab');
    assert.equal(await evaluate('document.querySelector("dialog").contains(document.activeElement)'), true);
    await cli('press', 'Escape');
    await cli('wait', '--fn', '!document.querySelector("dialog").open');
    assert.equal(await evaluate('document.activeElement.id'), 'open-dialog');
    cdp = await connectMeasurementSession(cli, pageUrl);
    for (const scheme of ['dark', 'light', 'contrast', 'forced-colors']) {
      await evaluate(`document.body.dataset.colorScheme = ${JSON.stringify(scheme === 'forced-colors' ? 'dark' : scheme)}`);
      await cdp.media([{ name: 'forced-colors', value: scheme === 'forced-colors' ? 'active' : 'none' }]);
      assert.equal(await evaluate('matchMedia("(forced-colors: active)").matches'), scheme === 'forced-colors');
      await cli('focus', '#project-name');
      await cli('press', 'Tab');
      await evaluate('Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => true)');
      const palette = await evaluate('window.wp02.measureColors()');
      t.diagnostic(`${scheme}：${palette.samples.length} 个计算样式测量，${palette.failures.length} 个对比度失败`);
      await t.test(`${scheme} 正文4.5、标题7、边框/图形/焦点3`, () => {
        assert.deepEqual(palette.failures, [], JSON.stringify(palette.failures, null, 2));
        assert.ok(palette.samples.some((sample) => sample.kind === 'focus'), '必须测量真实键盘焦点');
      });
      for (const width of [320, 768, 1440]) {
        await cli('set', 'viewport', String(width), '900');
        for (const factor of [1, 2]) {
          if (factor === 2) assert.equal(await evaluate('window.wp02.scaleText(2)'), true, '实际计算字号必须达到200%');
          const layout = await evaluate('window.wp02.measureLayout()');
          await t.test(`${scheme} ${width}px 文字${factor * 100}%重排`, () => assert.deepEqual(layout.failures, []));
          await cli('focus', '#open-dialog');
          await cli('press', 'Enter');
          await cli('wait', 'dialog[open]');
          const dialog = await evaluate('window.wp02.measureLayout()');
          await t.test(`${scheme} ${width}px 文字${factor * 100}%对话框重排`, () => assert.deepEqual(dialog.failures, []));
          await cli('press', 'Escape');
          await cli('wait', '--fn', '!document.querySelector("dialog").open');
          assert.equal(await evaluate('document.activeElement.id'), 'open-dialog');
          if (factor === 2) await evaluate('window.wp02.restoreText()');
        }
      }
    }
    await cdp.media([]);
    const errors = await cli('errors');
    assert.deepEqual(errors.data.errors, []);
  } finally {
    if (cdp !== undefined) await cdp.close();
    if (opened) await cli('close');
    if (server !== undefined) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    releaseIndependentHome(home);
  }
});
