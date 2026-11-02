/**
 * 终端的展示模型：命令与输出分开、断线不重放、读屏可读。
 *
 * 这里不做屏幕模拟：终端输出按行转成可读文本，转义序列只被移除，不解释光标定位与颜色
 * 状态，也不维护字符网格。每条命令单独成项，输出跟随其后；断线后重连把状态改成已连接并
 * 追加一条提示，最后输入不会重发。整段文本与逐条播报文本分别给出，读屏按条目朗读。
 * @module @chatdsh/client-workspace-tools/terminal
 */

import { WorkspaceClientError } from './types.ts';

/** 终端连接状态。 */
export const TERMINAL_STATUSES = ['connecting', 'connected', 'disconnected', 'closed'] as const;

/** 终端连接状态取值。 */
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** 状态说明。 */
export const TERMINAL_STATUS_TEXT: Readonly<Record<TerminalStatus, string>> = {
  connecting: '正在连接',
  connected: '已连接',
  disconnected: '连接已断开',
  closed: '已关闭',
};

/** 条目类别。 */
export const TERMINAL_ENTRY_KINDS = ['command', 'output', 'notice'] as const;

/** 条目类别取值。 */
export type TerminalEntryKind = (typeof TERMINAL_ENTRY_KINDS)[number];

/** 一个终端条目。 */
export interface TerminalEntry {
  readonly kind: TerminalEntryKind;
  readonly text: string;
  readonly at: number;
}

/** 控制字符与转义序列的清理结果。 */
export interface TerminalChunk {
  /** 可读行。 */
  readonly lines: readonly string[];
  /** 原文里的字节数，用于界面显示规模。 */
  readonly bytes: number;
}

/** 转义序列：CSI、OSC 与单字符转义。 */
const ESCAPE_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/gu;

/** 其余 C0 控制字符，保留制表符。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

/**
 * 把一段终端输出转成可读文本。
 *
 * 回车符按同一行重写处理，只保留最后一次写到的内容；转义序列被移除，不做颜色或光标解释。
 * @param chunk - 终端原始输出。
 * @returns 可读行与字节数。
 */
export function terminalChunk(chunk: string): TerminalChunk {
  const bytes = new TextEncoder().encode(chunk).length;
  const normalized = chunk.replaceAll('\r\n', '\n');
  const lines: string[] = [];
  for (const raw of normalized.split('\n')) {
    const rewritten = raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw;
    lines.push(rewritten.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARACTERS, ''));
  }
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return { lines, bytes };
}

/**
 * 一条条目的读屏文本。
 * @param entry - 终端条目。
 * @returns 播报文本。
 */
export function announcementOf(entry: TerminalEntry): string {
  if (entry.kind === 'command') return `命令：${entry.text}`;
  if (entry.kind === 'notice') return `提示：${entry.text}`;
  return `输出：${entry.text}`;
}

/**
 * 一个终端会话的展示状态。
 */
export class TerminalSession {
  readonly id: string;
  private status: TerminalStatus = 'connecting';
  private directory: string;
  private readonly entries: TerminalEntry[] = [];
  private lastSubmitted: string | undefined;
  private readonly now: () => number;

  /**
   * @param id - 会话标识。
   * @param cwd - 工作目录。
   * @param options - 时钟覆盖，便于测试。
   */
  constructor(id: string, cwd: string, options: { readonly now?: () => number } = {}) {
    if (id.trim() === '') throw new WorkspaceClientError('terminal-invalid', '终端会话标识不能为空');
    this.id = id;
    this.directory = cwd;
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前状态。 */
  get statusText(): string {
    return TERMINAL_STATUS_TEXT[this.status];
  }

  /** 当前状态取值。 */
  get state(): TerminalStatus {
    return this.status;
  }

  /** 工作目录。 */
  get cwd(): string {
    return this.directory;
  }

  /** 已收到的条目。 */
  get output(): readonly TerminalEntry[] {
    return this.entries;
  }

  /** 最后一次提交的命令。 */
  get lastInput(): string | undefined {
    return this.lastSubmitted;
  }

  /**
   * 连接成功。
   * @param cwd - 工作目录；省略时保持不变。
   */
  connected(cwd?: string): void {
    this.status = 'connected';
    if (cwd !== undefined) this.directory = cwd;
  }

  /**
   * 提交一条命令。
   * @param command - 命令文本。
   * @returns 命令条目。
   */
  submit(command: string): TerminalEntry {
    if (this.status !== 'connected') {
      throw new WorkspaceClientError('terminal-disconnected', '终端没有连接，命令不会提交');
    }
    if (command.trim() === '') throw new WorkspaceClientError('terminal-invalid', '命令不能为空');
    const entry: TerminalEntry = { kind: 'command', text: command, at: this.now() };
    this.entries.push(entry);
    this.lastSubmitted = command;
    return entry;
  }

  /**
   * 追加一段终端输出。
   * @param chunk - 原始输出。
   * @returns 追加的输出条目；空输出返回空数组。
   */
  append(chunk: string): readonly TerminalEntry[] {
    if (this.status === 'closed') throw new WorkspaceClientError('terminal-closed', '终端已关闭，不能追加输出');
    const readable = terminalChunk(chunk);
    const added: TerminalEntry[] = [];
    for (const line of readable.lines) {
      if (line === '') continue;
      const entry: TerminalEntry = { kind: 'output', text: line, at: this.now() };
      this.entries.push(entry);
      added.push(entry);
    }
    return added;
  }

  /**
   * 追加一条提示。
   * @param text - 提示文本。
   * @returns 提示条目。
   */
  notice(text: string): TerminalEntry {
    const entry: TerminalEntry = { kind: 'notice', text, at: this.now() };
    this.entries.push(entry);
    return entry;
  }

  /** 连接断开。 */
  disconnect(): void {
    if (this.status === 'closed') return;
    this.status = 'disconnected';
  }

  /**
   * 重新连接。
   *
   * 重连不重放输入：返回的重放计划恒为空，界面据提示说明这一点。
   * @returns 重放计划与提示文本。
   */
  reconnect(): { readonly replayedInputs: readonly string[]; readonly notice: string } {
    if (this.status === 'closed') throw new WorkspaceClientError('terminal-closed', '终端已关闭，不能重连');
    this.status = 'connected';
    const notice = '连接已恢复；上一次的输入不会重发，需要时请重新提交。';
    this.notice(notice);
    return { replayedInputs: [], notice };
  }

  /**
   * 关闭会话。
   * @param confirm - 是否已确认关闭活动进程。
   * @returns 进程处置说明。
   */
  close(confirm: boolean): { readonly processDisposition: 'terminate' | 'none' } {
    if (this.status === 'connected' && !confirm) {
      throw new WorkspaceClientError('terminal-close-unconfirmed', '终端仍然连接，关闭需要确认进程处置');
    }
    const disposition = this.status === 'connected' ? 'terminate' : 'none';
    this.status = 'closed';
    this.notice(disposition === 'terminate' ? '终端已关闭，活动进程被终止。' : '终端已关闭。');
    return { processDisposition: disposition };
  }

  /** 复制用的整段文本：命令带提示符前缀，输出原样，提示带方括号。 */
  viewText(): string {
    return this.entries
      .map((entry) => entry.kind === 'command' ? `$ ${entry.text}` : entry.kind === 'notice' ? `[系统] ${entry.text}` : entry.text)
      .join('\n');
  }

  /** 读屏用的逐条文本。 */
  screenReaderText(): string {
    return this.entries.map((entry) => announcementOf(entry)).join('\n');
  }
}

/**
 * 多终端控制。
 */
export class TerminalConsole {
  private readonly sessions = new Map<string, TerminalSession>();
  private currentId: string | undefined;

  /**
   * 新建一个会话并设为当前。
   * @param id - 会话标识。
   * @param cwd - 工作目录。
   * @returns 新建的会话。
   */
  create(id: string, cwd: string): TerminalSession {
    if (this.sessions.has(id)) throw new WorkspaceClientError('terminal-exists', `终端会话 ${id} 已经存在`);
    const session = new TerminalSession(id, cwd);
    this.sessions.set(id, session);
    this.currentId = id;
    return session;
  }

  /**
   * 切换当前会话。
   * @param id - 会话标识。
   * @returns 切换后的会话。
   */
  select(id: string): TerminalSession {
    const session = this.sessions.get(id);
    if (session === undefined) throw new WorkspaceClientError('terminal-not-found', `终端会话 ${id} 不存在`);
    this.currentId = id;
    return session;
  }

  /** 当前会话。 */
  get current(): TerminalSession | undefined {
    return this.currentId === undefined ? undefined : this.sessions.get(this.currentId);
  }

  /** 全部会话，按创建顺序。 */
  list(): TerminalSession[] {
    return [...this.sessions.values()];
  }
}
