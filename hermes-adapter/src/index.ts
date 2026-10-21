/**
 * Hermes 聊天后端。
 *
 * 把 {@link ChatBackend} 的五个动作翻译成 Hermes `api_server` 的接口：发起运行、读取
 * 事件流、回答审批、干预、终止。适配器不判断业务，也不重试；失败一律抛
 * {@link HermesError}，状态码与错误码交给上层决定是否重试。
 * @module @chatdsh/hermes-adapter
 */

import type {
  ApprovalChoice,
  BackendCallContext,
  BackendHealth,
  ChatBackend,
  ChatRunEvent,
  ChatRunHandle,
  ChatRunRequest,
} from '@chatdsh/core-contracts';
import { createHermesClient, HermesClient, type HermesConfig } from './client.ts';

export { createHermesClient, HermesClient, HermesError } from './client.ts';
export type { HermesConfig, HermesOperation } from './client.ts';

/** 适配器声明的能力。 */
const CAPABILITIES = ['approval', 'steer', 'events'] as const;

/** 取消信号是否已中止。 */
function aborted(context: BackendCallContext): boolean {
  return context.signal?.aborted === true;
}

/**
 * 按配置建立一个聊天后端。
 * @param config - Hermes 地址、凭据环境变量名与两个超时。
 * @returns 聊天后端。
 */
export function createHermesChatBackend(config: HermesConfig): ChatBackend {
  const client: HermesClient = createHermesClient(config);

  return {
    capabilities(): readonly string[] {
      return CAPABILITIES;
    },

    async createRun(request: ChatRunRequest, context: BackendCallContext): Promise<ChatRunHandle> {
      if (aborted(context)) throw new Error('调用已被取消');
      const handle = await client.createRun(request.sessionId, request.text);
      return { runId: handle.runId };
    },

    streamEvents(runId: string, context: BackendCallContext): AsyncIterable<ChatRunEvent> {
      const source = client.streamEvents(runId);
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ChatRunEvent> {
          for await (const event of source) {
            if (aborted(context)) return;
            yield event;
          }
        },
      };
    },

    async respondApproval(runId: string, requestId: string, choice: ApprovalChoice, context: BackendCallContext): Promise<void> {
      if (aborted(context)) throw new Error('调用已被取消');
      await client.respondApproval(runId, requestId, choice);
    },

    async steer(runId: string, text: string, context: BackendCallContext): Promise<void> {
      if (aborted(context)) throw new Error('调用已被取消');
      await client.steer(runId, text);
    },

    async stop(runId: string, context: BackendCallContext): Promise<void> {
      if (aborted(context)) throw new Error('调用已被取消');
      await client.stop(runId);
    },

    async health(): Promise<BackendHealth> {
      const reachable = await client.probe();
      return reachable ? { ok: true } : { ok: false, detail: 'unreachable' };
    },
  };
}
