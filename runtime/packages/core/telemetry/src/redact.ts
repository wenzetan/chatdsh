/**
 * 属性登记与脱敏。
 *
 * 业务侧只传登记过的键，未登记的键在非调试模式被丢弃并计数，因此「忘记脱敏」表现为
 * 一个可观测的丢弃计数，而不依赖评审记忆。消息一律经 {@link redactMessage} 处理。
 * @module @chatdsh/core-telemetry/redact
 */

import {
  TELEMETRY_CONTEXT_ATTRIBUTES,
  TELEMETRY_RESOURCE_ATTRIBUTES,
  type TelemetryAttributeValue,
  type TelemetryAttributes,
} from '@chatdsh/core-contracts';

/** 消息截断上限，超出部分丢弃。 */
export const MESSAGE_LIMIT = 200;

/** 必带属性键。 */
const RESOURCE_KEYS = Object.values(TELEMETRY_RESOURCE_ATTRIBUTES);

/** 上下文属性键。 */
const CONTEXT_KEYS = Object.values(TELEMETRY_CONTEXT_ATTRIBUTES);

/** 各信号清单里登记过的属性键。新增信号时同步补充。 */
const DECLARED_KEYS = [
  'action',
  'approval.kind',
  'attempt',
  'auth.mode',
  'bank.kind',
  'bank_kind',
  'boundary',
  'bytes',
  'carrier',
  'channel',
  'chat.backend',
  'command',
  'completion.tokens',
  'conflict.kind',
  'count',
  'credential.name',
  'decided_by',
  'decision',
  'dependency',
  'device.kind',
  'duration',
  'error_code',
  'error_type',
  'event.type',
  'events',
  'exit.code',
  'hits',
  'http.method',
  'http.route',
  'http.status_code',
  'kind',
  'lag.events',
  'matched',
  'method',
  'mode',
  'module',
  'module.count',
  'module.id',
  'parent.session.id',
  'patch.id',
  'plugin.name',
  'policy.mode',
  'power.mode',
  'probe.id',
  'prompt.tokens',
  'protocol.version',
  'reason',
  'result.bytes',
  'route',
  'rpc.method',
  'runtime.id',
  'scene',
  'seq',
  'session.kind',
  'share.id',
  'signal',
  'stage',
  'status',
  'status_class',
  'storage.domain',
  'subagent.count',
  'task.id',
  'tool',
  'tool.count',
  'up_to_seq',
  'uptime.seconds',
] as const;

/** 全部登记键。 */
export const DECLARED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set<string>([
  ...RESOURCE_KEYS,
  ...CONTEXT_KEYS,
  ...DECLARED_KEYS,
]);

/** 一条脱敏规则。 */
export interface RedactorRule {
  /** 匹配的属性键：精确名或正则。 */
  readonly key: string | RegExp;
  /** 命中后的处理：丢弃、替换成固定掩码、保留。 */
  readonly action: 'drop' | 'mask' | 'keep';
}

/** 脱敏结果。 */
export interface RedactOutcome {
  /** 保留下来的属性。 */
  readonly kept: TelemetryAttributes;
  /** 被丢弃的属性条数。 */
  readonly dropped: number;
}

/** 脱敏器。 */
export interface Redactor {
  /** 过滤属性表。 */
  attributes(attributes: TelemetryAttributes): RedactOutcome;
  /** 处理一条可能含敏感内容的消息。 */
  message(text: string): string;
}

const ABSOLUTE_PATH = /(?:^|\s)(\/(?:[\w.@-]+\/)+[\w.@-]+|[A-Za-z]:\\[^\s]+)/g;
const URL_QUERY = /(\?[^\s"']*)/g;
const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*[^\s,;]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /(?:\+?\d[\d\s-]{7,}\d)/g;

/**
 * 处理一条消息：截断到 {@link MESSAGE_LIMIT}，并把绝对路径、URL 查询串、形似凭据的片段、
 * 邮箱与手机号替换成占位符。
 * @param text - 原始消息。
 * @returns 可进入遥测的消息。
 */
export function redactMessage(text: string): string {
  const replaced = text
    .replace(BEARER, '[redacted-credential]')
    .replace(SECRET_ASSIGNMENT, '[redacted-credential]')
    .replace(URL_QUERY, '[redacted-query]')
    .replace(ABSOLUTE_PATH, ' [redacted-path]')
    .replace(EMAIL, '[redacted-email]')
    .replace(PHONE, '[redacted-number]');
  return replaced.length <= MESSAGE_LIMIT ? replaced : `${replaced.slice(0, MESSAGE_LIMIT)}…`;
}

/**
 * 建立一个脱敏器。
 * @param rules - 追加规则，按顺序匹配，命中即采用该规则的动作。
 * @param options - `debug` 为真时保留未登记键的内容但仍计数，供本地排查。
 * @returns 脱敏器。
 */
export function createRedactor(rules: readonly RedactorRule[] = [], options: { debug?: boolean } = {}): Redactor {
  const debug = options.debug === true;
  return {
    attributes(attributes: TelemetryAttributes): RedactOutcome {
      const kept: Record<string, TelemetryAttributeValue> = {};
      let dropped = 0;
      for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined) continue;
        const rule = rules.find((candidate) => typeof candidate.key === 'string' ? candidate.key === key : candidate.key.test(key));
        if (rule?.action === 'drop') {
          dropped += 1;
          continue;
        }
        if (rule?.action === 'mask') {
          kept[key] = '[redacted]';
          continue;
        }
        if (rule !== undefined || DECLARED_ATTRIBUTE_KEYS.has(key)) {
          kept[key] = typeof value === 'string' ? redactMessage(value) : value;
          continue;
        }
        dropped += 1;
        if (debug) kept[key] = typeof value === 'string' ? redactMessage(value) : value;
      }
      return { kept, dropped };
    },
    message(text: string): string {
      return redactMessage(text);
    },
  };
}
