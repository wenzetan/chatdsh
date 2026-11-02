/**
 * 非交互模式的行协议与退出码。
 *
 * stdin 每行是一个 JSON 对象，stdout 每行也是一个 JSON 对象。stdout 只承载业务协议：
 * 应答行带 `ok`，事件行带 `event`，两类都带 `protocol` 与时间戳。诊断信息走 stderr。
 * 退出码按失败类别固定，调用方可以只看退出码判断本次运行的结果。
 * @module @chatdsh/client-cli/protocol
 */

import { z } from 'zod';

/** 协议标识，出现在每一行的 `protocol` 字段。 */
export const PROTOCOL = 'chatdsh.cli/1';

/** 退出码。 */
export const EXIT_CODES = {
  /** 全部请求成功。 */
  success: 0,
  /** 运行时错误：通道建立失败、命令执行失败、子进程异常退出。 */
  runtime: 1,
  /** 用法错误：未知命令、缺少必需参数、无法解析的请求行。 */
  usage: 2,
  /** 收到 SIGINT 或 SIGTERM，清理之后退出。 */
  interrupted: 130,
} as const;

/** 退出码取值。 */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * 退出码优先级。
 *
 * 一次运行里可能同时出现用法错误与运行时错误；用法错误说明调用方式本身有问题，优先报告。
 */
const EXIT_PRIORITY: Readonly<Record<number, number>> = {
  [EXIT_CODES.success]: 0,
  [EXIT_CODES.runtime]: 1,
  [EXIT_CODES.usage]: 2,
  [EXIT_CODES.interrupted]: 3,
};

/**
 * 合并两个退出码，取更严重的一个。
 * @param left - 当前退出码。
 * @param right - 新出现的退出码。
 * @returns 更严重的退出码。
 */
export function worstExit(left: ExitCode, right: ExitCode): ExitCode {
  return (EXIT_PRIORITY[right] ?? 0) > (EXIT_PRIORITY[left] ?? 0) ? right : left;
}

/** 错误类别。 */
export const ERROR_CODES = ['usage', 'runtime', 'offline', 'rejected', 'timeout', 'protocol'] as const;

/** 错误类别取值。 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 错误类别对应的退出码。 */
const EXIT_BY_ERROR: Readonly<Record<ErrorCode, ExitCode>> = {
  usage: EXIT_CODES.usage,
  runtime: EXIT_CODES.runtime,
  offline: EXIT_CODES.runtime,
  rejected: EXIT_CODES.runtime,
  timeout: EXIT_CODES.runtime,
  protocol: EXIT_CODES.runtime,
};

/**
 * 命令执行失败。
 *
 * 带上类别之后，调用方可以从退出码与应答行两处看到同一判断。
 */
export class CliError extends Error {
  /** 错误类别。 */
  readonly code: ErrorCode;
  /** 该类别的退出码。 */
  readonly exitCode: ExitCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = EXIT_BY_ERROR[code];
  }
}

/** 非交互请求行的选项。 */
const optionsSchema = z
  .object({
    /** 审批无人应答时的等待上限；省略用通道默认值。 */
    approvalTimeoutMs: z.number().int().positive().max(600_000).optional(),
    /** 已确认危险动作。 */
    confirm: z.boolean().optional(),
  })
  .strict();

/** 非交互请求行。 */
export const requestLineSchema = z
  .object({
    /** 请求标识，回应对应同一标识。 */
    id: z.string().min(1).max(200),
    /** 命令标识，例如 `session.new`。 */
    command: z.string().min(1).max(120).optional(),
    /** 结构化参数，键名与命令声明一致。 */
    arguments: z.record(z.string().max(80), z.unknown()).optional(),
    /** 命令行文本，交给命令树解析。 */
    line: z.string().min(1).max(8_000).optional(),
    /** 执行选项。 */
    options: optionsSchema.optional(),
  })
  .strict()
  .refine((value) => (value.command === undefined) !== (value.line === undefined), {
    message: '请求行必须给 command 或 line 其中一个',
  });

/** 请求行类型。 */
export type RequestLine = z.infer<typeof requestLineSchema>;

/** 请求行解析失败。 */
export class RequestLineError extends CliError {
  /** 出错的请求标识；无法从行内读出时为 `undefined`。 */
  readonly requestId: string | undefined;

  constructor(message: string, requestId?: string) {
    super('usage', message);
    this.name = 'RequestLineError';
    this.requestId = requestId;
  }
}

/**
 * 解析一行请求。
 * @param text - 一行文本，不含换行。
 * @returns 请求行。
 * @throws {RequestLineError} 不是 JSON 对象、字段缺失或字段取值非法。
 */
export function parseRequestLine(text: string): RequestLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestLineError('请求行不是合法的 JSON');
  }
  const parsed = requestLineSchema.safeParse(value);
  if (!parsed.success) {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const id = typeof record.id === 'string' && record.id !== '' ? record.id : undefined;
    const detail = parsed.error.issues.map((issue) => issue.message).join('；');
    throw new RequestLineError(`请求行不符合协议：${detail}`, id);
  }
  return parsed.data;
}

/** 一行应答。 */
export interface ResponseLine {
  readonly protocol: string;
  readonly id: string;
  readonly ok: boolean;
  readonly at: string;
  readonly command?: string;
  readonly result?: unknown;
  readonly error?: { readonly code: ErrorCode; readonly message: string };
}

/** 一行事件。 */
export interface EventLine {
  readonly protocol: string;
  readonly event: string;
  readonly at: string;
  readonly [key: string]: unknown;
}

/**
 * 构造成功应答。
 * @param id - 请求标识。
 * @param command - 命令标识。
 * @param result - 执行结果。
 * @returns 应答对象。
 */
export function successLine(id: string, command: string, result: unknown): ResponseLine {
  return { protocol: PROTOCOL, id, ok: true, at: new Date().toISOString(), command, result };
}

/**
 * 构造失败应答。
 * @param id - 请求标识。
 * @param command - 命令标识；未知时省略。
 * @param error - 错误。
 * @returns 应答对象。
 */
export function failureLine(id: string, command: string | undefined, error: CliError): ResponseLine {
  const base = { protocol: PROTOCOL, id, ok: false, at: new Date().toISOString() };
  const body = { code: error.code, message: error.message };
  return command === undefined ? { ...base, error: body } : { ...base, command, error: body };
}

/**
 * 构造事件行。
 * @param event - 事件名，形如 `channel.open`。
 * @param payload - 事件载荷。
 * @returns 事件对象。
 */
export function eventLine(event: string, payload: Readonly<Record<string, unknown>> = {}): EventLine {
  return { protocol: PROTOCOL, event, at: new Date().toISOString(), ...payload };
}

/**
 * 把一行协议对象序列化成写入 stdout 的文本。
 * @param value - 应答或事件。
 * @returns 带换行的文本。
 */
export function serializeLine(value: ResponseLine | EventLine): string {
  return `${JSON.stringify(value)}\n`;
}
