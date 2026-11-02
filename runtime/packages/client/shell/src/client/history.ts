/**
 * 历史导航：把路由对象接到浏览器历史。
 *
 * 只依赖一个窄接口（`pushState`、`replaceState`、`location` 与 `popstate` 订阅），浏览器里
 * 用真实 `window`，测试里可以用真实事件派发的内存宿主。前进与后退由浏览器改地址，本模块在
 * `popstate` 上重新解析路径并通知订阅者，界面因此恢复同一个对象。
 * @module @chatdsh/client-shell/history
 */

import { parseRoute, routePath, sameRoute, type Route } from './route.ts';

/** 历史与地址的窄接口。 */
export interface HistoryTarget {
  readonly history: {
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
  };
  readonly location: { readonly pathname: string; readonly search: string };
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

/** 路由变化的原因。 */
export type RouteChangeReason = 'start' | 'push' | 'replace' | 'pop';

/** 路由变化的订阅函数。 */
export type RouteListener = (route: Route, reason: RouteChangeReason) => void;

/** 历史导航。 */
export class RouteNavigator {
  private readonly target: HistoryTarget;
  private readonly listener: RouteListener;
  private readonly onPopState = (): void => {
    this.listener(this.read(), 'pop');
  };

  /**
   * 建立导航。
   * @param target - 历史与地址。
   * @param listener - 路由变化订阅函数。
   */
  constructor(target: HistoryTarget, listener: RouteListener) {
    this.target = target;
    this.listener = listener;
  }

  /**
   * 读当前地址对应的路由。
   * @returns 路由对象。
   */
  read(): Route {
    return parseRoute(`${this.target.location.pathname}${this.target.location.search}`);
  }

  /**
   * 开始监听，并把当前地址交给订阅者一次。
   *
   * 深链接在这里恢复：地址里的会话、设置区段、分享与诊断都解析成同一个路由对象。
   */
  start(): void {
    this.target.addEventListener('popstate', this.onPopState);
    this.listener(this.read(), 'start');
  }

  /** 停止监听。 */
  stop(): void {
    this.target.removeEventListener('popstate', this.onPopState);
  }

  /**
   * 压入一个新路由。
   *
   * 与当前路由指向同一对象时不产生重复历史项，也不触发订阅，避免重复点击堆出一串相同的
   * 历史条目。
   * @param route - 目标路由。
   */
  push(route: Route): void {
    if (sameRoute(route, this.read())) return;
    const path = routePath(route);
    this.target.history.pushState({ route: path }, '', path);
    this.listener(route, 'push');
  }

  /**
   * 替换当前路由。
   * @param route - 目标路由。
   */
  replace(route: Route): void {
    const path = routePath(route);
    this.target.history.replaceState({ route: path }, '', path);
    this.listener(route, 'replace');
  }
}
