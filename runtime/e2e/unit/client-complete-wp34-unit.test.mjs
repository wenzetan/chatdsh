// WP34 单元验收：深链接、窗口登记、共用运行时、每窗口选择与草稿、分屏几何与比例记忆、
// 并发冲突判定与窗口动作遥测。
//
// 全部断言走真实实现：深链接与外壳的真实路由解析互认；窗口登记与共用运行时用真实的
// `BroadcastChannel` 在两个实例之间选举与转发；草稿与选择用内存存储（Node 没有
// `localStorage`），失败分支用真实的 `DOMException` 触发；冲突判定由两个真实登记表跨窗口
// 广播驱动；遥测载荷来自真实的中继编码。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseRoute } from '../../packages/client/shell/lib/client/route.js';
import {
  ConflictBoard,
  MIN_PANE_WIDTH,
  SEPARATOR_WIDTH,
  SharedRuntime,
  WindowRegistry,
  applySplitKey,
  clampRatio,
  clearWindowDraft,
  createWindowTelemetry,
  decideSplitLayout,
  deepLinkPath,
  deepLinkUrl,
  draftKeysOf,
  draftStorageKey,
  frameLine,
  parseDeepLink,
  ratioFromPointer,
  readSplitRatio,
  readWindowDraft,
  readWindowSelection,
  sameWindowTarget,
  writeScrollAnchor,
  writeSplitRatio,
  writeWindowDraft,
  writeWindowSelection,
} from '../../packages/client/multi-window/lib/index.js';

const RUNTIME = resolve(import.meta.dirname, '../..');
const PACKAGE = join(RUNTIME, 'packages/client/multi-window');

/** 编译客户端包；产物已存在时跳过。 */
function ensureBuild() {
  const artifact = join(PACKAGE, 'lib/index.js');
  if (existsSync(artifact)) return;
  execFileSync(join(RUNTIME, 'node_modules/.bin/tsc'), ['-b', PACKAGE], { cwd: RUNTIME, stdio: 'inherit' });
}
ensureBuild();

/** 等一段时间。 */
function settle(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 反复检查直到成立。
 * @param {() => boolean} check - 检查函数。
 * @param {number} [timeoutMs] - 超时毫秒数。
 * @param {string} [label] - 失败说明。
 */
async function waitFor(check, timeoutMs = 4000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await settle(10);
  }
  throw new Error(`等待超时：${label}`);
}

/** 内存存储：与浏览器 Storage 的语义一致。 */
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

/** 写入时抛真实 DOMException 的存储。 */
class FailingStorage extends MemoryStorage {
  constructor(errorName) {
    super();
    this.errorName = errorName;
  }

  setItem(key, value) {
    throw new DOMException('存储写入失败', this.errorName);
  }
}

/** 一个不受 Web Locks 影响的通道名。 */
function channelName(prefix) {
  return `${prefix}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

test('深链接保持会话、设备与右栏对象，并与外壳路由互认', () => {
  const target = { sessionId: 'session-1', deviceId: 'device-a', pane: { kind: 'artifact', id: 'art-9' } };
  const path = deepLinkPath(target);
  assert.equal(path, '/sessions/session-1?device=device-a#pane=artifact:art-9');
  const shellRoute = parseRoute(path);
  assert.deepEqual(shellRoute, { kind: 'sessions', sessionId: 'session-1', deviceId: 'device-a' });

  const url = deepLinkUrl(target, 'http://127.0.0.1:3080');
  assert.equal(url, 'http://127.0.0.1:3080/sessions/session-1?device=device-a#pane=artifact:art-9');
  const parsed = parseDeepLink(url, 'http://127.0.0.1:3080');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.target, target);
  assert.equal(sameWindowTarget(parsed.target, target), true);

  const withoutPane = deepLinkPath({ sessionId: 'session-2', deviceId: 'device-b' });
  assert.equal(withoutPane, '/sessions/session-2?device=device-b');
  assert.deepEqual(parseDeepLink(withoutPane).target, { sessionId: 'session-2', deviceId: 'device-b' });
  assert.equal(parseDeepLink(withoutPane, 'http://127.0.0.1:3080').ok, true);

  assert.deepEqual(parseDeepLink('/sessions/session-1'), { ok: false, reason: 'device' });
  assert.deepEqual(parseDeepLink('/sessions/session-1?device=device-a&tab=1'), { ok: false, reason: 'query' });
  assert.deepEqual(parseDeepLink('/sessions/session-1?device=device-a#pane=blob:1'), { ok: false, reason: 'fragment' });
  assert.deepEqual(parseDeepLink('/settings/general?device=device-a'), { ok: false, reason: 'path' });
  assert.deepEqual(parseDeepLink('http://evil.invalid/sessions/session-1?device=device-a', 'http://127.0.0.1:3080'), {
    ok: false,
    reason: 'origin',
  });
  assert.throws(() => deepLinkPath({ sessionId: '', deviceId: 'device-a' }), /会话标识/u);
});

test('两个真实窗口经广播通道互相登记、聚焦请求可达且登记过期会被清理', async () => {
  const name = channelName('wp34-registry');
  const channelA = new BroadcastChannel(name);
  const channelB = new BroadcastChannel(name);
  const clock = { now: 1000 };
  const targetA = { sessionId: 'session-a', deviceId: 'device-1' };
  const targetB = { sessionId: 'session-b', deviceId: 'device-2', pane: { kind: 'trace', id: 'turn-3' } };
  const registryA = new WindowRegistry({
    self: { windowId: 'window-a', clientId: 'client-1', target: targetA, title: '会话 A', openedAt: 10 },
    channel: channelA,
    now: () => clock.now,
    ttlMs: 500,
  });
  const registryB = new WindowRegistry({
    self: { windowId: 'window-b', clientId: 'client-1', target: targetB, title: '会话 B', openedAt: 20 },
    channel: channelB,
    now: () => clock.now,
    ttlMs: 500,
  });
  const focused = [];
  registryB.onFocusRequest((from) => focused.push(from));

  try {
    registryA.start();
    registryB.start();
    await waitFor(() => registryA.tabs().length === 2 && registryB.tabs().length === 2, 4000, '两个窗口互相登记');

    const tabsA = registryA.tabs();
    assert.deepEqual(tabsA.map((tab) => tab.windowId), ['window-a', 'window-b']);
    assert.equal(tabsA[0].current, true);
    assert.equal(tabsA[1].current, false);
    assert.equal(tabsA[1].title, '会话 B');
    assert.equal(tabsA[1].description, 'device-2 · session-b');
    assert.equal(registryA.windowCount, 2);

    // 第二窗口改选会话：第一窗口自己的选择不变，只更新标签上的标题。
    registryB.update({ sessionId: 'session-b2', deviceId: 'device-2' }, '会话 B2');
    await waitFor(() => registryA.tabs()[1].title === '会话 B2', 4000, '第一窗口读到第二窗口的改选');
    assert.deepEqual(registryA.presence.target, targetA, '第一窗口的当前会话没有被改选覆盖');

    assert.equal(registryA.requestFocus('window-b'), true);
    await waitFor(() => focused.includes('window-a'), 4000, '聚焦请求到达第二窗口');
    assert.equal(registryA.requestFocus('window-a'), false, '聚焦自己不等于跨窗口请求');

    // 登记过期：窗口直接关闭、来不及发 bye 时按最后见到的时间清理。
    clock.now += 400;
    assert.deepEqual(registryA.prune(), []);
    clock.now += 200;
    assert.deepEqual(registryA.prune(), ['window-b']);
    assert.equal(registryA.windowCount, 1);

    registryB.stop();
    await settle(60);
  } finally {
    registryA.stop();
    registryB.stop();
    channelA.close();
    channelB.close();
  }
});

test('共用运行时：两个窗口只保持一条订阅，持连窗口退出后由跟随窗口接管', async () => {
  const name = channelName('wp34-runtime');
  const channelA = new BroadcastChannel(name);
  const channelB = new BroadcastChannel(name);
  const createTransport = () => {
    const state = { opens: 0, concurrent: 0, peak: 0, handlers: undefined, closes: 0 };
    const transport = {
      open(handlers) {
        state.opens += 1;
        state.concurrent += 1;
        state.peak = Math.max(state.peak, state.concurrent);
        state.handlers = handlers;
        handlers.onStatus('open');
        return {
          close() {
            state.closes += 1;
            state.concurrent -= 1;
            state.handlers = undefined;
          },
        };
      },
    };
    return { state, transport };
  };
  const windowA = createTransport();
  const windowB = createTransport();
  const runtimeA = new SharedRuntime('window-a', { transport: windowA.transport, channel: channelA, locks: null, electionMs: 40 });
  const runtimeB = new SharedRuntime('window-b', { transport: windowB.transport, channel: channelB, locks: null, electionMs: 40 });
  const framesA = [];
  const framesB = [];
  const unsubscribeA = runtimeA.subscribe((frame) => framesA.push(frame));
  const unsubscribeB = runtimeB.subscribe((frame) => framesB.push(frame));

  try {
    runtimeA.start();
    runtimeB.start();
    await waitFor(() => runtimeA.role === 'leader' || runtimeB.role === 'leader', 5000, '选出持连窗口');
    await settle(200);
    assert.equal(windowA.state.opens + windowB.state.opens, 1, '两个窗口加起来只有一条订阅');
    assert.equal(windowA.state.peak <= 1 && windowB.state.peak <= 1, true, '任一窗口至多一条订阅');

    const leaderTransport = runtimeA.role === 'leader' ? windowA : windowB;
    const leader = runtimeA.role === 'leader' ? runtimeA : runtimeB;
    const follower = runtimeA.role === 'leader' ? runtimeB : runtimeA;
    assert.equal(leader.connectionCount, 1);
    assert.equal(follower.connectionCount, 0, '跟随窗口不建立订阅');

    leaderTransport.state.handlers.onFrame({ text: '第一帧' });
    await waitFor(() => framesA.length === 1 && framesB.length === 1, 4000, '两个窗口都收到同一帧');
    assert.deepEqual(framesA[0], { text: '第一帧' });
    assert.deepEqual(framesB[0], { text: '第一帧' });
    assert.equal(frameLine({ kind: 'replica', appended: 2 }), 'replica（2 条）');

    // 持连窗口关闭：跟随窗口接管，全程只有一条订阅。
    if (leader === runtimeA) {
      runtimeA.stop();
      await waitFor(() => runtimeB.role === 'leader', 6000, '跟随窗口接管');
    } else {
      runtimeB.stop();
      await waitFor(() => runtimeA.role === 'leader', 6000, '跟随窗口接管');
    }
    await settle(200);
    assert.equal(windowA.state.peak <= 1 && windowB.state.peak <= 1, true, '接管过程中没有并行订阅');
    const survivor = leader === runtimeA ? windowB : windowA;
    assert.equal(survivor.state.concurrent, 1, '接管之后仍是一条订阅');
    survivor.state.handlers.onFrame({ text: '接管后的帧' });
    await waitFor(() => framesA.some((frame) => frame.text === '接管后的帧') || framesB.some((frame) => frame.text === '接管后的帧'), 4000, '接管后帧仍然到达');
  } finally {
    unsubscribeA();
    unsubscribeB();
    runtimeA.stop();
    runtimeB.stop();
    channelA.close();
    channelB.close();
  }
});

test('每窗口选择与草稿互不覆盖，存储失败给出原因', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const targetA = { sessionId: 'session-1', deviceId: 'device-a' };
  const targetB = { sessionId: 'session-1', deviceId: 'device-a' };

  assert.equal(writeWindowDraft(local, { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a', sessionId: 'session-1' }, '窗口 A 的草稿', 100).outcome, 'saved');
  assert.equal(writeWindowDraft(local, { clientId: 'client-1', windowId: 'window-b', deviceId: 'device-a', sessionId: 'session-1' }, '窗口 B 的草稿', 200).outcome, 'saved');
  const keyA = draftStorageKey({ clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a', sessionId: 'session-1' });
  const keyB = draftStorageKey({ clientId: 'client-1', windowId: 'window-b', deviceId: 'device-a', sessionId: 'session-1' });
  assert.notEqual(keyA, keyB, '两个窗口的草稿键不同');
  assert.equal(readWindowDraft(local, { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a', sessionId: 'session-1' }).text, '窗口 A 的草稿');
  assert.equal(readWindowDraft(local, { clientId: 'client-1', windowId: 'window-b', deviceId: 'device-a', sessionId: 'session-1' }).text, '窗口 B 的草稿');
  assert.deepEqual(draftKeysOf(local, 'client-1', 'window-a').length, 1, '只列出本窗口的草稿键');
  assert.equal(writeWindowDraft(local, { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a', sessionId: 'session-1' }, '窗口 A 的第二稿', 300).revision, 2);
  clearWindowDraft(local, { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a', sessionId: 'session-1' });
  assert.equal(readWindowDraft(local, { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a', sessionId: 'session-1' }), undefined);
  assert.equal(readWindowDraft(local, { clientId: 'client-1', windowId: 'window-b', deviceId: 'device-a', sessionId: 'session-1' }).text, '窗口 B 的草稿', '清掉一个窗口的草稿不影响另一个窗口');

  const full = new FailingStorage('QuotaExceededError');
  const rejected = writeWindowDraft(full, { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a' }, '写不进去');
  assert.deepEqual(rejected, { outcome: 'rejected', reason: 'storage-full' });
  const privateMode = writeWindowDraft(new FailingStorage('SecurityError'), { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a' }, '隐私模式');
  assert.deepEqual(privateMode, { outcome: 'rejected', reason: 'privacy-mode' });
  assert.deepEqual(writeWindowDraft(undefined, { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a' }, '没有存储'), {
    outcome: 'rejected',
    reason: 'storage-unavailable',
  });

  // 选择按窗口保存：第二个窗口从深链接开始，不继承第一窗口的选择与滚动位置。
  assert.equal(writeWindowSelection(session, 'window-a', targetA, 480, 100), true);
  assert.deepEqual(readWindowSelection(session, 'window-a'), { target: targetA, scrollTop: 480, updatedAt: 100 });
  assert.equal(readWindowSelection(session, 'window-b'), undefined);
  assert.equal(writeScrollAnchor(session, 'window-a', 620, 200), true);
  assert.equal(readWindowSelection(session, 'window-a').scrollTop, 620);
  writeWindowSelection(session, 'window-b', targetB, 0, 300);
  assert.equal(readWindowSelection(session, 'window-a').scrollTop, 620, '第二窗口改选不影响第一窗口的滚动位置');
});

test('分屏几何：最小宽度、单栏切换、方向键与 Home/End、比例记忆', () => {
  const split = decideSplitLayout(1200, 0.5);
  assert.equal(split.mode, 'split');
  assert.equal(split.separator, SEPARATOR_WIDTH);
  assert.equal(split.primary + split.secondary, 1200 - SEPARATOR_WIDTH);
  assert.equal(split.primary, 596);

  assert.equal(decideSplitLayout(700, 0.5).mode, 'single', '窄屏切换单栏');
  assert.equal(decideSplitLayout(759, 0.5).mode, 'single', '低于 760px 时切换单栏');
  assert.equal(decideSplitLayout(760, 0.5).mode, 'split', '刚好到阈值并放得下两侧最小宽度');

  const min = clampRatio(0, 1200);
  assert.equal(min, MIN_PANE_WIDTH / (1200 - SEPARATOR_WIDTH));
  const max = clampRatio(1, 1200);
  assert.equal(max, 1 - min);

  const smaller = applySplitKey(0.5, 'ArrowLeft', { width: 1200 });
  assert.equal(smaller.action, 'smaller');
  assert.equal(smaller.ratio, 0.48);
  const larger = applySplitKey(0.5, 'ArrowRight', { width: 1200, shiftKey: true });
  assert.equal(larger.action, 'larger');
  assert.equal(larger.ratio, 0.6);
  assert.equal(applySplitKey(0.5, 'Home', { width: 1200 }).ratio, min);
  assert.equal(applySplitKey(0.5, 'End', { width: 1200 }).ratio, max);
  assert.deepEqual(applySplitKey(0.3, 'Enter', { width: 1200 }), { ratio: 0.5, action: 'reset' });
  assert.equal(applySplitKey(0.5, 'a', { width: 1200 }), undefined);
  assert.equal(applySplitKey(max, 'ArrowRight', { width: 1200 }).ratio, max, '方向键也在可用范围里');

  assert.equal(ratioFromPointer(0, 0, 1200), min, '拖到最左边收到最小宽度');
  assert.equal(ratioFromPointer(1200, 0, 1200), max, '拖到最右边放到最大宽度');

  const store = new MemoryStorage();
  const identity = { clientId: 'client-1', windowId: 'window-a', deviceId: 'device-a' };
  assert.equal(readSplitRatio(store, identity), 0.5, '没有记录时用默认比例');
  assert.equal(writeSplitRatio(store, identity, 0.62), true);
  assert.equal(readSplitRatio(store, identity), 0.62, '同一窗口同一设备恢复上次比例');
  assert.equal(readSplitRatio(store, { ...identity, windowId: 'window-b' }), 0.5, '另一个窗口的比例独立');
  store.setItem(`chatdsh-multi-window.split.v1:client-1:window-a:device-a`, 'not-a-number');
  assert.equal(readSplitRatio(store, identity), 0.5, '记录损坏时回到默认比例');
  writeSplitRatio(store, identity, 0.99);
  assert.equal(readSplitRatio(store, identity, 800), 1 - MIN_PANE_WIDTH / (800 - SEPARATOR_WIDTH), '读到之后按当前宽度夹取');
});

test('同一对象在两个窗口同时操作：版本冲突、操作去重与已处理结果', async () => {
  const name = channelName('wp34-conflicts');
  const channelA = new BroadcastChannel(name);
  const channelB = new BroadcastChannel(name);
  const boardA = new ConflictBoard({ windowId: 'window-a', channel: channelA });
  const boardB = new ConflictBoard({ windowId: 'window-b', channel: channelB });
  const objectKey = 'device-a:session-1';
  const writes = { a: 0, b: 0 };

  try {
    boardA.observeObject(objectKey, 7);
    boardB.observeObject(objectKey, 7);

    const first = boardA.begin({ operationId: 'op-1', objectKey, windowId: 'window-a', baseRevision: 7, action: 'approve' });
    assert.equal(first.accepted, true);
    writes.a += 1;
    boardA.settle('op-1', { outcome: 'applied', revision: 8 });
    await settle(80);

    const second = boardB.begin({ operationId: 'op-2', objectKey, windowId: 'window-b', baseRevision: 7, action: 'approve' });
    assert.equal(second.accepted, false, '基于过期版本的写入被拒绝');
    assert.equal(second.notice.kind, 'revision');
    assert.equal(second.notice.serverRevision, 8);
    assert.equal(second.notice.localRevision, 7);
    assert.match(second.notice.message, /服务端版本 8/u);
    assert.match(second.notice.message, /本窗口基于版本 7/u);
    assert.equal(second.notice.refreshLabel, '刷新读取最新内容');
    assert.equal(writes.b, 0, '冲突时没有发出写入');

    // 刷新入口：读到服务端最新版本之后允许重新提交，冲突提示撤掉。
    boardB.observeObject(objectKey, 8);
    boardB.dismiss(objectKey);
    assert.equal(boardB.noticeOf(objectKey), undefined);
    const afterRefresh = boardB.begin({ operationId: 'op-3', objectKey, windowId: 'window-b', baseRevision: 8, action: 'approve' });
    assert.equal(afterRefresh.accepted, true);
    writes.b += 1;
    boardB.settle('op-3', { outcome: 'applied', revision: 9 });
    assert.equal(writes.a + writes.b, 2);

    // 同一操作标识在两个窗口出现：只写入一次，第二个窗口读到去重结论。
    const shared = boardA.begin({ operationId: 'op-9', objectKey, windowId: 'window-a', baseRevision: 9, action: 'send' });
    assert.equal(shared.accepted, true);
    writes.a += 1;
    await settle(80);
    const duplicate = boardB.begin({ operationId: 'op-9', objectKey, windowId: 'window-b', baseRevision: 9, action: 'send' });
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.notice.kind, 'duplicate');
    assert.match(duplicate.notice.message, /按操作标识去重/u);
    assert.equal(writes.a + writes.b, 3, '去重之后没有再一次写入');

    // 服务端说已处理：两个窗口都显示已处理结果。
    const handled = boardA.begin({ operationId: 'op-10', objectKey, windowId: 'window-a', baseRevision: 9, action: 'approve' });
    assert.equal(handled.accepted, true);
    boardA.settle('op-10', { outcome: 'handled', revision: 10 });
    await waitFor(() => boardA.noticeOf(objectKey)?.kind === 'handled' && boardB.noticeOf(objectKey)?.kind === 'handled', 4000, '两个窗口都显示已处理');
    assert.match(boardB.noticeOf(objectKey).message, /已在另一个窗口处理/u);
  } finally {
    boardA.stop();
    boardB.stop();
    channelA.close();
    channelB.close();
  }
});

test('窗口动作遥测：导航与命令 span、失败事件与计数，载荷不含草稿与会话地址', async () => {
  const posts = [];
  const telemetry = createWindowTelemetry({
    fetchImpl: async (url, init) => {
      posts.push({ url, signal: init.headers['x-chatdsh-signal'], body: JSON.parse(init.body) });
      return new Response('', { status: 204 });
    },
    now: () => 1_700_000_000_000,
  });
  const target = { sessionId: 'session-1', deviceId: 'device-a', pane: { kind: 'document', id: 'doc-7' } };
  telemetry.navigation(target, 'ok', 1);
  telemetry.command('split.larger', 'ok');
  telemetry.action('window.open', 'ok');
  telemetry.failure('window.open', Object.assign(new Error('新窗口被浏览器拦截'), { code: 'window-blocked' }));
  await settle(20);

    const signals = posts.map((post) => post.signal);
  assert.deepEqual(signals.sort(), ['logs', 'logs', 'logs', 'metrics', 'metrics', 'metrics', 'traces', 'traces']);
  const spanNames = posts
    .filter((post) => post.signal === 'traces')
    .flatMap((post) => post.body.resourceSpans[0].scopeSpans[0].spans.map((span) => span.name));
  assert.deepEqual(spanNames.sort(), ['chatdsh.client.command.run', 'chatdsh.client.navigate']);
  const eventNames = posts
    .filter((post) => post.signal === 'logs')
    .flatMap((post) => post.body.resourceLogs[0].scopeLogs[0].logRecords.map((record) => record.body.stringValue));
  assert.deepEqual(eventNames.sort(), ['chatdsh.client.error', 'chatdsh.client.ui.action', 'chatdsh.client.ui.action']);
  const metricNames = posts
    .filter((post) => post.signal === 'metrics')
    .flatMap((post) => post.body.resourceMetrics[0].scopeMetrics[0].metrics.map((metric) => metric.name));
  assert.deepEqual(metricNames.sort(), [
    'chatdsh_client_command_runs_total',
    'chatdsh_client_errors_total',
    'chatdsh_client_navigations_total',
  ]);

  const encoded = JSON.stringify(posts);
  assert.equal(encoded.includes('属性正文'), false);
  assert.equal(encoded.includes('?device='), false, '遥测里不出现地址与查询串');
  assert.equal(encoded.includes('新窗口被浏览器拦截'), false, '遥测里不出现错误正文');
  const navigationSpan = posts
    .filter((post) => post.signal === 'traces')
    .flatMap((post) => post.body.resourceSpans[0].scopeSpans[0].spans)
    .find((span) => span.name === 'chatdsh.client.navigate');
  const keys = navigationSpan.attributes.map((item) => item.key);
  assert.deepEqual(keys.sort(), ['attempt', 'deviceId', 'outcome', 'session.id']);
  assert.equal(navigationSpan.attributes.find((item) => item.key === 'deviceId').value.stringValue, 'device-a');
});

test('桌面窗口登记：路由形状、级联摆放、最后窗口策略与恢复计划', async () => {
  const {
    WindowRegistry,
    cascadedBounds,
    createWindowDescriptor,
    decideWindowClose,
    planRestore,
    parseWindowSession,
    serializeWindowSession,
    windowAllClosedAction,
    windowTitleOf,
  } = await import('../../desktop/electron/windows/index.mjs');

  assert.throws(() => createWindowDescriptor({ id: 'w1', kind: 'secondary', route: 'https://evil.invalid/' }), /窗口路由不合法/u);
  assert.throws(() => createWindowDescriptor({ id: 'w1', kind: 'secondary', route: '/sessions/s-1' }), /窗口路由不合法：/u);

  const registry = new WindowRegistry({ now: () => 1000 });
  const main = createWindowDescriptor({ id: 'main', kind: 'main', route: '/sessions/session-1?device=device-a', openedAt: 10 });
  registry.add(main);
  const secondary = createWindowDescriptor({
    id: 'secondary-1',
    kind: 'secondary',
    route: '/sessions/session-1?device=device-a#pane=artifact:art-9',
    openedAt: 20,
  });
  registry.add(secondary);
  assert.equal(windowTitleOf(secondary), 'ChatDSH 第二窗口 · session-1');
  assert.equal(registry.tabs().length, 2);
  assert.equal(registry.canOpenMore(), true);
  assert.deepEqual(parseWindowSession(serializeWindowSession(registry.snapshot())).windows.length, 2);

  const placed = cascadedBounds({ x: 100, y: 100, width: 1200, height: 800 }, 0, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(placed.x, 128);
  assert.equal(placed.y, 128);
  assert.equal(placed.adjustment, 'none');
  const reversed = cascadedBounds({ x: 900, y: 400, width: 1000, height: 700 }, 0, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(reversed.adjustment, 'reversed', '右下放不下时向左上偏移');
  const resized = cascadedBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 0, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(resized.adjustment, 'resized', '主窗口铺满显示器时第二窗口按可用区域的八成摆放');
  assert.equal(resized.width, 1536);
  assert.equal(resized.x, 28);

  assert.deepEqual(decideWindowClose({ windowCount: 2, trayEnabled: false }), { action: 'close', reason: 'other-windows', keepsRuntime: true });
  assert.deepEqual(decideWindowClose({ windowCount: 1, trayEnabled: true }), { action: 'hide', reason: 'tray', keepsRuntime: true });
  const confirmRunning = decideWindowClose({ windowCount: 1, trayEnabled: false, runningTurns: 2 });
  assert.equal(confirmRunning.action, 'confirm-quit');
  assert.equal(confirmRunning.reason, 'running-turns');
  assert.match(confirmRunning.prompt.message, /还有 2 个回合正在执行/u);
  const confirmDraft = decideWindowClose({ windowCount: 1, trayEnabled: false, unsavedDrafts: 1 });
  assert.equal(confirmDraft.reason, 'unsaved-drafts');
  assert.match(confirmDraft.prompt.message, /未发送草稿/u);
  assert.deepEqual(decideWindowClose({ windowCount: 1, trayEnabled: false }), { action: 'close', reason: 'last-window', keepsRuntime: false });
  assert.equal(windowAllClosedAction({ trayEnabled: true }), 'keep-running');
  assert.equal(windowAllClosedAction({ trayEnabled: false }), 'quit');
  assert.equal(windowAllClosedAction({ trayEnabled: true, quitting: true }), 'quit');

  const plan = planRestore({ snapshot: registry.snapshot(), workAreas: [{ x: 0, y: 0, width: 1920, height: 1080 }] });
  assert.equal(plan.windows.length, 2);
  assert.equal(plan.windows[0].descriptor.kind, 'main');
  assert.equal(plan.windows[1].adjustment, 'resized');
  assert.deepEqual(plan.skipped, []);
});

test('桌面窗口 IPC：通道参数校验、未知窗口拒绝与数量上限', async () => {
  const { WindowRegistry, createWindowHandlers, mergeWindowChannels, validateWindowArguments, WINDOW_CALL_CHANNELS } = await import(
    '../../desktop/electron/windows/index.mjs'
  );
  const { CALL_CHANNELS, IpcRejection } = await import('../../desktop/electron/ipc.mjs');

  const merged = mergeWindowChannels(CALL_CHANNELS);
  assert.equal(merged.length, CALL_CHANNELS.length + WINDOW_CALL_CHANNELS.length);
  assert.throws(() => mergeWindowChannels(merged), /重名/u);

  const registry = new WindowRegistry({ now: () => 1 });
  registry.add({ id: 'main', kind: 'main', route: '/sessions/session-1?device=device-a', sessionId: 'session-1', deviceId: 'device-a', openedAt: 1 });
  const opened = [];
  const focused = [];
  const closed = [];
  const handlers = createWindowHandlers({
    registry,
    openWindow: (descriptor) => {
      opened.push(descriptor);
      return descriptor.id;
    },
    focusWindow: (windowId) => focused.push(windowId),
    closeWindow: (windowId) => closed.push(windowId),
    restoreWindows: () => [{ id: 'main', route: '/sessions/session-1?device=device-a' }],
    now: () => 1000,
  });

  assert.throws(() => validateWindowArguments('chatdsh:window:open', [{ route: 'https://evil.invalid/' }]), IpcRejection);
  assert.throws(() => validateWindowArguments('chatdsh:window:open', [{ route: '/sessions/session-1?device=device-a' }, { extra: 1 }]), IpcRejection);
  const payload = validateWindowArguments('chatdsh:window:open', [{ route: '/sessions/session-2?device=device-b#pane=trace:turn-1' }]);
  const result = await handlers['chatdsh:window:open'](payload);
  assert.equal(result.route, '/sessions/session-2?device=device-b#pane=trace:turn-1');
  assert.equal(opened.length, 1);
  assert.equal(registry.count, 2);

  await handlers['chatdsh:window:focus']({ windowId: registry.tabs()[1].id });
  assert.equal(focused.length, 1);
  await assert.rejects(async () => handlers['chatdsh:window:focus']({ windowId: 'missing' }), /窗口不存在/u);
  await handlers['chatdsh:window:dismiss']({ windowId: registry.tabs()[1].id });
  assert.equal(closed.length, 1);

  for (let index = registry.count; index < 6; index += 1) {
    await handlers['chatdsh:window:open']({ route: `/sessions/session-${String(index)}?device=device-a` });
  }
  assert.equal(registry.count, 6);
  await assert.rejects(
    async () => handlers['chatdsh:window:open']({ route: '/sessions/session-x?device=device-a' }),
    /窗口数量上限/u
  );

  const restored = await handlers['chatdsh:window:restore']();
  assert.equal(restored.windows.length, 1);
});
