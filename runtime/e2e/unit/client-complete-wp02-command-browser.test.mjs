import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { UI_KIT_CSS } from '../../packages/core/ui-kit/lib/index.js';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const execute = promisify(execFile);
const ROOT = new URL('../../', import.meta.url);

const exercise = `
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandSurface } from '../../packages/core/ui-kit/src/command.tsx';
window.command = { selected: [], queries: [], opened: 0, escaped: 0 };
const all = [
  { id: 'restricted', label: '受限命令', shortcut: 'Alt+R', disabledReason: '权限不足' },
  { id: 'open', label: '打开文件', description: '打开当前会话的文件', shortcut: 'Ctrl+O' },
  { id: 'close', label: '关闭会话', shortcut: 'Ctrl+W' },
];
function App() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const trigger = useRef(null);
  const close = () => { setOpen(false); setQuery(''); trigger.current?.focus(); };
  useEffect(() => {
    const handler = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.command.opened += 1;
        setOpen(true);
      } else if (event.key === 'Escape' && open) {
        window.command.escaped += 1;
        close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);
  useEffect(() => { if (open) document.querySelector('.chdsh-command__input')?.focus(); }, [open]);
  const items = all.filter((item) => item.label.includes(query));
  return <main><h1>命令面板交互验证</h1>
    <button id="trigger" ref={trigger} className="chdsh-btn" onClick={() => setOpen(true)}>打开命令面板</button>
    <button id="toggle-loading" className="chdsh-btn" onClick={() => setLoading((value) => !value)}>切换加载状态</button>
    {open ? <CommandSurface label="命令面板" query={query} items={items} loading={loading}
      onQueryChange={(value) => { window.command.queries.push(value); setQuery(value); }}
      onSelect={(id) => { window.command.selected.push(id); close(); }} /> : null}
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
`;

test('真实 Chrome：命令面键盘导航、禁用条目、清空查询、空结果与宿主焦点恢复', { timeout: 180000 }, async () => {
  const home = allocateIndependentHome('wp02-command');
  const session = `command-${randomUUID().slice(0, 8)}`;
  const env = { ...process.env, PATH: `/usr/local/nvm/versions/node/v24.19.0/bin:${process.env.PATH}`, HOME: home, TMPDIR: home, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome', AGENT_BROWSER_PROFILE: join(home, 'chrome'), AGENT_BROWSER_ARGS: '--no-sandbox' };
  const cli = async (...args) => {
    const result = await execute('/usr/local/nvm/versions/node/v24.19.0/bin/agent-browser', ['--session', session, '--json', ...args], { env, timeout: 30000, maxBuffer: 1024 * 1024 });
    const response = JSON.parse(result.stdout);
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  };
  let server;
  let opened = false;
  try {
    const bundle = await build({ stdin: { contents: exercise, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'command-exercise.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
    const tokens = readFileSync(new URL('packages/client/theme/src/client/styles/tokens.css', ROOT), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>命令面板交互验证</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
    server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await cli('open', `http://127.0.0.1:${server.address().port}/`);
    opened = true;
    await cli('wait', '#trigger');
    const evaluate = async (expression) => (await cli('eval', expression)).data.result;
    const input = 'document.querySelector(".chdsh-command__input")';
    const activeOption = () => evaluate(`(() => { const node = ${input}; return document.getElementById(node.getAttribute("aria-activedescendant")).textContent; })()`);
    const activeDescendant = () => evaluate(`${input}.getAttribute("aria-activedescendant")`);
    const optionSelector = (position) => `.chdsh-command__list li:nth-child(${position})`;

    await cli('focus', '#trigger');
    await cli('press', 'Control+k');
    await cli('wait', '.chdsh-command');
    await cli('wait', '--fn', `document.activeElement === ${input}`);
    assert.equal(await evaluate(`${input}.getAttribute("aria-expanded")`), 'true');
    assert.equal(await evaluate(`${input}.getAttribute("aria-autocomplete")`), 'list');
    assert.equal(await evaluate(`${input}.getAttribute("aria-controls")`), await evaluate('document.querySelector(".chdsh-command__list").id'));
    assert.match(await activeOption(), /打开文件/);
    const initialActive = await activeDescendant();
    assert.equal(await evaluate(`document.getElementById(${JSON.stringify(initialActive)}).getAttribute("aria-selected")`), 'true');
    assert.equal(await evaluate('document.querySelector(".chdsh-command__list").children[0].getAttribute("aria-disabled")'), 'true');
    assert.equal(await evaluate('document.querySelector(".chdsh-command__list").children[0].getAttribute("aria-selected")'), 'false');
    assert.match(await evaluate('document.querySelector(".chdsh-command__list").children[0].textContent'), /权限不足/);

    await cli('press', 'ArrowDown');
    assert.match(await activeOption(), /关闭会话/);
    await cli('press', 'ArrowDown');
    assert.match(await activeOption(), /受限命令/);
    await cli('press', 'Enter');
    assert.deepEqual(await evaluate('window.command.selected'), []);
    assert.equal(await evaluate('document.querySelector(".chdsh-command").contains(document.activeElement)'), true);
    await cli('press', 'ArrowDown');
    assert.match(await activeOption(), /打开文件/);
    await cli('press', 'Home');
    assert.match(await activeOption(), /受限命令/);
    await cli('press', 'End');
    assert.match(await activeOption(), /关闭会话/);
    await cli('press', 'ArrowUp');
    assert.match(await activeOption(), /打开文件/);
    await cli('press', 'Enter');
    assert.deepEqual(await evaluate('window.command.selected'), ['open']);
    await cli('wait', '--fn', '!document.querySelector(".chdsh-command")');
    assert.equal(await evaluate('document.activeElement.id'), 'trigger');

    await cli('press', 'Control+k');
    await cli('wait', '.chdsh-command');
    await cli('wait', '--fn', `document.activeElement === ${input}`);
    assert.equal(await evaluate(`${input}.value`), '');
    await cli('keyboard', 'type', '关闭');
    assert.equal(await evaluate(`${input}.value`), '关闭');
    assert.equal(await evaluate('document.querySelectorAll(".chdsh-command__list li").length'), 1);
    assert.match(await activeOption(), /关闭会话/);
    await cli('press', 'Escape');
    await cli('wait', '--fn', '!document.querySelector(".chdsh-command")');
    assert.equal(await evaluate('document.activeElement.id'), 'trigger');
    assert.equal(await evaluate('window.command.escaped'), 1);
    assert.equal(await evaluate('window.command.queries.at(-1)'), '');

    await cli('press', 'Control+k');
    await cli('wait', '.chdsh-command');
    await cli('wait', '--fn', `document.activeElement === ${input}`);
    await cli('keyboard', 'type', 'zzz');
    assert.equal(await evaluate('document.querySelector("[role=listbox]")'), null);
    assert.match(await evaluate('document.querySelector(".chdsh-command__empty").textContent'), /没有匹配的命令/);
    assert.equal(await evaluate(`${input}.getAttribute("aria-expanded")`), 'false');
    assert.equal(await evaluate(`${input}.getAttribute("aria-controls")`), null);
    await cli('click', '.chdsh-command__clear');
    await cli('wait', '[role=listbox]');
    assert.equal(await evaluate(`${input}.value`), '');
    assert.equal(await evaluate('document.querySelectorAll(".chdsh-command__list li").length'), 3);

    await cli('focus', '.chdsh-command__input');
    await cli('click', optionSelector(1));
    assert.deepEqual(await evaluate('window.command.selected'), ['open']);
    assert.equal(await evaluate('document.querySelector(".chdsh-command") !== null'), true);
    assert.equal(await evaluate(`document.activeElement === ${input}`), true);
    assert.match(await activeOption(), /打开文件/);
    await cli('press', 'ArrowDown');
    assert.match(await activeOption(), /关闭会话/);
    await cli('press', 'Enter');
    assert.deepEqual(await evaluate('window.command.selected'), ['open', 'close']);
    await cli('wait', '--fn', '!document.querySelector(".chdsh-command")');

    await cli('press', 'Control+k');
    await cli('wait', '.chdsh-command');
    await cli('click', '#toggle-loading');
    assert.equal(await evaluate('document.querySelector(".chdsh-command").getAttribute("aria-busy")'), 'true');
    assert.match(await evaluate('document.querySelector(".chdsh-command__hint").textContent'), /正在加载命令/);
    await cli('click', '#toggle-loading');
    assert.equal(await evaluate('document.querySelector(".chdsh-command").getAttribute("aria-busy")'), null);
    assert.equal(await evaluate('document.querySelector(".chdsh-command__hint")'), null);

    assert.deepEqual((await cli('errors')).data.errors, []);
  } finally {
    if (opened) await cli('close');
    if (server !== undefined) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    releaseIndependentHome(home);
  }
});
