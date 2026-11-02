// WP05 历史导航与分页的验收测试。
//
// 会话摘要由真实网关模块产生：真实 SQLite 存储、真实副本表、真实读回执与真实分页查询
// `createClientSessionQuery`。分组、同名工作区区分、未读合计、筛选持久化与分页累积使用
// 外壳的真实实现；浏览器存储用内存实现（Node 没有 `localStorage`），其余代码没有替身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore, ReceiptStore, ReplicaStore } from '../../gateway/lib/store.js';
import { createClientSessionQuery } from '../../gateway/lib/sessions.js';
import { isSessionItem, groupByDevice, groupByWorkspace, deviceLabels, findSession, isWritable } from '../../packages/client/shell/lib/client/sessions.js';
import { ReadGeneration, SessionPages } from '../../packages/client/shell/lib/client/pages.js';
import {
  DEFAULT_FILTERS,
  normalizeFilters,
  readFilters,
  writeFilters,
  filtersStorageKey,
} from '../../packages/client/shell/lib/client/filters.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 内存存储：真实 Storage 语义，用于替代浏览器存储。 */
class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }
}

/** 建立独立数据根与真实存储，写入三台设备、四条会话与真实副本事件。 */
async function withGateway(prefix, run) {
  const home = allocateIndependentHome(prefix);
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const receipts = new ReceiptStore(store.handle());
  try {
    store.registerNode({ id: 'device-a', name: '同甲设备', platform: 'linux', role: 'both', capabilities: [], tokenHash: hash('a') });
    store.registerNode({ id: 'device-b', name: '同甲设备', platform: 'linux', role: 'both', capabilities: [], tokenHash: hash('b') });
    store.registerNode({ id: 'device-c', name: '乙设备', platform: 'linux', role: 'both', capabilities: [], tokenHash: hash('c') });
    store.registerMobileDevice({ id: 'client-1', name: '验收客户端', platform: 'linux', tokenHash: hash('client') });

    const sessions = [
      { sessionId: 'one', deviceId: 'device-a', cwd: '/work/project/alpha', title: '甲上的 alpha', assistant: 2 },
      { sessionId: 'two', deviceId: 'device-b', cwd: '/work/project/alpha', title: '乙上的 alpha', assistant: 1 },
      { sessionId: 'three', deviceId: 'device-c', cwd: '/work/other/alpha', title: '乙设备上的另一个 alpha', assistant: 3 },
      { sessionId: 'four', deviceId: 'device-c', cwd: '/work/other/beta', title: '乙设备上的 beta', assistant: 0 },
    ];
    let time = 1000;
    for (const entry of sessions) {
      store.upsertSession({ sessionId: entry.sessionId, deviceId: entry.deviceId, cwd: entry.cwd, kind: 'work', createdAt: time });
      const events = [{ seq: 0, kind: 'session/title', time, bytes: 8, payload: { data: { title: entry.title } } }];
      for (let index = 0; index < entry.assistant; index += 1) {
        events.push({ seq: index + 1, kind: 'assistant/message', time: time + index, bytes: 8, payload: { data: { text: `回答${String(index)}` } } });
      }
      replica.append(entry.sessionId, events);
      time += 100;
    }
    // client-1 在会话 one 上只读到第 1 条事件，因此第 2 条助手消息算未读。
    receipts.mark({ sessionId: 'one', deviceId: 'client-1', readUpToSeq: 1 });
    const online = new Set(['device-a']);
    const query = createClientSessionQuery(store.handle(), (deviceId) => online.has(deviceId));
    await run({ store, query, home });
  } finally {
    store.close();
    releaseIndependentHome(home);
  }
}

test('真实会话摘要：标题、未读、归属设备与在线状态', async () => {
  await withGateway('wp05-sessions', async ({ query }) => {
    const { items } = query({ clientId: 'client-1', deviceIds: 'all', query: '', limit: 50 });
    assert.equal(items.length, 4);
    for (const item of items) {
      assert.equal(isSessionItem(item), true, `形状不合法：${JSON.stringify(item)}`);
      // 界面上不得出现副本水位等内部字段。
      for (const key of Object.keys(item)) {
        assert.ok(
          ['sessionId', 'deviceId', 'deviceName', 'cwd', 'workspaceName', 'kind', 'title', 'updatedAt', 'unreadMessages', 'online'].includes(key),
          `对外形状出现未登记字段：${key}`
        );
      }
    }
    const one = items.find((item) => item.sessionId === 'one');
    assert.equal(one.title, '甲上的 alpha');
    assert.equal(one.unreadMessages, 1, '只算读回执之后的助手消息');
    assert.equal(one.deviceName, '同甲设备');
    assert.equal(one.online, true);
    assert.equal(one.workspaceName, 'alpha');
    const two = items.find((item) => item.sessionId === 'two');
    assert.equal(two.unreadMessages, 1);
    assert.equal(two.online, false);
    const three = items.find((item) => item.sessionId === 'three');
    assert.equal(three.unreadMessages, 3, '没有读回执时全部助手消息算未读');
    const four = items.find((item) => item.sessionId === 'four');
    assert.equal(four.unreadMessages, 0);
    assert.equal(four.title, '乙设备上的 beta');
  });
});

test('检索与设备范围：过滤在真实查询上执行，结果进入同一套分组', async () => {
  await withGateway('wp05-sessions-query', async ({ query }) => {
    const searched = query({ clientId: 'client-1', deviceIds: 'all', query: 'beta', limit: 50 }).items;
    assert.equal(searched.length, 1);
    assert.equal(searched[0].sessionId, 'four');
    const perDevice = query({ clientId: 'client-1', deviceIds: 'all', query: '', deviceId: 'device-c', limit: 50 }).items;
    assert.deepEqual(perDevice.map((item) => item.sessionId).sort(), ['four', 'three']);
    assert.deepEqual(groupByDevice(perDevice).map((group) => group.deviceId), ['device-c']);
  });
});

test('同名工作区：跨设备合并，同时标出不同目录与同名设备', async () => {
  await withGateway('wp05-groups', async ({ query }) => {
    const items = query({ clientId: 'client-1', deviceIds: 'all', query: '', limit: 50 }).items;
    const groups = groupByWorkspace(items);
    const alpha = groups.find((group) => group.workspaceName === 'alpha');
    assert.ok(alpha !== undefined);
    assert.equal(alpha.sessionCount, 3);
    assert.equal(alpha.unread, 5, '未读按工作区合计');
    assert.equal(alpha.ambiguous, true, '三个目录共用同一个显示名');
    assert.deepEqual(alpha.cwds, ['/work/other/alpha', '/work/project/alpha']);
    assert.equal(alpha.entries.length, 3, '每个「设备 + 目录」一条');
    assert.deepEqual(
      alpha.entries.map((entry) => `${entry.deviceId}\u0000${entry.cwd}`).sort(),
      ['device-a\u0000/work/project/alpha', 'device-b\u0000/work/project/alpha', 'device-c\u0000/work/other/alpha']
    );
    // 两台设备取同一个显示名时，条目上补设备标识前八位。
    const labels = deviceLabels(items);
    assert.equal(labels.get('device-a'), '同甲设备（device-a）');
    assert.equal(labels.get('device-b'), '同甲设备（device-b）');
    assert.equal(labels.get('device-c'), '乙设备');
    // 条目内会话按最近活动倒序。
    const entry = alpha.entries.find((item) => item.deviceId === 'device-a');
    assert.equal(entry.sessions.length, 1);
    assert.equal(entry.sessions[0].sessionId, 'one');
  });
});

test('按设备分组：未读合计、在线状态与会话排序', async () => {
  await withGateway('wp05-groups-device', async ({ query }) => {
    const items = query({ clientId: 'client-1', deviceIds: 'all', query: '', limit: 50 }).items;
    const groups = groupByDevice(items);
    assert.equal(groups.length, 3);
    const deviceC = groups.find((group) => group.deviceId === 'device-c');
    assert.equal(deviceC.sessionCount, 2);
    assert.equal(deviceC.unread, 3);
    assert.equal(deviceC.online, false);
    assert.deepEqual(deviceC.entries.map((entry) => entry.cwd), ['/work/other/alpha', '/work/other/beta']);
    const deviceA = groups.find((group) => group.deviceId === 'device-a');
    assert.equal(deviceA.online, true);
    assert.equal(isWritable(items.find((item) => item.sessionId === 'one')), true);
    assert.equal(isWritable(items.find((item) => item.sessionId === 'two')), false);
  });
});

test('分页累积：游标翻页、按设备与会话去重、过期读取被丢弃', async () => {
  await withGateway('wp05-pages', async ({ query }) => {
    const first = query({ clientId: 'client-1', deviceIds: 'all', query: '', limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    const last = first.items.at(-1);
    const second = query({ clientId: 'client-1', deviceIds: 'all', query: '', limit: 2, after: [last.updatedAt, last.sessionId] });
    assert.equal(second.hasMore, false);
    assert.equal(second.items.length, 2);
    const pages = new SessionPages();
    // 私有读取入口把查询结果再包一层分页信息；外壳按这一层的形状累积。
    pages.reset({ items: first.items, page: { hasMore: first.hasMore, nextCursor: 'cursor-next' } });
    assert.equal(pages.hasMore, true);
    assert.equal(pages.nextCursor, 'cursor-next');
    assert.equal(pages.append({ items: second.items, page: { hasMore: second.hasMore } }), 2);
    assert.equal(pages.items.length, 4);
    assert.equal(pages.hasMore, false);
    assert.equal(pages.nextCursor, undefined);
    // 重复的一页不再增加条目。
    const before = pages.items.length;
    assert.equal(pages.append({ items: second.items, page: { hasMore: false } }), 0);
    assert.equal(pages.items.length, before);

    const generation = new ReadGeneration();
    const firstTicket = generation.next();
    const secondTicket = generation.next();
    assert.equal(generation.isCurrent(firstTicket), false, '旧代次的响应不得写入新页面');
    assert.equal(generation.isCurrent(secondTicket), true);
  });
});

test('筛选：默认值、坏取值收敛、按客户端持久化与读回', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readFilters(storage, 'client-1'), DEFAULT_FILTERS);
  assert.deepEqual(normalizeFilters(undefined), DEFAULT_FILTERS);
  assert.deepEqual(normalizeFilters({ query: '  alpha  ', deviceId: 'd1', grouping: 'device' }), {
    query: 'alpha',
    deviceId: 'd1',
    grouping: 'device',
  });
  assert.deepEqual(normalizeFilters({ query: 42, deviceId: '', grouping: 'time' }), {
    query: '',
    deviceId: 'all',
    grouping: 'workspace',
  });
  const filters = { query: 'alpha', deviceId: 'device-c', grouping: 'device' };
  writeFilters(storage, 'client-1', filters);
  assert.deepEqual(readFilters(storage, 'client-1'), filters);
  assert.equal(storage.getItem(filtersStorageKey('client-1')).includes('alpha'), true);
  // 另一次会话（刷新后）读到同一份筛选；另一台客户端互不影响。
  assert.deepEqual(readFilters(storage, 'client-2'), DEFAULT_FILTERS);
  // 坏内容按默认值处理，不抛错。
  storage.setItem(filtersStorageKey('client-1'), '{not json');
  assert.deepEqual(readFilters(storage, 'client-1'), DEFAULT_FILTERS);
  // 存储不可用时不抛错。
  assert.deepEqual(readFilters(undefined, 'client-1'), DEFAULT_FILTERS);
  assert.doesNotThrow(() => writeFilters(undefined, 'client-1', filters));
});

test('列表查找：设备与选中的会话标识共同确定对象', async () => {
  await withGateway('wp05-find', async ({ query }) => {
    const items = query({ clientId: 'client-1', deviceIds: 'all', query: '', limit: 50 }).items;
    assert.equal(findSession(items, 'one')?.deviceId, 'device-a');
    assert.equal(findSession(items, 'one', 'device-a')?.sessionId, 'one');
    assert.equal(findSession(items, 'one', 'device-b'), undefined, '同一标识在别的设备上不算同一个对象');
    assert.equal(findSession(items, 'missing'), undefined);
  });
});
