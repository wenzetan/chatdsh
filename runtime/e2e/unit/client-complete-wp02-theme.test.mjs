// 主题插件样式安装与清理的浏览器测试。
//
// `apply-styles.ts` 用 esbuild 按浏览器形态打包：`@chatdsh/core-ui-kit` 别名指向组件包源码，
// 两段 `.css` 以 text 载入，因此页面里执行的是生产函数本身。页面由真实 Chrome 通过
// agent-browser CLI 驱动，浏览器使用独立的 HOME、TMPDIR 与 profile 目录，每次调用都传入
// 同一份固定环境。断言取样式节点、body 属性与计算样式取值，不做截图。
//
// 运行：node --test e2e/unit/client-complete-wp02-theme.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..', '..');
const RUN = join(ROOT, '.run', `wp02-theme-${process.pid}`);
const HOME = join(RUN, 'home');
const TMP = join(RUN, 'tmp');
const PROFILE = join(RUN, 'profile');
const SITE = join(RUN, 'site');
const BUNDLE = join(SITE, 'bundle.js');
const PAGE = join(SITE, 'index.html');
const SESSION = `wp02-theme-${process.pid}`;
const CHROME = '/usr/bin/google-chrome';

/** 固定环境：浏览器与全部 CLI 调用共用，HOME 与 TMPDIR 都指向本次运行的独立目录。 */
const FIXED_ENV = {
  ...process.env,
  HOME,
  TMPDIR: TMP,
  XDG_CONFIG_HOME: join(HOME, '.config'),
  XDG_CACHE_HOME: join(HOME, '.cache'),
  XDG_STATE_HOME: join(HOME, '.local', 'state'),
  AGENT_BROWSER_SESSION: SESSION,
};

/** 从 PATH 里找 agent-browser 可执行文件。 */
function resolveCli() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'agent-browser');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 按固定环境执行一条 CLI。
 * @param cli - 可执行文件路径。
 * @param args - 参数。
 * @returns 标准输出。
 */
function runCli(cli, args) {
  return execFileSync(cli, ['--profile', PROFILE, '--executable-path', CHROME, ...args], {
    env: FIXED_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/** 把浏览器形态的打包产物与控制页面写到独立目录。 */
async function prepareSite() {
  for (const dir of [HOME, TMP, PROFILE, SITE]) mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'packages/client/theme/src/client/apply-styles.ts')],
    outfile: BUNDLE,
    bundle: true,
    format: 'iife',
    globalName: 'ChatdshThemeStyles',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    alias: { '@chatdsh/core-ui-kit': join(ROOT, 'packages/core/ui-kit/src/index.ts') },
    logLevel: 'silent',
  });
  writeFileSync(PAGE, [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><title>主题安装测试</title></head>',
    '<body><main id="main">主题安装测试</main>',
    '<script src="bundle.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n'));
}

test('主题样式在真实浏览器中的安装与清理', { timeout: 240_000 }, async (ctx) => {
  const cli = resolveCli();
  const missing = [
    ...(cli === undefined ? ['agent-browser 可执行文件'] : []),
    ...(existsSync(CHROME) ? [] : [CHROME]),
  ];
  if (missing.length > 0) {
    ctx.skip(`本机缺少 ${missing.join(' 与 ')}，主题安装测试未执行`);
    return;
  }

  await prepareSite();

  /** 页面里求值一个对象表达式，返回反序列化后的对象。 */
  function payload(expression) {
    const stdout = runCli(cli, ['eval', `JSON.stringify(${expression})`]).trim();
    return JSON.parse(JSON.parse(stdout));
  }

  /** 读当前配色属性与系统配色；媒体查询的变化事件按任务异步派发，读取前需要等待。 */
  function schemeSnapshot() {
    return payload(`({
      scheme: document.body.getAttribute('data-color-scheme'),
      matches: matchMedia('(prefers-color-scheme: dark)').matches,
    })`);
  }

  /**
   * 等配色属性落到期望取值。
   * @param expected - 期望的配色属性。
   * @returns 最后一次读数。
   **/
  async function waitForScheme(expected) {
    const deadline = Date.now() + 5_000;
    let snapshot = schemeSnapshot();
    while (snapshot.scheme !== expected && Date.now() < deadline) {
      await delay(100);
      snapshot = schemeSnapshot();
    }
    return snapshot;
  }

  let opened = false;
  try {
    await ctx.test('打包产物把组件令牌、上游映射与组件样式带进页面', async () => {
      const bundleText = readFileSync(BUNDLE, 'utf8');
      assert.match(bundleText, /--chatdsh-bg:/, '打包产物缺少令牌声明');
      assert.match(bundleText, /--dsw-alias-bg-base:/, '打包产物缺少上游别名映射');
      assert.match(bundleText, /\.chdsh-panel \{/, '打包产物缺少组件样式');

      const openedOutput = runCli(cli, ['open', pathToFileURL(PAGE).href]);
      opened = true;
      assert.match(openedOutput, /主题安装测试/, '页面没有按标题打开');
      const exported = payload('({ install: typeof ChatdshThemeStyles.installThemeStyles })');
      assert.equal(exported.install, 'function', '页面没有拿到安装函数');
      assert.ok(existsSync(join(PROFILE, 'Default')), '浏览器没有使用独立的 profile 目录');
    });

    await ctx.test('首次安装写入单一节点并补写配色属性', async () => {
      const installed = payload(`(() => {
        window.__first = ChatdshThemeStyles.installThemeStyles();
        window.__firstNode = document.getElementById('chatdsh-theme-styles');
        const node = window.__firstNode;
        return {
          nodes: document.querySelectorAll('#chatdsh-theme-styles').length,
          inHead: node !== null && node.parentElement === document.head,
          tokens: node.textContent.includes('--chatdsh-bg:'),
          aliases: node.textContent.includes('--dsw-alias-bg-base:'),
          kit: node.textContent.includes('.chdsh-panel'),
          scheme: document.body.getAttribute('data-color-scheme'),
        };
      })()`);
      assert.equal(installed.nodes, 1);
      assert.equal(installed.inHead, true);
      assert.equal(installed.tokens, true);
      assert.equal(installed.aliases, true);
      assert.equal(installed.kit, true);
      assert.equal(installed.scheme, 'light', '没有上游暗色属性时应为亮色');
    });

    await ctx.test('二次安装复用同一节点', async () => {
      const second = payload(`(() => {
        window.__second = ChatdshThemeStyles.installThemeStyles();
        return {
          nodes: document.querySelectorAll('#chatdsh-theme-styles').length,
          same: document.getElementById('chatdsh-theme-styles') === window.__firstNode,
        };
      })()`);
      assert.equal(second.nodes, 1);
      assert.equal(second.same, true);
    });

    await ctx.test('一次卸载保留样式并继续跟随上游暗色属性', async () => {
      payload(`(() => {
        window.__first();
        document.body.setAttribute('data-ds-dark-theme', '');
        return { released: true };
      })()`);
      const afterRelease = payload(`({
        nodes: document.querySelectorAll('#chatdsh-theme-styles').length,
        scheme: document.body.getAttribute('data-color-scheme'),
      })`);
      assert.equal(afterRelease.nodes, 1, '还有一处安装未卸载，样式节点应保留');
      assert.equal(afterRelease.scheme, 'dark', '观察器应在剩余安装期间继续同步配色');
    });

    await ctx.test('同一卸载函数重复调用不减少引用计数', async () => {
      payload(`(() => {
        window.__first();
        document.body.setAttribute('data-chatdsh-color-preference', 'contrast');
        return { repeated: true };
      })()`);
      const afterRepeat = payload(`({
        nodes: document.querySelectorAll('#chatdsh-theme-styles').length,
        scheme: document.body.getAttribute('data-color-scheme'),
      })`);
      assert.equal(afterRepeat.nodes, 1, '重复卸载不应移除样式节点');
      assert.equal(afterRepeat.scheme, 'contrast', '剩余安装仍应让偏好生效');
    });

    await ctx.test('最后一次卸载移除节点、断开观察并恢复原属性', async () => {
      payload(`(() => {
        window.__second();
        document.body.removeAttribute('data-chatdsh-color-preference');
        document.body.setAttribute('data-ds-dark-theme', '');
        return { released: true };
      })()`);
      const afterFinal = payload(`({
        nodes: document.querySelectorAll('#chatdsh-theme-styles').length,
        scheme: document.body.getAttribute('data-color-scheme'),
      })`);
      assert.equal(afterFinal.nodes, 0, '全部卸载后样式节点应移除');
      assert.equal(afterFinal.scheme, null, '安装前没有配色属性，卸载后应一并移除');
    });

    await ctx.test('高对比度偏好经真实计算样式生效', async () => {
      payload(`(() => {
        window.__third = ChatdshThemeStyles.installThemeStyles();
        document.body.setAttribute('data-chatdsh-color-preference', 'contrast');
        return { installed: true };
      })()`);
      const contrast = payload(`(() => {
        const style = getComputedStyle(document.body);
        return {
          scheme: document.body.getAttribute('data-color-scheme'),
          bg: style.getPropertyValue('--chatdsh-bg').trim(),
          ink: style.getPropertyValue('--chatdsh-ink').trim(),
          ok: style.getPropertyValue('--chatdsh-ok').trim(),
          focus: style.getPropertyValue('--chatdsh-focus').trim(),
          duration: style.getPropertyValue('--cdh-dur-1').trim(),
        };
      })()`);
      assert.equal(contrast.scheme, 'contrast');
      assert.equal(contrast.bg, '#000000', '高对比度画布应为纯黑');
      assert.equal(contrast.ink, '#ffffff');
      assert.equal(contrast.ok, '#8aefbb');
      assert.equal(contrast.focus, '#9bb7ff');
      assert.equal(contrast.duration, '120ms', '动效令牌应同时挂到文档上');
    });

    await ctx.test('系统配色变化经媒体查询跟进', async () => {
      payload(`(() => {
        document.body.setAttribute('data-chatdsh-color-preference', 'system');
        return { preference: 'system' };
      })()`);
      runCli(cli, ['set', 'media', 'dark']);
      const dark = await waitForScheme('dark');
      assert.equal(dark.matches, true, '系统配色应已切到暗色');
      assert.equal(dark.scheme, 'dark', '跟随系统时暗色偏好应写入暗色');

      runCli(cli, ['set', 'media', 'light']);
      const light = await waitForScheme('light');
      assert.equal(light.matches, false);
      assert.equal(light.scheme, 'light', '系统配色切回亮色后应跟随');
    });

    await ctx.test('全部卸载后系统配色变化不再写入', async () => {
      payload(`(() => {
        window.__third();
        document.body.removeAttribute('data-chatdsh-color-preference');
        return { released: true };
      })()`);
      runCli(cli, ['set', 'media', 'dark']);
      const afterRelease = payload(`({
        nodes: document.querySelectorAll('#chatdsh-theme-styles').length,
        scheme: document.body.getAttribute('data-color-scheme'),
      })`);
      assert.equal(afterRelease.nodes, 0);
      assert.equal(afterRelease.scheme, null, '媒体查询监听应在卸载时移除');
      runCli(cli, ['set', 'media', 'light']);
    });
  } finally {
    if (opened) runCli(cli, ['close']);
    rmSync(RUN, { recursive: true, force: true });
  }
});
