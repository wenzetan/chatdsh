import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field, ErrorSummary, ScrollRegion, Toast, Tabs, Dialog, Button, ProgressBar, StatusLine } from '../../packages/core/ui-kit/lib/index.js';

const render = (component, props, ...children) => renderToStaticMarkup(h(component, props, ...children));

test('字段标签帮助错误和必填关联到同一控件', () => {
  const markup = render(Field, { label: '项目名称', help: '填写显示名称', error: '名称不能为空', required: true }, h('input', { id: 'project' }));
  assert.match(markup, /for="project"/);
  assert.match(markup, /aria-describedby="project-help project-error"/);
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /required=""/);
  assert.match(markup, /id="project-help"/);
  assert.match(markup, /id="project-error"/);
});

test('摘要与状态使用可访问语义，宽内容拥有键盘入口', () => {
  assert.match(render(ErrorSummary, { errors: [{ fieldId: 'project', message: '请输入名称' }] }), /role="alert"/);
  assert.equal(render(ErrorSummary, { errors: [] }), '');
  assert.match(render(Toast, {}, '已保存'), /role="status"/);
  assert.match(render(Toast, { urgent: true }, '保存失败'), /role="alert"/);
  assert.match(render(ScrollRegion, { label: '完整记录' }, '记录'), /role="region" aria-label="完整记录" tabindex="0"/);
  assert.match(render(StatusLine, {}, '正在读取'), /role="status"/);
});

test('按钮传递原生属性和进度语义，非法进度立即拒绝', () => {
  assert.match(render(Button, { type: 'submit', 'aria-label': '保存项目', 'aria-busy': true }, '保存'), /type="submit"/);
  assert.match(render(ProgressBar, { ratio: 0.4, label: '下载进度' }), /aria-valuenow="40"/);
  assert.throws(() => render(ProgressBar, { ratio: NaN }), /有限数值/);
});

test('页签具有对应面板、禁用原因，非法选中状态立即拒绝', () => {
  const items = [{ id: 'one', label: '基本', content: '基本内容' }, { id: 'two', label: '高级', disabledReason: '权限不足', content: '高级内容' }];
  const markup = render(Tabs, { label: '设置区段', items, selectedId: 'one', onSelect() {} });
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /role="tabpanel"/);
  assert.match(markup, /aria-selected="true"/);
  assert.match(markup, /权限不足/);
  assert.throws(() => render(Tabs, { label: '设置', items, selectedId: 'two', onSelect() {} }), /可用/);
  assert.match(render(Dialog, { open: false, title: '确认', onClose() {} }, '内容'), /<dialog/);
});
