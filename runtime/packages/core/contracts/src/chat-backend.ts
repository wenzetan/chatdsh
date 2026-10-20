/**
 * 聊天后端契约。
 *
 * Hermes 与将来的其他会话执行后端实现这一组接口。契约只描述发起运行、读取事件流、
 * 回答审批、干预与终止，不出现任何具体服务的路由或地址。
 * @module @chatdsh/core-contracts/chat-backend
 */

import type { ApprovalChoice } from './approval.ts';
import type { BackendCallContext, BackendErrorCode, BackendHealth } from './services.ts';

/** 发起一次运行的请求。 */
export interface ChatRunRequest {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 用户输入。 */
  readonly text: string;
  /** 工作目录；聊天会话缺省。 */
  readonly cwd?: string;
  /** 附加元数据，键与取值由调用方与实现约定。 */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** 一次运行的句柄。 */
export interface ChatRunHandle {
  /** 运行标识，后续读取事件与干预都按它定位。 */
  readonly runId: string;
}

/** 运行事件流里的一项。 */
export type ChatRunEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly callId: string; readonly name: string }
  | {
      readonly type: 'approval-request';
      readonly runId: string;
      readonly requestId: string;
      readonly title: string;
      readonly choices: readonly ApprovalChoice[];
    }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'cancelled' | 'error' }
  | { readonly type: 'error'; readonly code: BackendErrorCode; readonly detail?: string };

/**
 * 聊天后端。
 *
 * 外部会话执行后端的子代只执行一次、不接受后续追问的语义由实现承担，契约只规定
 * 可观察动作。取消通过 {@link BackendCallContext.signal} 传播。
 */
export interface ChatBackend {
  /** 发起一次运行。 */
  createRun(request: ChatRunRequest, context: BackendCallContext): Promise<ChatRunHandle>;
  /** 读取一次运行的事件流。 */
  streamEvents(runId: string, context: BackendCallContext): AsyncIterable<ChatRunEvent>;
  /** 回答一次审批请求。 */
  respondApproval(
    runId: string,
    requestId: string,
    choice: ApprovalChoice,
    context: BackendCallContext,
  ): Promise<void>;
  /** 中途干预，向运行追加一段输入。 */
  steer(runId: string, text: string, context: BackendCallContext): Promise<void>;
  /** 终止一次运行。 */
  stop(runId: string, context: BackendCallContext): Promise<void>;
  /** 探测可用性。 */
  health(context: BackendCallContext): Promise<BackendHealth>;
  /** 声明支持的能力名。 */
  capabilities(): readonly string[];
}
