/**
 * 本机继续：把宿主导入服务挂到客户端 Remote 名册，再调用真实的 `chatdshImport.fork`。
 *
 * 自建服务没有上游生成器，descriptor 由 `@chatdsh/core-remote-client` 按同一份形状
 * 手工构造；参数按 JSON 传入，宿主侧仍按自己的方法签名校验。
 * @module @chatdsh/client-remote/import-service
 */

import { buildRemoteContribution, unwrapRemoteResult, type RemoteContribution } from '@chatdsh/core-remote-client';
import { z } from 'zod';
import type { ClientContext, ForkInput, ForkOutcome } from './types.ts';

/** 宿主导入服务的服务名。 */
export const IMPORT_SERVICE = 'chatdshImport';

/** 分叉端点。 */
export const IMPORT_ENDPOINT = 'chatdshImport/fork';

/**
 * 构造宿主导入服务的客户端贡献。
 * @returns 可直接交给 `ctx.remote.$mount` 的贡献。
 */
export function importContribution(): RemoteContribution {
  return buildRemoteContribution(IMPORT_SERVICE, {
    [IMPORT_ENDPOINT]: { parameters: [{ name: 'input', kind: 'json' }] },
  }, z);
}

/**
 * 在当前页面的宿主上创建分叉会话。
 * @param ctx - 客户端根上下文。
 * @param input - 分叉输入。
 * @returns 宿主返回的分叉结果。
 * @throws {Error} 宿主导入服务未挂载或调用失败。
 */
export async function forkOnHost(ctx: ClientContext, input: ForkInput): Promise<ForkOutcome> {
  const namespace = ctx.remote.chatdshImport;
  if (namespace === undefined) throw new Error('import-unavailable');
  const result = await namespace.fork(input);
  return unwrapRemoteResult<ForkOutcome>(result);
}
