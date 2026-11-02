/**
 * 本机 Channel。
 *
 * 通道以真实子进程启动本机运行时，只用 stdio 上的 ACP 会话方法，不经过控制平面，也没有任何
 * 设备参数：每一次调用都落在启动它的这台机器上。通道对外提供 `open`、`subscribe`、`invoke`、
 * `close` 四个动作，会话、配置与审批都在这一层收敛。
 *
 * 两处行为在通道里固定。
 *
 * 断线按标识去重：每条已写出的消息记在台账里，重连之后用同一标识再发一次不会写第二遍，直接
 * 返回第一次的投递记录。断线期间的新发送明确失败，不排队、不自动重发。
 *
 * 审批无人应答即拒绝：权限请求有等待上限，到点按拒绝选项应答并向运行时报告决定，请求不会
 * 留在待处理状态。
 * @module @chatdsh/client-cli/local-channel
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { AcpConnection, type AcpMessage, type AcpStats, type RuntimeCommand } from './acp.ts';
import { CliError } from './protocol.ts';

/** 通道状态。 */
export type ChannelState = 'idle' | 'opening' | 'open' | 'offline' | 'closed';

/** 会话公布的一项配置。 */
export interface ConfigOption {
  /** 配置标识，例如 `model`。 */
  readonly id: string;
  /** 展示名。 */
  readonly name: string;
  /** 类别。 */
  readonly category?: string;
  /** 选择型配置的当前取值。 */
  readonly currentValue?: string;
  /** 选择型配置的可选取值。 */
  readonly values: readonly { readonly value: string; readonly name: string; readonly group?: string }[];
}

/** 一条会话记录。 */
export interface SessionRecord {
  /** 会话标识。 */
  readonly sessionId: string;
  /** 会话的工作目录。 */
  readonly cwd: string;
  /** 运行时公布的配置项。 */
  readonly configOptions: readonly ConfigOption[];
  /** 创建或恢复的时刻。 */
  readonly at: string;
}

/** 一次消息投递。 */
export interface Delivery {
  /** 业务侧给定的投递标识。 */
  readonly id: string;
  /** 目标会话。 */
  readonly sessionId: string;
  /** 是否是重复提交（第一次已写出）。 */
  readonly duplicated: boolean;
  /** 投递时刻。 */
  readonly at: string;
  /** 已写出的次数。 */
  readonly attempts: number;
}

/** 一个待应答的权限请求。 */
export interface PendingApproval {
  /** 请求标识。 */
  readonly requestId: string;
  /** 会话标识。 */
  readonly sessionId: string;
  /** 工具调用的标题。 */
  readonly title: string;
  /** 工具种类。 */
  readonly toolKind: string;
  /** 可选项。 */
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[];
  /** 登记时刻。 */
  readonly at: string;
  /** 等待上限。 */
  readonly deadlineMs: number;
}

/** 一次审批决定。 */
export interface ApprovalDecision {
  /** 请求标识。 */
  readonly requestId: string;
  /** 结论。 */
  readonly outcome: 'allowed' | 'rejected';
  /** 选中的选项标识。 */
  readonly optionId: string;
  /** 决定的来源：`client` 或 `deadline`。 */
  readonly decidedBy: 'client' | 'deadline';
  /** 拒绝原因；允许时为 `undefined`。 */
  readonly reason?: string;
}

/** 通道事件。 */
export interface ChannelEvent {
  /** 事件名。 */
  readonly event:
    | 'channel.open'
    | 'channel.offline'
    | 'channel.closed'
    | 'session.update'
    | 'session.closed'
    | 'approval.request'
    | 'approval.decided';
  /** 事件载荷。 */
  readonly [key: string]: unknown;
}

/** 通道选项。 */
export interface LocalChannelOptions {
  /** 启动本机运行时的命令。 */
  readonly runtime: RuntimeCommand;
  /** 子进程工作目录。 */
  readonly cwd: string;
  /** 子进程环境变量。 */
  readonly env: NodeJS.ProcessEnv;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /** 诊断行出口，写 stderr。 */
  readonly onDiagnostic: (line: string) => void;
  /** 审批无人应答时的等待上限。 */
  readonly approvalTimeoutMs: number;
  /** 单个 ACP 请求的等待上限。 */
  readonly requestTimeoutMs?: number;
  /** 关闭子进程时从 `SIGTERM` 到 `SIGKILL` 的等待上限。 */
  readonly closeTimeoutMs?: number;
}

/** 通道建立之后的描述。 */
export interface ChannelInfo {
  /** 状态。 */
  readonly state: 'open';
  /** 协议版本。 */
  readonly protocolVersion: number;
  /** 运行时自我介绍。 */
  readonly agent: { readonly name: string; readonly version: string };
  /** 运行时声明的能力。 */
  readonly capabilities: unknown;
  /** 认证方式。 */
  readonly authMethods: readonly unknown[];
  /** 子进程标识。 */
  readonly pid: number | undefined;
  /** 启动命令。 */
  readonly runtime: RuntimeCommand;
}

/** 通道计数。 */
export interface ChannelStats {
  /** 状态。 */
  readonly state: ChannelState;
  /** 传输层计数。 */
  readonly transport: AcpStats;
  /** 台账里已投递的消息数。 */
  readonly delivered: number;
  /** 待应答审批数。 */
  readonly pendingApprovalCount: number;
  /** 重连次数。 */
  readonly reconnects: number;
}

/** ACP 请求的默认等待上限。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** 关闭子进程的默认等待上限。 */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * 展开一层的可选取值；嵌套分组按组名展开。
 * @param raw - 运行时返回值里的一项。
 * @param group - 外层分组名。
 * @returns 可选取值。
 */
function configValuesOf(raw: unknown, group?: string): { value: string; name: string; group?: string }[] {
  if (!Array.isArray(raw)) return [];
  const values: { value: string; name: string; group?: string }[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const option = candidate as Record<string, unknown>;
    if (typeof option.value === 'string') {
      const name = typeof option.name === 'string' ? option.name : option.value;
      const ownGroup = typeof option.group === 'string' ? option.group : group;
      values.push(ownGroup === undefined ? { value: option.value, name } : { value: option.value, name, group: ownGroup });
      continue;
    }
    // 分组项：组名取 `group`，没有时取 `name`，其 `options` 继续展开。
    const nestedGroup =
      typeof option.group === 'string' ? option.group : typeof option.name === 'string' ? option.name : group;
    values.push(...configValuesOf(option.options, nestedGroup));
  }
  return values;
}

/**
 * 解析运行时公布的配置项。
 * @param raw - 运行时返回值。
 * @returns 配置项列表。
 */
function configOptionsOf(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ConfigOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (id === undefined) continue;
    options.push({
      id,
      name: typeof record.name === 'string' ? record.name : id,
      ...(typeof record.category === 'string' ? { category: record.category } : {}),
      ...(typeof record.currentValue === 'string' ? { currentValue: record.currentValue } : {}),
      values: configValuesOf(record.options),
    });
  }
  return options;
}

/**
 * 选取允许选项。
 * @param options - 可选项。
 * @returns 选项标识。
 */
function allowOptionOf(options: readonly { optionId: string; kind: string }[]): string | undefined {
  const once = options.find((option) => option.kind === 'allow_once');
  if (once !== undefined) return once.optionId;
  return options.find((option) => option.kind === 'allow_always')?.optionId;
}

/**
 * 选取拒绝选项。
 * @param options - 可选项。
 * @returns 选项标识。
 */
function rejectOptionOf(options: readonly { optionId: string; kind: string }[]): string | undefined {
  const once = options.find((option) => option.kind === 'reject_once');
  if (once !== undefined) return once.optionId;
  return options.find((option) => option.kind === 'reject_always')?.optionId;
}

/**
 * 本机 Channel。
 *
 * 实例同时是一次本机运行的台账：已投递的消息、已知会话与待应答审批都挂在这里，重连只换掉
 * 传输层，因此台账在同一进程内跨重连保留。
 */
export class LocalChannel {
  private readonly options: LocalChannelOptions;
  private connection: AcpConnection | undefined;
  private currentState: ChannelState = 'idle';
  private readonly listeners = new Set<(event: ChannelEvent) => void>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ledger = new Map<string, Delivery>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();
  private reconnects = 0;
  private info: ChannelInfo | undefined;
  private closeReason: string | undefined;

  constructor(options: LocalChannelOptions) {
    this.options = options;
  }

  /** 当前状态。 */
  get state(): ChannelState {
    return this.currentState;
  }

  /** 建立之后的描述；未建立时为 `undefined`。 */
  get channelInfo(): ChannelInfo | undefined {
    return this.info;
  }

  /** 计数快照。 */
  get stats(): ChannelStats {
    return {
      state: this.currentState,
      transport: this.connection?.stats ?? { requests: 0, notifications: 0, responses: 0, writes: 0, frames: 0 },
      delivered: this.ledger.size,
      pendingApprovalCount: this.approvals.size,
      reconnects: this.reconnects,
    };
  }

  /** 已知会话。 */
  get knownSessions(): readonly SessionRecord[] {
    return [...this.sessions.values()];
  }

  /** 待应答审批。 */
  get pendingApprovals(): readonly PendingApproval[] {
    return [...this.approvals.values()];
  }

  /**
   * 订阅事件。
   * @param listener - 事件处理函数。
   * @returns 退订函数。
   */
  subscribe(listener: (event: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 启动本机运行时并完成握手。
   * @returns 通道描述。
   * @throws {CliError} 已在打开、正在打开或已关闭时拒绝。
   */
  async open(): Promise<ChannelInfo> {
    if (this.currentState === 'open') throw new CliError('rejected', '本机 Channel 已经打开');
    if (this.currentState === 'opening') throw new CliError('rejected', '本机 Channel 正在打开');
    if (this.currentState === 'closed') throw new CliError('rejected', '本机 Channel 已关闭');
    this.currentState = 'opening';
    try {
      return await this.start('initialize');
    } catch (error) {
      this.currentState = 'offline';
      throw error;
    }
  }

  /**
   * 断开之后重新打开，并恢复断开前已知的会话。
   *
   * 重连不改台账：同一标识的消息不会因为重连再发一次。
   * @returns 通道描述。
   */
  async reconnect(): Promise<ChannelInfo> {
    if (this.currentState === 'closed') throw new CliError('rejected', '本机 Channel 已关闭，不能重连');
    if (this.currentState === 'open') throw new CliError('rejected', '本机 Channel 仍然连接，不需要重连');
    const sessionIds = [...this.sessions.keys()];
    this.currentState = 'opening';
    const info = await this.start('reconnect');
    this.reconnects += 1;
    this.sessions.clear();
    for (const sessionId of sessionIds) {
      try {
        await this.resumeSession({ sessionId });
      } catch (error) {
        this.emit({
          event: 'session.closed',
          sessionId,
          reason: error instanceof CliError ? error.message : String(error),
        });
      }
    }
    return info;
  }

  /**
   * 关闭通道。
   * @param reason - 关闭原因，写进事件。
   */
  async close(reason: string): Promise<void> {
    if (this.currentState === 'closed') return;
    this.closeReason = reason;
    for (const [requestId, timer] of this.approvalTimers) {
      clearTimeout(timer);
      this.approvalTimers.delete(requestId);
      this.approvals.delete(requestId);
    }
    const connection = this.connection;
    this.connection = undefined;
    this.currentState = 'closed';
    if (connection !== undefined) await connection.close(this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
    this.emit({ event: 'channel.closed', reason });
  }

  /**
   * 调用本机运行时的一个方法。
   * @param method - ACP 方法名。
   * @param params - 参数。
   * @returns 结果。
   */
  async invoke(method: string, params: unknown): Promise<unknown> {
    return this.requireConnection(method).request(
      method,
      params,
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * 新建会话。
   * @param input - 工作目录。
   * @returns 会话记录。
   */
  async newSession(input: { readonly cwd?: string } = {}): Promise<SessionRecord> {
    const cwd = input.cwd ?? this.options.cwd;
    const result = (await this.invoke('session/new', { cwd, mcpServers: [] })) as Record<string, unknown>;
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined;
    if (sessionId === undefined) throw new CliError('protocol', 'session/new 没有返回会话标识');
    const record: SessionRecord = {
      sessionId,
      cwd,
      configOptions: configOptionsOf(result.configOptions),
      at: new Date().toISOString(),
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  /**
   * 恢复一个已持久化的会话。
   * @param input - 会话标识与工作目录。
   * @returns 会话记录。
   */
  async resumeSession(input: { readonly sessionId: string; readonly cwd?: string }): Promise<SessionRecord> {
    const cwd = input.cwd ?? this.options.cwd;
    const result = (await this.invoke('session/resume', {
      sessionId: input.sessionId,
      cwd,
      mcpServers: [],
    })) as Record<string, unknown>;
    const record: SessionRecord = {
      sessionId: input.sessionId,
      cwd,
      configOptions: configOptionsOf(result.configOptions),
      at: new Date().toISOString(),
    };
    this.sessions.set(input.sessionId, record);
    return record;
  }

  /**
   * 列出本机运行时可恢复的会话。
   * @param input - 工作目录过滤与游标。
   * @returns 会话摘要与下一页游标。
   */
  async listSessions(input: { readonly cwd?: string; readonly cursor?: string } = {}): Promise<{
    readonly sessions: readonly { readonly sessionId: string; readonly cwd: string }[];
    readonly nextCursor?: string;
  }> {
    const result = (await this.invoke('session/list', {
      ...(input.cwd === undefined ? { cwd: null } : { cwd: input.cwd }),
      ...(input.cursor === undefined ? { cursor: null } : { cursor: input.cursor }),
    })) as Record<string, unknown>;
    const rows = Array.isArray(result.sessions) ? result.sessions : [];
    const sessions = rows.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const record = row as Record<string, unknown>;
      if (typeof record.sessionId !== 'string') return [];
      return [{ sessionId: record.sessionId, cwd: typeof record.cwd === 'string' ? record.cwd : '' }];
    });
    return typeof result.nextCursor === 'string'
      ? { sessions, nextCursor: result.nextCursor }
      : { sessions };
  }

  /**
   * 关闭一个会话。
   * @param sessionId - 会话标识。
   */
  async closeSession(sessionId: string): Promise<void> {
    this.cancelApprovalsOf(sessionId);
    await this.invoke('session/close', { sessionId });
    this.sessions.delete(sessionId);
    this.emit({ event: 'session.closed', sessionId, reason: 'closed' });
  }

  /**
   * 发送一条消息。
   *
   * 台账里已有同一标识的投递记录时不再写出，返回第一次的记录并标记 `duplicated`。
   * @param input - 标识、会话与文本。
   * @returns 投递记录。
   * @throws {CliError} 通道未连接时为 `offline`；运行时拒绝时为 `runtime`。
   */
  async sendMessage(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly text: string;
  }): Promise<Delivery> {
    const existing = this.ledger.get(input.id);
    if (existing !== undefined) return { ...existing, duplicated: true };
    const connection = this.requireConnection('session/prompt');
    const delivery: Delivery = {
      id: input.id,
      sessionId: input.sessionId,
      duplicated: false,
      at: new Date().toISOString(),
      attempts: 1,
    };
    // 先记台账再写出：内容一旦交给运行时就不再重发，重连之后的同一标识直接返回这条记录。
    this.ledger.set(input.id, delivery);
    await connection.request(
      'session/prompt',
      { sessionId: input.sessionId, prompt: [{ type: 'text', text: input.text }] },
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    return delivery;
  }

  /**
   * 取消会话里正在进行的回合。
   * @param sessionId - 会话标识。
   */
  cancelSession(sessionId: string): void {
    this.cancelApprovalsOf(sessionId);
    this.requireConnection('session/cancel').notify('session/cancel', { sessionId });
  }

  /**
   * 更新会话的一项配置。
   * @param input - 会话、配置标识与取值。
   * @returns 更新之后的配置项。
   */
  async setConfigOption(input: {
    readonly sessionId: string;
    readonly configId: string;
    readonly value: string;
  }): Promise<ConfigOption[]> {
    const result = (await this.invoke('session/set_config_option', {
      sessionId: input.sessionId,
      configId: input.configId,
      value: input.value,
    })) as Record<string, unknown>;
    const options = configOptionsOf(result.configOptions);
    const record = this.sessions.get(input.sessionId);
    if (record !== undefined) this.sessions.set(input.sessionId, { ...record, configOptions: options });
    return options;
  }

  /**
   * 应答一个权限请求。
   * @param input - 请求标识与结论。
   * @returns 决定记录。
   * @throws {CliError} 请求不存在或没有对应选项时为 `rejected`。
   */
  answerApproval(input: { readonly requestId: string; readonly decision: 'allow' | 'deny' }): ApprovalDecision {
    const pending = this.approvals.get(input.requestId);
    if (pending === undefined) throw new CliError('rejected', `没有待应答的审批请求：${input.requestId}`);
    const optionId =
      input.decision === 'allow' ? allowOptionOf(pending.options) : rejectOptionOf(pending.options);
    if (optionId === undefined) {
      throw new CliError(
        'rejected',
        `审批请求 ${input.requestId} 没有${input.decision === 'allow' ? '允许' : '拒绝'}选项`,
      );
    }
    return this.settleApproval(pending, input.decision === 'allow', optionId, 'client');
  }

  /**
   * 启动传输层并握手。
   * @param mode - 首次打开或重连。
   * @returns 通道描述。
   */
  private async start(mode: 'initialize' | 'reconnect'): Promise<ChannelInfo> {
    const connection = AcpConnection.start({
      command: this.options.runtime,
      cwd: this.options.cwd,
      env: this.options.env,
      onNotification: (message) => this.handleNotification(message),
      onRequest: (message) => this.handleRequest(message),
      onExit: (info) => this.handleExit(info),
      onDiagnostic: (line) => this.options.onDiagnostic(line),
    });
    this.connection = connection;
    let result: Record<string, unknown>;
    try {
      result = (await connection.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'chatdsh-cli', version: '0.1.0' },
        },
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      )) as Record<string, unknown>;
    } catch (error) {
      await connection.close(this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
      throw error;
    }
    const protocolVersion = typeof result.protocolVersion === 'number' ? result.protocolVersion : 0;
    const agentInfo = typeof result.agentInfo === 'object' && result.agentInfo !== null
      ? (result.agentInfo as Record<string, unknown>)
      : {};
    const info: ChannelInfo = {
      state: 'open',
      protocolVersion,
      agent: {
        name: typeof agentInfo.name === 'string' ? agentInfo.name : 'unknown',
        version: typeof agentInfo.version === 'string' ? agentInfo.version : 'unknown',
      },
      capabilities: result.agentCapabilities ?? {},
      authMethods: Array.isArray(result.authMethods) ? result.authMethods : [],
      pid: connection.pid,
      runtime: this.options.runtime,
    };
    this.info = info;
    this.currentState = 'open';
    await this.options.telemetry.runSpan('chatdsh.cli.channel.open', { outcome: 'success' }, async (span) => {
      span.setAttribute('outcome', 'success');
    });
    this.emit({
      event: 'channel.open',
      pid: connection.pid,
      protocolVersion,
      agent: info.agent,
      mode,
    });
    return info;
  }

  /**
   * 处理运行时发来的通知。
   * @param message - 通知帧。
   */
  private handleNotification(message: AcpMessage): void {
    if (message.method !== 'session/update') {
      this.options.onDiagnostic(`忽略未知通知：${String(message.method)}`);
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    const update = (params.update ?? {}) as Record<string, unknown>;
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'unknown';
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const payload: Record<string, unknown> = { sessionId, kind };
    if (typeof update.toolCallId === 'string') payload.toolCallId = update.toolCallId;
    if (typeof update.title === 'string') payload.title = update.title;
    if (typeof update.status === 'string') payload.status = update.status;
    const content = update.content;
    if (typeof content === 'object' && content !== null) {
      const text = (content as Record<string, unknown>).text;
      if (typeof text === 'string') payload.text = text;
    }
    this.emit({ event: 'session.update', ...payload });
  }

  /**
   * 处理运行时发起的请求。
   * @param message - 请求帧。
   */
  private handleRequest(message: AcpMessage): void {
    const id = message.id;
    if (id === undefined) return;
    if (message.method !== 'session/request_permission') {
      this.options.onDiagnostic(`拒绝未实现的服务端请求：${String(message.method)}`);
      this.connection?.respondError(id, -32601, 'Method not found');
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options = rawOptions.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.optionId !== 'string' || typeof record.kind !== 'string') return [];
      return [
        {
          optionId: record.optionId,
          name: typeof record.name === 'string' ? record.name : record.optionId,
          kind: record.kind,
        },
      ];
    });
    const pending: PendingApproval = {
      requestId: String(id),
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
      title: typeof toolCall.title === 'string' ? toolCall.title : '',
      toolKind: typeof toolCall.kind === 'string' ? toolCall.kind : '',
      options,
      at: new Date().toISOString(),
      deadlineMs: this.options.approvalTimeoutMs,
    };
    this.approvals.set(pending.requestId, pending);
    const timer = setTimeout(() => {
      this.approvalTimers.delete(pending.requestId);
      if (!this.approvals.has(pending.requestId)) return;
      if (this.currentState !== 'open' || this.connection === undefined || this.connection.isClosed) {
        this.approvals.delete(pending.requestId);
        return;
      }
      const optionId = rejectOptionOf(pending.options);
      if (optionId === undefined) {
        // 运行时没有给拒绝选项时按取消应答，请求同样不会留下。
        this.approvals.delete(pending.requestId);
        this.connection.respond(id, { outcome: { outcome: 'cancelled' } });
        this.options.telemetry.log('warn', '审批无人应答，按取消应答', {
          outcome: 'cancelled',
          reason: 'no-reject-option',
        });
        this.emit({
          event: 'approval.decided',
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          outcome: 'rejected',
          optionId: '',
          decidedBy: 'deadline',
          reason: 'no-reject-option',
        });
        return;
      }
      this.settleApproval(pending, false, optionId, 'deadline');
    }, this.options.approvalTimeoutMs);
    timer.unref();
    this.approvalTimers.set(pending.requestId, timer);
    this.emit({
      event: 'approval.request',
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      title: pending.title,
      toolKind: pending.toolKind,
      options: pending.options,
      deadlineMs: pending.deadlineMs,
    });
  }

  /**
   * 处理子进程退出。
   * @param info - 退出信息。
   */
  private handleExit(info: { readonly code: number | null; readonly signal: NodeJS.Signals | null }): void {
    if (this.currentState === 'closed') return;
    this.currentState = 'offline';
    for (const [requestId, timer] of this.approvalTimers) {
      clearTimeout(timer);
      this.approvalTimers.delete(requestId);
      this.approvals.delete(requestId);
    }
    this.emit({
      event: 'channel.offline',
      reason: `本机运行时已退出（code=${info.code ?? 'null'}，signal=${info.signal ?? 'null'}）`,
    });
  }

  /**
   * 结算一个审批请求并写出应答。
   * @param pending - 待应答请求。
   * @param allow - 是否允许。
   * @param optionId - 选项标识。
   * @param by - 决定来源。
   * @returns 决定记录。
   */
  private settleApproval(
    pending: PendingApproval,
    allow: boolean,
    optionId: string,
    by: 'client' | 'deadline',
  ): ApprovalDecision {
    const timer = this.approvalTimers.get(pending.requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.approvalTimers.delete(pending.requestId);
    }
    this.approvals.delete(pending.requestId);
    const connection = this.connection;
    if (connection !== undefined && !connection.isClosed) {
      connection.respond(Number(pending.requestId), { outcome: { outcome: 'selected', optionId } });
    }
    const record: ApprovalDecision = {
      requestId: pending.requestId,
      outcome: allow ? 'allowed' : 'rejected',
      optionId,
      decidedBy: by,
      ...(allow ? {} : { reason: by === 'deadline' ? 'no-responder' : 'client' }),
    };
    if (!allow && by === 'deadline') {
      this.options.telemetry.log('warn', '审批无人应答，按拒绝收尾', {
        outcome: 'rejected',
        reason: 'no-responder',
      });
    }
    this.emit({
      event: 'approval.decided',
      requestId: record.requestId,
      sessionId: pending.sessionId,
      outcome: record.outcome,
      optionId: record.optionId,
      decidedBy: record.decidedBy,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    });
    return record;
  }

  /**
   * 把某个会话名下的待应答请求按取消收尾。
   * @param sessionId - 会话标识。
   */
  private cancelApprovalsOf(sessionId: string): void {
    for (const pending of [...this.approvals.values()]) {
      if (pending.sessionId !== sessionId) continue;
      const timer = this.approvalTimers.get(pending.requestId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.approvalTimers.delete(pending.requestId);
      }
      this.approvals.delete(pending.requestId);
      const connection = this.connection;
      if (connection !== undefined && !connection.isClosed) {
        connection.respond(Number(pending.requestId), { outcome: { outcome: 'cancelled' } });
      }
      this.emit({
        event: 'approval.decided',
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        outcome: 'cancelled',
        optionId: '',
        decidedBy: 'client',
        reason: 'session-cancelled',
      });
    }
  }

  /**
   * 取连接，未连接时按离线失败。
   * @param method - 即将执行的方法名。
   * @returns 连接。
   */
  private requireConnection(method: string): AcpConnection {
    if (this.connection === undefined || this.currentState !== 'open') {
      const detail = this.closeReason ?? '本机运行时未连接';
      throw new CliError('offline', `${detail}：${method} 没有投递`);
    }
    return this.connection;
  }

  /**
   * 发出事件。
   * @param event - 事件。
   */
  private emit(event: ChannelEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
