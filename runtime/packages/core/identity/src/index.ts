/**
 * 身份服务：把控制平面注入的请求头部解析成运行时内的身份。
 *
 * 运行时只绑回环，身份由控制平面在反向代理时写入头部，进程内的授权层恒为 owner，
 * 因此这里不做跨账号判定，只提供「这次请求是谁」这一个事实。身份在请求处理期间
 * 通过 AsyncLocalStorage 传递，路由属主不必逐层透传参数。
 * @module @chatdsh/core-identity
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Service, type Context } from '@chatdsh/adapter';
import { type ChatdshIdentity, resolveIdentity } from '@chatdsh/core-contracts';

/** 本机直连时使用的身份。 */
export const LOCAL_IDENTITY: ChatdshIdentity = { accountId: 'local', source: 'direct' };

/**
 * 身份读取与传递。
 *
 * 直接访问运行时（例如本机调试、命令行载体）不带身份头部，此时身份取 {@link LOCAL_IDENTITY}。
 */
export class ChatdshIdentityService extends Service {
  private readonly storage = new AsyncLocalStorage<ChatdshIdentity>();

  constructor(ctx: Context) {
    super(ctx, 'chatdshIdentity');
  }

  /** 从请求头部解析身份。 */
  fromHeaders(headers: IncomingHttpHeaders): ChatdshIdentity {
    return resolveIdentity(headers);
  }

  /** 从请求解析身份。 */
  fromRequest(request: IncomingMessage): ChatdshIdentity {
    return this.fromHeaders(request.headers);
  }

  /** 当前请求的身份；不在任何请求上下文里时返回 `undefined`。 */
  current(): ChatdshIdentity | undefined {
    return this.storage.getStore();
  }

  /** 当前身份，缺失时按本机直连返回 {@link LOCAL_IDENTITY}。 */
  currentOrLocal(): ChatdshIdentity {
    return this.storage.getStore() ?? LOCAL_IDENTITY;
  }

  /** 在给定身份下执行一段同步或异步逻辑。 */
  run<T>(identity: ChatdshIdentity, fn: () => T): T {
    return this.storage.run(identity, fn);
  }

  /** 解析请求头部并在该身份下执行一段逻辑。 */
  runWithRequest<T>(request: IncomingMessage, fn: (identity: ChatdshIdentity) => T): T {
    const identity = this.fromRequest(request);
    return this.storage.run(identity, () => fn(identity));
  }
}

export { ChatdshIdentityService as default };
