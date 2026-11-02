// WP15 记忆宿主的验收测试。
//
// 每个测试都在 runtime/.run 下分配独立数据根，把 DSH_HOME 指向它，并用显式根构造
// MemoryStore 与真实服务。覆盖记忆组的建立、更新、解除、删除、持久化、并发保存与数量
// 上限，状态视图与未确认写入视图的脱敏，后端不可达时的检索降级，以及 Hindsight 可达时
// 隔离 bank 上的真实召回。
//
// 运行：node --test e2e/unit/client-complete-wp15-memory.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';
import { allocateIndependentHome, probeHttpService, releaseIndependentHome } from '../lib/environment.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const { Context } = await import('@deepseek-ai/cordis');
const {
  ChatdshMemoryService,
  GROUP_LIMIT,
  GROUPS_STORE,
  MemoryGroupRegistry,
  MemoryStore,
  UnconfirmedWrites,
  memoryDataRoot,
} = await import('../../packages/host/memory/lib/index.js');
const { createMemoryClient } = await import('../../packages/host/memory/lib/client.js');
const { TypertRemoteService } = await import('../../../dsh-adapter/lib/index.js');
const { CHATDSH_ERROR_CODES } = await import('../../packages/core/contracts/lib/index.js');

/** 本机设备标识。 */
const DEVICE = 'device-wp15';

/** 不可达的记忆后端地址。 */
const UNREACHABLE = 'http://127.0.0.1:1';

/** Hindsight 地址。 */
const HINDSIGHT = process.env.HINDSIGHT_URL ?? 'http://127.0.0.1:8889';

/** 服务配置。 */
function configFor(overrides = {}) {
  return {
    hindsightUrl: UNREACHABLE,
    maxTokens: 1024,
    requestTimeoutMs: 2000,
    mirrorToOwnBank: false,
    additionalBanks: [],
    deviceId: DEVICE,
    ...overrides,
  };
}

/** 构造一个工作区关联。 */
function workspace(path) {
  return { deviceId: DEVICE, path };
}

/**
 * 在独立数据根里运行一个测试。
 * @param {{ hindsightUrl?: string, additionalBanks?: string[], requestTimeoutMs?: number }} options - 服务配置覆盖。
 * @param {(host: { home: string, root: string, open: (overrides?: object) => Promise<{ store: MemoryStore, service: ChatdshMemoryService }> }) => Promise<void>} run - 测试主体。
 */
async function withHost(options, run) {
  const home = allocateIndependentHome('wp15-memory');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = join(home, 'memory');
  const open = async (overrides = options) => {
    const store = new MemoryStore(root);
    const service = new ChatdshMemoryService(new Context(), configFor(overrides));
    await service[TypertRemoteService.init]();
    return { store, service };
  };
  try {
    assert.equal(memoryDataRoot(), root, '数据根应当由 DSH_HOME 决定');
    await run({ home, root, open });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    releaseIndependentHome(home);
  }
}

/**
 * 断言一个 Promise 以指定错误码失败。
 * @param {Promise<unknown>} promise - 待观察的调用。
 * @param {string} code - 期望的错误码。
 */
async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${String(error.code)}：${error.message}`);
    return true;
  });
}

/**
 * 读取数据根下全部文件的内容。
 * @param {string} root - 数据根。
 */
function readDataFiles(root) {
  const files = new Map();
  if (!existsSync(root)) return files;
  for (const name of readdirSync(root).sort()) files.set(name, readFileSync(join(root, name), 'utf8'));
  return files;
}

/**
 * 直接读取映射文件里的记忆组。
 * @param {string} root - 数据根。
 */
function readGroupsFile(root) {
  return JSON.parse(readFileSync(join(root, `${GROUPS_STORE}.json`), 'utf8')).groups;
}

/**
 * 召回结果是否来自本次写入。
 *
 * 隔离 bank 里只有一条写入内容，后端异步整合可能改写字句，因此标记缺失时按写入内容的核心事实判定。
 * @param {string} text - 召回文本。
 * @param {string} marker - 写入内容里的唯一标记。
 * @returns 是否命中写入内容。
 */
function mentionsWrittenContent(text, marker) {
  return text.includes(marker) || text.includes('蓝鲸');
}

/**
 * 轮询召回，直到写入内容可以被召回；返回最后一次召回结果。
 *
 * 后端可达时偶发的单次请求失败按重试处理，最后一次错误在没有任何命中时抛出，
 * 因此后端真正不可达仍然会失败。
 * @param {{ recall: (banks: string[], options: object) => Promise<object[]> }} client - 记忆客户端。
 * @param {string} bank - 隔离 bank 名。
 * @param {string} marker - 写入内容里的唯一标记。
 */
async function recallUntilMarked(client, bank, marker) {
  const query = `验收编号 ${marker} 蓝鲸 体长`;
  let hits = [];
  let lastError;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      hits = await client.recall([bank], { query, maxTokens: 512 });
      if (hits.some((hit) => mentionsWrittenContent(hit.text, marker))) return hits;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  if (lastError !== undefined && hits.length === 0) throw lastError;
  return hits;
}

/**
 * 删除隔离 bank，避免验收数据留在记忆后端。
 * @param {string} bank - 隔离 bank 名。
 */
async function dropBank(bank) {
  const response = await fetch(`${HINDSIGHT}/v1/default/banks/${encodeURIComponent(bank)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  assert.equal(response.ok, true, `隔离 bank 没有删除成功：HTTP ${response.status}`);
}

test('新建记忆组返回稳定标识与 revision 1，更新按 revision 递增', async () => {
  await withHost({}, async ({ root, open }) => {
    const { service } = await open();
    const created = await service.saveGroup({ displayName: '工作区记忆', workspaces: [workspace('/srv/wp15/main')] });
    assert.match(created.memoryGroupId, /^mg_[0-9a-f]{24}$/, '记忆组标识要带 mg_ 前缀与二十四位十六进制');
    assert.equal(created.revision, 1);
    assert.equal(created.displayName, '工作区记忆');
    assert.deepEqual(created.workspaces, [workspace('/srv/wp15/main')]);
    assert.equal(created.entryCount, undefined, '未读取到条目数时视图里不出现这个字段');
    assert.ok(Number.isInteger(created.createdAt) && created.createdAt > 0);
    assert.equal(created.updatedAt, created.createdAt);

    const updated = await service.saveGroup({
      memoryGroupId: created.memoryGroupId,
      displayName: '工作区记忆（改）',
      workspaces: [workspace('/srv/wp15/main'), workspace('/srv/wp15/second')],
      revision: created.revision,
    });
    assert.equal(updated.memoryGroupId, created.memoryGroupId);
    assert.equal(updated.revision, 2);
    assert.equal(updated.displayName, '工作区记忆（改）');
    assert.equal(updated.workspaces.length, 2);
    assert.equal(updated.createdAt, created.createdAt, '更新不改建立时刻');
    assert.ok(updated.updatedAt >= created.updatedAt);

    await rejectsWithCode(
      service.saveGroup({
        memoryGroupId: created.memoryGroupId,
        displayName: '过期写入',
        workspaces: [workspace('/srv/wp15/main')],
        revision: created.revision,
      }),
      'revision-conflict',
    );

    const listed = await service.listGroups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].memoryGroupId, created.memoryGroupId);
    assert.equal(listed[0].revision, 2);
    assert.equal(listed[0].displayName, '工作区记忆（改）');
    assert.equal(readGroupsFile(root).length, 1);
  });
});

test('工作区已属于另一个记忆组时保存被拒绝，原组保持原样', async () => {
  await withHost({}, async ({ open }) => {
    const { service } = await open();
    const first = await service.saveGroup({ displayName: '原组', workspaces: [workspace('/srv/wp15/shared')] });
    const snapshot = await service.listGroups();

    await rejectsWithCode(
      service.saveGroup({ displayName: '抢占组', workspaces: [workspace('/srv/wp15/shared')] }),
      'request-invalid',
    );

    const second = await service.saveGroup({ displayName: '另一组', workspaces: [workspace('/srv/wp15/other')] });
    await rejectsWithCode(
      service.saveGroup({
        memoryGroupId: second.memoryGroupId,
        displayName: '另一组（改）',
        workspaces: [workspace('/srv/wp15/other'), workspace('/srv/wp15/shared')],
        revision: second.revision,
      }),
      'request-invalid',
    );

    const listed = await service.listGroups();
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.find((group) => group.memoryGroupId === first.memoryGroupId), snapshot[0], '被拒绝的保存不改原组');
    assert.equal(listed.find((group) => group.memoryGroupId === second.memoryGroupId).revision, 1, '被拒绝的更新不改自身');
  });
});

test('解除单个工作区保留其余工作区，解除最后一个工作区删除整组', async () => {
  await withHost({}, async ({ root, open }) => {
    const { service } = await open();
    const created = await service.saveGroup({
      displayName: '多工作区',
      workspaces: [workspace('/srv/wp15/a'), workspace('/srv/wp15/b')],
    });

    const partial = await service.detachWorkspace(created.memoryGroupId, workspace('/srv/wp15/a'), created.revision);
    assert.notEqual(partial, undefined, '还有剩余工作区时返回更新后的记忆组');
    assert.equal(partial.memoryGroupId, created.memoryGroupId);
    assert.equal(partial.revision, created.revision + 1);
    assert.deepEqual(partial.workspaces, [workspace('/srv/wp15/b')]);

    await rejectsWithCode(
      service.detachWorkspace(created.memoryGroupId, workspace('/srv/wp15/b'), created.revision),
      'revision-conflict',
    );
    await rejectsWithCode(
      service.detachWorkspace(created.memoryGroupId, workspace('/srv/wp15/absent'), partial.revision),
      'request-invalid',
    );

    const removed = await service.detachWorkspace(created.memoryGroupId, workspace('/srv/wp15/b'), partial.revision);
    assert.equal(removed, undefined, '解除最后一个工作区会删除整组');
    assert.deepEqual(await service.listGroups(), []);
    assert.deepEqual(readGroupsFile(root), []);
  });
});

test('删除记忆组需要匹配的 revision，且只改映射文件', async () => {
  await withHost({}, async ({ root, open }) => {
    const { store, service } = await open();
    const created = await service.saveGroup({ displayName: '待删除', workspaces: [workspace('/srv/wp15/byebye')] });
    const record = await new UnconfirmedWrites(store).register({
      bank: 'acct',
      content: `待处理正文 ${randomBytes(4).toString('hex')}`,
      context: 'turn-summary',
    });
    const before = readDataFiles(root);

    await rejectsWithCode(service.removeGroup(created.memoryGroupId, 0), 'revision-conflict');
    assert.equal((await service.listGroups()).length, 1, '拒绝之后映射还在');

    assert.equal(await service.removeGroup(created.memoryGroupId, created.revision), true);
    assert.deepEqual(await service.listGroups(), []);
    assert.deepEqual(readGroupsFile(root), []);

    const after = readDataFiles(root);
    assert.equal(after.size, before.size, '删除记忆组不增删文件');
    const changed = [...before.keys()].filter((name) => after.get(name) !== before.get(name));
    assert.deepEqual(changed, [`${GROUPS_STORE}.json`], '删除记忆组只改映射文件');
    const queue = await service.writeQueue();
    assert.equal(queue.pendingCount, 1, '既有待写入记录不受影响');
    assert.equal(queue.oldestPendingAt, record.createdAt);
  });
});

test('重建存储与注册表后映射仍在', async () => {
  await withHost({}, async ({ root, open }) => {
    const { service } = await open();
    const created = await service.saveGroup({ displayName: '持久化', workspaces: [workspace('/srv/wp15/keep')] });
    await service.saveGroup({
      memoryGroupId: created.memoryGroupId,
      displayName: '持久化（改）',
      workspaces: [workspace('/srv/wp15/keep'), workspace('/srv/wp15/keep2')],
      revision: created.revision,
    });

    const registry = new MemoryGroupRegistry(new MemoryStore(root));
    const records = await registry.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].memoryGroupId, created.memoryGroupId);
    assert.equal(records[0].revision, 2);
    assert.equal(records[0].displayName, '持久化（改）');
    assert.deepEqual(records[0].workspaces, [workspace('/srv/wp15/keep'), workspace('/srv/wp15/keep2')]);
    assert.equal((await registry.resolve(workspace('/srv/wp15/keep2'))).memoryGroupId, created.memoryGroupId);
    assert.equal(await registry.resolve(workspace('/srv/wp15/unknown')), undefined);

    const onDisk = readGroupsFile(root);
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].memoryGroupId, created.memoryGroupId);
    assert.equal(onDisk[0].displayName, '持久化（改）');
    assert.equal(onDisk[0].revision, 2);
    assert.deepEqual(onDisk[0].workspaces.map((entry) => entry.path), ['/srv/wp15/keep', '/srv/wp15/keep2']);

    const reopened = (await open()).service;
    const listed = await reopened.listGroups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].memoryGroupId, created.memoryGroupId);
    assert.equal(listed[0].revision, 2);
  });
});

test('同一 revision 的并发保存只有一个成功', async () => {
  await withHost({}, async ({ open }) => {
    const { service } = await open();
    const created = await service.saveGroup({ displayName: '并发', workspaces: [workspace('/srv/wp15/race')] });
    const input = (displayName) => ({
      memoryGroupId: created.memoryGroupId,
      displayName,
      workspaces: [workspace('/srv/wp15/race')],
      revision: created.revision,
    });

    const settled = await Promise.allSettled([service.saveGroup(input('并发甲')), service.saveGroup(input('并发乙'))]);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1, `应当只有一个保存成功，实际成功 ${fulfilled.length} 个`);
    assert.equal(rejected.length, 1, `另一个保存应当被拒绝，实际拒绝 ${rejected.length} 个`);
    assert.equal(rejected[0].reason.code, 'revision-conflict');
    assert.equal(fulfilled[0].value.revision, 2);

    const listed = await service.listGroups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].revision, 2);
    assert.ok(['并发甲', '并发乙'].includes(listed[0].displayName));
  });
});

test('达到记忆组数量上限后拒绝新建，既有映射数量不变', async (t) => {
  await withHost({}, async ({ open }) => {
    const { service } = await open();
    assert.equal(GROUP_LIMIT, 1024, '记忆组数量上限是产品约定的 1024');
    const started = Date.now();
    for (let index = 0; index < GROUP_LIMIT; index += 1) {
      await service.saveGroup({ displayName: `批量 ${index}`, workspaces: [workspace(`/srv/wp15/bulk-${index}`)] });
    }
    t.diagnostic(`新建 ${GROUP_LIMIT} 个记忆组耗时 ${Date.now() - started} 毫秒`);
    assert.equal((await service.listGroups()).length, GROUP_LIMIT);

    await assert.rejects(
      service.saveGroup({ displayName: '超出上限', workspaces: [workspace('/srv/wp15/overflow')] }),
      (error) => {
        assert.equal(error.code, 'request-invalid');
        assert.equal(error.details.limit, GROUP_LIMIT);
        return true;
      },
    );
    assert.equal((await service.listGroups()).length, GROUP_LIMIT, '拒绝新建之后既有映射数量不变');
  });
});

test('未确认写入视图与状态视图只含脱敏字段', async () => {
  await withHost({}, async ({ open }) => {
    const { store, service } = await open();
    const marker = `wp15-secret-${randomBytes(8).toString('hex')}`;
    const content = `这段正文含有唯一标记 ${marker}，不得出现在任何视图里。`;
    const record = await new UnconfirmedWrites(store).register({ bank: 'acct', content, context: 'turn-summary' });

    const queue = await service.writeQueue();
    const settings = await service.settings();
    const status = await service.status();
    const serialized = JSON.stringify({ queue, settings, status });
    assert.equal(serialized.includes(marker), false, `视图里出现了写入内容的标记：${serialized}`);
    assert.equal(serialized.includes(content), false, '视图里出现了写入内容原文');

    assert.deepEqual(Object.keys(queue).sort(), ['discardedCount', 'oldestPendingAt', 'pendingCount']);
    assert.equal(queue.pendingCount, 1);
    assert.equal(queue.oldestPendingAt, record.createdAt);
    assert.equal(queue.discardedCount, 0);
    assert.equal(settings.state, 'enabled-unreachable');
    assert.equal(typeof settings.revision, 'number');
    assert.equal(status.available, false);

    assert.equal(await service.discardWrite(record.id), true);
    assert.equal(await service.discardWrite(record.id), false, '重复丢弃不再生效');
    const after = await service.writeQueue();
    assert.equal(after.pendingCount, 0);
    assert.equal(after.discardedCount, 1);
    assert.equal(after.oldestPendingAt, undefined);
  });
});

test('后端不可达时检索返回降级结果并带错误码', async () => {
  await withHost({ hindsightUrl: UNREACHABLE, requestTimeoutMs: 1000 }, async ({ open }) => {
    const { service } = await open();
    const result = await service.search({ text: '蓝鲸的体长是多少' });
    assert.equal(result.degraded, true, '后端不可达时必须标记降级');
    assert.notEqual(result.degraded, false, '后端不可达时不得返回未降级的空结果');
    assert.deepEqual(result.hits, []);
    assert.equal(result.code, CHATDSH_ERROR_CODES.memoryBackendUnreachable);
    assert.ok(Number.isInteger(result.readAt) && result.readAt > 0);
    assert.equal((await service.status()).available, false);
  });
});

test('Hindsight 可达时隔离 bank 的召回返回写入内容', async (t) => {
  const probe = await probeHttpService({ name: 'hindsight', url: `${HINDSIGHT}/version` });
  if (probe.ready !== true) {
    const reason = probe.reachable === true ? `HTTP ${probe.status}` : '连接失败';
    t.skip(`Hindsight 不可达：GET ${HINDSIGHT}/version ${reason}`);
    return;
  }
  t.diagnostic(`Hindsight 可达：${HINDSIGHT}，使用隔离 bank 验证真实召回`);
  const bank = `ws:test-wp15-${randomBytes(8).toString('hex')}`;
  const marker = `wp15${randomBytes(6).toString('hex')}`;
  const content = `验收编号 ${marker}：蓝鲸的体长约为三十米。`;
  const client = createMemoryClient({ hindsightUrl: HINDSIGHT, maxTokens: 512, requestTimeoutMs: 60_000 });
  try {
    const written = await client.write(bank, { content, context: 'chatdsh-wp15-acceptance', async: false });
    assert.ok(written.items >= 1, '写入应当至少落一条');
    const hits = await recallUntilMarked(client, bank, marker);
    const matched = hits.filter((hit) => mentionsWrittenContent(hit.text, marker));
    assert.ok(matched.length > 0, `召回没有返回写入内容，实际返回 ${JSON.stringify(hits.map((hit) => hit.text))}`);
  } finally {
    await dropBank(bank);
  }
});

test('Hindsight 可达时检索视图返回命中且不降级', async (t) => {
  const probe = await probeHttpService({ name: 'hindsight', url: `${HINDSIGHT}/version` });
  if (probe.ready !== true) {
    const reason = probe.reachable === true ? `HTTP ${probe.status}` : '连接失败';
    t.skip(`Hindsight 不可达：GET ${HINDSIGHT}/version ${reason}`);
    return;
  }
  const bank = `ws:test-wp15-${randomBytes(8).toString('hex')}`;
  const marker = `wp15${randomBytes(6).toString('hex')}`;
  const content = `验收编号 ${marker}：蓝鲸的体长约为三十米。`;
  const client = createMemoryClient({ hindsightUrl: HINDSIGHT, requestTimeoutMs: 60_000, maxTokens: 512 });
  try {
    await withHost({ hindsightUrl: HINDSIGHT, requestTimeoutMs: 60_000, additionalBanks: [bank] }, async ({ open }) => {
      const { service } = await open();
      await client.write(bank, { content, context: 'chatdsh-wp15-acceptance', async: false });
      const hits = await recallUntilMarked(client, bank, marker);
      assert.ok(hits.some((hit) => mentionsWrittenContent(hit.text, marker)), '召回通道应当已经能看到写入内容');

      // 全量测试并发跑时 Hindsight 检索接口会出现一次慢响应；后端可达时重试，慢响应不当作降级通过。
      let result;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        result = await service.search({ banks: [bank], text: `验收编号 ${marker} 蓝鲸 体长`, limit: 10 });
        if (result.degraded !== true) break;
        await new Promise((settle) => setTimeout(settle, 2000));
      }
      assert.equal(result.degraded, false, `后端可达时检索不应降级：${JSON.stringify(result)}`);
      assert.ok(result.hits.length > 0, '检索应当返回命中');
      assert.ok(result.hits.some((hit) => mentionsWrittenContent(hit.text, marker)), `检索结果没有包含写入内容：${JSON.stringify(result.hits)}`);
      assert.ok(result.hits.every((hit) => hit.bank === bank), `命中要带 bank 标识：${JSON.stringify(result.hits)}`);
    });
  } finally {
    await dropBank(bank);
  }
});
