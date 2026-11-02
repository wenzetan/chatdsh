/**
 * 后端选择的诊断记录。
 *
 * 每次发送记录一条实际判断：采用哪个执行体、当时的修订号、可达判断的结果与降级原因。
 * 记录只保留最近若干条，进程内不建立任何定时器，诊断页读到的就是最近一次发送看到的事实。
 * 属性值只有枚举、标识、修订号与时刻，不含消息正文与凭据。
 * @module @chatdsh/gateway/backends/diagnostics
 */

import type { ChatBackendId, MemoryBackendId } from './policy.ts';

/** 执行来源。 */
export type ExecutionSource = 'dsh' | 'hermes' | 'dsh-fallback';

/** 一次发送的判断结果。 */
export type DispatchOutcome = 'dsh' | 'hermes-accepted' | 'degraded-dsh' | 'unconfirmed' | 'rejected';

/** 完整历史桥接方式。 */
export type HistoryMode = 'dsh' | 'full';

/** 一次发送的实际判断。 */
export interface SendJudgment {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 回合号。 */
  readonly turn: number;
  /** 选择时的配置修订号。 */
  readonly revision: number;
  /** 配置里的聊天后端。 */
  readonly chatBackend: ChatBackendId;
  /** 配置里的记忆后端。 */
  readonly memoryBackend: MemoryBackendId;
  /** 实际执行体。 */
  readonly executionSource: ExecutionSource;
  /** 本次判断的结果。 */
  readonly outcome: DispatchOutcome;
  /** 会话的完整历史桥接方式。 */
  readonly historyMode: HistoryMode;
  /** 后续交给 Hermes 的运行是否必须携带完整历史。 */
  readonly historyBridgeRequired: boolean;
  /** 本回合记忆能力是否可用。 */
  readonly memoryEnabled: boolean;
  /** 降级或拒绝的原因码。 */
  readonly reason?: string;
  /** Hermes 运行标识。 */
  readonly runId?: string;
  /** Hermes 运行状态。 */
  readonly runStatus?: string;
  /** 发送准备阶段的探活结果。 */
  readonly probe?: {
    /** 依赖名。 */
    readonly dependency: 'hermes';
    /** 是否可达。 */
    readonly reachable: boolean;
    /** 能力是否齐全。 */
    readonly capabilities: boolean;
  };
  /** 判断时刻。 */
  readonly at: number;
  /** 是否沿用活动回合已经固定的选择。 */
  readonly pinned: boolean;
}

/** 保留的判断条数。 */
const HISTORY_LIMIT = 64;

/** 判断记录的存取。 */
export class BackendDiagnostics {
  private readonly records: SendJudgment[] = [];
  private readonly bySession = new Map<string, SendJudgment>();

  /** 记录一次判断，覆盖该会话的上一条。 */
  record(judgment: SendJudgment): void {
    this.records.push(judgment);
    if (this.records.length > HISTORY_LIMIT) this.records.shift();
    this.bySession.set(judgment.sessionId, judgment);
  }

  /** 最近一次发送的判断。 */
  last(): SendJudgment | undefined {
    return this.records.at(-1);
  }

  /** 某个会话最近一次判断。 */
  forSession(sessionId: string): SendJudgment | undefined {
    return this.bySession.get(sessionId);
  }

  /** 最近的判断，按发生顺序。 */
  history(): readonly SendJudgment[] {
    return [...this.records];
  }
}

/** 建立一个诊断记录。 */
export function createBackendDiagnostics(): BackendDiagnostics {
  return new BackendDiagnostics();
}
