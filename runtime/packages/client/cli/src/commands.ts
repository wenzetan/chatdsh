/**
 * 命令执行。
 *
 * 每条命令产出一份结构化的 `data` 与一份面向人的 `text`。非交互模式只写 `data`，交互模式只写
 * `text`；两者来自同一次执行，因此两条路径看到的结果一致。命令执行本身是一个 `chatdsh.cli.command`
 * span，成功与失败都计入计数指标。
 * @module @chatdsh/client-cli/commands
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { commandTreeView, completeCommands, helpText, usageOf, type ParsedCall } from './command-tree.ts';
import {
  EXTENSION_POINTS,
  SCENES,
  STATUS_ENTRIES,
  extensionPointOf,
  sceneOf,
} from './contributions.ts';
import { formatKeyValue, formatTable, type Column } from './format.ts';
import type { ConfigOption, LocalChannel, SessionRecord } from './local-channel.ts';
import { CliError } from './protocol.ts';
import type { Theme } from './theme.ts';

/** 一次执行的产出。 */
export interface CommandResult {
  /** 面向人的文本行。 */
  readonly text: readonly string[];
  /** 结构化结果，写进应答行的 `result`。 */
  readonly data: unknown;
}

/** 执行器选项。 */
export interface CommandRunnerOptions {
  /** 本机通道。 */
  readonly channel: LocalChannel;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /** 主题。 */
  readonly theme: Theme;
  /** 可用列数。 */
  readonly width: number;
  /** 新会话的默认工作目录。 */
  readonly workspace: string;
  /** 投递标识前缀，用来区分同一次运行里的不同调用。 */
  readonly runId: string;
}

/**
 * 渲染配置项表。
 * @param options - 配置项。
 * @param theme - 主题。
 * @param width - 列数。
 * @returns 文本行。
 */
function renderConfigOptions(options: readonly ConfigOption[], theme: Theme, width: number): string[] {
  const columns: Column[] = [
    { header: '配置', value: (row) => String(row.id) },
    { header: '标题', value: (row) => String(row.name) },
    { header: '当前取值', value: (row) => String(row.currentValue ?? '') },
    { header: '可选', value: (row) => String(row.values ?? '') },
  ];
  const rows = options.map((option) => ({
    id: option.id,
    name: option.name,
    currentValue: option.currentValue ?? '',
    values: option.values.map((value) => value.value).join('、'),
  }));
  return formatTable(rows, columns, { width, theme });
}

/**
 * 渲染会话表。
 * @param sessions - 会话摘要。
 * @param theme - 主题。
 * @param width - 列数。
 * @returns 文本行。
 */
function renderSessions(
  sessions: readonly { readonly sessionId: string; readonly cwd: string }[],
  theme: Theme,
  width: number,
): string[] {
  const columns: Column[] = [
    { header: '会话标识', value: (row) => String(row.sessionId) },
    { header: '工作目录', value: (row) => String(row.cwd) },
  ];
  return formatTable(sessions, columns, { width, theme });
}

/** 命令执行器。 */
export class CommandRunner {
  private readonly options: CommandRunnerOptions;
  private currentSession: string | undefined;
  private workspacePath: string;
  private lastDecision: string | undefined;
  private sendSequence = 0;

  constructor(options: CommandRunnerOptions) {
    this.options = options;
    this.workspacePath = options.workspace;
  }

  /** 当前会话标识。 */
  get sessionId(): string | undefined {
    return this.currentSession;
  }

  /** 当前工作区目录。 */
  get workspace(): string {
    return this.workspacePath;
  }

  /** 把当前会话设为指定会话，供连续调用复用。 */
  useSession(sessionId: string): void {
    this.currentSession = sessionId;
  }

  /**
   * 执行一次调用。
   * @param call - 解析之后的调用。
   * @returns 执行结果。
   * @throws {CliError} 用法错误或运行时错误。
   */
  async run(call: ParsedCall): Promise<CommandResult> {
    const attributes = { command: call.spec.id, outcome: 'success' };
    try {
      const result = await this.options.telemetry.runSpan('chatdsh.cli.command', attributes, async (span) => {
        try {
          const value = await this.dispatch(call);
          span.setAttribute('outcome', 'success');
          span.setAttribute('exit.code', 0);
          this.options.telemetry.counter('chatdsh_cli_commands_total').add(1, {
            command: call.spec.id,
            outcome: 'success',
          });
          return value;
        } catch (error) {
          span.setAttribute('outcome', 'failure');
          span.setAttribute('exit.code', error instanceof CliError ? error.exitCode : 1);
          this.options.telemetry.counter('chatdsh_cli_commands_total').add(1, {
            command: call.spec.id,
            outcome: 'failure',
          });
          this.options.telemetry.log('warn', '命令执行失败', {
            command: call.spec.id,
            outcome: 'failure',
            'error.type': error instanceof Error ? error.name : 'unknown',
            'error.code': error instanceof CliError ? error.code : 'runtime',
          });
          throw error;
        }
      });
      return result;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('runtime', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 分发一条命令。
   * @param call - 解析之后的调用。
   * @returns 执行结果。
   */
  private async dispatch(call: ParsedCall): Promise<CommandResult> {
    const { theme, width } = this.options;
    const { arguments: args, options } = call;
    switch (call.spec.id) {
      case 'scene.list': {
        const rows = SCENES.map((scene) => ({ id: scene.id, title: scene.title, summary: scene.summary }));
        const columns: Column[] = [
          { header: '场景', value: (row) => String(row.id) },
          { header: '标题', value: (row) => String(row.title) },
          { header: '内容', value: (row) => String(row.summary) },
        ];
        return { text: formatTable(rows, columns, { width, theme }), data: { scenes: SCENES } };
      }
      case 'scene.open':
        return this.openScene(String(options.scene));
      case 'settings.list': {
        const session = await this.ensureSession(options.session);
        return {
          text: renderConfigOptions(session.configOptions, theme, width),
          data: { sessionId: session.sessionId, options: session.configOptions },
        };
      }
      case 'settings.set': {
        const session = await this.ensureSession(options.session);
        const optionsAfter = await this.options.channel.setConfigOption({
          sessionId: session.sessionId,
          configId: String(options.option),
          value: String(options.value),
        });
        return {
          text: [`${session.sessionId} 的 ${String(options.option)} 已更新为 ${String(options.value)}`, ...renderConfigOptions(optionsAfter, theme, width)],
          data: { sessionId: session.sessionId, options: optionsAfter },
        };
      }
      case 'command.tree': {
        const tree = commandTreeView();
        const lines: string[] = [];
        for (const group of tree.groups) {
          lines.push(theme.paint('heading', `${group.id}（${group.title}）：${group.summary}`));
          for (const command of group.commands) {
            lines.push(`  ${command.id.padEnd(20)}${command.summary}`);
          }
          lines.push('');
        }
        return { text: lines, data: tree };
      }
      case 'command.help':
        return { text: helpText(String(args.target)), data: { target: String(args.target), lines: helpText(String(args.target)) } };
      case 'command.complete': {
        const candidates = completeCommands(String(args.prefix));
        return { text: candidates, data: { prefix: String(args.prefix), candidates } };
      }
      case 'extension.list': {
        const info = this.options.channel.channelInfo;
        const runtime = info === undefined
          ? { connected: false }
          : {
              connected: true,
              agent: info.agent,
              protocolVersion: info.protocolVersion,
              capabilities: info.capabilities,
              authMethods: info.authMethods,
            };
        const columns: Column[] = [
          { header: '扩展', value: (row) => String(row.id) },
          { header: '类别', value: (row) => String(row.kind) },
          { header: '提供方', value: (row) => String(row.provider) },
        ];
        return {
          text: formatTable(EXTENSION_POINTS.map((point) => ({ ...point })), columns, { width, theme }),
          data: { extensionPoints: EXTENSION_POINTS, runtime },
        };
      }
      case 'extension.show': {
        const id = String(args.id);
        const point = extensionPointOf(id);
        if (point === undefined) throw new CliError('usage', `没有这个扩展点：${id}`);
        return {
          text: formatKeyValue(
            [
              ['标识', point.id],
              ['类别', point.kind],
              ['标题', point.title],
              ['提供方', point.provider],
              ['说明', point.summary],
            ],
            { width, theme },
          ),
          data: point,
        };
      }
      case 'session.list': {
        const cwd = typeof options.cwd === 'string' ? resolve(this.workspacePath, options.cwd) : undefined;
        const listed = await this.options.channel.listSessions({
          ...(cwd === undefined ? {} : { cwd }),
          ...(typeof options.cursor === 'string' ? { cursor: options.cursor } : {}),
        });
        return {
          text: renderSessions(listed.sessions, theme, width),
          data: {
            sessions: listed.sessions,
            ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
          },
        };
      }
      case 'session.new': {
        const cwd = typeof options.cwd === 'string' ? resolve(this.workspacePath, options.cwd) : this.workspacePath;
        const record = await this.options.channel.newSession({ cwd });
        this.currentSession = record.sessionId;
        this.workspacePath = record.cwd;
        return { text: this.sessionText(record, '已新建会话'), data: record };
      }
      case 'session.resume': {
        const cwd = typeof options.cwd === 'string' ? resolve(this.workspacePath, options.cwd) : this.workspacePath;
        const record = await this.options.channel.resumeSession({ sessionId: String(args.sessionId), cwd });
        this.currentSession = record.sessionId;
        this.workspacePath = record.cwd;
        return { text: this.sessionText(record, '已恢复会话'), data: record };
      }
      case 'session.send': {
        const session = await this.ensureSession(options.session);
        const text = String(args.text);
        const deliveryId =
          typeof options.delivery === 'string'
            ? options.delivery
            : `${this.options.runId}:send:${(this.sendSequence += 1)}:${randomUUID().slice(0, 8)}`;
        const delivery = await this.options.channel.sendMessage({
          id: deliveryId,
          sessionId: session.sessionId,
          text,
        });
        const state = delivery.duplicated ? '已存在，未重复发送' : '已投递';
        return {
          text: [`${delivery.id} ${state}：${session.sessionId}`],
          data: delivery,
        };
      }
      case 'session.cancel': {
        const session = await this.ensureSession(options.session);
        this.options.channel.cancelSession(session.sessionId);
        return { text: [`已请求取消：${session.sessionId}`], data: { sessionId: session.sessionId, cancelled: true } };
      }
      case 'session.close': {
        const session = await this.ensureSession(options.session);
        this.confirm(call);
        await this.options.channel.closeSession(session.sessionId);
        if (this.currentSession === session.sessionId) this.currentSession = undefined;
        return { text: [`已关闭会话：${session.sessionId}`], data: { sessionId: session.sessionId, closed: true } };
      }
      case 'approval.list': {
        const pending = this.options.channel.pendingApprovals;
        const columns: Column[] = [
          { header: '请求', value: (row) => String(row.requestId) },
          { header: '会话', value: (row) => String(row.sessionId) },
          { header: '工具', value: (row) => String(row.title) },
          { header: '等待上限', value: (row) => `${String(row.deadlineMs)} 毫秒` },
        ];
        return {
          text: formatTable(pending.map((entry) => ({ ...entry })), columns, { width, theme }),
          data: { pending },
        };
      }
      case 'approval.answer': {
        const decision = options.decision === 'allow' ? 'allow' : 'deny';
        const record = this.options.channel.answerApproval({ requestId: String(args.requestId), decision });
        this.lastDecision = `${record.requestId}:${record.outcome}`;
        return {
          text: [`${record.requestId} ${record.outcome === 'allowed' ? '已允许' : '已拒绝'}`],
          data: record,
        };
      }
      case 'workspace.list': {
        const known = new Set<string>([this.workspacePath]);
        for (const session of this.options.channel.knownSessions) known.add(session.cwd);
        const entries = [...known].map((path) => ({
          path,
          current: path === this.workspacePath,
        }));
        const columns: Column[] = [
          { header: '工作目录', value: (row) => String(row.path) },
          { header: '当前', value: (row) => (row.current === true ? '是' : '') },
        ];
        return { text: formatTable(entries, columns, { width, theme }), data: { current: this.workspacePath, entries } };
      }
      case 'workspace.use': {
        const target = resolve(this.workspacePath, String(args.path));
        let isDirectory = false;
        try {
          isDirectory = statSync(target).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (!isDirectory) throw new CliError('usage', `工作目录不存在或不是目录：${target}`);
        this.workspacePath = target;
        return { text: [`当前工作区：${target}`], data: { current: target } };
      }
      case 'status':
        return this.status();
      case 'status.reconnect': {
        const info = await this.options.channel.reconnect();
        const sessions = this.options.channel.knownSessions.map((session) => session.sessionId);
        if (this.currentSession !== undefined && !sessions.includes(this.currentSession)) {
          this.currentSession = undefined;
        }
        return {
          text: [
            `已重新连接：pid=${info.pid ?? 'unknown'}，恢复 ${sessions.length} 个会话`,
            ...sessions.map((sessionId) => `  ${sessionId}`),
          ],
          data: { state: info.state, pid: info.pid ?? null, resumed: sessions },
        };
      }
      case 'help': {
        const target = args.target === undefined ? undefined : String(args.target);
        const lines = helpText(target);
        return { text: lines, data: { target: target ?? null, lines } };
      }
      default:
        throw new CliError('usage', `命令没有执行分支：${call.spec.id}`);
    }
  }

  /**
   * 打开一个场景。
   * @param sceneId - 场景标识。
   * @returns 执行结果。
   */
  private async openScene(sceneId: string): Promise<CommandResult> {
    const scene = sceneOf(sceneId);
    if (scene === undefined) throw new CliError('usage', `没有这个场景：${sceneId}`);
    const { theme, width } = this.options;
    await this.options.telemetry.runSpan('chatdsh.cli.scene.open', { scene: sceneId }, async (span) => {
      span.setAttribute('scene', sceneId);
    });
    switch (sceneId) {
      case 'sessions': {
        const listed = await this.options.channel.listSessions({});
        return {
          text: renderSessions(listed.sessions, theme, width),
          data: { scene: sceneId, sessions: listed.sessions },
        };
      }
      case 'session': {
        const session = await this.ensureSession(undefined);
        return {
          text: formatKeyValue(
            [
              ['会话标识', session.sessionId],
              ['工作目录', session.cwd],
              ['配置项', String(session.configOptions.length)],
              ['已知会话段', String(this.options.channel.knownSessions.length)],
            ],
            { width, theme },
          ),
          data: { scene: sceneId, session },
        };
      }
      case 'settings': {
        const session = await this.ensureSession(undefined);
        return {
          text: renderConfigOptions(session.configOptions, theme, width),
          data: { scene: sceneId, sessionId: session.sessionId, options: session.configOptions },
        };
      }
      case 'diagnostics': {
        const stats = this.options.channel.stats;
        const entries: (readonly [string, string])[] = [
          ['通道状态', stats.state],
          ['传输请求', String(stats.transport.requests)],
          ['传输通知', String(stats.transport.notifications)],
          ['传输应答', String(stats.transport.responses)],
          ['收到帧数', String(stats.transport.frames)],
          ['已投递消息', String(stats.delivered)],
          ['待应答审批', String(stats.pendingApprovalCount)],
          ['重连次数', String(stats.reconnects)],
          ['遥测开关', this.options.telemetry.enabled ? '开启' : `关闭（${this.options.telemetry.reason ?? 'unknown'}）`],
        ];
        return {
          text: formatKeyValue(entries, { width, theme }),
          data: { scene: sceneId, stats, telemetry: { enabled: this.options.telemetry.enabled, reason: this.options.telemetry.reason ?? null } },
        };
      }
      default:
        throw new CliError('usage', `没有这个场景：${sceneId}`);
    }
  }

  /**
   * 状态栏。
   * @returns 执行结果。
   */
  private status(): CommandResult {
    const { theme, width } = this.options;
    const stats = this.options.channel.stats;
    const info = this.options.channel.channelInfo;
    const values: Readonly<Record<string, string>> = {
      connection: info === undefined ? stats.state : `${stats.state}（pid=${info.pid ?? 'unknown'}）`,
      session: this.currentSession ?? '未选择',
      approval: `${stats.pendingApprovalCount} 待应答${this.lastDecision === undefined ? '' : `，最近 ${this.lastDecision}`}`,
      delivery: `${stats.delivered} 已投递，重连 ${stats.reconnects} 次`,
      telemetry: this.options.telemetry.enabled ? '开启' : `关闭（${this.options.telemetry.reason ?? 'unknown'}）`,
    };
    const rows = STATUS_ENTRIES.map((entry) => ({
      id: entry.id,
      title: entry.title,
      value: values[entry.id] ?? '',
    }));
    const columns: Column[] = [
      { header: '条目', value: (row) => String(row.title) },
      { header: '取值', value: (row) => String(row.value) },
    ];
    return {
      text: formatTable(rows, columns, { width, theme }),
      data: {
        entries: rows,
        state: stats.state,
        pendingApprovals: stats.pendingApprovalCount,
        delivered: stats.delivered,
        reconnects: stats.reconnects,
      },
    };
  }

  /**
   * 取会话记录。
   *
   * 会话不在当前连接里时先向本机运行时恢复它：ACP 的会话标识跨进程持久化，恢复之后才能发送、
   * 取消与关闭。
   * @param option - `--session` 取值。
   * @returns 会话记录。
   * @throws {CliError} 没有会话或恢复被拒绝时为用法错误。
   */
  private async ensureSession(option: string | boolean | undefined): Promise<SessionRecord> {
    const sessionId = typeof option === 'string' ? option : this.currentSession;
    if (sessionId === undefined) {
      throw new CliError('usage', '还没有当前会话，先用 session.new 或 session.resume 选一个');
    }
    const known = this.options.channel.knownSessions.find((session) => session.sessionId === sessionId);
    if (known !== undefined) return known;
    try {
      const record = await this.options.channel.resumeSession({ sessionId });
      this.currentSession = record.sessionId;
      return record;
    } catch (error) {
      throw new CliError(
        'usage',
        `会话 ${sessionId} 无法在当前连接里使用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 危险动作需要显式确认。
   * @param call - 解析之后的调用。
   */
  private confirm(call: ParsedCall): void {
    if (call.spec.confirmation === undefined) return;
    if (call.options.yes === true) return;
    throw new CliError(
      'usage',
      `${call.spec.id} 属于危险动作：${call.spec.confirmation}；确认时加 --yes。用法：${usageOf(call.spec)}`,
    );
  }

  /**
   * 渲染会话建立之后的文本。
   * @param record - 会话记录。
   * @param headline - 首行说明。
   * @returns 文本行。
   */
  private sessionText(record: SessionRecord, headline: string): string[] {
    const { theme, width } = this.options;
    return [
      theme.paint('success', headline),
      ...formatKeyValue(
        [
          ['会话标识', record.sessionId],
          ['工作目录', record.cwd],
          ['配置项', record.configOptions.map((option) => option.id).join('、')],
        ],
        { width, theme },
      ),
    ];
  }
}
