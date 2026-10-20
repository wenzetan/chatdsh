// 图像请求构造的单元测试。
//
// 直接调用编译后的真实实现，覆盖尺寸校验、生成与编辑模式的区分、响应解析。
//
// 运行：node --test e2e/unit/image-request.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImageRequest, firstImageOf, SIZES } from '../../packages/presets/tool-image/lib/request.js';

test('不给尺寸时取 1024x1024', () => {
  const { request, mode } = buildImageRequest({ prompt: '一只猫' });
  assert.equal(request.size, '1024x1024');
  assert.equal(mode, 'generate');
  assert.equal(request.images, undefined);
});

test('给出尺寸时按给定值', () => {
  const { request } = buildImageRequest({ prompt: '一只猫', size: '512x512' });
  assert.equal(request.size, '512x512');
});

test('尺寸不在清单里时报错并列出支持的取值', () => {
  assert.throws(
    () => buildImageRequest({ prompt: '一只猫', size: '800x600' }),
    new RegExp(SIZES.join('、')),
  );
});

test('提示词为空时报错', () => {
  assert.throws(() => buildImageRequest({ prompt: '   ' }), /不能为空/);
});

test('带输入图像进入编辑模式', () => {
  const { request, mode } = buildImageRequest({ prompt: '改成素描', images: ['AAAA'] });
  assert.equal(mode, 'edit');
  assert.deepEqual(request.images, ['AAAA']);
});

test('空数组按生成模式处理', () => {
  const { mode } = buildImageRequest({ prompt: '一只猫', images: [] });
  assert.equal(mode, 'generate');
});

test('从响应里取第一张图像', () => {
  assert.equal(firstImageOf({ data: [{ b64_json: 'AAAA' }, { b64_json: 'BBBB' }] }), 'AAAA');
});

test('响应里没有图像时报错', () => {
  assert.throws(() => firstImageOf({ data: [] }), /没有返回图像/);
  assert.throws(() => firstImageOf({}), /没有返回图像/);
});
