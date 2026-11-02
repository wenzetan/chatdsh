// WP01 客户端领域契约测试共用的断言工具。
//
// 运行方式：被各 client-complete-wp01-*.test.mjs 引用。

import assert from 'node:assert/strict';

/** 对外形状里不允许出现的键名片段：内部游标与副本水位的各种写法。 */
const FORBIDDEN_KEY_FRAGMENTS = ['seq', 'watermark', 'behind', 'synclevel', 'sync-level', 'syncLevel'];

/**
 * 递归收集一个取值里的全部对象键名。
 * @param {unknown} value - 待扫描的取值。
 * @param {Set<string>} sink - 收集结果的集合。
 * @returns {Set<string>} 收集结果。
 */
export function collectKeys(value, sink = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, sink);
    return sink;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      sink.add(key);
      collectKeys(item, sink);
    }
  }
  return sink;
}

/**
 * 断言一个对外形状不含内部序号与副本水位字段。
 *
 * 扫描对象是序列化之后再解析的结构，因此断言检查的正是客户端实际收到的字段名。
 * @param {unknown} value - 待扫描的取值。
 * @param {string} label - 断言失败时的说明。
 */
export function assertNoWatermark(value, label) {
  const serialized = JSON.parse(JSON.stringify(value));
  const keys = [...collectKeys(serialized)];
  const offenders = keys.filter((key) =>
    FORBIDDEN_KEY_FRAGMENTS.some((fragment) => key.toLowerCase().includes(fragment.toLowerCase())),
  );
  assert.deepEqual(offenders, [], `${label} 暴露了内部序号或副本水位字段`);
}

/**
 * 校验一次 schema 往返：解析、序列化、再解析，结果与首次解析一致。
 * @param {import('zod').ZodType} schema - 待校验的 schema。
 * @param {unknown} value - 输入取值。
 * @param {string} label - 断言失败时的说明。
 * @returns {unknown} 首次解析的结果。
 */
export function roundtrip(schema, value, label) {
  const parsed = schema.parse(value);
  const encoded = JSON.stringify(parsed);
  const decoded = JSON.parse(encoded);
  const again = schema.parse(decoded);
  assert.deepEqual(again, parsed, `${label} 往返后结果不一致`);
  assert.equal(JSON.stringify(again), encoded, `${label} 往返后序列化结果不一致`);
  return parsed;
}

/**
 * 断言一个取值被 schema 拒绝。
 * @param {import('zod').ZodType} schema - 待校验的 schema。
 * @param {unknown} value - 输入取值。
 * @param {string} label - 断言失败时的说明。
 */
export function expectReject(schema, value, label) {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `${label} 应当被拒绝`);
}

/**
 * 断言一个取值被 schema 接受。
 * @param {import('zod').ZodType} schema - 待校验的 schema。
 * @param {unknown} value - 输入取值。
 * @param {string} label - 断言失败时的说明。
 * @returns {unknown} 解析结果。
 */
export function expectAccept(schema, value, label) {
  const result = schema.safeParse(value);
  assert.equal(result.success, true, `${label} 应当被接受`);
  return result.data;
}

/** 一份合法内容范围。 */
export const CONTENT_SCOPE = {
  turnFrom: 1,
  turnTo: 4,
  eventCount: 21,
  charCount: 4096,
  compressed: false,
  attachmentsComplete: true,
};

/** 一个合法的操作标识。 */
export const OPERATION_ID = 'AbCdEf0123456789_-xY';

/** 一个合法的请求摘要。 */
export const REQUEST_DIGEST = 'a'.repeat(64);
