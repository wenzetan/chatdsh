// 字段到 S01–S32 契约清单与解析依赖登记的单元测试。
//
// 运行：node --test e2e/unit/client-complete-wp01-coverage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_COVERAGE,
  CONTRACT_MODULES,
  COVERAGE_SCENARIOS,
  PARSING_DEPENDENCIES,
  coverageOf,
  pendingFields,
} from '../../packages/core/contracts/lib/index.js';

test('契约清单覆盖 S01 到 S32 且顺序固定', () => {
  const expected = Array.from({ length: 32 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`);
  assert.deepEqual([...COVERAGE_SCENARIOS], expected);
  assert.equal(CONTRACT_COVERAGE.length, 32);
});

test('每个场景都有标题与至少两项字段登记', () => {
  for (const entry of CONTRACT_COVERAGE) {
    assert.ok(entry.title.length > 0, `${entry.scenario} 缺少标题`);
    assert.ok(entry.fields.length >= 2, `${entry.scenario} 的字段登记少于两项`);
  }
});

test('字段登记引用的契约模块都已登记', () => {
  for (const entry of CONTRACT_COVERAGE) {
    for (const field of entry.fields) {
      assert.ok(CONTRACT_MODULES.includes(field.module), `${entry.scenario} 的 ${field.field} 引用了未登记模块 ${field.module}`);
      assert.ok(field.field.length > 0, `${entry.scenario} 存在空字段名`);
    }
  }
});

test('待实施字段都写明了承担的工作包', () => {
  const pending = pendingFields();
  assert.ok(pending.length > 0, '未来扩展字段没有被标记为待实施');
  for (const field of pending) {
    assert.equal(field.status, 'pending');
    assert.ok(typeof field.note === 'string' && field.note.length > 0, `${field.field} 缺少待实施说明`);
  }
});

test('已实施字段占多数', () => {
  const all = CONTRACT_COVERAGE.flatMap((entry) => entry.fields);
  const implemented = all.filter((field) => field.status === 'implemented');
  assert.ok(implemented.length > all.length / 2, '已实施字段不足一半');
});

test('未来扩展字段明确标记为待实施', () => {
  const byName = new Map(CONTRACT_COVERAGE.flatMap((entry) => entry.fields).map((field) => [field.field, field]));
  for (const name of ['项目默认助手的持久化字段', 'cron 表达式的成熟解析依赖', '非交互退出码与 JSON 行输出']) {
    const field = byName.get(name);
    assert.ok(field !== undefined, `清单缺少字段：${name}`);
    assert.equal(field.status, 'pending', `${name} 应当标记为待实施`);
  }
  assert.equal(byName.get('内容读取状态与只读原因').status, 'implemented');
});

test('按场景取覆盖，未登记的场景直接抛出', () => {
  assert.equal(coverageOf('S18').title, '访问认证、双因素与恢复');
  assert.ok(coverageOf('S18').fields.some((field) => field.module === 'access'));
  assert.throws(() => coverageOf('S99'), /未登记的场景/);
});

test('解析依赖登记覆盖 JSON、YAML、cron 与时区', () => {
  const byFormat = new Map(PARSING_DEPENDENCIES.map((entry) => [entry.format, entry]));
  for (const format of ['json', 'yaml', 'cron', 'timezone']) {
    assert.ok(byFormat.has(format), `解析依赖缺少 ${format}`);
  }
  assert.equal(byFormat.get('json').library, 'zod');
  assert.equal(byFormat.get('json').status, 'implemented');
  assert.equal(byFormat.get('yaml').library, 'js-yaml');
  assert.equal(byFormat.get('yaml').status, 'implemented');
  assert.equal(byFormat.get('timezone').library, 'Intl.supportedValuesOf');
  assert.equal(byFormat.get('timezone').status, 'implemented');
  assert.equal(byFormat.get('cron').status, 'pending');
  assert.ok(byFormat.get('cron').library.length > 0);
  for (const entry of PARSING_DEPENDENCIES) {
    assert.ok(entry.owner.length > 0, `${entry.format} 缺少承担模块`);
  }
});
