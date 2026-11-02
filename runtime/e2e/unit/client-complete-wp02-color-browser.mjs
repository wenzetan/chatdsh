import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge, Button, ErrorNote, List, Panel, ProgressBar, Row, StatusLine, UI_KIT_CSS } from '../../packages/core/ui-kit/src/index.ts';

const componentStyles = document.createElement('style');
componentStyles.textContent = UI_KIT_CSS;
document.head.append(componentStyles);

const mount = document.createElement('section');
mount.id = 'wp02-colors';
mount.setAttribute('aria-label', '配色测量组件');
document.querySelector('main').append(mount);
createRoot(mount).render(h(Panel, { title: '共享组件配色', subtitle: '辅助说明与状态文字', count: '5' },
  h(List, null, ...['neutral', 'ok', 'warn', 'danger', 'brand'].map((tone) => h(Row, {
    key: tone, title: `状态 ${tone}`, meta: '设备状态说明', dot: tone === 'neutral' || tone === 'brand' ? 'idle' : tone,
    badge: h(Badge, { tone }, `状态 ${tone}`), actions: h(Button, { tone: 'default' }, '查看状态'),
  }))),
  h(StatusLine, null, '等待读取'), h(StatusLine, { tone: 'danger' }, '读取失败'),
  h(ErrorNote, null, '错误详情与软背景'),
  h(Button, { id: 'wp02-primary', tone: 'primary' }, '保存设置'),
  h(Button, { id: 'wp02-danger', tone: 'danger' }, '删除设置'),
  h(ProgressBar, { label: '警告进度', ratio: 0.6, tone: 'warn' }),
  h(ProgressBar, { label: '失败进度', ratio: 0.6, tone: 'danger' }),
));

const canvas = document.createElement('canvas');
canvas.width = canvas.height = 1;
const paint = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
if (paint === null) throw new Error('浏览器需要 Canvas2D 颜色计算支持');

function layers(element) {
  const result = [];
  for (let current = element; current !== null; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1 || style.filter !== 'none' || style.mixBlendMode !== 'normal') {
      throw new Error(`颜色测量不支持当前绘制效果：${current.className}`);
    }
    result.unshift(style.backgroundColor);
  }
  return result;
}

// CSS 颜色解析、色彩空间转换和 alpha 合成都交给浏览器的绘制实现。
function pixel(backgrounds, foreground) {
  paint.clearRect(0, 0, 1, 1);
  for (const color of [...backgrounds, ...(foreground === undefined ? [] : [foreground])]) {
    if (!CSS.supports('color', color)) throw new Error(`浏览器拒绝计算样式颜色：${color}`);
    paint.fillStyle = color;
    paint.fillRect(0, 0, 1, 1);
  }
  const channels = [...paint.getImageData(0, 0, 1, 1).data];
  if (channels[3] !== 255) throw new Error('颜色测量需要实际不透明背景');
  return channels.slice(0, 3);
}

function luminance(channels) {
  const linear = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function ratio(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function visible(element) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
}

function identify(element) {
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : `.${[...element.classList].join('.')}`} ${element.textContent.trim().slice(0, 48)}`;
}

function measureColors() {
  const samples = [];
  const record = (element, kind, foreground, backgrounds, threshold) => {
    const background = pixel(backgrounds);
    const rendered = pixel(backgrounds, foreground);
    samples.push({ element: identify(element), kind, threshold, ratio: ratio(rendered, background), foreground, rendered, background });
  };
  for (const element of document.querySelectorAll('main *')) {
    if (!visible(element) || element.matches(':disabled')) continue;
    const style = getComputedStyle(element);
    const own = layers(element);
    const outside = layers(element.parentElement);
    const text = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (text) record(element, element.matches('h1,h2,h3,h4,h5,h6') ? 'heading' : 'text', style.color, own, element.matches('h1,h2,h3,h4,h5,h6') ? 7 : 4.5);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (Number.parseFloat(style[`border${side}Width`]) <= 0 || ['none', 'hidden'].includes(style[`border${side}Style`])) continue;
      const color = style[`border${side}Color`];
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      // 完全透明边框不承担可见边界；实心按钮由填充区域提供边界。
      if (paint.getImageData(0, 0, 1, 1).data[3] === 0) continue;
      record(element, `border-${side}-inside`, color, own, 3);
      const border = pixel(own, color);
      samples.push({ element: identify(element), kind: `border-${side}-outside`, threshold: 3, ratio: ratio(border, pixel(outside)), foreground: color, rendered: border, background: pixel(outside) });
    }
    if (element.matches('.chdsh-dot, .chdsh-bar__fill')) record(element, 'graphic', style.backgroundColor, outside, 3);
    if (element.matches('.chdsh-btn--primary')) {
      const background = pixel(outside);
      const fill = pixel(own);
      const border = pixel(own, style.borderTopColor);
      samples.push({ element: identify(element), kind: 'button-boundary', threshold: 3, ratio: Math.max(ratio(fill, background), ratio(border, background)), rendered: fill, border, background });
    }
    if (element.matches(':focus-visible')) {
      if (style.outlineStyle === 'none' || Number.parseFloat(style.outlineWidth) < 2) throw new Error(`焦点轮廓不可见：${identify(element)}`);
      record(element, 'focus', style.outlineColor, outside, 3);
    }
  }
  if (!samples.some((sample) => sample.kind === 'heading') || !samples.some((sample) => sample.element.includes('chdsh-badge--ok'))) throw new Error('配色组件尚未完成渲染');
  return { samples, failures: samples.filter((sample) => sample.ratio < sample.threshold) };
}

let sizes;
function scaleText(factor) {
  if (sizes !== undefined) throw new Error('文字缩放必须先恢复');
  sizes = [...document.querySelectorAll('body, body *')].map((element) => ({ element, size: Number.parseFloat(getComputedStyle(element).fontSize), value: element.style.getPropertyValue('font-size'), priority: element.style.getPropertyPriority('font-size') }));
  for (const entry of sizes) entry.element.style.setProperty('font-size', `${entry.size * factor}px`, 'important');
  return sizes.every(({ element, size }) => Math.abs(Number.parseFloat(getComputedStyle(element).fontSize) - size * factor) < 0.01);
}

function restoreText() {
  for (const { element, value, priority } of sizes) {
    if (value) element.style.setProperty('font-size', value, priority);
    else element.style.removeProperty('font-size');
  }
  sizes = undefined;
}

function measureLayout() {
  const failures = [];
  if (document.documentElement.scrollWidth > innerWidth) failures.push(`页面横向溢出 ${document.documentElement.scrollWidth}/${innerWidth}`);
  for (const element of document.querySelectorAll('main *')) {
    if (!visible(element)) continue;
    const box = element.getBoundingClientRect();
    if (element.matches('button, input, select, textarea, a[href]') && (box.width < 44 || box.height < 44)) failures.push(`触控区域不足：${identify(element)} ${box.width}×${box.height}`);
    if (element.closest('.chdsh-scroll-region') === null && (box.left < -1 || box.right > innerWidth + 1)) failures.push(`元素超出页面：${identify(element)}`);
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || (element.closest('.chdsh-scroll-region') === null && (rect.left < box.left - 1 || rect.right > box.right + 1))) failures.push(`文字超出容器：${identify(element)}`);
      }
    }
  }
  const region = document.querySelector('.chdsh-scroll-region');
  if (region.getAttribute('role') !== 'region' || !region.getAttribute('aria-label') || region.tabIndex < 0 || getComputedStyle(region).overflowX !== 'auto') failures.push('长表格需要独立命名键盘滚动区域');
  return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, failures: [...new Set(failures)] };
}

window.wp02 = { measureColors, scaleText, restoreText, measureLayout };
