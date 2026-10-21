/**
 * 基于 AsyncLocalStorage 的 OpenTelemetry 上下文管理器。
 *
 * `@opentelemetry/api` 默认使用空上下文管理器，`context.with` 不会保存当前 span。
 * 客户端启用时必须注册一个真实管理器，才能让 `startSpan`、`runSpan`、`inject`、
 * `withContext` 共用同一条链路。宿主环境已经注册管理器时保留宿主选择。
 * @module @chatdsh/core-diagnostics/context-manager
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ROOT_CONTEXT,
  context,
  type Context,
  type ContextManager,
} from '@opentelemetry/api';

/** 用 AsyncLocalStorage 保存当前 Context。 */
class AsyncLocalStorageContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(activeContext, () => fn.apply(thisArg, args)) as ReturnType<F>;
  }

  bind<T>(activeContext: Context, target: T): T {
    if (typeof target !== 'function') return target;
    const manager = this;
    return function bound(this: unknown, ...args: unknown[]): unknown {
      return manager.with(activeContext, target as (...inner: unknown[]) => unknown, this, ...args);
    } as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}

let manager: AsyncLocalStorageContextManager | undefined;

/**
 * 确保进程内注册了可用的上下文管理器。
 *
 * 只注册一次；`context.setGlobalContextManager` 返回 false 时说明宿主已经注册了管理器，
 * 本次保留宿主实现，不覆盖已有上下文传播。
 */
export function ensureContextManager(): void {
  if (manager !== undefined) return;
  manager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(manager);
}
