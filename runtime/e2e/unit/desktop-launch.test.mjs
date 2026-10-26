// 桌面壳编排的解析测试。
//
// 壳要靠运行时的标准输出找到带令牌的地址，这一步解析错了窗口就打不开。这里对纯函数
// `extractBootUrl` 做覆盖：噪声行、多次出现、地址缺失、以及令牌形态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBootUrl } from '../../desktop/electron/launch.mjs';

test('从启动输出里取出带令牌的地址', () => {
  const output = [
    '[chatdsh] phase runtime active',
    'dsh web: http://127.0.0.1:3151/?token=abc123XYZ',
    '[chatdsh] phase runtime done',
  ].join('\n');
  assert.equal(extractBootUrl(output), 'http://127.0.0.1:3151/?token=abc123XYZ');
});

test('输出里没有地址时返回 undefined', () => {
  assert.equal(extractBootUrl('[chatdsh] phase runtime active\n'), undefined);
  assert.equal(extractBootUrl(''), undefined);
});

test('半行输出也算就绪', () => {
  assert.equal(extractBootUrl('dsh web: http://127.0.0.1:3151/?token=abc'), 'http://127.0.0.1:3151/?token=abc');
});

test('多次出现时取第一处', () => {
  const output = 'dsh web: http://127.0.0.1:3151/?token=first\ndash web: http://127.0.0.1:3152/?token=second\n';
  assert.equal(extractBootUrl(output), 'http://127.0.0.1:3151/?token=first');
});

test('不含令牌的地址前缀不会被误当成就绪地址', () => {
  const output = 'listening on http://127.0.0.1:3151/\n';
  assert.equal(extractBootUrl(output), undefined);
});
