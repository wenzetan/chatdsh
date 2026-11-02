/**
 * Hermes 聊天后端与完整历史运行桥接。
 *
 * 旧接口把五个 {@link ChatBackend} 动作翻译成 Hermes `api_server` 的接口。完整历史、
 * 精确审批、停止确认与确定终态使用 {@link createHermesHistoryRunBridge}；宿主在任何
 * 执行前先确认能力，缺能力时直接拒绝。
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

export { createHermesClient, HermesClient } from './client.ts';
export { HermesCapabilityError, HermesError } from './errors.ts';
export type { HermesConfig, HermesOperation } from './errors.ts';
export { createHermesHistoryRunBridge, HermesHistoryRunBridge, parseRunStatus, REQUIRED_HISTORY_RUN_FEATURES, RUN_STATES } from './history-run.ts';
export type {
  ApprovalAnswer,
  CancelOutcome,
  HermesCapabilities,
  HermesHistoryRunConfig,
  HermesRunState,
  HistoryRunAdmission,
  HistoryRunRequest,
  RunStatusSnapshot,
} from './history-run.ts';
export { historyDigestOf, normalizeHistory, readHistoryPages, DEFAULT_HISTORY_PAGE_SIZE } from './history.ts';
export type {
  HistoryEventLike,
  HistoryLossDeclaration,
  HistoryMessage,
  HistoryPage,
  HistoryProjectedMessage,
  HistoryProjection,
  HistoryReadResult,
  HistoryReadSource,
  HistorySnapshot,
} from './history.ts';
export { readRunFrames, streamRunEvents, translateRunFrame, terminalOf, TERMINAL_RUN_EVENTS } from './run-stream.ts';
export type { ApprovalEventPayload, HistoryRunEvent, RunFrame, RunTerminalStatus } from './run-stream.ts';

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
