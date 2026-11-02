// WP05 逻辑路由与历史导航的验收测试。
//
// 路由解析、生成与往返使用真实实现；历史导航用真实事件派发的内存宿主驱动（Node 没有
// `window.history`，宿主替身只提供浏览器已在实现的四个成员，`popstate` 走真实 EventTarget），
// 浏览器里的真实前进后退由同编号的 Chrome 用例覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  continueRoute,
  parseRoute,
  routePath,
  sameRoute,
  sessionRoute,
  SETTINGS_SECTIONS,
} from '../../packages/client/shell/lib/client/route.js';
import { RouteNavigator } from '../../packages/client/shell/lib/client/history.js';

/** 内存里的历史宿主：真实的 EventTarget 加四个浏览器成员。 */
class HistoryHost extends EventTarget {
  constructor(path = '/') {
    super();
    const self = this;
    this.pathname = path;
    this.search = '';
    this.entries = [path];
    this.position = 0;
    this.history = {
      pushState: (_data, _unused, url) => {
        this.entries = this.entries.slice(0, this.position + 1);
        this.entries.push(url);
        this.position = this.entries.length - 1;
        this.apply(url);
      },
      replaceState: (_data, _unused, url) => {
        this.entries[this.position] = url;
        this.apply(url);
      },
    };
    this.location = {
      get pathname() {
        return self.pathname;
      },
      get search() {
        return self.search;
      },
    };
  }

  apply(url) {
    const question = url.indexOf('?');
    this.pathname = question === -1 ? url : url.slice(0, question);
    this.search = question === -1 ? '' : url.slice(question);
  }

  /** 模拟浏览器后退：地址回到前一项并派发真实的 popstate 事件。 */
  back() {
    if (this.position === 0) return;
    this.position -= 1;
    this.apply(this.entries[this.position]);
    this.dispatchEvent(new Event('popstate'));
  }

  /** 模拟浏览器前进。 */
  forward() {
    if (this.position >= this.entries.length - 1) return;
    this.position += 1;
    this.apply(this.entries[this.position]);
    this.dispatchEvent(new Event('popstate'));
  }
}

test('路径解析：会话、创建、继续、设置、分享、诊断与非法路径', () => {
  assert.deepEqual(parseRoute('/'), { kind: 'sessions' });
  assert.deepEqual(parseRoute('/sessions/abc'), { kind: 'sessions', sessionId: 'abc' });
  assert.deepEqual(parseRoute('/sessions/abc?device=d1'), { kind: 'sessions', sessionId: 'abc', deviceId: 'd1' });
  assert.deepEqual(parseRoute('/sessions/new'), { kind: 'new-session' });
  assert.deepEqual(parseRoute('/sessions/abc/continue?device=d1'), {
    kind: 'continue',
    sessionId: 'abc',
    deviceId: 'd1',
  });
  assert.deepEqual(parseRoute('/settings/general'), { kind: 'settings', section: 'general' });
  assert.deepEqual(parseRoute('/s/xyz'), { kind: 'share', token: 'xyz' });
  assert.deepEqual(parseRoute('/diagnostics'), { kind: 'diagnostics' });
  assert.deepEqual(parseRoute('/no-such-page'), { kind: 'invalid', path: '/no-such-page' });
  // 每个设置区段都能解析回同一个区段标识。
  for (const section of SETTINGS_SECTIONS) {
    assert.deepEqual(parseRoute(`/settings/${section}`), { kind: 'settings', section });
  }
});

test('路径解析：结尾斜杠、编码标识与越界查询串', () => {
  assert.deepEqual(parseRoute('/sessions/abc/?device=d1'), { kind: 'sessions', sessionId: 'abc', deviceId: 'd1' });
  assert.deepEqual(parseRoute('/settings/devices/'), { kind: 'settings', section: 'devices' });
  assert.deepEqual(parseRoute('/sessions/a%2Fb?device=d%201'), {
    kind: 'sessions',
    sessionId: 'a/b',
    deviceId: 'd 1',
  });
  assert.equal(parseRoute('/sessions/abc?device=d1&device=d2').kind, 'invalid');
  assert.equal(parseRoute('/sessions/abc?other=1').kind, 'invalid');
  assert.equal(parseRoute('/sessions/abc?device=').kind, 'invalid');
  assert.equal(parseRoute('/settings/general?device=d1').kind, 'invalid');
  assert.equal(parseRoute('/settings/unknown').kind, 'invalid');
  assert.equal(parseRoute('/sessions/new/too/deep').kind, 'invalid');
  assert.equal(parseRoute('/sessions/abc/other').kind, 'invalid');
  assert.equal(parseRoute('https://other.example/sessions/abc').kind, 'invalid');
  assert.equal(parseRoute('/sessions/%E0%A4%A').kind, 'invalid');
});

test('路径生成与往返：同一个对象还原成同一个路由', () => {
  const routes = [
    { kind: 'sessions' },
    { kind: 'sessions', deviceId: 'd1' },
    { kind: 'sessions', sessionId: 'abc' },
    { kind: 'sessions', sessionId: 'a/b', deviceId: 'd 1' },
    { kind: 'new-session' },
    { kind: 'continue', sessionId: 'abc' },
    { kind: 'continue', sessionId: 'abc', deviceId: 'd1' },
    { kind: 'settings', section: 'memory' },
    { kind: 'share', token: 'tok/en' },
    { kind: 'diagnostics' },
  ];
  for (const route of routes) {
    const path = routePath(route);
    assert.deepEqual(parseRoute(path), route, `${path} 没有还原成同一个路由`);
    assert.equal(routePath(parseRoute(path)), path);
    assert.equal(sameRoute(route, parseRoute(path)), true);
  }
  assert.equal(routePath({ kind: 'invalid', path: '/nope' }), '/nope');
  assert.equal(sameRoute(sessionRoute('a'), sessionRoute('b')), false);
  assert.equal(sameRoute(continueRoute('a', 'd1'), continueRoute('a', 'd2')), false);
});

test('历史导航：压入、替换、后退与前进都还原同一个对象', () => {
  const host = new HistoryHost('/');
  const changes = [];
  const navigator = new RouteNavigator(host, (route, reason) => changes.push({ route, reason }));
  navigator.start();
  assert.deepEqual(changes, [{ route: { kind: 'sessions' }, reason: 'start' }]);

  navigator.push(sessionRoute('abc', 'd1'));
  assert.deepEqual(changes.at(-1), {
    route: { kind: 'sessions', sessionId: 'abc', deviceId: 'd1' },
    reason: 'push',
  });
  assert.equal(host.location.pathname, '/sessions/abc');
  assert.equal(host.location.search, '?device=d1');

  // 重复压入同一个对象不产生新的历史项。
  const before = changes.length;
  navigator.push(sessionRoute('abc', 'd1'));
  assert.equal(changes.length, before);
  assert.equal(host.entries.length, 2);

  navigator.push({ kind: 'settings', section: 'devices' });
  assert.equal(host.location.pathname, '/settings/devices');

  host.back();
  assert.deepEqual(changes.at(-1), {
    route: { kind: 'sessions', sessionId: 'abc', deviceId: 'd1' },
    reason: 'pop',
  });
  host.back();
  assert.deepEqual(changes.at(-1), { route: { kind: 'sessions' }, reason: 'pop' });
  host.forward();
  assert.deepEqual(changes.at(-1), {
    route: { kind: 'sessions', sessionId: 'abc', deviceId: 'd1' },
    reason: 'pop',
  });

  navigator.replace({ kind: 'diagnostics' });
  assert.deepEqual(changes.at(-1), { route: { kind: 'diagnostics' }, reason: 'replace' });
  assert.equal(host.location.pathname, '/diagnostics');

  navigator.stop();
  const stopped = changes.length;
  host.back();
  assert.equal(changes.length, stopped, '停止监听后不再收到 popstate');
});

test('历史导航：深链接直接还原成与浏览器地址相同的对象', () => {
  const host = new HistoryHost('/sessions/deep-1?device=dev-9');
  const seen = [];
  const navigator = new RouteNavigator(host, (route) => seen.push(route));
  navigator.start();
  assert.deepEqual(seen, [{ kind: 'sessions', sessionId: 'deep-1', deviceId: 'dev-9' }]);
  assert.equal(routePath(navigator.read()), '/sessions/deep-1?device=dev-9');
});
