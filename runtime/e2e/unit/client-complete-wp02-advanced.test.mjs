import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';

const require = createRequire(import.meta.url);
async function sourceModule(relative) {
  const output = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { Menu, FileTree, ErrorBoundary } = await sourceModule('../../packages/core/ui-kit/src/advanced.tsx');
const render = (component, props, ...children) => renderToStaticMarkup(h(component, props, ...children));
const nodes = [{ id: 'folder', label: '源码', children: [{ id: 'alpha', label: 'alpha.ts' }, { id: 'beta', label: 'beta.ts' }] }, { id: 'readme', label: '说明.md' }];
const treeProps = { label: '项目文件', nodes, expandedIds: ['folder'], selectedId: 'alpha', onExpandedChange() {}, onSelect() {} };

test('SSR：菜单按钮具备名称、关联、展开状态和空菜单禁用状态', () => {
  const markup = render(Menu, { label: '文件操作', items: [{ id: 'open', label: '打开' }], onAction() {} });
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-controls="[^"]+-menu"/);
  assert.match(render(Menu, { label: '文件操作', items: [], onAction() {} }), /disabled=""/);
  assert.throws(() => render(Menu, { label: '操作', items: [{ id: 'same', label: '甲' }, { id: 'same', label: '乙' }], onAction() {} }), /不能重复/);
  assert.throws(() => render(Menu, { label: ' ', items: [], onAction() {} }), /名称不能为空/);
});

test('SSR：文件树保留层级、同级位置、选中与展开语义', () => {
  const markup = render(FileTree, treeProps);
  assert.match(markup, /role="tree" aria-label="项目文件"/);
  assert.match(markup, /role="group"/);
  assert.match(markup, /aria-level="2" aria-posinset="2" aria-setsize="2"/);
  assert.match(markup, /aria-selected="true"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /（已选择）/);
  assert.equal((markup.match(/tabindex="0"/g) ?? []).length, 1);
  const collapsed = render(FileTree, { ...treeProps, expandedIds: [] });
  assert.doesNotMatch(collapsed, /role="group"/);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.equal((collapsed.match(/tabindex="0"/g) ?? []).length, 1);
  const empty = render(FileTree, { ...treeProps, nodes: [], selectedId: undefined, expandedIds: [] });
  assert.match(empty, /role="tree"[^>]+tabindex="0"/);
  assert.match(empty, /role="status"/);
  assert.match(empty, /没有文件/);
  const emptyDirectory = render(FileTree, { ...treeProps, nodes: [{ id: 'folder', label: '空目录', children: [] }], selectedId: undefined });
  assert.match(emptyDirectory, /aria-expanded="true"/);
  assert.doesNotMatch(emptyDirectory, /role="group"/);
});

test('SSR：文件树拒绝重复标识和过期受控选择/目录状态', () => {
  assert.throws(() => render(FileTree, { ...treeProps, nodes: [{ id: 'folder', label: '目录', children: [{ id: 'folder', label: '重复' }] }] }), /不能重复/);
  assert.throws(() => render(FileTree, { ...treeProps, selectedId: 'removed' }), /需要存在/);
  assert.throws(() => render(FileTree, { ...treeProps, expandedIds: ['removed'] }), /展开目录需要存在/);
  assert.throws(() => render(FileTree, { ...treeProps, expandedIds: ['alpha'] }), /children/);
  assert.throws(() => render(FileTree, { ...treeProps, expandedIds: ['folder', 'folder'] }), /不能重复/);
  assert.throws(() => render(FileTree, { ...treeProps, nodes: [{ id: '', label: '空白' }] }), /不能为空/);
});

test('真实函数：ErrorBoundary 固定分类回调、显式失败动作和宿主回调异常传播', () => {
  assert.deepEqual(ErrorBoundary.getDerivedStateFromError(), { failed: true });
  const received = [];
  const boundary = new ErrorBoundary({ children: h('p', {}, '正常内容'), onError: (...args) => received.push(args) });
  boundary.componentDidCatch(new Error('业务正文不得进入分类回调'), { componentStack: '业务位置' });
  assert.deepEqual(received, [['render-error']]);
  boundary.state = { failed: true, generation: 2 };
  const markup = renderToStaticMarkup(boundary.render());
  assert.match(markup, /role="alert"/);
  assert.match(markup, /界面发生故障/);
  assert.match(markup, /重试/);
  assert.doesNotMatch(markup, /业务正文/);
  boundary.state = { failed: false, generation: 3 };
  assert.equal(boundary.render().key, '3');
  const callbackError = new Error('宿主回调失败');
  const failing = new ErrorBoundary({ children: null, onError() { throw callbackError; } });
  assert.throws(() => failing.componentDidCatch(), (error) => error === callbackError);
  assert.equal(render(ErrorBoundary, { onError() {} }, h('span', {}, '内容正常')), '<span>内容正常</span>');
});

const exercise = `
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Menu, FileTree, ErrorBoundary } from '../../packages/core/ui-kit/src/advanced.tsx';
window.exercise = { actions: [], categories: [], caught: [], mounts: 0, retries: 0 };
const initialNodes = [{id:'folder',label:'源码',children:[{id:'alpha',label:'alpha.ts'},{id:'beta',label:'beta.ts'}]},{id:'readme',label:'说明.md'}];
function Content({ failure }) {
  useEffect(() => { window.exercise.mounts += 1; }, []);
  if (failure) throw new Error('验收专用渲染故障');
  return <p id="healthy">内容正常</p>;
}
function Exercise() {
  const [nodes, setNodes] = useState(initialNodes);
  const [expandedIds, setExpanded] = useState([]);
  const [selectedId, setSelected] = useState(undefined);
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    const remove = (event) => {
      if (event.key === 'Delete' && document.activeElement?.getAttribute('role') === 'treeitem') {
        setNodes(current => current.map(node => node.children ? {...node,children:node.children.filter(child=>child.id!=='alpha')} : node));
        setSelected(current => current === 'alpha' ? undefined : current);
      }
      if (event.key === 'F8') { setNodes([]); setExpanded([]); setSelected(undefined); }
    };
    document.addEventListener('keydown', remove);
    return () => document.removeEventListener('keydown', remove);
  }, []);
  return <main><h1>高级组件交互验证</h1>
    <button id="before-menu" className="chdsh-btn">前序操作</button>
    <Menu label="文件操作" items={[{id:'open',label:'Alpha 打开'},{id:'restricted',label:'受限操作',disabledReason:'权限不足'},{id:'save',label:'Beta 保存'}]} onAction={id => window.exercise.actions.push(id)} />
    <button id="after-menu" className="chdsh-btn">后续操作</button>
    <FileTree label="项目文件" nodes={nodes} expandedIds={expandedIds} selectedId={selectedId} onExpandedChange={setExpanded} onSelect={setSelected} />
    <ErrorBoundary onError={(...args)=>window.exercise.categories.push(args)} onRetry={()=>{window.exercise.retries+=1;setFailure(false);}}>
      <Content failure={failure} />
      <button id="fail" className="chdsh-btn" onClick={()=>setFailure(true)}>触发渲染故障</button>
    </ErrorBoundary>
  </main>;
}
createRoot(document.getElementById('root'), {onCaughtError(error) { window.exercise.caught.push(error.message); }}).render(<Exercise />);
`;

test('真实 Chrome：菜单与文件树键盘、移除焦点、错误边界故障及重新挂载', { timeout: 180000 }, async () => {
  const home = allocateIndependentHome('wp02-advanced');
  const session = `advanced-${randomUUID().slice(0, 8)}`;
  const execute = promisify(execFile);
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
    const bundle = await build({ stdin: { contents: exercise, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'advanced-exercise.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
    const { UI_KIT_CSS } = await sourceModule('../../packages/core/ui-kit/src/styles.ts');
    const tokens = readFileSync(new URL('../../packages/client/theme/src/client/styles/tokens.css', import.meta.url), 'utf8');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>高级组件交互验证</title><style>${tokens}\n${UI_KIT_CSS}\nmain { padding:16px; max-width:100%; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
    server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await cli('open', `http://127.0.0.1:${server.address().port}`);
    opened = true;
    await cli('wait', '.chdsh-menu__trigger');
    const evaluate = async (expression) => (await cli('eval', expression)).data.result;
    const activeText = () => evaluate('document.activeElement.textContent');
    const activeTree = () => evaluate('document.activeElement.getAttribute("aria-label")');

    await cli('focus', '.chdsh-menu__trigger');
    await cli('press', 'Enter');
    await cli('wait', '[role=menu]');
    assert.equal(await activeText(), 'Alpha 打开');
    await cli('press', 'ArrowDown');
    assert.match(await activeText(), /权限不足/);
    await cli('press', 'Enter');
    assert.deepEqual(await evaluate('window.exercise.actions'), []);
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-disabled")'), 'true');
    await cli('press', 'End');
    assert.equal(await activeText(), 'Beta 保存');
    await cli('press', 'Home');
    assert.equal(await activeText(), 'Alpha 打开');
    await cli('press', 'b');
    assert.equal(await activeText(), 'Beta 保存');
    await cli('press', 'Enter');
    assert.deepEqual(await evaluate('window.exercise.actions'), ['save']);
    assert.equal(await evaluate('document.activeElement.classList.contains("chdsh-menu__trigger")'), true);
    assert.equal(await evaluate('document.querySelector("[role=menu]")'), null);
    await cli('press', 'ArrowUp');
    assert.equal(await activeText(), 'Beta 保存');
    await cli('press', 'ArrowDown');
    assert.equal(await activeText(), 'Alpha 打开');
    await cli('press', 'Escape');
    assert.equal(await activeText(), '文件操作');
    await cli('press', 'ArrowDown');
    await cli('press', 'Tab');
    assert.equal(await evaluate('document.activeElement.id'), 'after-menu');
    await cli('focus', '.chdsh-menu__trigger');
    await cli('press', 'Space');
    assert.equal(await activeText(), 'Alpha 打开');
    await cli('press', 'Space');
    assert.deepEqual(await evaluate('window.exercise.actions'), ['save', 'open']);
    await cli('press', 'Enter');
    await cli('press', 'Shift+Tab');
    assert.equal(await evaluate('document.activeElement.id'), 'before-menu');
    assert.equal(await evaluate('document.querySelector("[role=menu]")'), null);
    await cli('click', '.chdsh-menu__trigger');
    await cli('click', '#before-menu');
    assert.equal(await evaluate('document.querySelector("[role=menu]")'), null);

    await cli('focus', '[role=treeitem][aria-label="源码"]');
    await cli('press', 'ArrowRight');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'), 'true');
    await cli('press', 'ArrowRight');
    assert.equal(await activeTree(), 'alpha.ts');
    await cli('click', '[role=treeitem][aria-label="alpha.ts"] > .chdsh-tree__row');
    assert.equal(await activeTree(), 'alpha.ts');
    assert.equal(await evaluate('document.querySelector("[role=treeitem][aria-label=源码]").getAttribute("aria-expanded")'), 'true');
    await cli('press', 'Enter');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-selected")'), 'true');
    await cli('press', 'ArrowDown');
    assert.equal(await activeTree(), 'beta.ts');
    await cli('press', 'ArrowUp');
    assert.equal(await activeTree(), 'alpha.ts');
    await cli('press', 'Delete');
    assert.equal(await activeTree(), 'beta.ts');
    await cli('press', 'ArrowLeft');
    assert.equal(await activeTree(), '源码');
    await cli('press', 'ArrowLeft');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'), 'false');
    await cli('press', 'End');
    assert.equal(await activeTree(), '说明.md');
    await cli('press', 'Space');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-selected")'), 'true');
    await cli('press', 'Home');
    assert.equal(await activeTree(), '源码');
    await cli('press', 'F8');
    assert.equal(await evaluate('document.activeElement.getAttribute("role")'), 'tree');
    assert.match(await evaluate('document.querySelector(".chdsh-tree__empty").textContent'), /没有文件/);

    assert.equal(await evaluate('window.exercise.mounts'), 1);
    await cli('click', '#fail');
    await cli('wait', '.chdsh-error-boundary__retry');
    assert.match(await evaluate('document.querySelector("[role=alert]").textContent'), /界面发生故障/);
    assert.deepEqual(await evaluate('window.exercise.categories'), [['render-error']]);
    assert.deepEqual(await evaluate('window.exercise.caught'), ['验收专用渲染故障']);
    assert.equal(await evaluate('document.querySelector("[role=alert]").textContent.includes("验收专用")'), false);
    await cli('click', '.chdsh-error-boundary__retry');
    await cli('wait', '#healthy');
    assert.equal(await evaluate('window.exercise.mounts'), 2);
    assert.equal(await evaluate('window.exercise.retries'), 1);
    assert.deepEqual((await cli('errors')).data.errors, []);
  } finally {
    if (opened) await cli('close');
    if (server !== undefined) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    releaseIndependentHome(home);
  }
});
