// 技能目录的测试。
//
// 只验证纯函数目录：顺序、默认启用、停用、未知标识与重复标识。技能来源的扫描由宿主
// 侧的 `ctx.skills` 提供，不在这一层验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillCatalog } from '../../packages/host/skills/lib/registry.js';

test('目录按来源列出并默认全部启用', () => {
  const catalog = createSkillCatalog([
    { id: 'tdd', name: '测试驱动', description: '先写测试', source: 'builtin' },
    { id: 'repo', name: '仓库规则', description: '项目约定', source: 'workspace' },
  ]);
  assert.deepEqual(catalog.list().map((entry) => entry.id), ['tdd', 'repo']);
  assert.equal(catalog.enabled().length, 2);
  assert.deepEqual(catalog.catalog(), { total: 2, enabled: 2 });
});

test('停用后从启用列表移除，重新启用后恢复', () => {
  const catalog = createSkillCatalog([{ id: 'tdd', name: '测试驱动', description: '先写测试', source: 'builtin' }]);
  catalog.disable('tdd');
  assert.equal(catalog.enabled().length, 0);
  assert.deepEqual(catalog.catalog(), { total: 1, enabled: 0 });
  catalog.enable('tdd');
  assert.deepEqual(catalog.enabled().map((entry) => entry.id), ['tdd']);
});

test('未知标识就地抛出', () => {
  const catalog = createSkillCatalog([{ id: 'tdd', name: '测试驱动', description: '先写测试', source: 'builtin' }]);
  assert.throws(() => catalog.disable('missing'), /未知技能/);
  assert.throws(() => catalog.enable('missing'), /未知技能/);
});

test('重复标识在构造时就地抛出', () => {
  assert.throws(
    () => createSkillCatalog([
      { id: 'tdd', name: '测试驱动', description: '先写测试', source: 'builtin' },
      { id: 'tdd', name: '另一个', description: '重复', source: 'user' },
    ]),
    /技能标识重复/,
  );
});

test('toggle 返回设置后的启用状态', () => {
  const catalog = createSkillCatalog([{ id: 'tdd', name: '测试驱动', description: '先写测试', source: 'builtin' }]);
  assert.equal(catalog.toggle('tdd', false).enabled, false);
  assert.equal(catalog.toggle('tdd', true).enabled, true);
});
