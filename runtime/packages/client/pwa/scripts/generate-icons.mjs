// 生成 PWA 图标的占位资源。
//
// 图标没有设计稿可用，这里按设计令牌里的品牌填充色生成稳定的占位图：品牌色圆角方块与白色
// 对话气泡。同一份脚本生成普通图标与 maskable 图标，maskable 版本把图形收进中心 80% 的
// 安全区，任何形状遮罩裁切都不会切掉主体。重新生成后图片内容不变，便于在版本管理里核对。
//
// 用法：node packages/client/pwa/scripts/generate-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(import.meta.filename), '..');
const OUTPUT = join(ROOT, 'assets', 'icons');

/** 品牌填充色，与设计令牌 `--chatdsh-brand-fill` 的暗色取值一致。 */
const BRAND = [0x3d, 0x56, 0xe8, 0xff];
/** 图标主体的白色。 */
const INK = [0xff, 0xff, 0xff, 0xff];
/** 图标之外完全透明的像素。 */
const CLEAR = [0x00, 0x00, 0x00, 0x00];

/** CRC32 查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 计算一段字节的 CRC32。
 * @param {Buffer} bytes - 待计算的数据。
 * @returns {number} 校验值。
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 拼一个 PNG 数据块。
 * @param {string} type - 块类型。
 * @param {Buffer} data - 块内容。
 * @returns {Buffer} 完整的数据块。
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 把逐像素颜色函数编码成 PNG。
 * @param {number} width - 宽度。
 * @param {number} height - 高度。
 * @param {(x: number, y: number) => number[]} pixel - 颜色函数，返回 RGBA。
 * @returns {Buffer} PNG 文件内容。
 */
function encodePng(width, height, pixel) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const offset = y * stride + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 判断点是否落在圆角矩形内。
 * @param {number} x - 横坐标。
 * @param {number} y - 纵坐标。
 * @param {number} left - 左边界。
 * @param {number} top - 上边界。
 * @param {number} width - 宽度。
 * @param {number} height - 高度。
 * @param {number} radius - 圆角半径。
 * @returns {boolean} 落在内部时为真。
 */
function inRoundedRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x >= left + width || y >= top + height) return false;
  const nearLeft = x < left + radius;
  const nearRight = x >= left + width - radius;
  const nearTop = y < top + radius;
  const nearBottom = y >= top + height - radius;
  if (!(nearLeft || nearRight) || !(nearTop || nearBottom)) return true;
  const centerX = nearLeft ? left + radius : left + width - radius;
  const centerY = nearTop ? top + radius : top + height - radius;
  return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
}

/**
 * 画一枚图标：品牌色底与白色气泡。
 * @param {number} size - 边长。
 * @param {number} inset - 四周留白占边长的比例；maskable 用 0.1。
 * @returns {(x: number, y: number) => number[]} 颜色函数。
 */
function iconPainter(size, inset) {
  const pad = Math.round(size * inset);
  const corner = Math.round(size * 0.22);
  const bubbleLeft = Math.round(size * 0.24);
  const bubbleTop = Math.round(size * 0.28);
  const bubbleWidth = Math.round(size * 0.52);
  const bubbleHeight = Math.round(size * 0.34);
  const bubbleRadius = Math.round(size * 0.09);
  const tailCenter = Math.round(size * 0.42);
  return (x, y) => {
    const visible = inRoundedRect(x, y, 0, 0, size, size, inset === 0 ? corner : 0);
    if (!visible) return CLEAR;
    const bubble = inRoundedRect(x, y, bubbleLeft, bubbleTop, bubbleWidth, bubbleHeight, bubbleRadius);
    const tail = y >= bubbleTop + bubbleHeight - 1
      && y < bubbleTop + bubbleHeight + Math.round(size * 0.12)
      && Math.abs(x - tailCenter) < Math.round(size * 0.1) - (y - (bubbleTop + bubbleHeight)) * 2;
    if (bubble || tail) return INK;
    return BRAND;
  };
}

mkdirSync(OUTPUT, { recursive: true });
const targets = [
  { name: 'icon-192.png', size: 192, inset: 0.075 },
  { name: 'icon-512.png', size: 512, inset: 0.075 },
  { name: 'icon-maskable-512.png', size: 512, inset: 0 },
];
for (const target of targets) {
  const bytes = encodePng(target.size, target.size, iconPainter(target.size, target.inset));
  writeFileSync(join(OUTPUT, target.name), bytes);
  console.log(`${target.name}：${target.size}×${target.size}，${String(bytes.length)} 字节`);
}
