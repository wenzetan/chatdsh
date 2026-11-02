import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandSurface } from '../../packages/core/ui-kit/lib/index.js';

const render = (props) => renderToStaticMarkup(h(CommandSurface, props));
const items = [
  { id: 'open', label: '打开文件', description: '打开当前会话的文件', shortcut: 'Ctrl+O' },
  { id: 'rename', label: '重命名', shortcut: 'F2', disabledReason: '需要编辑权限' },
  { id: 'close', label: '关闭会话' },
];
const base = { label: '命令面板', query: '', items, onQueryChange() {}, onSelect() {} };

test('SSR：命令面具备对话框名称、组合框输入与列表语义', () => {
  const markup = render(base);
  assert.match(markup, /<section class="chdsh-command" role="dialog" aria-label="命令面板">/);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-label="搜索命令面板"/);
  assert.match(markup, /aria-controls="[^"]+-list"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /aria-autocomplete="list"/);
  assert.match(markup, /role="listbox" aria-label="命令面板结果"/);
  assert.equal((markup.match(/role="option"/g) ?? []).length, 3);
  assert.match(markup, /<kbd class="chdsh-command__shortcut">Ctrl\+O<\/kbd>/);
  assert.match(markup, /<span class="chdsh-command__description">打开当前会话的文件<\/span>/);
  assert.match(markup, /（需要编辑权限）/);
  assert.match(markup, /aria-disabled="true"/);
});

test('SSR：活动条目使用 aria-activedescendant 指向当前选项，首项禁用时从可用项开始', () => {
  const markup = render(base);
  const activeId = /aria-activedescendant="([^"]+)"/.exec(markup);
  assert.notEqual(activeId, null);
  assert.match(activeId[1], /-list-option-0$/);
  const first = /<li id="[^"]+-list-option-0"[^>]*>/.exec(markup);
  assert.match(first[0], /aria-selected="true"/);
  assert.doesNotMatch(first[0], /aria-disabled/);
  const second = /<li id="[^"]+-list-option-1"[^>]*>/.exec(markup);
  assert.match(second[0], /aria-selected="false"/);
  assert.match(second[0], /aria-disabled="true"/);

  const disabledFirst = render({ ...base, items: [{ id: 'locked', label: '受限命令', disabledReason: '权限不足' }, { id: 'open', label: '打开文件' }] });
  assert.match(disabledFirst, /aria-activedescendant="[^"]+-list-option-1"/);
  assert.match(/<li id="[^"]+-list-option-1"[^>]*>/.exec(disabledFirst)[0], /aria-selected="true"/);
});

test('SSR：查询文本由宿主控制，清除搜索只在有空查询文本且无结果时出现', () => {
  assert.match(render({ ...base, query: '关闭' }), /value="关闭"/);
  const emptyWithQuery = render({ ...base, query: '不存在', items: [] });
  assert.match(emptyWithQuery, /role="status"/);
  assert.match(emptyWithQuery, /清除搜索/);
  const emptyWithoutQuery = render({ ...base, query: '', items: [] });
  assert.match(emptyWithoutQuery, /没有匹配的命令/);
  assert.doesNotMatch(emptyWithoutQuery, /清除搜索/);
});

test('SSR：空结果使用状态文本，加载中显示 aria-busy 与提示且不显示空结果', () => {
  const custom = render({ ...base, items: [], emptyMessage: '没有可用的命令' });
  assert.doesNotMatch(custom, /role="listbox"/);
  assert.match(custom, /role="status" aria-atomic="true">没有可用的命令<\/p>/);
  assert.match(custom, /aria-expanded="false"/);
  assert.doesNotMatch(custom, /aria-controls/);

  const loadingEmpty = render({ ...base, items: [], loading: true });
  assert.match(loadingEmpty, /<section class="chdsh-command" role="dialog" aria-label="命令面板" aria-busy="true">/);
  assert.match(loadingEmpty, /role="status" aria-atomic="true">正在加载命令<\/p>/);
  assert.doesNotMatch(loadingEmpty, /没有匹配的命令/);
  assert.doesNotMatch(loadingEmpty, /清除搜索/);

  const loadingList = render({ ...base, loading: true });
  assert.match(loadingList, /aria-busy="true"/);
  assert.match(loadingList, /role="listbox"/);
  assert.doesNotMatch(render(base), /aria-busy/);
});

test('立即失败：标识重复、查询非字符串、活动条目失效、接口约定缺失与空白名称', () => {
  assert.throws(() => render({ ...base, items: [{ id: 'same', label: '甲' }, { id: 'same', label: '乙' }] }), /命令条目标识不能重复/);
  assert.throws(() => render({ ...base, query: 42 }), /命令查询必须是字符串/);
  assert.throws(() => render({ ...base, items: 'x' }), /命令条目必须是数组/);
  assert.throws(() => render({ ...base, activeId: 'removed', onActiveChange() {} }), /命令面板当前活动条目不在列表中/);
  assert.throws(() => render({ ...base, activeId: 'open' }), /需要提供 onActiveChange/);
  assert.throws(() => render({ ...base, label: ' ' }), /命令面板名称不能为空/);
  assert.throws(() => render({ ...base, items: [{ id: ' ', label: '甲' }] }), /命令条目标识不能为空/);
  assert.throws(() => render({ ...base, items: [{ id: 'a', label: ' ' }] }), /命令条目名称不能为空/);
});

test('SSR：宿主接管的活动条目决定选中语义，呈现阶段不触发选择与活动回调', () => {
  const calls = [];
  const markup = render({ ...base, activeId: 'close', onActiveChange: (id) => calls.push(id), onSelect: (id) => calls.push(`select:${id}`) });
  assert.match(markup, /aria-activedescendant="[^"]+-list-option-2"/);
  assert.match(/<li id="[^"]+-list-option-2"[^>]*>/.exec(markup)[0], /aria-selected="true"/);
  assert.deepEqual(calls, []);
});
