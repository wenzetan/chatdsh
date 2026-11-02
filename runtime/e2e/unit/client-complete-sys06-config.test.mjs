// SYS06 的运行期配置与后端注册表验收。
//
// 真实文件、真实遥测收集器：合法组合逐项保存并重新读盘；非法组合、未知标识、过期修订号
// 与未配置 Hermes 四种拒绝都发生在写入之前，磁盘内容保持不变。注册表部分用真实的 chat
// 描述符（内部创建 hermes 适配器）验证按标识选择与可选值提示。
//
// 运行：node --test e2e/unit/client-complete-sys06-config.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import {
  flattenLogs,
  flattenMetrics,
  flattenTraces,
  startCollector,
  telemetryClientFor,
} from './client-complete-sys06-support.mjs';

const { BackendSettingsStore, BACKEND_SETTINGS_FILE } = await import('../../gateway/lib/backends/settings.js');
const policy = await import('../../gateway/lib/backends/policy.js');
const { BackendRegistry } = await import('../../packages/core/backends/lib/index.js');
const { createHermesChatBackend } = await import('../../../hermes-adapter/lib/index.js');

test('合法组合逐项保存并重新读盘，非法组合与过期修订号拒绝写入', async () => {
  const collector = await startCollector();
  const telemetry = telemetryClientFor(collector, '@chatdsh/gateway');
  const home = tempHome('sys06-config');
  const store = new BackendSettingsStore({ dataRoot: home, telemetry, hermesConfigured: () => true });

  // 默认取值。
  assert.deepEqual(store.current(), { revision: 0, chatBackend: 'dsh', memoryBackend: 'none' });
  assert.equal(policy.LEGAL_COMBINATIONS.length, 5);
  assert.deepEqual(
    policy.LEGAL_COMBINATIONS.map((item) => policy.combinationKey(item.chatBackend, item.memoryBackend)).sort(),
    ['dsh+hindsight', 'dsh+none', 'hermes+hermes', 'hermes+hindsight', 'hermes+none'],
  );

  // 逐项保存五种合法组合。
  let revision = 0;
  for (const combination of policy.LEGAL_COMBINATIONS) {
    const saved = await store.save({ revision, ...combination });
    assert.equal(saved.revision, revision + 1);
    assert.equal(saved.chatBackend, combination.chatBackend);
    assert.equal(saved.memoryBackend, combination.memoryBackend);
    revision = saved.revision;
  }
  assert.equal(store.current().revision, 5);

  // 重新打开：修订号与开关都从磁盘读出。
  const reopened = new BackendSettingsStore({ dataRoot: home, telemetry, hermesConfigured: () => true });
  assert.deepEqual(reopened.current(), store.current());
  const onDisk = JSON.parse(readFileSync(join(home, 'backends', BACKEND_SETTINGS_FILE), 'utf8'));
  assert.deepEqual(onDisk, store.current());

  // 非法组合：记忆取 hermes 而聊天取 dsh。
  await assert.rejects(
    store.save({ revision: 5, chatBackend: 'dsh', memoryBackend: 'hermes' }),
    (error) => {
      assert.equal(error.name, 'BackendSettingsError');
      assert.equal(error.code, 'invalid-combination');
      return true;
    },
  );
  assert.equal(store.current().revision, 5);
  assert.equal(JSON.parse(readFileSync(join(home, 'backends', BACKEND_SETTINGS_FILE), 'utf8')).revision, 5);

  // 未知标识。
  await assert.rejects(
    store.save({ revision: 5, chatBackend: 'openai', memoryBackend: 'none' }),
    (error) => error.code === 'unknown-chat-backend',
  );
  await assert.rejects(
    store.save({ revision: 5, chatBackend: 'dsh', memoryBackend: 'redis' }),
    (error) => error.code === 'unknown-memory-backend',
  );

  // 过期修订号：错误里带回当前修订号，界面据此重新读取。
  await assert.rejects(
    store.save({ revision: 3, chatBackend: 'dsh', memoryBackend: 'none' }),
    (error) => {
      assert.equal(error.code, 'revision-stale');
      assert.equal(error.revision, 5);
      return true;
    },
  );

  // 未配置 Hermes 时不允许把聊天切过去。
  const unconfigured = new BackendSettingsStore({ dataRoot: tempHome('sys06-config-unset'), telemetry, hermesConfigured: () => false });
  await assert.rejects(
    unconfigured.save({ revision: 0, chatBackend: 'hermes', memoryBackend: 'none' }),
    (error) => error.code === 'hermes-unconfigured',
  );

  await telemetry.flush(2000);
  const traces = flattenTraces(collector.records().traces);
  const logs = flattenLogs(collector.records().logs);
  const metrics = flattenMetrics(collector.records().metrics);
  assert.ok(
    traces.some((span) => span.name === 'chatdsh.gateway.settings.write' && span.attributes.outcome === 'saved'),
    '保存成功的 span 应当带 outcome=saved',
  );
  assert.ok(
    traces.some((span) => span.name === 'chatdsh.gateway.settings.write' && span.attributes.outcome === 'rejected'),
    '拒绝保存的 span 应当带 outcome=rejected',
  );
  const rejected = logs.filter((log) => log.name === 'chatdsh.gateway.settings.rejected');
  assert.ok(rejected.length >= 5, '每一次拒绝都要有一条失败事件');
  assert.ok(rejected.some((log) => log.attributes['error.code'] === 'invalid-combination'));
  assert.ok(rejected.some((log) => log.attributes['error.code'] === 'revision-stale'));
  const writes = metrics.filter((metric) => metric.name === 'chatdsh_gateway_settings_writes_total');
  assert.ok(writes.some((metric) => metric.attributes.outcome === 'saved'));
  assert.ok(writes.some((metric) => metric.attributes.outcome === 'rejected'));

  await telemetry.shutdown();
  await collector.close();
});

test('损坏的配置文件直接失败，不用默认值覆盖现场', async () => {
  const collector = await startCollector();
  const telemetry = telemetryClientFor(collector, '@chatdsh/gateway');
  try {
    const home = tempHome('sys06-config-broken');
    mkdirSync(join(home, 'backends'), { recursive: true });
    const file = join(home, 'backends', BACKEND_SETTINGS_FILE);
    writeFileSync(file, '{"revision": 1, "chatBackend": "dsh", "memoryBackend": "hermes"}\n', 'utf8');
    assert.throws(
      () => new BackendSettingsStore({ dataRoot: home, telemetry, hermesConfigured: () => true }),
      (error) => {
        assert.equal(error.code, 'settings-corrupt');
        assert.match(error.message, /不能同时选择/);
        return true;
      },
    );
    writeFileSync(file, '不是 JSON\n', 'utf8');
    assert.throws(
      () => new BackendSettingsStore({ dataRoot: home, telemetry, hermesConfigured: () => true }),
      (error) => error.code === 'settings-corrupt',
    );
  } finally {
    await telemetry.shutdown();
    await collector.close();
  }
});

test('注册表按标识选择实现，缺失时列出可选取值', () => {
  const registry = new BackendRegistry();
  registry.register({
    kind: 'chat',
    id: 'hermes',
    version: '0.21.7',
    capabilities: ['approval', 'steer', 'events'],
    configSchema: {
      parse(value) {
        if (typeof value !== 'object' || value === null) throw new Error('配置必须是对象');
        const baseUrl = value.baseUrl;
        if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('配置缺少 baseUrl');
        return { baseUrl };
      },
    },
    create(config) {
      return createHermesChatBackend({
        baseUrl: config.baseUrl,
        requestTimeoutMs: 1000,
        approvalTimeoutMs: 1000,
      });
    },
    async health() {
      return { ok: true };
    },
  });

  assert.equal(registry.has('chat', 'hermes'), true);
  assert.equal(registry.has('memory', 'hermes'), false);
  assert.deepEqual(registry.list('chat'), ['hermes']);
  const described = registry.describe('chat');
  assert.equal(described.length, 1);
  assert.equal(described[0].id, 'hermes');
  assert.equal(described[0].version, '0.21.7');
  assert.deepEqual(described[0].capabilities, ['approval', 'steer', 'events']);

  assert.equal(registry.select('chat', 'hermes').id, 'hermes');
  assert.throws(
    () => registry.select('memory', 'hermes'),
    (error) => {
      assert.match(error.message, /未注册的后端 memory:hermes/);
      assert.match(error.message, /没有任何实现/);
      return true;
    },
  );

  const resolved = registry.resolve('chat', 'hermes', { baseUrl: 'http://127.0.0.1:1' });
  assert.deepEqual(resolved.descriptor.capabilities, ['approval', 'steer', 'events']);
  assert.equal(typeof resolved.service.createRun, 'function');
  assert.deepEqual(resolved.service.capabilities(), ['approval', 'steer', 'events']);
});
